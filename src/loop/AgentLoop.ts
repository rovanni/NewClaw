/**
 * AgentLoop — Atomic Cognition Pattern
 * 
 * Unifies execution, validation, reassessment, and criticism into a single TURN.
 */

import { ProviderFactory, LLMMessage, ToolDefinition } from '../core/ProviderFactory';
import type { Message } from '../memory/MemoryManager';
import { ContextBuilder } from './ContextBuilder';
import { ResponseBuilder } from './ResponseBuilder';
import { ModelRouter } from './ModelRouter';
import PQueue from 'p-queue';
import { MemoryManager } from '../memory/MemoryManager';
import { traceManager } from '../core/ExecutionTrace';
import { ContextCompressor } from './ContextCompressor';
import { SkillLearner } from './SkillLearner';
import { AgentStateManager } from '../core/AgentStateManager';
import { MemoryScoringEngine } from '../memory/MemoryScoringEngine';
import { MemoryReconciliationEngine } from '../memory/MemoryReconciliationEngine';
import { StateStabilityGuard } from '../core/StateStabilityGuard';
import { ContextValidator } from './ContextValidator';
import { DecisionPostProcessor } from './DecisionPostProcessor';

export interface ToolResult {
    success: boolean;
    output: string;
    error?: string;
}

export interface ToolExecutor {
    name: string;
    description: string;
    parameters: Record<string, any>;
    execute(args: Record<string, any>): Promise<ToolResult>;
}

export interface AgentLoopConfig {
    languageDirective: string;
    systemPrompt: string;
    modelRouter?: {
        chat?: string;
        code?: string;
        vision?: string;
        light?: string;
        analysis?: string;
        execution?: string;
        visionServer?: string;
    };
}

const llmQueue = new PQueue({ concurrency: 1 });

function sanitizeContent(content: string): string {
    if (!content) return '';
    let result = content;
    result = result.replace(/<think>[\s\S]*?<\/think>/gi, '');
    result = result.replace(/<\/?think>/gi, '');
    result = result.replace(/```json\s*[\s\S]*?```/gi, '');
    result = result.replace(/\[TOOL_CALL\][\s\S]*?\[\/TOOL_CALL\]/gi, '');
    return result.trim();
}

export class AgentLoop {
    private providerFactory: ProviderFactory;
    private memory: MemoryManager;
    private tools: Map<string, ToolExecutor> = new Map();
    private config: AgentLoopConfig;
    private maxIterations: number = 5;
    private compressor: ContextCompressor;
    private contextBuilder: ContextBuilder;
    private responseBuilder: ResponseBuilder;
    private skillLearner: SkillLearner;
    private modelRouter: ModelRouter;
    private stateManager: AgentStateManager;
    private scoringEngine: MemoryScoringEngine;
    private reconciliationEngine: MemoryReconciliationEngine;
    private stabilityGuard: StateStabilityGuard;
    private contextValidator: ContextValidator;
    private postProcessor: DecisionPostProcessor;

    constructor(providerFactory: ProviderFactory, memory: MemoryManager, config: AgentLoopConfig, skillLearner?: SkillLearner) {
        this.providerFactory = providerFactory;
        this.memory = memory;
        this.config = config;
        this.compressor = new ContextCompressor(this.providerFactory);
        this.contextBuilder = new ContextBuilder(memory);
        this.responseBuilder = new ResponseBuilder();
        this.skillLearner = skillLearner || new SkillLearner((memory as any).db || (memory as any)._db);
        this.modelRouter = new ModelRouter(config.modelRouter as any);
        this.stateManager = new AgentStateManager(memory);
        this.scoringEngine = new MemoryScoringEngine(memory);
        this.reconciliationEngine = new MemoryReconciliationEngine(memory);
        this.stabilityGuard = new StateStabilityGuard(this.stateManager);
        this.contextValidator = new ContextValidator();
        this.postProcessor = new DecisionPostProcessor();
    }

    public getStateManager(): AgentStateManager {
        return this.stateManager;
    }

    public setTelegramContext(chatId: string, botToken: string) {
        // Para ferramentas que precisam enviar mensagens diretas
        (this as any).currentChatId = chatId;
        (this as any).currentBotToken = botToken;
    }

    public async process(conversationId: string, userText: string, userId?: string): Promise<string> {
        return this.run(conversationId, userText, userId);
    }

    public registerTool(tool: ToolExecutor) {
        this.tools.set(tool.name, tool);
    }

    private ts(): string { return new Date().toLocaleTimeString('pt-BR', { hour12: false }); }

    private buildSystemPrompt(userText: string): string {
        return `${this.config.systemPrompt}\n\n[DIRETRIZ DE IDIOMA]\nResponda sempre em Português do Brasil de forma natural e amigável.`;
    }

