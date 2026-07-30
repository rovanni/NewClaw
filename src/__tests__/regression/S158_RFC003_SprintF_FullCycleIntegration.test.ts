/// <reference types="node" />
/**
 * TESTE DE INTEGRAÇÃO — S158 (RFC-003 Sprint F — Integração,
 * `docs/decisoes/RFC-003_AQUISICAO_CONHECIMENTO_OPERACIONAL.md`)
 *
 * Sprints A-E (Infra, Pesquisa/Reutilização, Validação, Modelo de Confiança) foram implementadas
 * e testadas em ISOLAMENTO: S141 testa `GoalEvaluator` instanciado standalone
 * (`new GoalEvaluator(operationalKnowledge)`), S84.4/S84.5 testam `handleNeedsDependencyOutcome()`
 * chamado direto (sem passar por `evaluate()` real), S142/S143 testam `OperationalKnowledge`
 * isolada ou só integrada com `GoalPlanner`. Nenhum teste existente até aqui roda
 * `GoalExecutionLoop` + o `GoalEvaluator` que ELE MESMO constrói internamente (linha do
 * construtor: `this.evaluator = new GoalEvaluator(operationalKnowledge)`) + `OperationalKnowledge`
 * como uma única instância compartilhada, dirigida por `runLoopInternal()` de ponta a ponta —
 * exatamente o que a Sprint F pede ("cada etapa realmente é exercitada... nenhuma etapa ficou
 * isolada").
 *
 * Reutiliza a infraestrutura já estabelecida por S84/S89/S123 (`makeLoop()`, `chatWithFallback`
 * devolvendo `{achieved:true}` para validar o goal como concluído) — estendida aqui só para
 * aceitar `operationalKnowledge` e um `replan()` controlável por cenário.
 *
 * ACHADO DESTA SPRINT (S158.1): o ciclo "Pesquisa" (Sprint C, 2ª metade — dependência
 * desconhecida por KNOWN_DEPS E por OperationalKnowledge, outcome=`blocked` com sugestão de
 * `web_search`/`web_navigate`) NUNCA alimenta `OperationalKnowledge`, mesmo quando o replan
 * subsequente (LLM/Planner) resolve o problema com sucesso real. Causa raiz:
 * `OperationalKnowledge.captureFromGoal()` (Sprint D) só credita aprendizado quando existe um
 * attempt com `planStepId` prefixado `'verify_'` — e esse prefixo só é gerado por
 * `GoalExecutionLoop.handleNeedsDependencyOutcome()`, exclusivo do outcome `needs_dependency`
 * (caminho determinístico). O outcome `blocked` (Pesquisa) nunca passa por esse método — o plano
 * que resolve o problema vem inteiro do `GoalPlanner.replan()`, com ids de step arbitrários
 * (`sanitizePlanSteps.ts`: `s.id ?? step_N`), nunca `verify_*` a menos que o próprio LLM decida
 * nomear assim, o que nada no prompt hoje instrui. Resultado prático: o conhecimento que a
 * Sprint C foi desenhada para primeiro ADQUIRIR (dependências fora de KNOWN_DEPS) nunca chega a
 * "Reutilização futura" — só chega lá conhecimento que já tinha uma entrada distribuída completa
 * (installByPlatform + verifyCmd), categoria que hoje não existe em KNOWN_DEPS de forma real (só
 * `ffmpeg` tem verifyCmd, e só resolve via fallback `installCmd` legado em Linux — nunca em
 * Windows/macOS, ver comentário de KNOWN_DEPS em GoalEvaluator.ts). Isto NÃO é corrigido nesta
 * Sprint: fechar essa lacuna exigiria decidir COMO um plano gerado por LLM/Pesquisa sinaliza "este
 * step é a verificação objetiva" — uma extensão do contrato entre `GoalPlanner`/prompt e
 * `OperationalKnowledge`, portanto uma decisão de responsabilidade (RFC-003 restringe
 * explicitamente a Sprint F: "não introduzir novas arquiteturas", "qualquer ideia... deve virar
 * futura ADR/RFC"). Registrado aqui como teste que documenta o comportamento ATUAL (não o
 * desejado) — se alguém "corrigir" isto sem uma ADR/RFC, este teste será o primeiro a acusar a
 * mudança de responsabilidade não planejada.
 *
 * Execução: npx ts-node src/__tests__/regression/S158_RFC003_SprintF_FullCycleIntegration.test.ts
 */

