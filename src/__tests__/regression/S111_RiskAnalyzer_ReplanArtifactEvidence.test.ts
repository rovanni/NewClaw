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

console.log('\n=== S111.6 — achado ao vivo (13/07): extensão literal no texto (.txt sem keyword dedicada) vence script-fonte mais recente ===');
{
    // Réplica exata do bug encontrado na validação end-to-end: descrição menciona "planetas.txt"
    // literalmente (sem nenhuma keyword de inferExpectedExtensions cobrir .txt), e existe um
    // .py mais recente no goal.attempts (o script que gerou o .txt). Antes do fix, .txt não
    // entrava em expectedExts, o filtro virava permissivo, e o .py (mais recente) vencia —
    // exatamente a classe de bug que o teste S27 cobria em outro call site.
    const goal = {
        userIntent: 'Crie um script Python que gere um arquivo texto tmp/planetas.txt e me envie',
        sentArtifacts: [],
        attempts: [
            attempt({ id: 'a1', toolName: 'write', executedAt: 1000, producedArtifactPaths: ['gerar_planetas.py'] }),
            attempt({ id: 'a2', toolName: 'exec_command', executedAt: 2000, producedArtifactPaths: ['tmp/planetas.txt'] }),
        ],
    };
    const resolved = resolveArtifactPathFromEvidence(goal, 'Envia o arquivo planetas.txt gerado para o usuário');
    assert(resolved === 'tmp/planetas.txt', 'resolveu para o .txt (extensão literal do texto), não o .py mais recente', resolved);
}

console.log('\n=== S111.7 — sem NENHUM candidato exceto um script-fonte → undefined, nunca envia o script por padrão ===');
{
    // Caso mais estrito que o S111.6: nem sequer existe um .txt no goal.attempts ainda (só o
    // script foi escrito, exec_command ainda não rodou). Mesmo com filtro permissivo (nenhuma
    // extensão esperada inferível do texto), um .py NUNCA deve ser o fallback silencioso.
    const goal = {
        userIntent: 'gerar um arquivo com a lista de planetas',
        sentArtifacts: [],
        attempts: [
            attempt({ id: 'a1', toolName: 'write', executedAt: 1000, producedArtifactPaths: ['gerar_planetas.py'] }),
        ],
    };
    const resolved = resolveArtifactPathFromEvidence(goal, 'enviar o arquivo gerado para o usuário');
    assert(resolved === undefined, 'não escolheu o script-fonte como fallback — retornou undefined (cai para agentloop)', resolved);
}

console.log('\n=== S111.8 — bloqueio de script é INCONDICIONAL, mesmo quando o nome do script é citado literalmente na description ===');
{
    // A description de um step de exec_command tipicamente cita o nome do script que está
    // rodando (ex.: "executar gerar_planetas.py") — se isso "qualificasse" .py em expectedExts,
    // a mesma brecha do bug ao vivo reabriria por outro caminho. Bloqueio precisa ser
    // incondicional: pedido explícito pelo script cai para o fallback normal (AgentLoop), não
    // por resolveArtifactPathFromEvidence.
    const goal = {
        userIntent: 'gerar lista de planetas',
        sentArtifacts: [],
        attempts: [
            attempt({ id: 'a1', toolName: 'write', executedAt: 1000, producedArtifactPaths: ['gerar_planetas.py'] }),
        ],
    };
    const resolved = resolveArtifactPathFromEvidence(goal, 'executar o script gerar_planetas.py');
    assert(resolved === undefined, 'script nunca é retornado por aqui, mesmo citado literalmente na description do step', resolved);
}

console.log('\n=== S111.9a — .js/.ts NÃO são bloqueados como script-fonte — fonte única com AgentLoop.DELIVERABLE_EXTENSIONS ===');
{
    // Achado da revisão de código (Sprint F2): a lista anterior de SOURCE_SCRIPT_EXTENSIONS
    // incluía '.js'/'.ts', contradizendo AgentLoop.ts, que já trata esses dois como deliverable
    // legítimo (DELIVERABLE_EXTENSIONS), não como script-fonte. Um .js gerado (ex: widget web)
    // precisa continuar elegível aqui.
    const goal = {
        userIntent: 'gerar um widget em javascript',
        sentArtifacts: [],
        attempts: [attempt({ id: 'a1', toolName: 'write', executedAt: 1000, producedArtifactPaths: ['widget.js'] })],
    };
    const resolved = resolveArtifactPathFromEvidence(goal, 'enviar o widget gerado');
    assert(resolved === 'widget.js', '.js não é tratado como script-fonte — permanece candidato válido', resolved);
}

