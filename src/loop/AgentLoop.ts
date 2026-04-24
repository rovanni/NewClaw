/**
 * AgentLoop — OpenClaw Pattern (native tool calling)
 * 
 * Tool results are ALWAYS fed back to the LLM for natural formatting.
 * No raw technical output leaks to the user.
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
    // Strip think tags and their contents
    result = result.replace(/<think>[\s\S]*?<\/think>/gi, '');
    // Remove any remaining orphaned tags
    result = result.replace(/<\/?think>/gi, '');
    result = result.replace(/<\/?tool_call>/gi, '');
    result = result.replace(/<\/?tool_result>/gi, '');
    result = result.replace(/```json\s*[\s\S]*?```/gi, '');
    // Remove leaked tool call patterns: {tool => "name", args => {...}} or [TOOL_CALL]...[/TOOL_CALL]
    result = result.replace(/\[TOOL_CALL\][\s\S]*?\[\/TOOL_CALL\]/gi, '');
    result = result.replace(/\{tool\s*=>\s*"[^"]*"[\s\S]*?\}\s*/gi, '');
    result = result.replace(/\n{2,}/g, '\n\n').trim();
    return result;
}

export class AgentLoop {
    private providerFactory: ProviderFactory;
    private memory: MemoryManager;
    private tools: Map<string, ToolExecutor> = new Map();
    private config: AgentLoopConfig;
    private currentChatId: string | null = null;
    private currentBotToken: string | null = null;
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

    public getStateManager(): AgentStateManager {
        return this.stateManager;
    }




    constructor(
        providerFactory: ProviderFactory,
        memory: MemoryManager,
        config?: Partial<AgentLoopConfig>,
        skillLearner?: SkillLearner
    ) {
        this.providerFactory = providerFactory;
        this.memory = memory;
        this.compressor = new ContextCompressor(providerFactory);
        this.contextBuilder = new ContextBuilder(memory);
        this.responseBuilder = new ResponseBuilder();
        this.skillLearner = skillLearner || new SkillLearner(memory.getDatabase());
        this.modelRouter = new ModelRouter();
        this.stateManager = new AgentStateManager(memory);
        this.scoringEngine = new MemoryScoringEngine(memory);
        this.reconciliationEngine = new MemoryReconciliationEngine(memory);
        this.stabilityGuard = new StateStabilityGuard(this.stateManager);
        this.contextValidator = new ContextValidator();
        this.postProcessor = new DecisionPostProcessor();
        this.config = {
            languageDirective: config?.languageDirective || 'Responda SEMPRE em português brasileiro. Seja direto e conciso.',
            systemPrompt: config?.systemPrompt || 'Voce e o NewClaw, um agente cognitivo local...',
            modelRouter: config?.modelRouter
        };

        if (this.config.modelRouter) {
            this.applyModelRouterConfig(this.config.modelRouter);
        }
    }

    private applyModelRouterConfig(routerConfig: any): void {
        const profiles = (this.modelRouter as any).config.profiles;
        if (routerConfig.chat) { const p = profiles.find((p: any) => p.category === 'chat'); if (p) p.model = routerConfig.chat; }
        if (routerConfig.code) { const p = profiles.find((p: any) => p.category === 'code'); if (p) p.model = routerConfig.code; }
        if (routerConfig.vision) { const p = profiles.find((p: any) => p.category === 'vision'); if (p) p.model = routerConfig.vision; }
        if (routerConfig.light) { const p = profiles.find((p: any) => p.category === 'light'); if (p) p.model = routerConfig.light; }
        if (routerConfig.analysis) { const p = profiles.find((p: any) => p.category === 'analysis'); if (p) p.model = routerConfig.analysis; }
        if (routerConfig.execution) { const p = profiles.find((p: any) => p.category === 'execution'); if (p) p.model = routerConfig.execution; }
        if (routerConfig.visionServer) (this.modelRouter as any).config.classifierServer = routerConfig.visionServer;
    }

    registerTool(tool: ToolExecutor): void {
        this.tools.set(tool.name, tool);
    }

