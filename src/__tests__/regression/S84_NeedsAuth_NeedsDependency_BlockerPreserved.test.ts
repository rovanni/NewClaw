/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S84 (Sprint 0.8, achados L02d/L12/L13 do ledger)
 *
 * Prova que `GoalExecutionLoop`, nos branches `needs_auth` (modo SAFE) e `needs_dependency`,
 * descarta o `blocker` já classificado por `GoalEvaluator.evaluate()` — o mesmo padrão de
 * perda já corrigido na Sprint 0.6 (Front B) para os branches `partial`/`failed`/deferred
 * `send_document`, mas nunca estendido a estes dois.
 *
 * Evidência de produção real que motivou este teste (Sprint 0.8, `newclaw-audit.log`):
 *   goal_1783215245583_ml39u — outcome=needs_dependency blocker=missing_tool (edge-tts
 *   ausente) — confirmado no banco real que `goal.blockers` não contém esse blocker.
 *
 * Também prova que `needs_auth` em modo auto-aprovado (DEVELOPER/GOD) NÃO deve registrar um
 * blocker `missing_permission` — nesse modo a tool roda normalmente, registrar um bloqueio
 * que não ocorreu seria factualmente incorreto (não é o mesmo bug, é o oposto: um falso
 * bloqueio no histórico).
 *
 * Execução: npx ts-node src/__tests__/regression/S84_NeedsAuth_NeedsDependency_BlockerPreserved.test.ts
 */

