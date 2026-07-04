/// <reference types="node" />
/**
 * Harness de validação integrada (Campanha S7.5-validation) — PRIMEIRO script do projeto a
 * instanciar e rodar o pipeline real completo (AgentLoop → GoalOrchestrator → GoalExecutionLoop
 * → GoalPlanner/RiskAnalyzer → ReflectionMemory/CaseMemory) fim-a-fim, com provider LLM REAL
 * (Ollama, configurável via OLLAMA_URL/OLLAMA_MODEL) e um SQLite :memory: isolado — sem tocar
 * data/newclaw.db nem qualquer instalação de produção.
 *
 * Construção espelha a ordem real de src/core/AgentController.ts (não inventa wiring
 * alternativo): db → GoalStore/WorkflowEngine → MemoryManager → ProviderFactory → AgentLoop →
 * GoalOrchestrator. Ponto de entrada é GoalOrchestrator.process() — o mesmo método que
 * MessageBus chama em produção — não GoalExecutionLoop.executeGoal() direto, para preservar o
 * caminho real "entrada do usuário → Intent/Goal → ...".
 *
 * Ferramentas registradas no ToolRegistry: WriteTool, ReadTool, ExecCommandTool — suficientes
 * para success criteria determinísticos e Cases via deterministic_criteria. SendDocumentTool/
 * SendAudioTool (exigem MessageBus+SessionManager completos) foram deliberadamente deixados de
 * fora — confirmed_delivery (D2) é documentado como BLOCKED_BY_ENVIRONMENT nesta campanha.
 *
 * runGoalWithTimeout() é a peça de supervisão real desta infraestrutura: impõe um teto de tempo
 * por Goal (Promise.race), garantindo que um travamento (ver BUG-001) seja registrado como
 * timeout — nunca escondido — e que a campanha continue para o próximo cenário em vez de
 * bloquear indefinidamente. Não é isolamento por subprocesso (não há kill de processo filho);
 * o teardown final de qualquer operação pendurada é o process.exit(0) explícito ao fim da
 * campanha (ver integration-campaign-runner.ts).
 *
 * Uso direto (smoke test mínimo): npx ts-node scripts/testes/integration-campaign.ts
 */
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { MemoryManager } from '../../src/memory/MemoryManager';
import { ProviderFactory } from '../../src/core/ProviderFactory';
import { GoalStore } from '../../src/loop/GoalStore';
import { WorkflowEngine } from '../../src/loop/WorkflowEngine';
import { SkillLearner } from '../../src/loop/SkillLearner';
import { SkillLoader } from '../../src/skills/SkillLoader';
import { ClassificationMemory } from '../../src/memory/ClassificationMemory';
import { DecisionMemory } from '../../src/memory/DecisionMemory';
import { AgentLoop } from '../../src/loop/AgentLoop';
import { GoalOrchestrator } from '../../src/loop/GoalOrchestrator';
import { ReflectionMemory } from '../../src/memory/ReflectionMemory';
import { CaseMemory } from '../../src/memory/CaseMemory';
import { ToolRegistry } from '../../src/core/ToolRegistry';
import { WriteTool } from '../../src/tools/write_tool';
import { ReadTool } from '../../src/tools/read_tool';
import { ExecCommandTool } from '../../src/tools/exec_command';
import type { ChannelContext } from '../../src/loop/agentLoopTypes';

export const WORKSPACE_DIR = path.join(__dirname, '..', '..', 'workspace', '_campaign_scratch');
fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

export async function buildHarness() {
    const db = new (Database as any)(':memory:');
    const goalStore = new GoalStore(db);
    const workflowEngine = new WorkflowEngine(db);
    const ollamaUrl = process.env.OLLAMA_URL || 'http://localhost:11434';
    const memory = new MemoryManager(db, ollamaUrl);

    const available = await memory.getEmbeddingService().isAvailable();
    console.log(`[HARNESS] Ollama/embedding disponível: ${available}`);

    const providerFactory = new ProviderFactory({
        ollamaUrl,
        ollamaModel: process.env.OLLAMA_MODEL || 'glm-5.1:cloud',
        defaultProvider: 'ollama',
    });

    // Registro mínimo de tools reais — mesma classe usada em produção, sem mock.
    ToolRegistry.register(new WriteTool());
    ToolRegistry.register(new ReadTool());
    ToolRegistry.register(new ExecCommandTool(), { dangerous: true });

    const skillLoader = new SkillLoader(path.join(__dirname, '..', '..', 'skills'));
    const skillLearner = new SkillLearner(db, path.join(__dirname, '..', '..', 'skills'));
    const classificationMemory = new ClassificationMemory(db);
    const decisionMemory = new DecisionMemory(db);

    const agentLoop = new AgentLoop(
        providerFactory,
        memory,
        { languageDirective: 'Responda sempre em português do Brasil.', systemPrompt: 'Você é o NewClaw, um agente de IA local. Ambiente de teste isolado (campanha de validação integrada).' },
        skillLearner,
        skillLoader,
        classificationMemory,
        decisionMemory,
    );
    agentLoop.setWorkflowEngine(workflowEngine);

    const goalOrchestrator = new GoalOrchestrator(agentLoop, providerFactory, goalStore, memory);

    // Handles PRÓPRIOS para diagnóstico/verificação — mesma memory/db do goalOrchestrator
    // interno, então observam as MESMAS tabelas reais (cases, reflection_entries etc.), nunca
    // usados para influenciar a execução (só leitura pós-fato, mesma prática de S22/S23/S25).
    const inspectReflectionMemory = new ReflectionMemory(memory);
    const inspectCaseMemory = new CaseMemory(memory);

    return { db, goalStore, memory, providerFactory, agentLoop, goalOrchestrator, inspectReflectionMemory, inspectCaseMemory, skillLoader };
}

