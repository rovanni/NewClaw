/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S24 (Sprint S6.5a do roadmap de aprendizado orientado a objetivos)
 *
 * Gate de integridade do ciclo captureIfEligible() → embedObjectiveShadow() → UPDATE.
 *
 * GAP REAL CONFIRMADO (auditoria S6.5a, antes desta correção): um Caso cujo embed() falhasse
 * no momento da captura (Ollama indisponível/timeout) ficava PERMANENTEMENTE invisível a
 * findRelevantCasesShadow() — nada reprocessava esses registros. Corrigido com
 * backfillMissingEmbeddings(): idempotente (WHERE objective_embedding IS NULL), limitado
 * (LIMIT), observável ([CASE-EMBED-BACKFILL]), fail-open, disparado no mesmo gatilho já
 * existente (início de goal), sem scheduler novo.
 *
 * Execução: npx ts-node src/__tests__/regression/S24_CaseMemory_EmbeddingIntegrity.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { CaseMemory } from '../../memory/CaseMemory';
import { Goal } from '../../loop/GoalTypes';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`); failed++; }
}
function readSource(relPath: string): string {
    return fs.readFileSync(path.join(process.cwd(), 'src', relPath), 'utf-8');
}

/** Fake EmbeddingService cujo embed() pode ser trocado em runtime (simula provider
 * indisponível em um momento e disponível depois — sem precisar de Ollama real). */
function makeControllableEmbedding() {
    let mode: 'ok' | 'unavailable' = 'ok';
    const calls: string[] = [];
    const svc = {
        embed: async (text: string) => {
            calls.push(text);
            if (mode === 'unavailable') return null;
            // vetor determinístico simples: comprimento do texto em 3 dimensões fixas
            return [text.length, text.length % 7, 1];
        },
        cosineSimilarity: (a: number[], b: number[]) => {
            let dot = 0, na = 0, nb = 0;
            for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
            const d = Math.sqrt(na) * Math.sqrt(nb);
            return d === 0 ? 0 : dot / d;
        },
    };
    return { svc, setMode: (m: 'ok' | 'unavailable') => { mode = m; }, calls };
}

function freshCaseMemoryWithControl() {
    const db = new (Database as any)(':memory:');
    const control = makeControllableEmbedding();
    const cm = new CaseMemory({ getDatabase: () => db, getEmbeddingService: () => control.svc } as any);
    return { cm, control, db };
}

let goalCounter = 0;
function makeGoal(objective: string, overrides: Partial<Goal> = {}): Goal {
    goalCounter++;
    const now = Date.now();
    return {
        id: `goal_s24_${goalCounter}`,
        sessionKey: 'test:user', conversationId: 'test-conv',
        userIntent: objective, objective,
        status: 'completed', currentPlan: [], attempts: [], blockers: [],
        toolsTried: [], strategiesTried: [],
        successCriteria: [{ id: 'c1', description: 'ev', check: 'tool_succeeded', status: 'met', metAt: now, evidence: 'ev' }],
        sentArtifacts: [], retryBudget: 3, replanBudget: 5, confidence: 0.9,
        requiresAuth: false, authorizationScope: [],
        createdAt: now, updatedAt: now, expiresAt: now + 3_600_000,
        ...overrides,
    } as Goal;
}
async function flush(): Promise<void> { await new Promise((r) => setTimeout(r, 10)); }

async function main() {
    const caseMemorySrc = readSource('memory/CaseMemory.ts');
    const gelSrc = readSource('loop/GoalExecutionLoop.ts');
    const plannerSrc = readSource('loop/GoalPlanner.ts');
    const riskSrc = readSource('loop/RiskAnalyzer.ts');

    // ══════════ 1. Caso capturado + embedding disponível → persistido ══════════
    console.log('\n=== S24.1 — Embedding disponível: persistido após captureIfEligible() (background) ===');
    {
        const { cm, control } = freshCaseMemoryWithControl();
        control.setMode('ok');
        cm.captureIfEligible(makeGoal('Objetivo com embedding disponível'));
        await flush();
        const candidates = await cm.findRelevantCasesShadow('Objetivo com embedding disponível');
        assert(candidates.length === 1, 'embedding foi persistido em background e é recuperável na consulta sombra');
    }

    // ══════════ 2. Provider indisponível → Caso permanece válido, execução continua ══════════
    console.log('\n=== S24.2 — Provider indisponível: captureIfEligible() não falha, retorna captured=true normalmente ===');
    {
        const { cm, control } = freshCaseMemoryWithControl();
        control.setMode('unavailable');
        const result = cm.captureIfEligible(makeGoal('Objetivo sem provider disponível'));
        await flush();
        assert(result.captured === true, 'captura do Caso não depende da disponibilidade do embedding — Caso é conhecimento válido mesmo sem índice derivado');
    }

    // ══════════ 3. Embedding null não corrompe o Caso ══════════
    console.log('\n=== S24.3 — embed()=null: linha do Caso permanece íntegra (objective_embedding=NULL, resto intacto) ══════════');
    {
        const { cm, control, db } = freshCaseMemoryWithControl();
        control.setMode('unavailable');
        cm.captureIfEligible(makeGoal('Objetivo com embed nulo'));
        await flush();
        const row = db.prepare('SELECT * FROM cases').get() as any;
        assert(row !== undefined, 'linha do Caso existe');
        assert(row.objective_embedding === null, 'objective_embedding fica NULL — não corrompido, não um Buffer vazio/lixo');
        assert(row.objective === 'Objetivo com embed nulo', 'demais campos do Caso permanecem íntegros');
    }

    // ══════════ 4. Gap comprovado é recuperável via backfill ══════════
    console.log('\n=== S24.4 — "Processo interrompido" simulado: Caso sem embedding é recuperado depois via backfillMissingEmbeddings() ===');
    {
        const { cm, control } = freshCaseMemoryWithControl();
        control.setMode('unavailable'); // simula: captura aconteceu, mas provider estava fora
        cm.captureIfEligible(makeGoal('Objetivo pendente de reprocessamento'));
        await flush();
        let candidates = await cm.findRelevantCasesShadow('Objetivo pendente de reprocessamento');
        assert(candidates.length === 0, 'ANTES do backfill: Caso não é encontrado (sem embedding) — gap real confirmado');

        control.setMode('ok'); // provider volta a funcionar
        const backfillResult = await cm.backfillMissingEmbeddings(10);
        assert(backfillResult.attempted === 1 && backfillResult.embedded === 1, 'backfill processou o Caso pendente com sucesso assim que o provider voltou');

        candidates = await cm.findRelevantCasesShadow('Objetivo pendente de reprocessamento');
        assert(candidates.length === 1, 'DEPOIS do backfill: Caso antes invisível agora é recuperável — gap fechado');
    }

    // ══════════ 5. Backfill é idempotente ══════════
    console.log('\n=== S24.5 — Backfill idempotente: rodar 2x não reprocessa o mesmo Caso ===');
    {
        const { cm, control } = freshCaseMemoryWithControl();
        control.setMode('ok');
        cm.captureIfEligible(makeGoal('Objetivo já processado'));
        await flush(); // já embeddado no fluxo normal
        control.calls.length = 0; // reset contador de chamadas
        const r1 = await cm.backfillMissingEmbeddings(10);
        assert(r1.attempted === 0, 'backfill não reprocessa Caso que já tem embedding (WHERE objective_embedding IS NULL)');
        assert(control.calls.length === 0, 'embed() não foi chamado de novo para um Caso já indexado');
    }

    // ══════════ 6. Caso já indexado não recalcula ══════════
    console.log('\n=== S24.6 — Caso com embedding válido não é alvo de novo embed() em chamadas subsequentes de captureIfEligible/backfill ===');
    {
        const { cm, control } = freshCaseMemoryWithControl();
        control.setMode('ok');
        const goal = makeGoal('Objetivo estável');
        cm.captureIfEligible(goal);
        await flush();
        const callsAfterFirstCapture = control.calls.length;
        // Segunda tentativa de captura do MESMO goal.id — já é rejeitada por already_captured,
        // então nem chega a tentar embed de novo.
        const second = cm.captureIfEligible(goal);
        await flush();
        assert(second.captured === false && second.reason === 'already_captured', 'segunda captura do mesmo goal.id é rejeitada antes de qualquer embedding');
        assert(control.calls.length === callsAfterFirstCapture, 'nenhuma chamada extra de embed() foi feita');
    }

    // ══════════ 7. Consulta com zero embeddings retorna vazio sem falhar ══════════
    console.log('\n=== S24.7 — findRelevantCasesShadow sem nenhum Caso no banco: retorna [] sem lançar ===');
    {
        const { cm } = freshCaseMemoryWithControl();
        const candidates = await cm.findRelevantCasesShadow('qualquer objetivo');
        assert(Array.isArray(candidates) && candidates.length === 0, 'retorna array vazio, sem exceção, quando não há Casos');
    }

    // ══════════ 8. Consulta com embeddings válidos retorna top-K ══════════
    console.log('\n=== S24.8 — findRelevantCasesShadow com múltiplos Casos retorna no máximo topK ===');
    {
        const { cm, control } = freshCaseMemoryWithControl();
        control.setMode('ok');
        for (let i = 0; i < 8; i++) {
            cm.captureIfEligible(makeGoal(`Objetivo numero ${i}`));
        }
        await flush();
        const candidates = await cm.findRelevantCasesShadow('Objetivo numero 1', 3);
        assert(candidates.length <= 3, `respeita topK=3 (obtido: ${candidates.length})`);
        assert(candidates.every((c, i) => i === 0 || c.score <= candidates[i - 1].score), 'candidatos vêm ordenados por score decrescente');
    }

    // ══════════ 9. Falha da consulta sombra não altera execução ══════════
    console.log('\n=== S24.9 — consulta sombra (agora findApplicableCasesShadow, S7) lançando erro é sempre .catch()-ado no ponto de chamada (fire-and-forget) ===');
    assert(
        /void this\.caseMemory\.findApplicableCasesShadow\(goal\.objective\)\.catch/.test(gelSrc),
        'chamada em GoalExecutionLoop continua fire-and-forget com .catch() — falha nunca propaga para executeGoal() ' +
        '(S7: redirecionada de findRelevantCasesShadow para findApplicableCasesShadow, que reaproveita a mesma busca internamente — ver S25)'
    );
    assert(
        /void this\.caseMemory\.backfillMissingEmbeddings\(\)\.catch/.test(gelSrc),
        'backfill também é fire-and-forget com .catch() — nunca bloqueia nem propaga erro para o goal'
    );

    // ══════════ 10. Zero influência comportamental (não regressão) ══════════
    console.log('\n=== S24.10 — Planner/RiskAnalyzer continuam sem qualquer referência a CaseMemory ===');
    assert(!plannerSrc.includes('CaseMemory'), 'GoalPlanner.ts inalterado nesta Sprint');
    assert(!riskSrc.includes('CaseMemory'), 'RiskAnalyzer.ts inalterado nesta Sprint');
    assert(caseMemorySrc.includes('backfillMissingEmbeddings'), 'backfillMissingEmbeddings existe em CaseMemory.ts');
    assert(!caseMemorySrc.includes('setInterval'), 'nenhum setInterval/scheduler novo foi criado — backfill é disparado pelo gatilho já existente (início de goal), não por um cron');

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S24 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    if (failed > 0) process.exit(1);
}

main().catch(err => { console.error('ERRO NÃO TRATADO:', err); process.exit(1); });