import Database from 'better-sqlite3';
import { GoalExecutionLoop } from '../../loop/GoalExecutionLoop';
import { GoalStore } from '../../loop/GoalStore';
import { ToolRegistry } from '../../core/ToolRegistry';
import { permissionRegistry } from '../../core/PermissionRegistry';
import { OperationalMode } from '../../core/CapabilityMode';
import { CapabilityRegistry } from '../../core/CapabilityRegistry';
import { OperationalKnowledge } from '../../memory/OperationalKnowledge';
import { KNOWN_DEPS } from '../../loop/GoalEvaluator';
import { Goal, PlanStep, DependencyInfo } from '../../loop/GoalTypes';
import { ChannelContext } from '../../loop/agentLoopTypes';

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

function makeFakeProviderFactory() {
    return {
        chatWithFallback: async () => ({ status: 'success', content: JSON.stringify({ achieved: true, summary: 'teste S158' }) }),
        getProvider: () => undefined,
        getProviderWithModel: () => ({ chat: async () => ({ status: 'success', content: JSON.stringify({ achieved: true, summary: 'teste S158' }) }) }),
    } as unknown as import('../../core/ProviderFactory').ProviderFactory;
}

type ReplanFn = () => Promise<{ steps: PlanStep[]; strategy: string }>;

/** Mesmo padrão de makeLoop() já usado em S84/S89/S123 — estendido só para aceitar
 *  operationalKnowledge (9º parâmetro do construtor real) e um replan() controlável. */
function makeLoop(operationalKnowledge?: OperationalKnowledge, replanImpl?: ReplanFn) {
    const db = new (Database as any)(':memory:');
    const goalStore = new GoalStore(db);
    const fakeMemory = { getDatabase: () => db, semanticSearch: async () => [] } as any;
    const fakePlanner = {
        getAvailableSkills: () => [], setSkillContext: () => {}, setModel: () => {},
        replan: replanImpl ?? (async () => ({ steps: [], strategy: 'n/a' })),
    } as any;
    const fakeAgentLoop = { process: async () => 'não deveria ser chamado neste teste' } as any;
    const loop = new GoalExecutionLoop(
        fakeAgentLoop, goalStore, fakePlanner,
        { record: () => {}, buildContextHint: () => '', findHardConstraints: () => [], findToolFailures: () => '' } as any,
        ToolRegistry, makeFakeProviderFactory(), fakeMemory,
        { findApplicableCasesShadow: async () => [], backfillMissingEmbeddings: async () => {}, captureIfEligible: () => {}, findSimilarShadow: () => [] } as any,
        operationalKnowledge,
    );
    return { loop, goalStore };
}

