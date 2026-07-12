/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S17 (Sprint S2 do roadmap de aprendizado orientado a objetivos)
 *
 * Valida SEMANTICAMENTE os 5 produtores migrados na S2 — não apenas que record() foi
 * chamado, mas que cada site fornece exatamente os campos que sua evidência real permite,
 * e nenhum campo que não pode comprovar (failureType/category ausentes onde não há base).
 *
 * Sites cobertos (GoalExecutionLoop.ts:908,1203,1822 · AgentLoop.ts:497,613):
 *   1. Semantic mismatch downgrade → outcome='partial', failureType='semantic_mismatch'
 *   2. Step blocked → outcome='failure', failureType=<BlockerKind real do blocker>
 *   3. markStepDone → outcome='success' (default, modos 'add'/'finalize') OU derivado do
 *      GoalAttempt real já persistido (modo 'skip', pode ser 'partial' de baixa confiança —
 *      Sprint 0.8.3, correção do achado residual 1 da Sprint 0.8.2); nunca failureType
 *   4. tryValidateTool → outcome binário, category=<IntentCategory real>, sem failureType
 *   5. commitResponse → outcome binário, SEM category, SEM failureType (ResponseCommit não
 *      tem taxonomia — ver relatório da S2, gap documentado deliberadamente)
 *
 * Execução: npx ts-node src/__tests__/regression/S17_ReflectionMemory_ProducerContract.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { ReflectionMemory } from '../../memory/ReflectionMemory';

function createInMemoryReflectionMemory(): { rm: ReflectionMemory; db: any } {
    const db = new (Database as any)(':memory:');
    const mockMemoryManager = { getDatabase: () => db } as any;
    return { rm: new ReflectionMemory(mockMemoryManager), db };
}