/**
 * BUG-001 (campanha S7.5-validation): um Goal real travou indefinidamente (sem exceção, sem
 * timeout) num step "free-form agentloop" forçado pelo StrategyDiversityGuard após replan
 * estruturalmente idêntico — ver relatório para a cadeia completa de logs. Envolve esta
 * chamada num timeout para que NENHUM cenário futuro trave a campanha inteira; um timeout aqui
 * é registrado como evidência (INCONCLUSIVE/BLOCKED_BY_ENVIRONMENT), nunca escondido.
 */
export async function runGoalWithTimeout(
    goalOrchestrator: Awaited<ReturnType<typeof buildHarness>>['goalOrchestrator'],
    conversationId: string,
    message: string,
    userId: string,
    context: ChannelContext,
    timeoutMs = 90_000,
): Promise<{ ok: true; result: unknown } | { ok: false; reason: 'timeout' | 'error'; error?: unknown }> {
    let timer: NodeJS.Timeout;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`TIMEOUT_${timeoutMs}ms`)), timeoutMs);
    });
    try {
        const result = await Promise.race([goalOrchestrator.process(conversationId, message, userId, context), timeout]);
        clearTimeout(timer!);
        return { ok: true, result };
    } catch (err) {
        clearTimeout(timer!);
        const isTimeout = err instanceof Error && err.message.startsWith('TIMEOUT_');
        return { ok: false, reason: isTimeout ? 'timeout' : 'error', error: err };
    }
}

let convCounter = 0;
export function freshContext(): { conversationId: string; userId: string; context: ChannelContext } {
    convCounter++;
    return {
        conversationId: `campaign-conv-${convCounter}`,
        userId: 'campaign-user',
        context: { channel: 'test', chatId: `campaign-chat-${convCounter}` },
    };
}

async function smokeTest() {
    console.log('=== SMOKE TEST — construção do harness + 1 Goal real mínimo ===');
    const h = await buildHarness();
    const { conversationId, userId, context } = freshContext();
    const objective = `Escreva um arquivo de texto em ${WORKSPACE_DIR.replace(/\\/g, '/')}/smoke_test.txt contendo exatamente a frase: campanha de validacao ok`;
    console.log(`[SMOKE] objective="${objective}"`);
    const t0 = Date.now();
    const result = await h.goalOrchestrator.process(conversationId, objective, userId, context);
    console.log(`[SMOKE] tempo=${Date.now() - t0}ms`);
    console.log('[SMOKE] resultado:', JSON.stringify(result).slice(0, 500));
    const goals = h.db.prepare('SELECT id, status, objective, success_criteria, sent_artifacts FROM goals').all();
    console.log('[SMOKE] goals no banco:', JSON.stringify(goals, null, 2));
    const fileExists = fs.existsSync(path.join(WORKSPACE_DIR, 'smoke_test.txt'));
    console.log(`[SMOKE] arquivo criado de verdade: ${fileExists}`);
    if (fileExists) console.log('[SMOKE] conteúdo:', fs.readFileSync(path.join(WORKSPACE_DIR, 'smoke_test.txt'), 'utf-8'));
    const stats = h.inspectCaseMemory.getStats();
    console.log('[SMOKE] CaseMemory.getStats():', JSON.stringify(stats));
}

if (require.main === module) {
    // process.exit explícito: AttentionFeedback/outros subsistemas registram setInterval em
    // background que mantêm o processo Node vivo indefinidamente mesmo após o script terminar.
    smokeTest()
        .then(() => process.exit(0))
        .catch(err => { console.error('[SMOKE] ERRO NÃO TRATADO:', err); process.exit(1); });
}
