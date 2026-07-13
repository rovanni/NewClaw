/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S111
 *
 * Piloto arquitetural especificado em docs/REVISAO_ARQUITETURAL_SPRINT_R7_2026-07-13.md
 * (fase de análise: R1 → R7, docs/AUDITORIA_PIPELINE_ARTEFATOS_SPRINT_R1_2026-07-13.md e
 * seguintes). Causa raiz original (R1 §5): `RiskAnalyzer` resolvia `file_path` de
 * `send_document` só por proximidade sintática com um `write` NO MESMO BATCH de steps sendo
 * revisado — se o `write` que produziu o arquivo aconteceu num CICLO ANTERIOR (típico de
 * replan), a busca não encontrava nada e desistia, mesmo com evidência real já persistida em
 * `goal.attempts`.
 *
 * Fix: `resolveArtifactPathFromEvidence()` (planning/artifactContract.ts) — quando a busca
 * sintática falha, resolve via evidência real: (1) `goal.attempts` com
 * `producedArtifactPaths`, filtrado por `inferExpectedExtensions` e ordenado por recência
 * (R6 — "mais recente" sozinho não bastava, precisa ser compatível com o deliverable
 * esperado); (2) fallback de leitura (nunca escrita) de `goal.sentArtifacts`, cobrindo o
 * caso em que o artefato foi produzido dentro de um step `agentloop` opaco sem pseudo-write
 * injetado (R7 §3/§7 — mesma classe de bug de project_session_bugs_jul2026_ak, emenda
 * explícita ao hard gate da Sprint R3, aprovada pelo usuário em 2026-07-13).
 *
 * Execução: npx ts-node src/__tests__/regression/S111_RiskAnalyzer_ReplanArtifactEvidence.test.ts
 */

import Database from 'better-sqlite3';
import { GoalStore } from '../../loop/GoalStore';
import { RiskAnalyzer } from '../../loop/RiskAnalyzer';
import { ToolRegistry } from '../../core/ToolRegistry';
import { Goal, PlanStep, GoalAttempt } from '../../loop/GoalTypes';
import { resolveArtifactPathFromEvidence } from '../../loop/planning/artifactContract';
import { ProviderFactory } from '../../core/ProviderFactory';
import { ReflectionMemory } from '../../memory/ReflectionMemory';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

function attempt(overrides: Partial<GoalAttempt> & { id: string }): GoalAttempt {
    return {
        planStepId: 'step_prev',
        toolName: 'exec_command',
        args: {},
        result: 'success',
        durationMs: 10,
        executedAt: Date.now(),
        ...overrides,
    };
}