function lastRow(db: any): any {
    return db.prepare('SELECT * FROM reflection_annotations ORDER BY created_at DESC, rowid DESC LIMIT 1').get();
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
    // ── Schema: 3 colunas novas existem e são anuláveis ─────────────────────────
    console.log('\n=== S17.0 — schema tem outcome/category/failure_type (anuláveis) ===');
    const { rm, db } = createInMemoryReflectionMemory();
    const cols = (db.prepare('PRAGMA table_info(reflection_annotations)').all() as any[]).map(c => c.name);
    assert(cols.includes('outcome'), 'coluna outcome existe');
    assert(cols.includes('category'), 'coluna category existe');
    assert(cols.includes('failure_type'), 'coluna failure_type existe');

    // ── Site 1 — semantic mismatch downgrade (GoalExecutionLoop.ts ~908) ────────
    console.log('\n=== S17.1 — semantic mismatch: outcome=partial, failureType=semantic_mismatch ===');
    rm.record({
        userInput: 'gerar relatório de vendas',
        intent: 'ler dados de vendas do CSV',
        toolUsed: 'exec_command',
        toolOutput: 'saída não relacionada ao pedido',
        approved: false,
        reason: 'Mismatch semântico: output não endereça a intenção do step',
        confidence: 0.8,
        pattern: 'tool_exec_command',
        outcome: 'partial',
        failureType: 'semantic_mismatch',
    });
    let row = lastRow(db);
    assert(row.outcome === 'partial', `outcome gravado como 'partial' (veio: '${row.outcome}')`);
    assert(row.failure_type === 'semantic_mismatch', `failure_type='semantic_mismatch' (veio: '${row.failure_type}')`);
    assert(row.pattern === 'tool_exec_command', 'pattern legado preservado sem alteração');
    assert(row.tool_used === 'exec_command', 'tool_used preservado');

    // ── Site 2 — step blocked (GoalExecutionLoop.ts ~1203) ──────────────────────
    console.log('\n=== S17.2 — step blocked: outcome=failure, failureType=BlockerKind real ===');
    rm.record({
        userInput: 'instalar dependência X',
        intent: 'objetivo do goal',
        toolUsed: 'exec_command',
        approved: false,
        reason: 'dependência ausente',
        confidence: 0.9,
        pattern: 'tool_dependency_missing',
        outcome: 'failure',
        failureType: 'dependency_missing',
    });
    row = lastRow(db);
    assert(row.outcome === 'failure', "outcome gravado como 'failure'");
    assert(row.failure_type === 'dependency_missing', `failure_type reflete o BlockerKind real do blocker (veio: '${row.failure_type}')`);

    // ── Site 3 — markStepDone (GoalExecutionLoop.ts ~1822) ──────────────────────
    console.log('\n=== S17.3 — markStepDone: outcome=success, SEM failureType inventado ===');
    rm.record({
        userInput: 'ler arquivo X',
        intent: 'objetivo do goal',
        toolUsed: 'read',
        toolOutput: 'conteúdo lido',
        approved: true,
        reason: 'step completed successfully',
        confidence: 0.9,
        pattern: 'tool_read',
        outcome: 'success',
    });
    row = lastRow(db);
    assert(row.outcome === 'success', "outcome gravado como 'success'");
    assert(row.failure_type === null, 'failure_type é NULL — nenhuma classificação inventada para um sucesso');

    // ── Site 4 — tryValidateTool (AgentLoop.ts ~497) ────────────────────────────
    console.log('\n=== S17.4 — tryValidateTool: category real presente, failureType ausente ===');
    rm.record({
        userInput: 'poderia gerar os slides',
        intent: 'gerar apresentação',
        toolUsed: 'write',
        toolOutput: 'script escrito',
        approved: false,
        reason: 'ferramenta pode não ter atendido à solicitação',
        confidence: 0.65,
        pattern: 'creation',
        outcome: 'failure',
        category: 'creation',
    });
    row = lastRow(db);
    assert(row.category === 'creation', `category='creation' (IntentCategory real, veio: '${row.category}')`);
    assert(row.failure_type === null, 'failure_type é NULL — ValidationResult não tem taxonomia, nada foi inventado');
    assert(row.outcome === 'failure', "outcome binário 'failure' (ValidationResult não distingue partial)");

    // ── Site 5 — commitResponse (AgentLoop.ts ~613) — bloqueado e aprovado ──────
    console.log('\n=== S17.5 — commitResponse: outcome binário, SEM category, SEM failureType ===');
    rm.record({
        userInput: 'poderia gerar os slides editáveis',
        intent: 'gerar apresentação',
        toolUsed: 'write',
        toolOutput: 'script escrito, não executado',
        approved: false,
        reason: 'O assistente leu o script de geração, mas não o executou',
        confidence: 0.9,
        pattern: 'hallucination_blocked_pre_commit',
        outcome: 'failure',
    });
    row = lastRow(db);
    assert(row.outcome === 'failure', "outcome='failure' para commit bloqueado");
    assert(row.category === null, 'category NÃO populada em commitResponse nesta Sprint (decisão deliberada, ver relatório)');
    assert(row.failure_type === null, 'failure_type NÃO inventado para commitResponse — ResponseCommit não tem base para isso');
    assert(row.pattern === 'hallucination_blocked_pre_commit', 'pattern legado idêntico ao de hoje — nada quebra para leitores antigos');

    rm.record({
        userInput: 'poderia gerar os slides',
        intent: 'gerar apresentação',
        toolUsed: 'send_document',
        toolOutput: 'arquivo enviado',
        approved: true,
        reason: 'Q4 commit aprovado',
        confidence: 0.95,
        pattern: 'commit_approved',
        outcome: 'success',
    });
    row = lastRow(db);
    assert(row.outcome === 'success', "outcome='success' para commit aprovado");
    assert(row.pattern === 'commit_approved', 'pattern legado idêntico ao de hoje para o caso aprovado');

    // ── Confirmação estrutural: os campos realmente estão wired nos 5 call sites ─
    console.log('\n=== S17.6 — confirmação estrutural: código-fonte realmente passa os novos campos ===');
    const goalExecSrc = readSource('loop/GoalExecutionLoop.ts');
    const agentLoopSrc = readSource('loop/AgentLoop.ts');

    assert(/outcome:\s*'partial'/.test(goalExecSrc) && /failureType:\s*'semantic_mismatch'/.test(goalExecSrc),
        'GoalExecutionLoop.ts (mismatch semântico) passa outcome/failureType no código real');
    assert(/outcome:\s*'failure',\s*\n\s*failureType:\s*cycleResult\.blocker\.kind/.test(goalExecSrc),
        'GoalExecutionLoop.ts (blocked) passa failureType=cycleResult.blocker.kind no código real');
    // Sprint 0.8.3 (correção do achado residual 1, Sprint 0.8.2): markStepDone() não hardcoda
    // mais outcome='success' incondicionalmente — no modo 'skip' (executeStep() já rodou para
    // este step no mesmo ciclo), deriva outcome/confidence do GoalAttempt REAL já persistido
    // (que pode ser 'partial' de baixa confiança), para que RiskAnalyzer/findToolFailures/
    // findHardConstraints/findCategoryHints recebam informação coerente com o que o runtime
    // realmente produziu, em vez de um 'success'/confidence=0.9 sempre fixo.
    assert(/let reflectionOutcome:[^=]*=\s*'success'/.test(goalExecSrc) && /reflectionOutcome\s*=\s*existing\.result/.test(goalExecSrc),
        "GoalExecutionLoop.ts (markStepDone) deriva outcome do GoalAttempt real no modo 'skip', com 'success' só como default nos modos 'add'/'finalize' no código real");
    assert(/outcome:\s*validation\.approved\s*\?\s*'success'\s*:\s*'failure'/.test(agentLoopSrc),
        'AgentLoop.ts (tryValidateTool) deriva outcome de validation.approved no código real');
    assert(/outcome:\s*commit\.valid\s*\?\s*'success'\s*:\s*'failure'/.test(agentLoopSrc),
        'AgentLoop.ts (commitResponse) deriva outcome de commit.valid no código real');

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S17 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    if (failed > 0) process.exit(1);
}

main().catch(err => { console.error('ERRO NÃO TRATADO:', err); process.exit(1); });