    public updateConfig(newConfig: Partial<AgentLoopConfig>): void {
        if (newConfig.languageDirective) this.config.languageDirective = newConfig.languageDirective;
        if (newConfig.systemPrompt) this.config.systemPrompt = newConfig.systemPrompt;
        if (newConfig.modelRouter) {
            this.config.modelRouter = { ...(this.config.modelRouter || {}), ...newConfig.modelRouter };
            this.applyModelRouterConfig(this.config.modelRouter);
        }
    }

    setTelegramContext(chatId: string, botToken: string): void {
        this.currentChatId = chatId;
        this.currentBotToken = botToken;
        console.log(`[${this.ts()}] [CTX] setTelegramContext: chatId=${chatId}, botToken=${botToken ? 'SET' : 'EMPTY'}`);
        const sendAudio = this.tools.get('send_audio') as any;
        if (sendAudio?.setContext) sendAudio.setContext(chatId, botToken);
        const sendDocument = this.tools.get('send_document') as any;
        if (sendDocument?.setContext) sendDocument.setContext(chatId, botToken);
    }

    private buildToolDefinitions(): ToolDefinition[] {
        return Array.from(this.tools.values()).map(tool => ({
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters
        }));
    }

    private prioritizeToolDefinitions(toolDefs: ToolDefinition[], preferredTools: string[]): ToolDefinition[] {
        if (preferredTools.length === 0) return toolDefs;

        const order = new Map(preferredTools.map((name, index) => [name, index]));
        return [...toolDefs].sort((a, b) => {
            const aRank = order.has(a.name) ? order.get(a.name)! : Number.MAX_SAFE_INTEGER;
            const bRank = order.has(b.name) ? order.get(b.name)! : Number.MAX_SAFE_INTEGER;
            if (aRank !== bRank) return aRank - bRank;
            return 0;
        });
    }

    private buildSystemPrompt(userText?: string, userId?: string): string {
        // Compact system prompt — only essential info, no context stuffing
        let prompt = this.config.systemPrompt;

        // Add cognitive state and behavioral adaptation
        prompt += '\n\n' + this.buildAdaptiveSystemPrompt(userId);

        try {
            const soul = this.memory.getSetting('soul');
            if (soul) {
                const soulData = JSON.parse(soul);
                if (soulData.principles && soulData.principles.length > 0) {
                    prompt += '\nRegras: ' + soulData.principles.slice(0, 3).join('; ') + '.';
                }
            }
        } catch { /* skip */ }

        try {
            const profile = this.memory.getUserProfile(userId || 'USER_ID_PLACEHOLDER');
            if (profile) {
                prompt += ` Usuario: ${profile.name || 'Usuario'}. Idioma: ${profile.language_preference || 'pt-BR'}.`;
            }
        } catch { /* skip */ }

        return prompt;
    }

    private buildAdaptiveSystemPrompt(userId?: string): string {
        const interactionCount = parseInt(this.memory.getSetting('interaction_count') || '0');
        const state = this.stateManager.getState();
        
        let prompt = `[COGNITIVE STATE] Mode: ${state.mode}, Focus: ${state.current_focus}, Confidence: ${state.confidence.toFixed(2)}\n`;
        
        if (interactionCount < 3) {
            prompt += "USER STATUS: NEW. Guidance level: HIGH. Be more explanatory and helpful. Explain tool usage if needed.\n";
        } else if (interactionCount > 20) {
            prompt += "USER STATUS: VETERAN. Guidance level: LOW. Be direct and concise. Skip obvious explanations.\n";
        }
        
        if (state.confidence > 0.7 && state.current_focus !== 'unknown') {
            prompt += `PROACTIVITY: ENABLED. You may suggest logical next steps related to ${state.current_focus} if they add value.\n`;
        }
        
        return prompt;
    }