console.log('\n=== S111.9b — attempts com result=\'partial\' NÃO contam como evidência confiável ===');
{
    // GoalStore.downgradeLastAttemptToPartial rebaixa um attempt pra 'partial' quando o
    // SemanticValidator julga o output irrelevante ao objetivo — producedArtifactPaths fica
    // intacto, mas não deve ser tratado como evidência plenamente válida.
    const goal = {
        userIntent: 'gerar um relatório em pdf',
        sentArtifacts: [],
        attempts: [attempt({ id: 'a1', result: 'partial', executedAt: 1000, producedArtifactPaths: ['tmp/relatorio_duvidoso.pdf'] })],
    };
    const resolved = resolveArtifactPathFromEvidence(goal, 'enviar o relatório');
    assert(resolved === undefined, 'attempt \'partial\' não foi aceito como evidência — retornou undefined', resolved);
}

console.log('\n=== S111.9c — stepDescription genérica combina com goal.userIntent, não ignora suas keywords ===');
{
    // Antes: inferExpectedExtensions(stepDescription || goal.userIntent) só consultava userIntent
    // quando stepDescription era vazia. Uma description genérica ("Enviar o arquivo gerado",
    // sem keyword) fazia o filtro virar permissivo mesmo com userIntent dizendo "apresentação
    // de slides" (que inferiria .pptx).
    const goal = {
        userIntent: 'gerar uma apresentação de slides sobre o tema',
        sentArtifacts: [],
        attempts: [
            attempt({ id: 'a1', executedAt: 1000, producedArtifactPaths: ['tmp/aula.pptx'] }),
            attempt({ id: 'a2', executedAt: 2000, producedArtifactPaths: ['tmp/rascunho.png'] }), // mais recente, mas não é o tipo pedido
        ],
    };
    const resolved = resolveArtifactPathFromEvidence(goal, 'Enviar o arquivo gerado ao usuário'); // description genérica, sem keyword
    assert(resolved === 'tmp/aula.pptx', 'combinou description+userIntent — extensão .pptx do userIntent não foi ignorada', resolved);
}

// ── Parte 2: integração — RiskAnalyzer.analyze() com plano real via LLM mockado ────────────

console.log('\n=== S111.9 — RiskAnalyzer.analyze() end-to-end: send_document sem file_path + write em CICLO ANTERIOR (replan real) ===');
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

console.log('\n=== S111.10 — CR#3 não fica diluída: send_document consertado NÃO isenta outro step genuinamente quebrado ===');
{
    // Achado da revisão de código pós-piloto (Sprint F1): mover CR#3 pra depois da correção de
    // file_path (S111.9) não pode fazer com que consertar send_document "empreste" crédito de
    // validade pro plano inteiro — um 'read' sem 'path' no mesmo batch, que nada aqui conserta,
    // precisa continuar contando como inválido e derrubar o plano (2 steps, 1 genuinamente
    // quebrado = 100% dos NÃO-consertados = ainda rejeita).
    ToolRegistry.register({ name: 'read', description: 'test', parameters: {}, execute: async () => ({ success: true, output: '' }) });

    const db = new (Database as any)(':memory:');
    const goalStore = new GoalStore(db);
    const goal: Goal = goalStore.create({
        sessionKey: 'test:s111-cr3',
        conversationId: 'test-conv-s111-cr3',
        userIntent: 'gerar uma apresentação de slides e enviar',
        objective: 'Gerar e enviar apresentação de slides',
        status: 'executing',
        currentPlan: [],
        attempts: [attempt({ id: 'prev1', toolName: 'exec_command', executedAt: Date.now() - 60_000, producedArtifactPaths: ['tmp/aula.pptx'] })],
        blockers: [], toolsTried: [], strategiesTried: [], successCriteria: [], sentArtifacts: [],
        retryBudget: 3, replanBudget: 5, confidence: 0.9, requiresAuth: false, authorizationScope: [],
        expiresAt: Date.now() + 3_600_000,
    } as Omit<Goal, 'id' | 'createdAt' | 'updatedAt'>);

    const newPlanFromLLM = [
        { id: 'step_send', description: 'Enviar a apresentação pronta', toolName: 'send_document', toolArgs: {} },
        { id: 'step_read', description: 'Ler configuração', toolName: 'read', toolArgs: {} }, // sem 'path' — genuinamente inválido, nada conserta isso
    ];
    const fakeProviderFactory = {
        getProviderWithModel: () => ({ chat: async () => ({ content: JSON.stringify({ risks: [], plan: newPlanFromLLM }) }) }),
    } as unknown as ProviderFactory;
    const fakeReflectionMemory = { findHardConstraints: () => [], findToolFailures: () => undefined } as unknown as ReflectionMemory;
    const analyzer = new RiskAnalyzer(fakeProviderFactory, ToolRegistry, fakeReflectionMemory);
    const currentPlan: PlanStep[] = [
        { id: 'step_send', description: 'Enviar a apresentação pronta', toolName: 'send_document', toolArgs: {}, status: 'pending', fallbackSteps: [] },
        { id: 'step_read', description: 'Ler configuração', toolName: 'read', toolArgs: {}, status: 'pending', fallbackSteps: [] },
    ];
    const report = await analyzer.analyze(goal, currentPlan);

    assert(
        report.planRejected === true,
        'plano rejeitado: o read genuinamente quebrado não foi mascarado pelo send_document consertado',
        report
    );
}

