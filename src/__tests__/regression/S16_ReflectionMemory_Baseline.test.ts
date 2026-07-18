/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S16 (Sprint S0 do roadmap de aprendizado orientado a objetivos)
 *
 * Baseline: transforma os 3 achados críticos da auditoria de ReflectionMemory em asserções
 * automatizadas sobre o comportamento ATUAL (mesmo o que está errado). Sem isso, "melhorou"
 * vira opinião — este arquivo é a linha de base objetiva contra a qual S1-S4 são medidas.
 *
 * ESTADO ATUAL: os 5 testes abaixo DEVEM PASSAR — documentam o comportamento hoje.
 * PÓS-S3: os testes 1, 2 e 4 devem passar a FALHAR (sinal de que a correção funcionou) e
 * precisam ser invertidos/atualizados na própria Sprint que os corrige, não apagados.
 *
 * Execução: npx ts-node src/__tests__/regression/S16_ReflectionMemory_Baseline.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { ReflectionMemory } from '../../memory/ReflectionMemory';

function createInMemoryReflectionMemory(): ReflectionMemory {
    const db = new (Database as any)(':memory:');
    const mockMemoryManager = { getDatabase: () => db } as any;
    return new ReflectionMemory(mockMemoryManager);
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
    // ── Baseline 1 — PARCIALMENTE INVERTIDO NA S3c ───────────────────────────────
    // Original (S0): nada consultava por pattern='hallucination_blocked_pre_commit'
    // nem 'commit_approved' — o dado ficava permanentemente inacessível.
    // Situação real após S3c: nenhum código ainda busca pelo LITERAL desses
    // patterns (essa parte continua verdadeira, e é o correto — buscar por
    // pattern seria repetir o erro original). MAS os dados desses registros
    // deixaram de estar isolados: como findToolFailures() agora agrega por
    // tool_used (Opção B, conexão conservadora documentada no relatório), e
    // tool_used sempre foi populado corretamente nesses registros (ex: 'write'),
    // eles PASSAM a ser alcançados indiretamente — só que pela dimensão
    // ferramenta, não pela dimensão "tipo de alucinação" (que ResponseCommit
    // não tem base pra fornecer). Teste atualizado para provar exatamente isso.
    console.log('\n=== S16.1 — hallucination_blocked_pre_commit/commit_approved: ainda sem busca por pattern, mas agora alcançável via tool_used (Opção B, S3c) ===');

    const agentLoopSrc = readSource('loop/AgentLoop.ts');
    const writesCommitPattern = /pattern:\s*commit\.blocked\s*\?\s*'hallucination_blocked_pre_commit'\s*:\s*'commit_approved'/.test(agentLoopSrc);
    assert(writesCommitPattern, "AgentLoop.commitResponse ainda grava pattern='hallucination_blocked_pre_commit'/'commit_approved' (compatibilidade legada preservada)");

    // O literal só deve aparecer 1x (o próprio ponto de escrita) em AgentLoop.ts,
    // e 0x nos outros 3 arquivos — nenhuma consulta nova foi construída em cima
    // do literal (isso repetiria o erro original de chave por string mágica).
    const occurrencesIn = (src: string, literal: string) => (src.match(new RegExp(literal, 'g')) ?? []).length;
    const otherFiles = ['loop/GoalExecutionLoop.ts', 'loop/GoalPlanner.ts', 'loop/RiskAnalyzer.ts'].map(readSource);
    const literalOnlyAtWriteSite =
        occurrencesIn(agentLoopSrc, 'hallucination_blocked_pre_commit') === 1 &&
        occurrencesIn(agentLoopSrc, 'commit_approved') === 1 &&
        otherFiles.every(src => occurrencesIn(src, 'hallucination_blocked_pre_commit') === 0 && occurrencesIn(src, 'commit_approved') === 0);
    assert(literalOnlyAtWriteSite, "Nenhuma consulta em src/loop/*.ts busca pelo LITERAL 'hallucination_blocked_pre_commit'/'commit_approved' — correto: buscar por pattern repetiria o erro original");

    const commitConnectsViaToolUsed = /this\.reflectionMemory\.findToolFailures\(last\.toolName\)/.test(agentLoopSrc);
    assert(commitConnectsViaToolUsed, "commitResponse agora consulta findToolFailures(last.toolName) — conexão real (Opção B), via tool_used, não via pattern");

    // O hint por categoria agora usa findCategoryHints (agrega por category, corrige fragmentação)
    const agentLoopReadsCategoryOnly = /findCategoryHints\(intentDecision\.category\)/.test(agentLoopSrc);
    assert(agentLoopReadsCategoryOnly, "AgentLoop.ts:1179 consulta findCategoryHints(intentDecision.category) — agregação corrigida, sem fragmentar por ferramenta");

    // ── Baseline 2 — INVERTIDO NA S3a ────────────────────────────────────────────
    // Original (S0): RiskAnalyzer.buildConstraints(goal.objective.slice(0,150), planTools)
    // passava texto livre do objetivo do usuário como se fosse uma chave técnica —
    // a query SQL faz WHERE pattern = ?, então nunca casava com nada de verdade.
    // Correção real (S3a): substituído por findHardConstraints(planTools) —
    // consulta por ferramenta real (tool_used), uma pergunta por tool do plano,
    // sem depender de nenhum texto livre. Teste de bug substituído por teste do
    // comportamento correto: confirma que o texto livre NÃO é mais usado E que o
    // novo método estruturado é chamado no lugar.
    console.log('\n=== S16.2 — RiskAnalyzer usa findHardConstraints(planTools), não mais texto livre (invertido na S3a) ===');

    const riskAnalyzerSrc = readSource('loop/RiskAnalyzer.ts');
    const stillPassesFreeText = /buildConstraints\(goal\.objective\.slice\(0,\s*150\),\s*planTools\)/.test(riskAnalyzerSrc);
    assert(!stillPassesFreeText, 'RiskAnalyzer.ts NÃO chama mais buildConstraints(goal.objective..., ...) — bug crítico corrigido');
    const usesStructuredConstraints = /findHardConstraints\(planTools\)/.test(riskAnalyzerSrc);
    assert(usesStructuredConstraints, 'RiskAnalyzer.ts:133 agora chama findHardConstraints(planTools) — consulta por ferramenta real');

    // ── Baseline 3 — INVERTIDO NA S3b ────────────────────────────────────────────
    // Original (S0): escrita sempre prefixava com tool_ (mesmo pro fallback de
    // blocker.kind), leitura caía pro blocker.kind SEM prefixo — mismatch de string.
    // Correção real (S3b): GoalPlanner.replan() não monta mais nenhum prefixo —
    // chama findBlockerLessons(blocker), que decide internamente se busca por
    // tool_used (coluna real) ou failure_type (coluna real), sem string concatenada.
    // O mismatch de prefixo deixa de ser possível porque não há mais prefixo.
    console.log('\n=== S16.3 — GoalPlanner.replan() usa findBlockerLessons(blocker), sem prefixo de string (invertido na S3b) ===');

    const goalExecutionLoopSrc = readSource('loop/GoalExecutionLoop.ts');
    const goalPlannerSrc = readSource('loop/GoalPlanner.ts');

    // ARCH-020 (S24): case 'blocked' virou o método handleBlockedOutcome(), onde o parâmetro
    // se chama `step` (não mais `pendingStep`, que continua sendo o nome usado no corpo de
    // runLoopInternal() para o mesmo valor antes de ser passado ao handler) — mesmo valor,
    // outro nome de variável local, sem mudança de comportamento.
    const writeAlwaysPrefixed = /pattern:\s*`tool_\$\{step\.toolName \?\? cycleResult\.blocker\.kind\}`/.test(goalExecutionLoopSrc);
    assert(writeAlwaysPrefixed, "GoalExecutionLoop.ts continua gravando pattern legado com prefixo tool_ (compatibilidade preservada)");

    const noLongerGuessesPrefix = /blocker\.toolName \? `tool_\$\{blocker\.toolName\}` : blocker\.kind/.test(goalPlannerSrc);
    assert(!noLongerGuessesPrefix, "GoalPlanner.ts NÃO monta mais prefixo tool_/bare para adivinhar a chave de leitura");
    const usesStructuredBlockerLessons = /findBlockerLessons\(blocker\)/.test(goalPlannerSrc);
    assert(usesStructuredBlockerLessons, "GoalPlanner.ts:659 agora chama findBlockerLessons(blocker) — decide tool_used vs failure_type internamente na ReflectionMemory");

    // ── Baseline 4 — INVERTIDO NA S4 ─────────────────────────────────────────────
    // Original (S0): plan() (primeira tentativa) nunca consultava ReflectionMemory
    // — só replan() (após falha) consultava. A primeira tentativa de todo goal
    // sempre partia do zero, mesmo quando já existia evidência histórica relevante.
    // Correção real (S4): plan() agora chama findHardConstraints(availableTools)
    // — reaproveita o MESMO método da S3a, não uma API nova. Só a camada de
    // constraint (90% falha, já a mais confiável) se aplica: sem blocker ainda,
    // sem tool escolhida, sem IntentCategory no caminho de goal (ver relatório S4).
    console.log('\n=== S16.4 — GoalPlanner.plan() agora consulta findHardConstraints() (invertido na S4); replan() consulta via findBlockerLessons ===');

    const planBody = goalPlannerSrc.slice(
        goalPlannerSrc.indexOf('async plan('),
        goalPlannerSrc.indexOf('async replan(')
    );
    const replanBody = goalPlannerSrc.slice(goalPlannerSrc.indexOf('async replan('));

    assert(planBody.includes('this.reflectionMemory.findHardConstraints('), "plan() (primeira tentativa) agora referencia reflectionMemory.findHardConstraints — gap da S0 fechado");
    assert(replanBody.includes('this.reflectionMemory.findBlockerLessons('), "replan() (só após falha) referencia reflectionMemory.findBlockerLessons — método estruturado da S3b, inalterado");

    // ── Baseline 5 — GROUP BY (pattern, tool_used) fragmenta padrão categórico amplo ────
    console.log("\n=== S16.5 — getFailurePatterns('conversation') retorna vazio apesar de sinal agregado suficiente ===");

    const rm = createInMemoryReflectionMemory();
    // Reproduz a distribuição real observada em produção: 20 registros 'conversation'
    // espalhados por múltiplas ferramentas, 6 falhas (30% agregado) — mas nenhum subgrupo
    // (pattern, tool_used) isolado atinge total>=2 E failure_rate>=0.30 simultaneamente.
    const toolSpread = ['memory_search', 'read', 'write', 'send_document', 'web_search', 'crypto_analysis', 'weather'];
    let recorded = 0;
    for (let i = 0; i < 20; i++) {
        const tool = toolSpread[i % toolSpread.length];
        const isFailure = i < 6; // 6/20 = 30% agregado
        rm.record({
            userInput: `mensagem de conversa ${i}`,
            intent: 'conversation',
            toolUsed: tool,
            approved: !isFailure,
            reason: isFailure ? 'resposta insatisfatória' : 'ok',
            confidence: 0.6,
            pattern: 'conversation',
        });
        recorded++;
    }
    assert(recorded === 20, 'seed de 20 registros pattern=conversation gravado com sucesso');

    const hint = rm.buildContextHint('conversation');
    assert(hint === '', `buildContextHint('conversation') retorna vazio mesmo com 20 registros / 30% falha agregada (retornou: "${hint.slice(0, 60) || '(vazio)'}")`);

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S16 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    console.log('\nLembrete: estes testes documentam o estado ATUAL (com os bugs). Quando S3');
    console.log('corrigir cada achado, a asserção correspondente deve ser inversamente atualizada');
    console.log('nesta Sprint — não apagada — para provar a correção contra a mesma linha de base.');
    if (failed > 0) process.exit(1);
}

main().catch(err => { console.error('ERRO NÃO TRATADO:', err); process.exit(1); });