import Database from 'better-sqlite3';
import { GoalExecutionLoop } from '../../loop/GoalExecutionLoop';
import { GoalStore } from '../../loop/GoalStore';
import { ToolRegistry } from '../../core/ToolRegistry';
import { permissionRegistry } from '../../core/PermissionRegistry';
import { OperationalMode } from '../../core/CapabilityMode';
import { Goal, PlanStep, CycleResult } from '../../loop/GoalTypes';
import { ChannelContext } from '../../loop/agentLoopTypes';
import { KNOWN_DEPS } from '../../loop/GoalEvaluator';
import { CapabilityRegistry } from '../../core/CapabilityRegistry';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  OK ${message}`); passed++; }
    else { console.error(`  FALHOU: ${message}`, detail ?? ''); failed++; }
}

function emptyState(goalId: string): { cognitiveContext: unknown; progressModel: unknown } {
    return {
        cognitiveContext: { discoveries: [], failedStrategies: [], filesRead: [], filesModified: [], generatedArtifacts: [], executedCommands: [], importantOutputs: [] },
        progressModel: { goalId, components: [], overallPercent: 0, updatedAt: Date.now() },
    };
}

const AUTH_TOOL = 'exec_command'; // única forma de casar com ToolRegistry.isDangerous()
const DEP_TOOL = '__s84_dep_tool__';
ToolRegistry.register({
    name: AUTH_TOOL,
    description: 'test',
    parameters: {},
    execute: async () => ({ success: false, output: '', error: 'EACCES: permission denied' }),
}, { dangerous: true });

// Falha na 1ª chamada (dispara needs_dependency, igual ao goal real edge-tts), sucede na 2ª
// (o step de instalação injetado é reexecutado depois) — evita um 2º ciclo de falha que
// adicionaria um 2º blocker "missing_tool" pelo caminho 'blocked'/'failed' (já corrigido na
// Sprint 0.6), o que mascararia se o branch 'needs_dependency' específico preserva o dele.
let depToolCalls = 0;
ToolRegistry.register({
    name: DEP_TOOL,
    description: 'test',
    parameters: {},
    execute: async () => {
        depToolCalls++;
        // "spawn pandoc ENOENT" casa com extractMissingExecutable() E com o padrão missing_tool
        // do GoalEvaluator; "pandoc" está em KNOWN_DEPS — reproduz o padrão real do log (edge-tts).
        if (depToolCalls === 1) return { success: false, output: '', error: 'spawn pandoc ENOENT' };
        return { success: true, output: 'Documento convertido com sucesso.' };
    },
});

function makeFakeProviderFactory() {
    return {
        chatWithFallback: async () => ({ status: 'success', content: JSON.stringify({ achieved: true, summary: 'teste S84' }) }),
        getProvider: () => undefined,
        getProviderWithModel: () => ({ chat: async () => ({ status: 'success', content: JSON.stringify({ achieved: true, summary: 'teste S84' }) }) }),
    } as unknown as import('../../core/ProviderFactory').ProviderFactory;
}

// Usado apenas pelo caminho 'agentloop' (steps sem toolName — ex.: o step de instalação
// manual injetado por needs_dependency quando não há comando automático seguro para o SO,
// o caso real observado no log de produção para edge-tts). Resposta com sinal de sucesso
// explícito ("concluída") evita escalonar para LLM — mantém o teste focado no que importa.
const fakeAgentLoop = { process: async () => 'Instalação concluída manualmente (simulado).', clearActiveTurn: () => {} } as any;

function makeLoop() {
    const db = new (Database as any)(':memory:');
    const goalStore = new GoalStore(db);
    const fakeMemory = { getDatabase: () => db } as any;
    const fakePlanner = { getAvailableSkills: () => [], setSkillContext: () => {}, setModel: () => {}, replan: async () => ({ steps: [], strategy: 'n/a' }) } as any;
    const loop = new GoalExecutionLoop(
        fakeAgentLoop, goalStore, fakePlanner,
        { record: () => {}, buildContextHint: () => '', findHardConstraints: () => [] } as any,
        ToolRegistry, makeFakeProviderFactory(), fakeMemory,
        { findApplicableCasesShadow: async () => [], backfillMissingEmbeddings: async () => {}, captureIfEligible: () => {}, findSimilarShadow: () => [] } as any,
    );
    return { loop, goalStore };
}

function makeGoal(store: GoalStore, overrides: Partial<Goal> & { currentPlan: PlanStep[] }): Goal {
    return store.create({
        sessionKey: 'test:s84', conversationId: 'test-conv-s84',
        userIntent: 'objetivo de teste S84', objective: 'Objetivo de teste S84',
        status: 'executing', attempts: [], blockers: [], toolsTried: [], strategiesTried: [],
        successCriteria: [], sentArtifacts: [], retryBudget: 3, replanBudget: 5, confidence: 0.9,
        requiresAuth: false, authorizationScope: [], expiresAt: Date.now() + 3_600_000,
        ...overrides,
    } as Omit<Goal, 'id' | 'createdAt' | 'updatedAt'>);
}

const channelContext: ChannelContext = { channel: 'test', chatId: 'test-user' };

async function main() {
    console.log('\n=== S84.1 — needs_auth em modo SAFE: blocker "missing_permission" preservado ===');
    {
        permissionRegistry.setMode(OperationalMode.SAFE, 'test-s84');
        const { loop, goalStore } = makeLoop();
        const goal = makeGoal(goalStore, {
            currentPlan: [{ id: 'stepAuth', description: 'Executar comando perigoso', toolName: AUTH_TOOL, toolArgs: { command: 'echo x' }, status: 'pending', fallbackSteps: [] }],
        });
        const state = emptyState(goal.id) as any;
        await (loop as any).runLoopInternal(goal, channelContext, undefined, 0, 0, undefined, state);
        const stored = goalStore.getById(goal.id)!;
        assert(stored.status === 'blocked', 'goal.status === "blocked" (aguardando autorização)', stored.status);
        assert(
            stored.blockers.some(b => b.kind === 'missing_permission'),
            'goal.blockers contém o blocker "missing_permission" (ANTES da correção: sempre vazio neste branch)',
            stored.blockers
        );
    }

    console.log('\n=== S84.2 — needs_auth em modo auto-aprovado (DEVELOPER): NENHUM blocker espúrio ===');
    {
        permissionRegistry.setMode(OperationalMode.DEVELOPER, 'test-s84', true);
        const { loop, goalStore } = makeLoop();
        const goal = makeGoal(goalStore, {
            currentPlan: [{ id: 'stepAuth2', description: 'Executar comando perigoso', toolName: AUTH_TOOL, toolArgs: { command: 'echo x' }, status: 'pending', fallbackSteps: [] }],
            replanBudget: 0,
        });
        const state = emptyState(goal.id) as any;
        await (loop as any).runLoopInternal(goal, channelContext, undefined, 0, 0, undefined, state);
        const stored = goalStore.getById(goal.id)!;
        assert(
            !stored.blockers.some(b => b.kind === 'missing_permission'),
            'goal.blockers NÃO contém "missing_permission" em modo auto-aprovado — a tool não foi de fato bloqueada, registrar um blocker aqui seria factualmente incorreto',
            stored.blockers
        );
        permissionRegistry.setMode(OperationalMode.SAFE, 'test-s84-restore');
    }

    console.log('\n=== S84.3 — needs_dependency: blocker "missing_tool" preservado (reproduz goal_...ml39u real) ===');
    {
        const { loop, goalStore } = makeLoop();
        const goal = makeGoal(goalStore, {
            currentPlan: [{ id: 'stepDep', description: 'Converter documento', toolName: DEP_TOOL, toolArgs: {}, status: 'pending', fallbackSteps: [] }],
        });
        const state = emptyState(goal.id) as any;
        await (loop as any).runLoopInternal(goal, channelContext, undefined, 0, 0, undefined, state);
        const stored = goalStore.getById(goal.id)!;
        assert(
            stored.blockers.some(b => b.kind === 'missing_tool'),
            'goal.blockers contém o blocker "missing_tool" (ANTES da correção: sempre vazio neste branch — mesmo padrão do goal real goal_1783215245583_ml39u, edge-tts ausente)',
            stored.blockers
        );
    }

    console.log('\n=== S84.4 — RFC-003 Sprint D: verifyCmd injeta step de verificação (planejamento apenas) ===');
    {
        // handleNeedsDependencyOutcome() só reconstrói o plano (goalStore.update), nunca executa
        // nenhum step — chamado direto (mesmo padrão já usado nesta suíte para runLoopInternal),
        // é seguro mesmo com autoInstall=true: nenhum comando real dispara aqui, só o
        // PLANEJAMENTO do step é verificado.
        //
        // DependencyInfo SINTÉTICO de propósito, não KNOWN_DEPS['ffmpeg'] real: hoje 'ffmpeg' só
        // tem manualInstructions multi-SO (texto), NÃO tem installByPlatform.windows — decisão
        // consciente e já discutida nesta sessão (usuário optou por não habilitar auto-instalação
        // via winget ainda). resolveInstallCommand() corretamente devolve undefined pra ele nesta
        // máquina, então autoInstall nunca fica true com a entrada real — o que é o comportamento
        // CORRETO do catálogo hoje, não um bug deste teste. Testar o MECANISMO de injeção do
        // verify step exige uma entrada sintética com installByPlatform preenchido; a existência
        // de KNOWN_DEPS['ffmpeg'].verifyCmd em si já é conferida separadamente (S141).
        permissionRegistry.setMode(OperationalMode.DEVELOPER, 'test-s84-4', true);
        try {
            // resolveInstallCommand() precisa do SO real já probado (getOSSync() só devolve
            // dado depois de uma passada async) — mesmo padrão de priming já usado em S35.
            await CapabilityRegistry.getInstance().getCapabilitySummary();
            const platform = CapabilityRegistry.getInstance().getOSSync()?.platform;
            assert(!!platform, 'pré-requisito: CapabilityRegistry resolveu o SO real', platform);

            const syntheticDep = {
                name: 'ferramenta-sintetica-s84',
                installByPlatform: { [platform!]: 'echo instalando-ferramenta-sintetica' },
                manualInstructions: 'instrução manual de teste',
                verifyCmd: 'ferramenta-sintetica-s84 --version',
                type: 'system' as const,
            };

            const { loop, goalStore } = makeLoop();
            const goal = makeGoal(goalStore, {
                currentPlan: [{ id: 'stepSintetico', description: 'Usar ferramenta sintética', toolName: DEP_TOOL, toolArgs: {}, status: 'pending', fallbackSteps: [] }],
            });
            const step = goal.currentPlan[0];
            const cycleResult: CycleResult = {
                outcome: 'needs_dependency',
                confidence: 0.8,
                blocker: {
                    kind: 'missing_tool',
                    toolName: DEP_TOOL,
                    missingDependency: syntheticDep.name,
                    description: `Binário '${syntheticDep.name}' não encontrado`,
                    suggestedActions: [],
                    detectedAt: Date.now(),
                },
                depInfo: syntheticDep,
            };
            const result = await (loop as any).handleNeedsDependencyOutcome(goal, step, cycleResult, 0, 0, undefined, undefined);
            const verifyStep = (result.goal.currentPlan as PlanStep[]).find(s => s.id.startsWith('verify_'));
            assert(!!verifyStep, 'plano reconstruído contém um step com id prefixado "verify_"', result.goal.currentPlan);
            assert(verifyStep?.toolArgs?.command === syntheticDep.verifyCmd, `verify step usa exatamente o verifyCmd declarado ("${syntheticDep.verifyCmd}")`, verifyStep);
            const installIdx = (result.goal.currentPlan as PlanStep[]).findIndex(s => s.id.startsWith('install_'));
            const verifyIdx = (result.goal.currentPlan as PlanStep[]).findIndex(s => s.id.startsWith('verify_'));
            const origIdx = (result.goal.currentPlan as PlanStep[]).findIndex(s => s.id === 'stepSintetico');
            assert(installIdx < verifyIdx && verifyIdx < origIdx, 'ordem no plano: install → verify → step original', result.goal.currentPlan);
        } finally {
            permissionRegistry.setMode(OperationalMode.SAFE, 'test-s84-4-restore');
        }
    }

    console.log('\n=== S84.5 — autoInstall=true SEM verifyCmd declarado: nenhum step de verificação é injetado ===');
    {
        // Isola a variável: mesmo com autoInstall=true (installByPlatform preenchido), sem
        // verifyCmd nenhum step novo é injetado — comportamento idêntico ao anterior a esta
        // Sprint. É o caso real de 19 das ~20 entradas de KNOWN_DEPS hoje (ex.: pandoc), que
        // não têm verifyCmd declarado (Nunca Adivinhar: não populado sem evidência própria).
        permissionRegistry.setMode(OperationalMode.DEVELOPER, 'test-s84-5', true);
        try {
            await CapabilityRegistry.getInstance().getCapabilitySummary();
            const platform = CapabilityRegistry.getInstance().getOSSync()?.platform;
            const syntheticDepSemVerify = {
                name: 'outra-ferramenta-sintetica-s84',
                installByPlatform: { [platform!]: 'echo instalando-outra-ferramenta' },
                manualInstructions: 'instrução manual de teste',
                // verifyCmd deliberadamente ausente
                type: 'system' as const,
            };
            const { loop, goalStore } = makeLoop();
            const goal = makeGoal(goalStore, {
                currentPlan: [{ id: 'stepSemVerify', description: 'Usar outra ferramenta sintética', toolName: DEP_TOOL, toolArgs: {}, status: 'pending', fallbackSteps: [] }],
            });
            const step = goal.currentPlan[0];
            const cycleResult: CycleResult = {
                outcome: 'needs_dependency',
                confidence: 0.8,
                blocker: {
                    kind: 'missing_tool',
                    toolName: DEP_TOOL,
                    missingDependency: syntheticDepSemVerify.name,
                    description: `Binário '${syntheticDepSemVerify.name}' não encontrado`,
                    suggestedActions: [],
                    detectedAt: Date.now(),
                },
                depInfo: syntheticDepSemVerify,
            };
            const result = await (loop as any).handleNeedsDependencyOutcome(goal, step, cycleResult, 0, 0, undefined, undefined);
            const installStep = (result.goal.currentPlan as PlanStep[]).find(s => s.id.startsWith('install_'));
            assert(installStep?.toolName === 'exec_command', 'pré-requisito: autoInstall ficou true (installStep virou exec_command real)', installStep);
            const verifyStep = (result.goal.currentPlan as PlanStep[]).find(s => s.id.startsWith('verify_'));
            assert(!verifyStep, 'sem verifyCmd declarado, nenhum step de verificação é injetado mesmo com autoInstall=true', result.goal.currentPlan);
        } finally {
            permissionRegistry.setMode(OperationalMode.SAFE, 'test-s84-5-restore');
        }
    }

    console.log('\n=== S84.6 — dado real: KNOWN_DEPS["ffmpeg"].verifyCmd está populado; as demais entradas não ===');
    {
        assert(KNOWN_DEPS['ffmpeg'].verifyCmd === 'ffmpeg -version', 'KNOWN_DEPS["ffmpeg"].verifyCmd é exatamente "ffmpeg -version"', KNOWN_DEPS['ffmpeg'].verifyCmd);
        const entriesWithVerifyCmd = Object.entries(KNOWN_DEPS).filter(([, dep]) => dep.verifyCmd);
        assert(
            entriesWithVerifyCmd.length === 1 && entriesWithVerifyCmd[0][0] === 'ffmpeg',
            'ffmpeg é a ÚNICA entrada de KNOWN_DEPS com verifyCmd nesta Sprint — as demais ficam sem, de propósito (Nunca Adivinhar)',
            entriesWithVerifyCmd.map(([k]) => k)
        );
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S84 RESULTADO: ${passed} passou | ${failed} falhou`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => { console.error('ERRO NÃO TRATADO:', err); process.exit(1); });