console.log('\n=== S111.11 — planAdjusted não dispara por ordem de chaves diferente em toolArgs com mesmo valor ===');
{
    ToolRegistry.register({ name: 'write', description: 'test', parameters: {}, execute: async () => ({ success: true, output: '' }) });

    const db = new (Database as any)(':memory:');
    const goalStore = new GoalStore(db);
    const goal: Goal = goalStore.create({
        sessionKey: 'test:s111-order', conversationId: 'test-conv-s111-order',
        userIntent: 'escrever um arquivo', objective: 'Escrever um arquivo',
        status: 'executing', currentPlan: [], attempts: [], blockers: [], toolsTried: [], strategiesTried: [],
        successCriteria: [], sentArtifacts: [], retryBudget: 3, replanBudget: 5, confidence: 0.9,
        requiresAuth: false, authorizationScope: [], expiresAt: Date.now() + 3_600_000,
    } as Omit<Goal, 'id' | 'createdAt' | 'updatedAt'>);

    // Mesmos valores, ordem de chaves INVERTIDA em relação ao currentPlan — semanticamente idêntico.
    const newPlanFromLLM = [
        { id: 'step_1', description: 'Escrever nota', toolName: 'write', toolArgs: { content: 'ola mundo', path: 'nota.txt' } },
    ];
    const fakeProviderFactory = {
        getProviderWithModel: () => ({ chat: async () => ({ content: JSON.stringify({ risks: [], plan: newPlanFromLLM }) }) }),
    } as unknown as ProviderFactory;
    const fakeReflectionMemory = { findHardConstraints: () => [], findToolFailures: () => undefined } as unknown as ReflectionMemory;
    // Isola o teste do classificador de content-stub (que faria uma 2ª chamada LLM real via
    // fakeProviderFactory, não relacionada ao que este teste verifica) — sempre "não é stub".
    const fakeClassifyContentStub = async () => ({ isStub: false, reason: 'test' });
    const analyzer = new RiskAnalyzer(fakeProviderFactory, ToolRegistry, fakeReflectionMemory, fakeClassifyContentStub);
    const currentPlan: PlanStep[] = [
        { id: 'step_1', description: 'Escrever nota', toolName: 'write', toolArgs: { path: 'nota.txt', content: 'ola mundo' }, status: 'pending', fallbackSteps: [] },
    ];
    const report = await analyzer.analyze(goal, currentPlan);

    assert(
        report.planAdjusted === false,
        'planAdjusted permaneceu false — mesmos valores em ordem de chaves diferente não contam como mudança',
        report
    );
    assert(
        report.adjustedPlan[0]?.toolArgs === currentPlan[0].toolArgs,
        'adjustedPlan devolveu o plano ORIGINAL (mesma referência de objeto), não uma reconstrução desnecessária do LLM de risco',
        report.adjustedPlan[0]?.toolArgs
    );
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S111 RESULTADO: ${passed} passou | ${failed} falhou`);
if (failed > 0) process.exit(1);
}

main().catch(err => { console.error('ERRO NÃO TRATADO:', err); process.exit(1); });