    async process(userId: string, text: string): Promise<string> {
        const trace = traceManager.startTrace(userId, text);
        const stateBefore = this.stateManager.getState();
        const conversationId = this.memory.getOrCreateConversation(userId);
        this.memory.addMessage(conversationId, 'user', text);

        let result: string;
        try {
            // Context Validation (pre-run)
            const rawContext = await this.contextBuilder.buildContext(text);
            const validation = this.contextValidator.validate(text, rawContext, stateBefore);

            result = await this.runWithTools(conversationId, text, 0);
            
            // Decision Post-Processing
            result = this.postProcessor.process(result, stateBefore, validation);

            // Cognitive Logging
            console.log('[COGNITIVE_LOG]', JSON.stringify({
                userId,
                intent: text.slice(0, 50),
                state: stateBefore,
                validation,
                adjustmentsApplied: true // Simplified for log
            }));

        } catch (error: any) {
            const activeModel = this.providerFactory.getOllamaProvider()?.getModel() || 'unknown';
            console.error(`[AGENT] Error with model ${activeModel}: ${error.message}`);
            
            // Try fallback model before retry
            const fallbackProfiles = this.modelRouter.getProfiles().filter((p: any) => p.model !== activeModel);
            if (fallbackProfiles.length > 0) {
                const profile = fallbackProfiles[0];
                const ollama = this.providerFactory.getOllamaProvider();
                if (ollama) {
                    ollama.setModel(profile.model);
                    if (profile.server && ollama.getBaseUrl() !== profile.server) {
                        ollama.setBaseUrl(profile.server);
                    }
                    console.log(`[AGENT] Fallback: ${activeModel} → ${profile.model}`);
                }
            }
            
            await this.notifyRetry();
            try {
                result = await this.runWithTools(conversationId, text, 0);
            } catch (retryError: any) {
                const retryModel = this.providerFactory.getOllamaProvider()?.getModel() || 'unknown';
                console.error(`[AGENT] Retry failed with model ${retryModel}: ${retryError.message}`);
                result = 'Nao consegui processar. Tente novamente.';
            }
        }

        result = sanitizeContent(result) || 'Resposta vazia. Tente reformular.';

        // Only replace with generic success if it was likely an HTML creation task
        // and the result is long/raw HTML that shouldn't leak to Telegram chat
        if (result.includes('<!DOCTYPE') || result.includes('<html')) {
            if (result.length > 500) {
                result = '✅ Arquivo criado com sucesso! Acesse via dashboard.';
            }
        }

        // Safety filter for raw command output (ls, cat, etc.)
        if (/^total \d+\n|^drwx|^-[rwx-]{10}\s/.test(result) && result.split('\n').length > 5) {
            result = 'Comando executado com sucesso.';
        }


        this.memory.addMessage(conversationId, 'assistant', result);
        try {
            // Update cognitive state using Stability Guard for transitions
            this.stabilityGuard.requestTransition({}); // Triggers stability calculations
            
            this.stateManager.updateFromInteraction(true, 1.0, 0.0);
            this.skillLearner.observe('interaction_pattern', {
                userId,
                intent: text.slice(0, 50),
                success: true,
                response_length: result.length
            });
            this.scoringEngine.applyDecay();
            
            // Periodic Reconciliation
            const interactionCount = parseInt(this.memory.getSetting('interaction_count') || '0');
            if (interactionCount % 10 === 0) {
                this.reconciliationEngine.reconcile();
            }
        } catch {}
        traceManager.completeTrace(trace, 'completed', result);
        return result;
    }

    private ts(): string { return new Date().toLocaleTimeString('pt-BR', { hour12: false }); }