async function main() {
// ── Parte 1: unidade — resolveArtifactPathFromEvidence() isolada, sem LLM/DB ──────────────

console.log('\n=== S111.1 — mais recente ENTRE OS COMPATÍVEIS, não simplesmente o mais recente (R6) ===');
{
    const goal = {
        userIntent: 'gerar uma apresentação de slides sobre segurança de redes',
        sentArtifacts: [],
        attempts: [
            attempt({ id: 'a1', executedAt: 1000, producedArtifactPaths: ['tmp/aula.pptx'] }),
            // mais recente que a1, mas extensão não compatível com o deliverable esperado (pptx)
            attempt({ id: 'a2', executedAt: 2000, producedArtifactPaths: ['tmp/rascunho_debug.png'] }),
        ],
    };
    const resolved = resolveArtifactPathFromEvidence(goal, 'enviar a apresentação final');
    assert(resolved === 'tmp/aula.pptx', 'escolheu o .pptx compatível, ignorando o .png mais recente porém incompatível', resolved);
}

console.log('\n=== S111.2 — fallback para sentArtifacts (leitura) quando goal.attempts não tem candidato — caso agentloop (R7) ===');
{
    const goal = {
        userIntent: 'gerar um relatório em pdf',
        sentArtifacts: ['tmp/relatorio_final.pdf'],
        attempts: [
            // único attempt é o step 'agentloop' opaco em si — sem producedArtifactPaths
            attempt({ id: 'a1', toolName: 'agentloop', producedArtifactPaths: undefined }),
        ],
    };
    const resolved = resolveArtifactPathFromEvidence(goal, 'enviar o relatório');
    assert(resolved === 'tmp/relatorio_final.pdf', 'resolveu via goal.sentArtifacts quando goal.attempts não tinha evidência direta', resolved);
}

console.log('\n=== S111.3 — sem NENHUMA evidência (attempts vazio, sentArtifacts vazio) → undefined, não adivinha ===');
{
    const goal = { userIntent: 'gerar um relatório em pdf', sentArtifacts: [], attempts: [] };
    const resolved = resolveArtifactPathFromEvidence(goal, 'enviar o relatório');
    assert(resolved === undefined, 'retornou undefined — comportamento permissivo original preservado (sem adivinhação às cegas)', resolved);
}

console.log('\n=== S111.4 — sem extensão esperada inferível → permissivo, pega o mais recente sem filtrar ===');
{
    const goal = {
        userIntent: 'faça uma coisa qualquer', // nenhuma keyword de tipo de arquivo
        sentArtifacts: [],
        attempts: [
            attempt({ id: 'a1', executedAt: 1000, producedArtifactPaths: ['tmp/x.txt'] }),
            attempt({ id: 'a2', executedAt: 2000, producedArtifactPaths: ['tmp/y.bin'] }),
        ],
    };
    const resolved = resolveArtifactPathFromEvidence(goal, '');
    assert(resolved === 'tmp/y.bin', 'sem extensão inferível, manteve comportamento permissivo (mais recente, sem filtro)', resolved);
}

console.log('\n=== S111.5 — caso-limite aceito (R6 §4): dois candidatos de MESMA extensão esperada → mais recente dos dois ===');
{
    const goal = {
        userIntent: 'gerar um relatório em pdf',
        sentArtifacts: [],
        attempts: [
            attempt({ id: 'a1', executedAt: 1000, producedArtifactPaths: ['tmp/relatorio_v1.pdf'] }),
            attempt({ id: 'a2', executedAt: 2000, producedArtifactPaths: ['tmp/relatorio_final.pdf'] }),
        ],
    };
    const resolved = resolveArtifactPathFromEvidence(goal, 'enviar o relatório');
    assert(
        resolved === 'tmp/relatorio_final.pdf',
        'ambiguidade de mesma extensão resolvida por recência (limite conhecido e aceito, não uma garantia de correção — R6 §4)',
        resolved
    );
}

// ── Parte 2: integração — RiskAnalyzer.analyze() com plano real via LLM mockado ────────────

console.log('\n=== S111.6 — RiskAnalyzer.analyze() end-to-end: send_document sem file_path + write em CICLO ANTERIOR (replan real) ===');
{
    ToolRegistry.register({
        name: 'send_document',
        description: 'test',
        parameters: {},
        execute: async () => ({ success: true, output: 'ok' }),
    });

    const db = new (Database as any)(':memory:');
    const goalStore = new GoalStore(db);
    const goal: Goal = goalStore.create({
        sessionKey: 'test:s111',
        conversationId: 'test-conv-s111',
        userIntent: 'gerar uma apresentação de slides sobre segurança de redes e enviar',
        objective: 'Gerar e enviar apresentação de slides',
        status: 'executing',
        currentPlan: [],
        // Evidência de um ciclo ANTERIOR — o write que gerou o artefato NÃO está no novo
        // batch de steps sendo revisado agora (é exatamente isso que a busca sintática antiga
        // não enxergava, forçando o replan a perder o rastro do arquivo já produzido).
        attempts: [attempt({ id: 'prev1', toolName: 'exec_command', executedAt: Date.now() - 60_000, producedArtifactPaths: ['tmp/aula_seguranca_redes.pptx'] })],
        blockers: [],
        toolsTried: [],
        strategiesTried: [],
        successCriteria: [],
        sentArtifacts: [],
        retryBudget: 3,
        replanBudget: 5,
        confidence: 0.9,
        requiresAuth: false,
        authorizationScope: [],
        expiresAt: Date.now() + 3_600_000,
    } as Omit<Goal, 'id' | 'createdAt' | 'updatedAt'>);

    // Plano do NOVO ciclo (pós-replan): só um send_document, sem file_path, sem write
    // precedente no mesmo batch — o cenário exato que a busca sintática original não resolvia.
    const newPlanFromLLM = [
        { id: 'step_send', description: 'Enviar a apresentação de slides pronta', toolName: 'send_document', toolArgs: {} },
    ];

    const fakeProviderFactory = {
        getProviderWithModel: () => ({
            chat: async () => ({ content: JSON.stringify({ risks: [], plan: newPlanFromLLM }) }),
        }),
    } as unknown as ProviderFactory;

    const fakeReflectionMemory = {
        findHardConstraints: () => [],
        findToolFailures: () => undefined,
    } as unknown as ReflectionMemory;

    const analyzer = new RiskAnalyzer(fakeProviderFactory, ToolRegistry, fakeReflectionMemory);
    const currentPlan: PlanStep[] = [{ id: 'step_send', description: 'Enviar a apresentação de slides pronta', toolName: 'send_document', toolArgs: {}, status: 'pending', fallbackSteps: [] }];
    const report = await analyzer.analyze(goal, currentPlan);

    const sendStep = report.adjustedPlan.find(s => s.toolName === 'send_document');
    assert(!!sendStep, 'plano ajustado contém o step send_document', report.adjustedPlan);
    assert(
        sendStep?.toolArgs?.['file_path'] === 'tmp/aula_seguranca_redes.pptx',
        'file_path resolvido via evidência de goal.attempts de um ciclo anterior — não mais perdido no replan',
        sendStep?.toolArgs
    );
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S111 RESULTADO: ${passed} passou | ${failed} falhou`);
if (failed > 0) process.exit(1);
}

main().catch(err => { console.error('ERRO NÃO TRATADO:', err); process.exit(1); });
