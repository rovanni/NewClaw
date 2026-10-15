/**
 * Harness compartilhado (S278, S279) — `GoalExecutionLoop` REAL com LLM/planner/memória fakes.
 *
 * Mesmo padrão que S84/S158 já usam: o loop, o `GoalEvaluator` e o `GoalStore` são os de produção;
 * só o que exigiria rede/LLM é substituído. O provider fake devolve `validationJson` para qualquer
 * chamada — é o veredito do validador de conclusão do goal.
 *
 * Módulo-folha: importado pelos testes, não importa nenhum deles. Não termina em `.test.ts`, então o
 * runner de regressão não o executa.
 */
import Database from 'better-sqlite3';
import { GoalExecutionLoop } from '../../../loop/GoalExecutionLoop';
import { GoalStore } from '../../../loop/GoalStore';
import { Goal, PlanStep } from '../../../loop/GoalTypes';
import { ChannelContext } from '../../../loop/agentLoopTypes';
import { vereditoConclusao, tipoDaPerguntaDoMotor, orcamentoDeTeste } from './veredito';

type Conclusao = { achieved?: boolean; summary?: string; reason?: string; suggestions?: string[] };

/**
 * `formatoDoMotor`: o juiz de conclusão recebe `validationJson` traduzido para o formato do motor único (ADR-014);
 * as demais chamadas, o JSON como está. Sem a opção, todas recebem o JSON como está (comportamento original).
 */
export function fakeProviderFactory(validationJson: Conclusao, opcoes: { formatoDoMotor?: boolean } = {}) {
    const content = JSON.stringify(validationJson);
    const doMotor = vereditoConclusao(validationJson.achieved === true, validationJson);
    return {
        chatWithFallback: async (msgs: Array<{ content?: unknown }>) => ({
            status: 'success', content: opcoes.formatoDoMotor && tipoDaPerguntaDoMotor(msgs) === 'conclusao' ? doMotor : content,
        }),
        ...(opcoes.formatoDoMotor ? { getBudgetAuxiliar: orcamentoDeTeste } : {}),
        getProvider: () => undefined,
        getProviderWithModel: () => ({ chat: async () => ({ status: 'success', content }) }),
    } as unknown as import('../../../core/ProviderFactory').ProviderFactory;
}

export function makeLoop(validationJson: Conclusao, opcoes: { formatoDoMotor?: boolean } = {}) {
    const db = new (Database as any)(':memory:');
    const goalStore = new GoalStore(db);
    const fakeMemory = { getDatabase: () => db, semanticSearch: async () => [] } as any;
    const fakePlanner = {
        getAvailableSkills: () => [], setSkillContext: () => {}, setModel: () => {},
        replan: async () => ({ steps: [], strategy: 'n/a' }),
    } as any;
    const { ToolRegistry } = require('../../../core/ToolRegistry');
    const loop = new GoalExecutionLoop(
        { process: async () => 'não deveria ser chamado' } as any, goalStore, fakePlanner,
        { record: () => {}, buildContextHint: () => '', findHardConstraints: () => [], findToolFailures: () => '' } as any,
        ToolRegistry, fakeProviderFactory(validationJson, opcoes), fakeMemory,
        { findApplicableCasesShadow: async () => [], backfillMissingEmbeddings: async () => {}, captureIfEligible: () => {}, findSimilarShadow: () => [] } as any,
    );
    return { loop, goalStore };
}

export function makeGoal(store: GoalStore, plan: PlanStep[], over: Partial<Goal> = {}): Goal {
    return store.create({
        sessionKey: 'test:harness', conversationId: `h-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        userIntent: 'Gerar um relatório de teste', objective: 'Gerar um relatório de teste', status: 'executing',
        attempts: [], blockers: [], toolsTried: [], strategiesTried: [], successCriteria: [], sentArtifacts: [],
        retryBudget: 3, replanBudget: 5, confidence: 0.9, requiresAuth: false, authorizationScope: [],
        expiresAt: Date.now() + 3_600_000, currentPlan: plan, ...over,
    } as Omit<Goal, 'id' | 'createdAt' | 'updatedAt'>);
}

export const emptyState = (goalId: string) => ({
    cognitiveContext: { discoveries: [], failedStrategies: [], filesRead: [], filesModified: [], generatedArtifacts: [], executedCommands: [], importantOutputs: [] },
    progressModel: { goalId, components: [], overallPercent: 0, updatedAt: Date.now() },
}) as any;

export const channelContext: ChannelContext = { channel: 'test', chatId: 'test-user' };
