/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S18 (Sprint S3 do roadmap de aprendizado orientado a objetivos)
 *
 * Valida os 5 consumidores migrados na S3 — critério não é "a query retornou linhas",
 * é "o conhecimento correto retorna ao componente correto, de forma semanticamente
 * confiável". Cobre os 5 requisitos obrigatórios da S3: RiskAnalyzer, GoalPlanner.replan,
 * categoria (fragmentação corrigida), commit-phase (Opção B) e compatibilidade legada.
 *
 * Execução: npx ts-node src/__tests__/regression/S18_ReflectionMemory_ConsumerContract.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { ReflectionMemory } from '../../memory/ReflectionMemory';

function freshMemory(): { rm: ReflectionMemory; db: any } {
    const db = new (Database as any)(':memory:');
    return { rm: new ReflectionMemory({ getDatabase: () => db } as any), db };
}

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`); failed++; }
}
function readSource(relPath: string): string {
    return fs.readFileSync(path.join(process.cwd(), 'src', relPath), 'utf-8');
}

async function main() {
    // ══════════════════════════ 1. RiskAnalyzer ══════════════════════════
    console.log('\n=== S18.1 — RiskAnalyzer: sem texto livre, constraint real recuperável, sem evidência não inventa ===');

    const riskSrc = readSource('loop/RiskAnalyzer.ts');
    assert(!/buildConstraints\(goal\.objective/.test(riskSrc), 'texto livre do objetivo não é mais usado como chave técnica');
    assert(/findHardConstraints\(planTools\)/.test(riskSrc), 'usa findHardConstraints(planTools) — chave real por ferramenta');
    assert(/findToolFailures\(step\.toolName\)/.test(riskSrc), 'hint por step usa findToolFailures(step.toolName) — chave real');

    {
        const { rm } = freshMemory();
        // 3 falhas 100% para ferramenta X — deve virar constraint
        for (let i = 0; i < 3; i++) {
            rm.record({
                userInput: 'a', intent: 'b', toolUsed: 'flaky_tool',
                approved: false, reason: 'PEP 668 externally-managed-environment', confidence: 0.9,
                pattern: 'tool_flaky_tool', outcome: 'failure', failureType: 'environment_limit',
            });
        }
        const withEvidence = rm.findHardConstraints(['flaky_tool']);
        assert(withEvidence.length > 0, 'constraint estruturada real É recuperada quando há evidência (3x falha 100%)');

        const withoutEvidence = rm.findHardConstraints(['ferramenta_nunca_usada']);
        assert(withoutEvidence.length === 0, 'ausência de evidência NÃO cria constraint (ferramenta sem histórico)');
    }

    // ══════════════════════════ 2. GoalPlanner.replan() ══════════════════════════
    console.log('\n=== S18.2 — GoalPlanner.replan(): mismatch de prefixo não importa mais, failureType real recupera, legado ainda acessível ===');

    const plannerSrc = readSource('loop/GoalPlanner.ts');
    assert(/findBlockerLessons\(blocker\)/.test(plannerSrc), 'replan() usa findBlockerLessons(blocker) — decide tool_used vs failure_type sem prefixo');

    {
        const { rm } = freshMemory();
        // Blocker COM toolName — deve achar via tool_used, independente de qualquer prefixo
        for (let i = 0; i < 3; i++) {
            rm.record({
                userInput: 'a', intent: 'b', toolUsed: 'exec_command',
                approved: false, reason: 'CLIXML', confidence: 0.9,
                pattern: 'tool_exec_command', outcome: 'failure', failureType: 'tool_error',
            });
        }
        const withTool = rm.findBlockerLessons({ kind: 'tool_error', toolName: 'exec_command' });
        assert(withTool.length > 0, 'blocker com toolName recupera lição correspondente via tool_used (prefixo irrelevante)');

        // Blocker SEM toolName — deve achar via failure_type real
        for (let i = 0; i < 3; i++) {
            rm.record({
                userInput: 'a', intent: 'b', toolUsed: 'unknown',
                approved: false, reason: 'objetivo ambíguo', confidence: 0.8,
                pattern: 'tool_goal_ambiguous', outcome: 'failure', failureType: 'goal_ambiguous',
            });
        }
        const withoutTool = rm.findBlockerLessons({ kind: 'goal_ambiguous' });
        assert(withoutTool.length > 0, 'blocker SEM toolName recupera lição via failure_type real (nova capacidade da S3b)');
    }

    // ══════════════════════════ 3. Categoria (fragmentação corrigida) ══════════════════════════
    console.log('\n=== S18.3 — Categoria: 20 registros / 30% falha agregada NÃO se perde por fragmentação de GROUP BY ===');

    {
        const { rm } = freshMemory();
        // Reproduz o caso real do S16.5: falhas espalhadas por ferramentas DIFERENTES,
        // nenhuma isolada bateria total>=2 se o agrupamento fosse por (category, tool_used).
        const tools = ['memory_search', 'read', 'write', 'send_document', 'web_search', 'crypto_analysis'];
        for (let i = 0; i < 6; i++) {
            rm.record({
                userInput: 'a', intent: 'b', toolUsed: tools[i % tools.length],
                approved: false, reason: 'resposta insatisfatória', confidence: 0.6,
                pattern: 'conversation', outcome: 'failure', category: 'conversation',
            });
        }
        const hint = rm.findCategoryHints('conversation');
        assert(hint.length > 0, "findCategoryHints('conversation') recupera o sinal agregado (6 falhas em 6 tools diferentes)");
        assert(/6\/6|100%/.test(hint), 'o hint reflete o agregado da categoria inteira, não um fragmento por ferramenta');
    }

    const agentLoopSrc = readSource('loop/AgentLoop.ts');
    assert(/findCategoryHints\(intentDecision\.category\)/.test(agentLoopSrc), 'AgentLoop usa findCategoryHints — agregação correta, não mais buildContextHint(category)');

    // ══════════════════════════ 4. Commit-phase (decisão Opção B) ══════════════════════════
    console.log('\n=== S18.4 — Commit-phase: Opção B — conexão conservadora via tool_used, SEM failureType inventado ===');

    assert(/this\.reflectionMemory\.findToolFailures\(last\.toolName\)/.test(agentLoopSrc),
        'commitResponse conecta via findToolFailures(last.toolName) — Opção B, escopo limitado');
    assert(!/failureType:\s*['"]hallucinated_completion['"]/.test(agentLoopSrc) && !/failureType:\s*['"]false_success_claim['"]/.test(agentLoopSrc),
        'NENHUMA classificação de failureType foi inventada para commitResponse (nem hallucinated_completion nem false_success_claim)');
    assert(/correlação observacional, não altera a decisão de commit/.test(agentLoopSrc),
        'a conexão é documentada explicitamente como observacional, não decisória — não muda commit.valid/blocked');

    {
        // Prova que dados gravados por commitResponse (tool_used='write', pattern legado)
        // SÃO recuperáveis pela nova conexão, mesmo sem failureType.
        const { rm } = freshMemory();
        for (let i = 0; i < 3; i++) {
            rm.record({
                userInput: 'a', intent: 'b', toolUsed: 'write',
                approved: false, reason: 'não executou o script gerado', confidence: 0.9,
                pattern: 'hallucination_blocked_pre_commit', outcome: 'failure',
                // sem failureType — exatamente como commitResponse grava hoje
            });
        }
        const hint = rm.findToolFailures('write');
        assert(hint.length > 0, "dados de commitResponse (tool_used='write', sem failureType) SÃO recuperados via findToolFailures — conexão real, não teatro");
    }

    // ══════════════════════════ 5. Compatibilidade legada ══════════════════════════
    console.log('\n=== S18.5 — Compatibilidade: novos e legados recuperáveis; consumidores não conhecem convenções de pattern ===');

    {
        const { rm } = freshMemory();
        // Registro "legado" simulado: só tem tool_used + pattern antigo, SEM outcome/category/failureType
        // (como estava todo registro gravado antes da S2).
        for (let i = 0; i < 3; i++) {
            rm.record({
                userInput: 'a', intent: 'b', toolUsed: 'legacy_tool',
                approved: false, reason: 'falha antiga', confidence: 0.8,
                pattern: 'goal_blocker_tool_error', // convenção legada, pré-S2
                // outcome/category/failureType ausentes — simula dado gravado antes da S1/S2
            });
        }
        const legacyHint = rm.findToolFailures('legacy_tool');
        assert(legacyHint.length > 0, 'registro legado (sem outcome/category/failureType, só tool_used+pattern antigo) continua recuperável — tool_used sempre foi confiável');
    }

    for (const file of ['loop/RiskAnalyzer.ts', 'loop/GoalPlanner.ts', 'loop/AgentLoop.ts'] as const) {
        const src = readSource(file);
        const knowsLegacyConvention = /goal_blocker_|tool_\$\{.*\}_success|_success['"`]/.test(src);
        assert(!knowsLegacyConvention, `${file} não conhece convenções legadas de pattern (goal_blocker_*, _success) — compatibilidade fica centralizada em ReflectionMemory`);
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S18 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    if (failed > 0) process.exit(1);
}

main().catch(err => { console.error('ERRO NÃO TRATADO:', err); process.exit(1); });