    /**
     * Classifica o tipo de tarefa do usuário para adaptar o comportamento do loop.
     */
    private async classifyTask(userText: string): Promise<'INFORMACIONAL' | 'INVESTIGATIVA' | 'EXECUTIVA'> {
        try {
            const prompt = `Classifique a tarefa do usuário em uma destas 3 categorias:
- INFORMACIONAL: Perguntas simples, conversas ou solicitações de explicação baseada em conhecimento geral.
- INVESTIGATIVA: Busca de dados, pesquisa na web, análise de arquivos ou cruzamento de informações. Requer evidências.
- EXECUTIVA: Criação de arquivos, execução de comandos, envio de áudios/documentos ou modificação de sistema.

[TAREFA]
${userText}

Responda APENAS com o tipo (INFORMACIONAL, INVESTIGATIVA ou EXECUTIVA).`;

            const response = await llmQueue.add(() => this.providerFactory.chatWithFallback([
                { role: 'system', content: 'Você é um classificador de intenções rápido e preciso.' },
                { role: 'user', content: prompt }
            ], []));

            const type = (response.content || '').toUpperCase();
            if (type.includes('INVESTIGATIVA')) return 'INVESTIGATIVA';
            if (type.includes('EXECUTIVA')) return 'EXECUTIVA';
            return 'INFORMACIONAL';
        } catch {
            return 'INFORMACIONAL';
        }
    }

    /**
     * Valida se a tarefa foi realmente concluída usando o LLM.
     * Equilibra completude, eficiência e relevância para evitar over-execution.
     */
    private async validateCompletion(
        userText: string,
        loopMessages: LLMMessage[],
        partialResult: string,
        startIndex: number,
        taskType: 'INFORMACIONAL' | 'INVESTIGATIVA' | 'EXECUTIVA'
    ): Promise<{ isComplete: boolean, reason?: string }> {
        // Extrai apenas as ações executadas nesta sessão (desde o startIndex)
        const sessionMessages = loopMessages.slice(startIndex);
        const actionsSummary = sessionMessages
            .filter(m => m.role === 'tool')
            .map((m, i) => {
                const idx = sessionMessages.indexOf(m);
                const assistantMsg = sessionMessages[idx - 1];
                const toolName = assistantMsg?.toolCalls?.[0]?.name || 'tool';
                const output = m.content?.slice(0, 150).replace(/\n/g, ' ') || '';
                const status = output.includes('Erro:') ? '❌ FALHA' : '✅ SUCESSO';
                return `${i + 1}. ${status} [${toolName}]: ${output}...`;
            })
            .join('\n');

        const validationPrompt = `Avalie estrategicamente se devemos finalizar a tarefa agora.

[TIPO DE TAREFA]
${taskType}

[OBJETIVO ORIGINAL]
${userText}

[AÇÕES EXECUTADAS]
${actionsSummary || 'Nenhuma ferramenta utilizada nesta etapa.'}

[RESPOSTA FINAL PROPOSTA]
${partialResult || '(Sem resposta textual)'}

---
CRITÉRIOS DE VALIDAÇÃO (OBRIGATÓRIOS):
1. EVIDÊNCIA (Somente para INVESTIGATIVA): A resposta é baseada em dados REAIS obtidos pelas ferramentas ou em suposições? Se for suposição e a tarefa pedir dados, marque como INCOMPLETE.
2. UTILIDADE REAL: A resposta resolve DIRETAMENTE o problema do usuário? Respostas como "vou verificar", "estou analisando" ou "posso fazer isso" são INACEITÁVEIS para finalizar.
3. COMPLETUDE EXECUTIVA (Somente para EXECUTIVA): A ação foi concluída com sucesso? Se o usuário pediu para criar algo e você apenas explicou como, marque como INCOMPLETE.
4. GANHO MARGINAL: Novas ações trariam informações CRÍTICAS? Se o ganho for baixo e a utilidade já for alta, pode marcar como COMPLETE.
5. ADAPTAÇÃO: Se a pergunta for simples, priorize rapidez. Se exigir precisão (dados/código), priorize completude.

Responda APENAS:
- "COMPLETE" (se houver evidência/utilidade suficiente e a tarefa estiver resolvida)
ou
- "INCOMPLETE: <motivo detalhado do que falta ou falhou>"`;

        try {
            console.log(`[${this.ts()}] [VALIDATION] Asking LLM for strategic completion check (${taskType})...`);
            const response = await llmQueue.add(() => this.providerFactory.chatWithFallback([
                { role: 'system', content: 'Você é um estrategista de IA focado em utilidade, evidência e eficiência. Não aceite respostas vazias ou baseadas em suposições para tarefas investigativas.' },
                { role: 'user', content: validationPrompt }
            ], []));

            const content = (response.content || '').trim();
            console.log(`[${this.ts()}] [VALIDATION] Result: ${content.slice(0, 100)}`);

            if (content.toUpperCase().startsWith('COMPLETE')) {
                // Proteção extra contra respostas de "vou verificar" que o LLM de validação possa ter deixado passar
                const lowContent = partialResult.toLowerCase();
                if (lowContent.length < 30 && (lowContent.includes('vou') || lowContent.includes('analisando') || lowContent.includes('verificar'))) {
                    return { isComplete: false, reason: 'Resposta muito curta ou evasiva.' };
                }
                return { isComplete: true };
            }
            
            if (content.toUpperCase().startsWith('INCOMPLETE:')) {
                return { isComplete: false, reason: content.substring(11).trim() };
            }

            return { isComplete: true };
        } catch (err) {
            console.error(`[${this.ts()}] [VALIDATION] Error:`, err);
            return { isComplete: true };
        }
    }

