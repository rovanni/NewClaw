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
    // Remove apenas tags técnicas disruptivas, PRESERVA o conteúdo
    result = result.replace(/<think>[\s\S]*?<\/think>/gi, '');
    result = result.replace(/<\/?think>/gi, '');
    result = result.replace(/\[TOOL_CALL\][\s\S]*?\[\/TOOL_CALL\]/gi, '');
    // Failsafe: Remove negritos residuais (**)
    result = result.replace(/\*\*/g, '');
    return result.trim();
}

export class AgentLoop {
    private providerFactory: ProviderFactory;
    private memory: MemoryManager;
    private tools: Map<string, ToolExecutor> = new Map();
    private config: AgentLoopConfig;
    private maxIterations: number = 2;
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
        return `Você é o núcleo cognitivo do agente NewClaw. Resolva a tarefa com eficiência máxima e rigor semântico.

## PRINCÍPIO CENTRAL
Toda a cognição acontece em uma ÚNICA RESPOSTA por ciclo. Não há etapas externas.

## CURADORIA DE EVIDÊNCIA (CRÍTICO)
1. RELEVÂNCIA: Avalie cada resultado de ferramenta. Se a informação for irrelevante, genérica ou fora de contexto, IGNORE-A completamente.
2. HIERARQUIA: Priorize dados estruturados (ferramentas de crypto/análise) sobre buscas genéricas na web (Wikipedia, portais gerais).
3. DESCARTE DE RUÍDO: Não liste dados inúteis. Se o web_search retornar lixo, baseie-se apenas em dados confiáveis ou no seu conhecimento interno.

## ESTILO DE RESPOSTA
1. LIMPEZA: NÃO use negrito (**texto**) ou itálico. Use texto limpo e direto. Responda APENAS a pergunta do usuário.
2. SÍNTESE: Não despeje resultados brutos. Entregue uma conclusão coerente baseada APENAS em evidências relevantes.

## FORMATO DE RESPOSTA (OBRIGATÓRIO)
Você deve SEMPRE responder em JSON:
{
  "thought": "Sua análise crítica das evidências e estratégia de filtragem",
  "action": {
    "type": "tool" | "final_answer",
    "name": "nome_da_tool",
    "input": { "param": "valor" },
    "content": "Resposta final limpa e filtrada (se type = final_answer)"
  },
  "evaluation": {
    "is_complete": true | false,
    "confidence": "low" | "medium" | "high",
    "reason": "Justificativa da confiança baseada na qualidade da evidência"
  }
}

Se houver conflito de dados, a ferramenta específica sempre vence a busca genérica.`;
    }

    public async run(conversationId: string, userText: string, userId?: string): Promise<string> {
        return this.runWithTools(conversationId, userText, 0, userId);
    }

    private parseLLMResponse(content: string): any | null {
        if (!content) return null;
        
        const clean = sanitizeContent(content);
        try {
            // Tentativa 1: Parse direto
            return JSON.parse(clean);
        } catch (e) {
            try {
                // Tentativa 2: Extração via Regex
                const match = content.match(/\{[\s\S]*\}/);
                if (match) {
                    let jsonStr = match[0];
                    // Limpeza básica de Markdown se sobrar algo
                    jsonStr = jsonStr.replace(/```json/g, '').replace(/```/g, '');
                    jsonStr = jsonStr.replace(/,\s*([\}\]])/g, '$1'); 
                    return JSON.parse(jsonStr);
                }
            } catch (e2) {
                return null;
            }
        }
        return null;
    }

    private async runWithTools(conversationId: string, userText: string, iteration: number, userId?: string): Promise<string> {
        // Limite estrito de 2 ciclos totais
        if (iteration >= 2) {
            return 'Analisei as informações disponíveis e identifiquei os seguintes pontos: (detalhes processados no contexto).'; 
        }

        console.log(`[${this.ts()}] [LOOP] Atomic Cognition Cycle ${iteration + 1}`);

        // Memória local do ciclo para detectar repetição e estagnação
        const cycleHistory: Array<{ tool: string, input: string, status: string }> = [];
        let lastThought = '';
        let lastBestContent = '';

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

        // Roteamento determinístico e instantâneo
        const chatProfile = await this.modelRouter.route(userText);
        let stepCount = 0;
        const maxSteps = 4; // Limite de passos dentro do ciclo

        while (stepCount < maxSteps) {
            stepCount++;
            console.log(`[${this.ts()}] [COGNITION] Step ${stepCount}...`);

            let response = await this.callLLMWithFallback(loopMessages, toolDefs, chatProfile);
            let atomicData = this.parseLLMResponse(response.content || '');
            let bestPartialContent = atomicData?.action?.content || sanitizeContent(response.content || '');
            if (atomicData?.action?.content) lastBestContent = atomicData.action.content;

            // 1. Detecção de Estagnação (Thought Repetition)
            if (atomicData && atomicData.thought === lastThought && !response.toolCalls?.length && !atomicData.action?.name) {
                console.warn(`[${this.ts()}] [COGNITION] Stagnation detected. Stopping with partial content.`);
                return lastBestContent || bestPartialContent || 'Não consegui avançar mais nesta análise, mas os dados atuais estão processados.';
            }
            lastThought = atomicData?.thought || '';

            // 2. Retry Lógica (Máx 1x)
            if (!atomicData && !response.toolCalls?.length) {
                console.warn(`[${this.ts()}] [ATOMIC] Invalid JSON. Retrying (1/1)...`);
                loopMessages.push({ role: 'assistant', content: response.content || 'Erro de formato' });
                loopMessages.push({ role: 'user', content: 'Sua resposta anterior não estava em JSON válido. Responda novamente APENAS no formato JSON exigido.' });
                
                response = await this.callLLMWithFallback(loopMessages, toolDefs, chatProfile);
                atomicData = this.parseLLMResponse(response.content || '');
                
                if (!atomicData) return 'Houve um erro de processamento estrutural. Tente reformular.';
            }

            loopMessages.push({ role: 'assistant', content: response.content, toolCalls: response.toolCalls });

            // 3. Early Stop Imediato (Prioridade Máxima)
            if (atomicData?.evaluation?.is_complete === true) {
                console.log(`[${this.ts()}] [ATOMIC] Task COMPLETE. Returning immediately.`);
                return atomicData.action?.content || sanitizeContent(response.content || '') || 'Tarefa concluída.';
            }

            // 4. Native toolCalls com Anti-Repetição
            if (response.toolCalls && response.toolCalls.length > 0) {
                for (const toolCall of response.toolCalls) {
                    const toolName = toolCall.name;
                    const toolInput = JSON.stringify(toolCall.arguments);
                    
                    // Verifica se já falhou com esse input neste ciclo
                    const previousFailure = cycleHistory.find(h => h.tool === toolName && h.input === toolInput && h.status === 'error');
                    if (previousFailure) {
                        console.warn(`[${this.ts()}] [TOOL] Blocking repetitive failure for ${toolName}.`);
                        loopMessages.push({ role: 'tool', content: `Erro: Ação repetitiva detectada. Você já tentou ${toolName} com esses parâmetros e falhou. Mude sua estratégia.`, tool_call_id: toolCall.id });
                        continue;
                    }

                    const tool = this.tools.get(toolName);
                    if (tool) {
                        const result = await tool.execute(toolCall.arguments);
                        console.log(`[${this.ts()}] [TOOL] ${toolName} -> ${result.success ? '✓' : '✗'}`);
                        cycleHistory.push({ tool: toolName, input: toolInput, status: result.success ? 'success' : 'error' });
                        loopMessages.push({ role: 'tool', content: result.output, tool_call_id: toolCall.id });
                        
                        if (toolName === 'send_audio' || toolName === 'send_document') return result.output;
                    }
                }
                continue; 
            }

            // 5. Atomic Action com Anti-Repetição
            if (atomicData?.action?.type === 'tool' && atomicData.action.name) {
                const toolName = atomicData.action.name;
                const toolInput = JSON.stringify(atomicData.action.input || {});

                const previousFailure = cycleHistory.find(h => h.tool === toolName && h.input === toolInput && h.status === 'error');
                if (previousFailure) {
                    loopMessages.push({ role: 'tool', content: `Erro: Falha repetitiva bloqueada para ${toolName}. Tente outra abordagem.` });
                    continue;
                }

                const tool = this.tools.get(toolName);
                if (tool) {
                    const result = await tool.execute(atomicData.action.input || {});
                    console.log(`[${this.ts()}] [ATOMIC-TOOL] ${toolName} -> ${result.success ? '✓' : '✗'}`);
                    cycleHistory.push({ tool: toolName, input: toolInput, status: result.success ? 'success' : 'error' });
                    loopMessages.push({ role: 'tool', content: result.output });
                    continue;
                }
            }

            // 6. Parada por Confiança ou Limite de Passos
            if (atomicData?.evaluation?.confidence === 'high' || stepCount >= maxSteps) {
                return atomicData?.action?.content || sanitizeContent(response.content || '') || 'Tarefa concluída.';
            }

            loopMessages.push({ role: 'user', content: '[SISTEMA] Continue sua execução ou finalize se já for suficiente.' });
        }

        // 7. Síntese de Emergência (Garantir resposta útil)
        const toolOutputs = loopMessages
            .filter(m => m.role === 'tool')
            .map(m => m.content)
            .filter(c => c && c.length > 20 && !c.includes('Erro'))
            .slice(-2); // Pega as duas últimas evidências úteis

        let synthesis = '';
        if (lastBestContent && lastBestContent.length > 20) {
            synthesis = lastBestContent;
        } else if (toolOutputs.length > 0) {
            synthesis = `Com base nas buscas realizadas: ${toolOutputs.join(' ')}`;
        } else if (lastThought) {
            synthesis = `Concluí que: ${lastThought}`;
        } else {
            synthesis = 'Não foi possível obter uma resposta detalhada agora.';
        }

        // Limpeza final para remover qualquer JSON que tenha vazado na síntese
        return synthesis.replace(/\{[\s\S]*\}/g, '').trim() || 'Tarefa processada.';
    }

    private async callLLMWithFallback(messages: LLMMessage[], toolDefs: ToolDefinition[], chatProfile: any): Promise<any> {
        const timeoutMs = 8000; // Timeout agressivo para eficiência (8s)
        try {
            return await llmQueue.add(() => this.providerFactory.chatWithFallback(
                messages, 
                toolDefs, 
                chatProfile?.id, 
                timeoutMs
            ));
        } catch (error: any) {
            console.warn(`[AGENT] Critical failure: ${error.message}.`);
            throw error; // Não retenta aqui, deixa o loop decidir
        }
    }
}