    private buildAtomicPrompt(): string {
        return `Você é o núcleo cognitivo do agente NewClaw. Resolva a tarefa com eficiência máxima.

## PRINCÍPIO CENTRAL
Toda a cognição acontece em uma ÚNICA RESPOSTA por ciclo. Não há etapas externas.

## REGRAS DE OURO
1. BOM O SUFICIENTE: Se a resposta for correta, útil e compreensível, finalize IMEDIATAMENTE. Não refine por estética.
2. EVIDÊNCIA TEM PRIORIDADE: Dados reais via tools garantem confiança ALTA.
3. EVITE OVER-COGNITION: Não repita raciocínio sem nova informação.
4. REFINAMENTO: Máximo 1 vez se houver erro grave.

## FORMATO DE RESPOSTA (OBRIGATÓRIO)
Você deve SEMPRE responder em JSON:
{
  "thought": "Seu raciocínio estratégico resumido",
  "action": {
    "type": "tool" | "final_answer",
    "name": "nome_da_tool (se houver)",
    "input": { "param": "valor" },
    "content": "resposta final ao usuário (se type = final_answer)"
  },
  "evaluation": {
    "is_complete": true | false,
    "confidence": "low" | "medium" | "high",
    "reason": "Justificativa objetiva"
  }
}

Importante: Use as ferramentas APENAS se precisar de dados reais. Se já tiver a resposta, finalize.`;
    }

    public async run(conversationId: string, userText: string, userId?: string): Promise<string> {
        return this.runWithTools(conversationId, userText, 0, userId);
    }

    private async runWithTools(conversationId: string, userText: string, iteration: number, userId?: string): Promise<string> {
        if (iteration >= this.maxIterations) {
            return 'Não consegui completar a tarefa após várias tentativas.';
        }

        console.log(`[${this.ts()}] [LOOP] Atomic Cognition Cycle ${iteration + 1}`);

        const recentMessages = this.memory.getRecentMessages(conversationId, 6);
        const context = await this.contextBuilder.buildContext(userText);
        const skillContext = this.skillLearner.buildSkillContext(userText, 2);
        const now = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'full', timeStyle: 'short' });
        
        const toolDefs: ToolDefinition[] = Array.from(this.tools.values()).map(t => ({
            name: t.name,
            description: t.description,
            parameters: t.parameters
        }));

        const systemSections = [
            this.config.languageDirective,
            this.buildSystemPrompt(userText),
            this.buildAtomicPrompt(),
            skillContext && skillContext.confidence >= 0.7 ? `[SKILL LEARNER]\n${skillContext.text}` : '',
            `Data Atual: ${now}`,
            context
        ].filter(Boolean);

        const loopMessages: LLMMessage[] = [
            { role: 'system', content: systemSections.join('\n\n') },
            ...recentMessages.map(m => ({ role: m.role as LLMMessage['role'], content: m.content })),
            { role: 'user', content: userText }
        ];

        let chatProfile = this.modelRouter.route(userText);
        let currentIteration = 0;

        while (currentIteration < this.maxIterations) {
            currentIteration++;
            console.log(`[${this.ts()}] [COGNITION] Step ${currentIteration}...`);

            const response = await this.callLLMWithFallback(loopMessages, toolDefs, chatProfile);
            const content = sanitizeContent(response.content || '');
            
            let atomicData: any = { thought: '', action: { type: 'final_answer', content: content }, evaluation: { is_complete: true } };
            try {
                const jsonStr = content.substring(content.indexOf('{'), content.lastIndexOf('}') + 1);
                atomicData = JSON.parse(jsonStr);
                console.log(`[${this.ts()}] [ATOMIC] Thought: ${atomicData.thought?.slice(0, 100)}...`);
                console.log(`[${this.ts()}] [ATOMIC] Evaluation: ${atomicData.evaluation?.is_complete ? 'COMPLETE' : 'INCOMPLETE'} (${atomicData.evaluation?.confidence})`);
            } catch (e) {
                console.log(`[${this.ts()}] [ATOMIC] LLM did not provide valid JSON. Proceeding with raw content.`);
            }

            loopMessages.push({ role: 'assistant', content: response.content, toolCalls: response.toolCalls });

            if (response.toolCalls && response.toolCalls.length > 0) {
                for (const toolCall of response.toolCalls) {
                    const tool = this.tools.get(toolCall.name);
                    if (tool) {
                        const result = await tool.execute(toolCall.arguments);
                        console.log(`[${this.ts()}] [TOOL] ${toolCall.name} -> ${result.success ? '✓' : '✗'}`);
                        loopMessages.push({ role: 'tool', content: result.output, tool_call_id: toolCall.id });
                    }
                }
                continue; 
            }

            if (atomicData.action?.type === 'tool' && atomicData.action.name) {
                const tool = this.tools.get(atomicData.action.name);
                if (tool) {
                    const result = await tool.execute(atomicData.action.input || {});
                    console.log(`[${this.ts()}] [ATOMIC-TOOL] ${atomicData.action.name} -> ${result.success ? '✓' : '✗'}`);
                    loopMessages.push({ role: 'tool', content: result.output });
                    continue;
                }
            }

            if (atomicData.evaluation?.is_complete || atomicData.evaluation?.confidence === 'high' || currentIteration >= 4) {
                return atomicData.action?.content || content || 'Tarefa concluída.';
            }

            loopMessages.push({ role: 'user', content: '[SISTEMA] Continue sua execução ou finalize se já for suficiente.' });
        }

        return 'Limite de iterações atingido.';
    }

    private async callLLMWithFallback(messages: LLMMessage[], toolDefs: ToolDefinition[], chatProfile: any): Promise<any> {
        try {
            return await llmQueue.add(() => this.providerFactory.chatWithFallback(messages, toolDefs));
        } catch (error: any) {
            console.warn(`[AGENT] Model execution failed: ${error.message}.`);
            return await llmQueue.add(() => this.providerFactory.chatWithFallback(messages, toolDefs));
        }
    }
}