function makeGoal(store: GoalStore, currentPlan: PlanStep[], overrides: Partial<Goal> = {}): Goal {
    return store.create({
        sessionKey: 'test:s158', conversationId: `test-conv-s158-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        userIntent: 'objetivo de teste S158', objective: 'Objetivo de teste S158',
        status: 'executing', attempts: [], blockers: [], toolsTried: [], strategiesTried: [],
        successCriteria: [], sentArtifacts: [], retryBudget: 3, replanBudget: 5, confidence: 0.9,
        requiresAuth: false, authorizationScope: [], expiresAt: Date.now() + 3_600_000,
        currentPlan,
        ...overrides,
    } as Omit<Goal, 'id' | 'createdAt' | 'updatedAt'>);
}

function freshOperationalKnowledge(): OperationalKnowledge {
    const db = new (Database as any)(':memory:');
    return new OperationalKnowledge({ getDatabase: () => db } as any);
}

const channelContext: ChannelContext = { channel: 'test', chatId: 'test-user' };

async function main() {
    console.log('\n=== S158 — RFC-003 Sprint F: integração de ponta a ponta (GoalEvaluator + GoalExecutionLoop + OperationalKnowledge, wiring real) ===');

    console.log('\n--- S158.1 — Pesquisa sugerida para dependência totalmente desconhecida; sucesso subsequente NÃO é capturado (achado desta Sprint) ---');
    {
        const SYNTH_DEP = 'ferramenta-pesquisa-s158';
        const DEP_TOOL = '__s158_pesquisa_tool__';
        let calls = 0;
        ToolRegistry.register({
            name: DEP_TOOL, description: 'test', parameters: {},
            execute: async () => {
                calls++;
                if (calls === 1) return { success: false, output: '', error: `spawn ${SYNTH_DEP} ENOENT` };
                return { success: true, output: 'instalado via comando pesquisado' };
            },
        });

        permissionRegistry.setMode(OperationalMode.DEVELOPER, 'test-s158-1', true);
        try {
            const ok = freshOperationalKnowledge();
            const replanImpl: ReplanFn = async () => ({
                steps: [{
                    id: 'pesquisado_1',
                    description: 'Instalar via comando encontrado na documentação oficial (pesquisa)',
                    toolName: DEP_TOOL, toolArgs: {}, status: 'pending', fallbackSteps: [],
                }],
                strategy: 'pesquisa',
            });
            const { loop, goalStore } = makeLoop(ok, replanImpl);
            const goal = makeGoal(goalStore, [
                { id: 'stepInicial', description: 'Usar ferramenta desconhecida do catálogo', toolName: DEP_TOOL, toolArgs: {}, status: 'pending', fallbackSteps: [] },
            ]);
            const state = emptyState(goal.id) as any;
            await (loop as any).runLoopInternal(goal, channelContext, undefined, 0, 0, undefined, state);
            const stored = goalStore.getById(goal.id)!;

            assert(
                stored.blockers.some(b => b.kind === 'missing_tool' && b.description.includes('Pesquise a documentação oficial')),
                'blocker registrado é o de Pesquisa (GoalEvaluator real, wired via GoalExecutionLoop, não instanciado standalone)',
                stored.blockers
            );
            assert(stored.status === 'completed', 'goal completa após o replan (pesquisa) resolver o problema', stored.status);
            assert(
                ok.buildEvidenceHint(SYNTH_DEP) === '',
                'ACHADO S158: mesmo com sucesso real após a Pesquisa, OperationalKnowledge continua vazio para esta dependência — captureFromGoal() exige um step "verify_*" que só o caminho needs_dependency injeta, nunca o caminho Pesquisa/blocked',
                ok.buildEvidenceHint(SYNTH_DEP)
            );
        } finally {
            permissionRegistry.setMode(OperationalMode.SAFE, 'test-s158-1-restore');
        }
    }

    console.log('\n--- S158.2 a S158.4 — ciclo determinístico completo: needs_dependency → install real → verify real → captureFromGoal → confiança → reutilização ---');
    {
        await CapabilityRegistry.getInstance().getCapabilitySummary();
        const platform = CapabilityRegistry.getInstance().getOSSync()?.platform;
        assert(!!platform, 'pré-requisito: CapabilityRegistry resolveu o SO real (mesmo priming de S84.4)', platform);

        const SYNTH_DEP_DET = 'dep-sintetica-s158-determinista';
        const INSTALL_MARKER = `echo instalando-${SYNTH_DEP_DET}`;
        const VERIFY_MARKER = `echo verificando-${SYNTH_DEP_DET}`;
        const ORIG_TOOL = '__s158_det_tool__';

        // exec_command sintético — SÓ usado por install/verify steps injetados nesta suíte
        // (mesmo padrão de fake dangerous tool de S84, isolado por processo de teste).
        ToolRegistry.register({
            name: 'exec_command', description: 'test', parameters: {},
            execute: async (args: any) => ({ success: true, output: `ok: ${args?.command}` }),
        }, { dangerous: true });
        // Tool "real" do step original — sempre sucede (o que está sob teste aqui é o
        // ciclo de aquisição/captura, não o comportamento de falha do step original, já
        // coberto por S84.3).
        ToolRegistry.register({
            name: ORIG_TOOL, description: 'test', parameters: {},
            execute: async () => ({ success: true, output: 'tarefa original concluída' }),
        });

        const ok = freshOperationalKnowledge();

        function makeSyntheticCycleResult() {
            const syntheticDep: DependencyInfo = {
                name: SYNTH_DEP_DET,
                installByPlatform: { [platform!]: INSTALL_MARKER },
                manualInstructions: 'instrução manual de teste S158',
                verifyCmd: VERIFY_MARKER,
                type: 'system',
            };
            return {
                outcome: 'needs_dependency' as const,
                confidence: 0.8,
                blocker: {
                    kind: 'missing_tool' as const,
                    toolName: ORIG_TOOL,
                    missingDependency: SYNTH_DEP_DET,
                    description: `Binário '${SYNTH_DEP_DET}' não encontrado`,
                    suggestedActions: [],
                    detectedAt: Date.now(),
                },
                depInfo: syntheticDep,
            };
        }

        permissionRegistry.setMode(OperationalMode.DEVELOPER, 'test-s158-2', true);
        try {
            // S158.2 — primeira execução real do ciclo determinístico completo
            {
                const { loop, goalStore } = makeLoop(ok);
                const goal = makeGoal(goalStore, [
                    { id: 'stepOrig1', description: 'Usar dependência sintética determinística (1ª vez)', toolName: ORIG_TOOL, toolArgs: {}, status: 'pending', fallbackSteps: [] },
                ]);
                const step = goal.currentPlan[0];
                const cycleResult = makeSyntheticCycleResult();
                const handled = await (loop as any).handleNeedsDependencyOutcome(goal, step, cycleResult, 0, 0, undefined, undefined);
                const state = emptyState(handled.goal.id) as any;
                await (loop as any).runLoopInternal(handled.goal, channelContext, undefined, 0, 0, handled.priorFeedback, state);
                const stored = goalStore.getById(handled.goal.id)!;

                assert(stored.status === 'completed', 'S158.2: install real + verify real + step original executam e o goal completa', stored.status);
                assert(
                    stored.attempts.some(a => a.planStepId.startsWith('verify_') && a.result === 'success'),
                    'S158.2: existe um attempt real (não sintético) com planStepId "verify_*" bem-sucedido',
                    stored.attempts
                );
                assert(
                    ok.buildEvidenceHint(SYNTH_DEP_DET).includes(INSTALL_MARKER) && ok.buildEvidenceHint(SYNTH_DEP_DET).includes('recém-aprendido'),
                    'S158.2: captureFromGoal() creditou o aprendizado de verdade — 1 sucesso, confiança "weak" (recém-aprendido)',
                    ok.buildEvidenceHint(SYNTH_DEP_DET)
                );
                assert(ok.getTacticalCommand(SYNTH_DEP_DET) === null, 'S158.2: com apenas 1 sucesso, ainda não elegível ao atalho tático (limiar é 2)');
            }

            // S158.3 — segunda execução real do MESMO ciclo (2º goal) → confiança sobe a 'validated'
            {
                const { loop, goalStore } = makeLoop(ok);
                const goal = makeGoal(goalStore, [
                    { id: 'stepOrig2', description: 'Usar dependência sintética determinística (2ª vez)', toolName: ORIG_TOOL, toolArgs: {}, status: 'pending', fallbackSteps: [] },
                ]);
                const step = goal.currentPlan[0];
                const cycleResult = makeSyntheticCycleResult();
                const handled = await (loop as any).handleNeedsDependencyOutcome(goal, step, cycleResult, 0, 0, undefined, undefined);
                const state = emptyState(handled.goal.id) as any;
                await (loop as any).runLoopInternal(handled.goal, channelContext, undefined, 0, 0, handled.priorFeedback, state);

                assert(
                    ok.getTacticalCommand(SYNTH_DEP_DET) === INSTALL_MARKER,
                    'S158.3: após a 2ª verificação real bem-sucedida, computeConfidenceLevel() eleva a confiança a "validated" e getTacticalCommand() passa a devolver o comando',
                    ok.getTacticalCommand(SYNTH_DEP_DET)
                );
            }

            // S158.4 — REUTILIZAÇÃO real: 3º goal, mesma dependência (agora 'validated'), falha
            // ORGÂNICA dentro de runLoopInternal (não CycleResult sintético) — prova que o
            // GoalEvaluator REAL, internamente construído por GoalExecutionLoop, resolve via
            // OperationalKnowledge (Aprendido) SEM cair no ramo de Pesquisa desta vez.
            {
                let calls = 0;
                const REUSE_TOOL = '__s158_det_tool_reuse__';
                ToolRegistry.register({
                    name: REUSE_TOOL, description: 'test', parameters: {},
                    execute: async () => {
                        calls++;
                        if (calls === 1) return { success: false, output: '', error: `spawn ${SYNTH_DEP_DET} ENOENT` };
                        return { success: true, output: 'ok via conhecimento reaproveitado' };
                    },
                });
                const { loop, goalStore } = makeLoop(ok);
                const goal = makeGoal(goalStore, [
                    { id: 'stepReuse', description: 'Usar dependência sintética determinística (reutilização)', toolName: REUSE_TOOL, toolArgs: {}, status: 'pending', fallbackSteps: [] },
                ]);
                const state = emptyState(goal.id) as any;
                await (loop as any).runLoopInternal(goal, channelContext, undefined, 0, 0, undefined, state);
                const stored = goalStore.getById(goal.id)!;

                assert(
                    stored.blockers.some(b => b.kind === 'missing_tool' && b.missingDependency === SYNTH_DEP_DET),
                    'S158.4: o GoalEvaluator real (interno ao loop) classificou a falha e registrou o blocker',
                    stored.blockers
                );
                assert(
                    !stored.blockers.some(b => b.description.includes('Pesquise a documentação oficial')),
                    'S158.4: NÃO caiu no ramo de Pesquisa — conhecimento aprendido (validated) resolveu antes disso',
                    stored.blockers
                );
                assert(stored.status === 'completed', 'S158.4: goal completa reaproveitando o comando aprendido, sem nova pesquisa', stored.status);
            }
        } finally {
            permissionRegistry.setMode(OperationalMode.SAFE, 'test-s158-2-restore');
        }
    }

    console.log('\n--- S158.5 — KNOWN_DEPS mantém prioridade absoluta mesmo com OperationalKnowledge fabricado, através do loop REAL (não do GoalEvaluator isolado) ---');
    {
        assert('pandoc' in KNOWN_DEPS, 'pré-requisito: "pandoc" continua em KNOWN_DEPS (dado real, não alterado nesta Sprint)', Object.keys(KNOWN_DEPS));
        const DEP_TOOL = '__s158_pandoc_priority_tool__';
        ToolRegistry.register({
            name: DEP_TOOL, description: 'test', parameters: {},
            execute: async () => ({ success: false, output: '', error: 'spawn pandoc ENOENT' }),
        });

        const ok = freshOperationalKnowledge();
        ok.recordAttempt('pandoc', 'comando-aprendido-que-nunca-deveria-vencer', true);
        ok.recordAttempt('pandoc', 'comando-aprendido-que-nunca-deveria-vencer', true);

        const { loop, goalStore } = makeLoop(ok);
        const goal = makeGoal(goalStore, [
            { id: 'stepPandoc', description: 'Converter documento com pandoc', toolName: DEP_TOOL, toolArgs: {}, status: 'pending', fallbackSteps: [] },
        ]);
        const state = emptyState(goal.id) as any;
        await (loop as any).runLoopInternal(goal, channelContext, undefined, 0, 0, undefined, state);
        const stored = goalStore.getById(goal.id)!;

        assert(
            stored.blockers.some(b => b.kind === 'missing_tool' && b.toolName === DEP_TOOL),
            'pré-requisito: o blocker "missing_tool" real foi registrado', stored.blockers
        );
        assert(
            !stored.blockers.some(b => b.suggestedActions.some(a => a.includes('comando-aprendido-que-nunca-deveria-vencer'))),
            'S158.5: o comando aprendido (fabricado) NUNCA aparece nas suggestedActions — KNOWN_DEPS (pandoc) decide, mesmo com o loop real de ponta a ponta',
            stored.blockers
        );
    }

    console.log('\n--- S158.6 — SAFE bloqueia a sugestão de Pesquisa também através do loop REAL (não apenas do GoalEvaluator isolado) ---');
    {
        const SYNTH_DEP_SAFE = 'ferramenta-safe-s158';
        const DEP_TOOL = '__s158_safe_tool__';
        ToolRegistry.register({
            name: DEP_TOOL, description: 'test', parameters: {},
            execute: async () => ({ success: false, output: '', error: `spawn ${SYNTH_DEP_SAFE} ENOENT` }),
        });

        permissionRegistry.setMode(OperationalMode.SAFE, 'test-s158-6');
        const ok = freshOperationalKnowledge();
        const { loop, goalStore } = makeLoop(ok);
        const goal = makeGoal(goalStore, [
            { id: 'stepSafe', description: 'Usar ferramenta desconhecida em modo SAFE', toolName: DEP_TOOL, toolArgs: {}, status: 'pending', fallbackSteps: [] },
        ], { replanBudget: 0 }); // sem replanBudget: garante 'failed' em vez de um replan real sem planner útil
        const state = emptyState(goal.id) as any;
        await (loop as any).runLoopInternal(goal, channelContext, undefined, 0, 0, undefined, state);
        const stored = goalStore.getById(goal.id)!;

        assert(
            !stored.blockers.some(b => b.description.includes('Pesquise a documentação oficial')),
            'S158.6: em modo SAFE, o ramo de Pesquisa nunca é sugerido — mesmo comportamento de antes desta Sprint, agora confirmado com o loop real',
            stored.blockers
        );
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S158 RESULTADO: ${passed} passou | ${failed} falhou`);
    if (failed > 0) process.exit(1);
    process.exit(0);
}

main().catch(err => { console.error('ERRO NÃO TRATADO:', err); process.exit(1); });