    /**
     * Main loop — native tool calling (like OpenClaw)
     * 
     * Tool results are ALWAYS fed back to the LLM.
     * The LLM formats the response naturally — no raw output leaks to the user.
     * Only send_audio returns directly (already sent via Telegram).
     */
    private async runWithTools(conversationId: string, userText: string, iteration: number, userId?: string): Promise<string> {
        if (iteration >= this.maxIterations) {
            return 'Nao consegui completar a tarefa apos varias tentativas.';
        }

        // Classificação inicial da tarefa para adaptar o loop
        const taskType = await this.classifyTask(userText);
        console.log(`[${this.ts()}] [CLASSIFIER] Task Type: ${taskType}`);

        // Update attention context with current interaction
        const attentionLayer = this.memory.getAttentionLayer();
        if (attentionLayer) {
            attentionLayer.updateContext({
                recentInteraction: userText.slice(0, 100),
            });
        }

        // Contextual message retrieval: recent messages + relevant history
        const recentMessages = this.memory.getRecentMessages(conversationId, 6);
        
        // Search relevant past messages based on user's query (skip for very short inputs like "oi")
        let relevantMessages: Message[] = [];
        if (userText.trim().length > 3) {
            try {
                relevantMessages = this.memory.searchMessages(conversationId, userText, 6);
                console.log(`[LOOP] searchMessages found ${relevantMessages.length} relevant messages`);
                // Deduplicate: don't include messages already in recentMessages
                const recentIds = new Set(recentMessages.map(m => m.id));
                relevantMessages = relevantMessages.filter(m => !recentIds.has(m.id));
                // Limit to 4 relevant messages to keep context lean
                relevantMessages = relevantMessages.slice(-4);
            } catch (err) { console.log(`[LOOP] searchMessages error: ${err}`); }
        }
        
        // Use ContextBuilder for intelligent context selection
        const context = await this.contextBuilder.buildContext(userText);
        const skillContext = this.skillLearner.buildSkillContext(userText, 2);
        const toolHints = this.skillLearner.getToolHints(userText);
        const preferredTools = Array.from(new Set([
            ...(skillContext?.preferredTools || []),
            ...this.skillLearner.getRecommendedTools(userText)
        ])).slice(0, 3);
        const now = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'full', timeStyle: 'short' });
        const toolDefs = this.prioritizeToolDefinitions(this.buildToolDefinitions(), preferredTools);

        // Build conversation context: relevant history + recent + current message
        const contextMessages: LLMMessage[] = [];
        
        // Add relevant historical messages as context summary
        if (relevantMessages.length > 0) {
            const historySummary = relevantMessages
                .map(m => `${m.role === 'user' ? 'Usuario' : 'Assistente'}: ${m.content?.slice(0, 300)}`)
                .join('\n');
            contextMessages.push({ role: 'system', content: `[CONTEXTO ANTERIOR - LEIA E USE ESTAS INFORMACOES]\n${historySummary}\n[FIM DO CONTEXTO ANTERIOR - NAO diga que nao se lembra, as informacoes estao acima]` });
        }
        
        // Add recent messages (last 6)
        contextMessages.push(...recentMessages.map(m => ({ role: m.role as LLMMessage['role'], content: m.content })));
        // Add current user message
        contextMessages.push({ role: 'user', content: userText });
        
        const systemSections = [
            this.config.languageDirective,
            this.buildSystemPrompt(userText),
            skillContext && skillContext.confidence >= 0.7 ? `[SKILL LEARNER]\n${skillContext.text}` : '',
            toolHints ? `[TOOL HINTS]\n${toolHints}` : '',
            `Data: ${now}`,
            context
        ].filter(Boolean);

        const messages: LLMMessage[] = [
            { role: 'system', content: systemSections.join('\n\n') },
            ...contextMessages
        ];

        const compressedMessages = messages.length > 20 ? await this.compressor.compress(messages) : messages;

        const contextSize = compressedMessages.reduce((sum, m) => sum + (m.content?.length || 0), 0);
        const toolDefsSize = JSON.stringify(toolDefs).length;
        
        // Route to best model for this query (async LLM classification)
        const chatProfile = await this.modelRouter.route(userText);
        const executionProfile = this.modelRouter.getExecutionProfile();
        
        // Determinar modelo inicial: tarefas complexas usam execução desde o início
        const needsExecutionModel = chatProfile.category === 'code' || 
                                   chatProfile.category === 'analysis' || 
                                   chatProfile.category === 'execution' ||
                                   userText.length > 500; // Queries muito longas

        const activeProfile = needsExecutionModel ? executionProfile : chatProfile;

        const ollama = this.providerFactory.getOllamaProvider();
        if (ollama) {
            const currentModel = ollama.getModel();
            if (currentModel !== activeProfile.model) {
                ollama.setModel(activeProfile.model);
                if (activeProfile.server && ollama.getBaseUrl() !== activeProfile.server) {
                    ollama.setBaseUrl(activeProfile.server);
                }
                console.log(`[${this.ts()}] [MODEL_ROUTER] ${needsExecutionModel ? 'Execution Mode' : 'Chat Mode'}: ${activeProfile.model} (cat: ${chatProfile.category})`);
            }
        }
        
        console.log(`[${this.ts()}] [LLM] Calling (iteration ${iteration}) | context: ${contextSize} chars | model: ${activeProfile.model}`);
        const llmStartTime = Date.now();

        const response = await llmQueue.add(() => this.providerFactory.chatWithFallback(compressedMessages, toolDefs));

        const llmDuration = ((Date.now() - llmStartTime) / 1000).toFixed(1);
        const tokensInfo = response.usage ? ` | in:${response.usage.prompt_tokens} out:${response.usage.completion_tokens}` : '';
        console.log(`[${this.ts()}] [LLM] Response in ${llmDuration}s | model: ${activeProfile.model}${tokensInfo}`);

        // ── UNIFIED TOOL & VALIDATION LOOP ──────────────────────────
        let loopMessages: LLMMessage[] = [...compressedMessages];
        let currentLLMResponse = response;
        let validationCount = 0;
        const maxValidations = 2; // Até 2 ciclos extras de validação
        const maxSteps = 12; // Limite total de passos (ferramentas + respostas)
        const startIndex = loopMessages.length; // Para o resumo de ações na validação

        const executionHistory = new Map<string, { successCount: number, failCount: number, lastError?: string }>();

        for (let step = 0; step < maxSteps; step++) {
            // Build history summary to help LLM avoid loops
            let historySummary = '';
            if (executionHistory.size > 0) {
                historySummary = '\n\n[HISTÓRICO RECENTE DE EXECUÇÃO]\n';
                executionHistory.forEach((stats, toolName) => {
                    const status = stats.failCount > 0 
                        ? `falhou ${stats.failCount} vez(es)${stats.successCount > 0 ? ' (e funcionou em outras)' : ''}` 
                        : 'funcionando normalmente';
                    historySummary += `- Tool: ${toolName}\n  Status: ${status}\n`;
                    if (stats.lastError && stats.failCount > 0) {
                        historySummary += `  Último Erro: ${stats.lastError.slice(0, 150)}\n`;
                    }
                });
                historySummary += '\nInstrução:\nSe uma ferramenta falhou repetidamente, não tente a mesma coisa. Escolha uma nova abordagem para resolver o problema.';
            }

            const currentToolCall = currentLLMResponse.toolCalls?.[0];

            if (currentToolCall) {
                // --- EXECUÇÃO DE FERRAMENTA ---
                const toolName = currentToolCall.name;
                const toolParams = currentToolCall.arguments;
                
                // GARANTIR MODELO DE EXECUÇÃO: Se houve tool call, as próximas decisões DEVEM ser feitas pelo execution model
                if (ollama && ollama.getModel() !== executionProfile.model) {
                    console.log(`[${this.ts()}] [LOOP] Switching to Execution Model for tool loop: ${executionProfile.model}`);
                    ollama.setModel(executionProfile.model);
                    if (executionProfile.server) ollama.setBaseUrl(executionProfile.server);
                }

                console.log(`[${this.ts()}] [LOOP] Step ${step + 1}: ${toolName}(${JSON.stringify(toolParams).slice(0, 80)})`);
                
                const tool = this.tools.get(toolName);
                if (!tool) {
                    const errorMsg = `Erro: Ferramenta '${toolName}' não encontrada.`;
                    const stats = executionHistory.get(toolName) || { successCount: 0, failCount: 0 };
                    executionHistory.set(toolName, { ...stats, failCount: stats.failCount + 1, lastError: errorMsg });

                    loopMessages.push(
                        { role: 'assistant', content: currentLLMResponse.content || '', toolCalls: [currentToolCall] },
                        { role: 'tool', content: errorMsg }
                    );
                    
                    // Inject history into the prompt
                    const tempMessages = [...loopMessages];
                    if (historySummary) tempMessages.push({ role: 'user', content: historySummary });

                    currentLLMResponse = await this.callLLMWithFallback(tempMessages, toolDefs, chatProfile);
                    continue;
                }
                
                const startTime = Date.now();
                let toolResult: ToolResult;
                try {
                    toolResult = await tool.execute(toolParams);
                } catch (error: any) {
                    toolResult = { success: false, output: '', error: error.message };
                }
                const elapsed = Date.now() - startTime;
                console.log(`[${this.ts()}] [LOOP] ${toolName} ${toolResult.success ? '✓' : '✗'} in ${elapsed}ms`);
                
                // Update Execution History
                const stats = executionHistory.get(toolName) || { successCount: 0, failCount: 0 };
                if (toolResult.success) {
                    executionHistory.set(toolName, { ...stats, successCount: stats.successCount + 1 });
                } else {
                    executionHistory.set(toolName, { ...stats, failCount: stats.failCount + 1, lastError: toolResult.error });
                }

                try { this.skillLearner.recordPattern(userText, toolName, toolResult.success, elapsed); } catch {}
                
                // Retornos imediatos (Telegram)
                if (toolResult.success && (toolName === 'send_document' || toolName === 'send_audio')) {
                    return toolResult.output || (toolName === 'send_document' ? '📄 Documento enviado!' : '🔊 Áudio enviado!');
                }
                
                // Prepara output para o próximo passo
                const maxOutput = 2000;
                let toolOutput = (toolResult.success ? toolResult.output : `Erro: ${toolResult.error || 'desconhecido'}`) || '';
                if (toolOutput.length > maxOutput) {
                    toolOutput = toolOutput.slice(0, maxOutput) + '\n\n[... conteúdo truncado]';
                }
                
                if (toolResult.success && toolName === 'memory_write' && toolParams.id) {
                    this.scoringEngine.calibrate(toolParams.id, 'consistent');
                    toolOutput += '\n\n[UX] Confirme a gravação na memória de forma amigável.';
                }

                loopMessages.push(
                    { role: 'assistant', content: currentLLMResponse.content || '', toolCalls: [currentToolCall] },
                    { role: 'tool', content: toolOutput }
                );
                
                // Próxima decisão do LLM (sempre usando o modelo ativo, que agora é o de execução)
                // Inject history into the prompt
                const tempMessages = [...loopMessages];
                if (historySummary) tempMessages.push({ role: 'user', content: historySummary });

                currentLLMResponse = await this.callLLMWithFallback(tempMessages, toolDefs, chatProfile);
            } else {
                // --- RESPOSTA DE TEXTO / VALIDAÇÃO ---
                const textResponse = sanitizeContent(currentLLMResponse.content || '');
                
                // Valida se terminou mesmo
                const validation = await this.validateCompletion(userText, loopMessages, textResponse, startIndex, taskType);
                
                if (validation.isComplete) {
                    return textResponse || 'Tarefa concluída com sucesso.';
                }

                // Tarefa incompleta
                if (validationCount >= maxValidations) {
                    console.log(`[${this.ts()}] [VALIDATION] Max validations reached. Returning best effort.`);
                    return (textResponse || '') + `\n\n(Aviso: A tarefa pode estar incompleta: ${validation.reason})`;
                }

                console.log(`[${this.ts()}] [VALIDATION] Task INCOMPLETE: ${validation.reason}. Retrying cycle ${validationCount + 1}...`);
                validationCount++;
                
                loopMessages.push({ 
                    role: 'user', 
                    content: `[SISTEMA: VALIDAÇÃO DE COMPLETUDE]\nA tarefa ainda não foi concluída totalmente.\nPENDÊNCIA: ${validation.reason}\n\nPor favor, execute as ações necessárias ou encontre as informações que faltam. Use as ferramentas disponíveis se precisar.` 
                });
                
                // Inject history into the prompt
                const tempMessages = [...loopMessages];
                if (historySummary) tempMessages.push({ role: 'user', content: historySummary });

                // Tenta novamente com o contexto atualizado
                currentLLMResponse = await this.callLLMWithFallback(tempMessages, toolDefs, chatProfile);
            }
        }

        // Fim dos passos sem conclusão definitiva
        return sanitizeContent(currentLLMResponse.content || '') || 'Não consegui concluir todas as etapas a tempo.';
    }

    /**
     * Determine if a tool result needs LLM continuation or can return directly.
     */
    private needsLLMContinuation(toolName: string, params: Record<string, any>): boolean {
        if (toolName === 'send_document' || toolName === 'send_audio') return false;
        if (toolName === 'memory_admin') return false;
        if (toolName === 'file_ops' && params.action !== 'read') return false;
        return true;
    }

    private async notifyRetry(): Promise<void> {
        if (!this.currentChatId || !this.currentBotToken) return;
        try {
            await fetch(`https://api.telegram.org/bot${this.currentBotToken}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: this.currentChatId, text: '\u23f3 Tentando novamente...' })
            });
        } catch { /* ignore */ }
    }

    /**
     * Auxiliar para chamadas do LLM com fallback inteligente.
     * Se o modelo de execução falhar, tenta o modelo de chat como último recurso.
     */
    private async callLLMWithFallback(messages: LLMMessage[], toolDefs: ToolDefinition[], chatProfile: any): Promise<any> {
        try {
            return await llmQueue.add(() => this.providerFactory.chatWithFallback(messages, toolDefs));
        } catch (error: any) {
            console.warn(`[AGENT] Model execution failed: ${error.message}. Attempting smart fallback to Chat model.`);
            
            const ollama = this.providerFactory.getOllamaProvider();
            if (ollama) {
                ollama.setModel(chatProfile.model);
                if (chatProfile.server) ollama.setBaseUrl(chatProfile.server);
            }
            
            return await llmQueue.add(() => this.providerFactory.chatWithFallback(messages, toolDefs));
        }
    }
}
