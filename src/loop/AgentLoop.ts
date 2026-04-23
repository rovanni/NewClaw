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

    public getStateManager(): AgentStateManager {
        return this.stateManager;
    }

    updateConfig(updates: Partial<AgentLoopConfig>): void {
        this.config = { ...this.config, ...updates };
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
        this.config = {
            languageDirective: config?.languageDirective || 'Responda SEMPRE em português brasileiro. Seja direto e conciso.',
            systemPrompt: config?.systemPrompt || 'Voce e o NewClaw, um agente cognitivo local. Ao usar ferramentas (tools), seja extremamente preciso com nomes de arquivos e caminhos. NUNCA mostre codigo tecnico ou saida de comandos ao usuario. Sempre formate a resposta de forma natural e amigavel. IMPORTANTE: Voce tem acesso ao historico completo da conversa — quando o usuario se referir a algo mencionado antes (ex: "esses valores", "aquele arquivo", "o que acabamos de falar"), USE as informacoes do contexto anterior relevante que esta disponivel. NUNCA diga que nao se lembra ou que nao tem acesso ao historico. EDICAO DE ARQUIVOS: Para modificar um arquivo existente, use file_ops com uma destas acoes: (1) action=replace — troca texto exato (target e replacement). (2) action=patch — troca por numero de linha (startLine, endLine, content). (3) action=append — adiciona conteudo ao final do arquivo. NUNCA recrie o arquivo inteiro com action=create se ele ja existe — isso apaga todo o conteudo original. Para edicoes grandes em HTML/CSS/JS, prefira action=patch com numeros de linha.'
        };
    }

    registerTool(tool: ToolExecutor): void {
        this.tools.set(tool.name, tool);
    }

    setTelegramContext(chatId: string, botToken: string): void {
        this.currentChatId = chatId;
        this.currentBotToken = botToken;
        console.log(`[${this.ts()}] [CTX] setTelegramContext: chatId=${chatId}, botToken=${botToken ? 'SET' : 'EMPTY'}`);
        const sendAudio = this.tools.get('send_audio') as any;
        if (sendAudio?.setContext) sendAudio.setContext(chatId, botToken);
        const sendDocument = this.tools.get('send_document') as any;
        if (sendDocument?.setContext) sendDocument.setContext(chatId, botToken);
        console.log(`[${this.ts()}] [CTX] send_document chatId=${(sendDocument as any)?.chatId || 'NOT_SET'}, botToken=${(sendDocument as any)?.botToken ? 'SET' : 'EMPTY'}`);
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
        const conversationId = this.memory.getOrCreateConversation(userId);
        this.memory.addMessage(conversationId, 'user', text);

        // Log removed to avoid duplication with input handlers

        let result: string;
        try {
            result = await this.runWithTools(conversationId, text, 0);
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
            this.stateManager.updateFromInteraction(true, 1.0, 0.0);
            this.skillLearner.observe('interaction_pattern', {
                userId,
                intent: text.slice(0, 50),
                success: true,
                response_length: result.length
            });
            this.scoringEngine.applyDecay();
        } catch {}
        traceManager.completeTrace(trace, 'completed', result);
        return result;
    }

    /**
     * Main loop — native tool calling (like OpenClaw)
     * 
     * KEY CHANGE: Tool results are ALWAYS fed back to the LLM.
     * The LLM formats the response naturally — no raw output leaks to the user.
     * Only send_audio returns directly (already sent via Telegram).
     */
    private ts(): string { return new Date().toLocaleTimeString('pt-BR', { hour12: false }); }
    private async runWithTools(conversationId: string, userText: string, iteration: number, userId?: string): Promise<string> {
        if (iteration >= this.maxIterations) {
            return 'Nao consegui completar a tarefa apos varias tentativas.';
        }

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
        const userProfile = await this.modelRouter.route(userText);
        const ollama = this.providerFactory.getOllamaProvider();
        if (ollama) {
            const currentModel = ollama.getModel();
            if (currentModel !== userProfile.model) {
                ollama.setModel(userProfile.model);
                if (userProfile.server && ollama.getBaseUrl() !== userProfile.server) {
                    ollama.setBaseUrl(userProfile.server);
                }
                console.log(`[${this.ts()}] [MODEL_ROUTER] Switched: ${currentModel} → ${userProfile.model} (${userProfile.category})`);
            }
        }
        
        console.log(`[${this.ts()}] [LLM] Calling with ${toolDefs.length} tools (iteration ${iteration}) | context: ${contextSize} chars | tools: ${toolDefsSize} chars | total: ${contextSize + toolDefsSize} chars | model: ${userProfile.model}`);
        const llmStartTime = Date.now();

        const response = await llmQueue.add(() => this.providerFactory.chatWithFallback(compressedMessages, toolDefs));

        const llmDuration = ((Date.now() - llmStartTime) / 1000).toFixed(1);
        const tokensInfo = response.usage ? ` | in:${response.usage.prompt_tokens} out:${response.usage.completion_tokens}` : '';
        console.log(`[${this.ts()}] [LLM] Response in ${llmDuration}s | model: ${userProfile.model}${tokensInfo}`);

        // ── ITERATIVE TOOL LOOP (max 3 steps) ──────────────────────────
        // LLM decides tool → execute → LLM decides next action or final response
        if (response.toolCalls && response.toolCalls.length > 0) {
            let currentToolDefs = toolDefs;
            let loopMessages: LLMMessage[] = [...compressedMessages];
            // Track executed actions to avoid repeats
            const executedActions: string[] = [];
            
            let currentLLMResponse = response;
            for (let step = 0; step < 6; step++) {
                // Call LLM for next steps
                if (step > 0) {
                    currentLLMResponse = await llmQueue.add(() => this.providerFactory.chatWithFallback(loopMessages, currentToolDefs));
                }
                
                const currentToolCall = currentLLMResponse.toolCalls?.[0];
                
                if (!currentToolCall) {
                    // LLM returned text instead of tool call — return it
                    const textResponse = sanitizeContent(currentLLMResponse.content || '');
                    return textResponse || 'Ação concluída.';
                }
                
                const toolName = currentToolCall.name;
                const toolParams = currentToolCall.arguments;
                const actionKey = `${toolName}:${toolParams.action || toolParams.path || ''}`;
                
                executedActions.push(actionKey);
                
                console.log(`[${this.ts()}] [LOOP] Step ${step + 1}/6: ${toolName}(${JSON.stringify(toolParams).slice(0, 80)}) | model: ${ollama?.getModel() || userProfile.model}`);
                
                const tool = this.tools.get(toolName);
                if (!tool) break;
                
                // Execute tool
                const startTime = Date.now();
                let toolResult: ToolResult;
                try {
                    toolResult = await tool.execute(toolParams);
                } catch (error: any) {
                    toolResult = { success: false, output: '', error: error.message };
                }
                const elapsed = Date.now() - startTime;
                console.log(`[${this.ts()}] [LOOP] ${toolName} ${toolResult.success ? '✓' : '✗'} in ${elapsed}ms | model: ${ollama?.getModel() || userProfile.model}`);
                
                try { this.skillLearner.recordPattern(userText, toolName, toolResult.success, elapsed); } catch {}
                
                // ── Immediate returns (no more LLM calls needed) ──
                if (toolResult.success && (toolName === 'send_document' || toolName === 'send_audio')) {
                    return toolResult.output || (toolName === 'send_document' ? '📄 Documento enviado!' : '🔊 Áudio enviado!');
                }
                
                // ── Direct returns ONLY for truly final actions ──
                // file_ops(create) is NOT final — needs send_document after
                const isTrulyFinal = false;
                if (toolResult.success && isTrulyFinal) {
                    const directResponse = this.responseBuilder.buildResponse(toolName, toolParams, toolResult);
                    if (directResponse) {
                        console.log(`[${this.ts()}] [LOOP] ${toolName} → direct response (no LLM)`);
                        return directResponse;
                    }
                }
                
                // ── Prepare context for next iteration ──
                const maxOutput = 2000;
                let toolOutput = (toolResult.success ? toolResult.output : `Erro: ${toolResult.error || 'desconhecido'}`) || '';
                if (toolOutput.length > maxOutput) {
                    toolOutput = toolOutput.slice(0, maxOutput) + '\n\n[... conteúdo truncado]';
                }
                
                if (toolResult.success && toolName === 'memory_write') {
                    toolOutput += '\n\n[UX] Responda ao usuario de forma educada e natural. Confirme o que voce entendeu e, quando fizer sentido, diga que isso foi salvo na memoria. Nao responda apenas com texto tecnico.';
                }
                // Keep context growing so the LLM remembers executed steps
                loopMessages.push(
                    { role: 'assistant', content: currentLLMResponse.content || '', toolCalls: [currentToolCall] },
                    { role: 'tool', content: toolOutput }
                );
                
                currentToolDefs = toolDefs;
            }
            
            // Max iterations reached — ask LLM for final response
            try {
                console.log(`[${this.ts()}] [LOOP] Final LLM call after 6 tool steps...`);
                const finalResponse = await llmQueue.add(() => this.providerFactory.chatWithFallback(loopMessages, []));
                const finalContent = sanitizeContent(finalResponse.content || '');
                console.log(`[${this.ts()}] [LOOP] Final response: ${finalContent.slice(0, 100)}${finalContent.length > 100 ? '...' : ''} (${finalContent.length} chars)`);
                return finalContent || 'Concluí as ações, mas não consegui gerar uma resposta detalhada. Pode perguntar de novo?';
            } catch (err) {
                console.log(`[${this.ts()}] [LOOP] Final LLM call FAILED: ${err}`);
                return 'Concluí as ações solicitadas, mas tive dificuldade ao gerar a resposta final. Pode me perguntar o resultado?';
            }
        }

            // No tool calls — pure text response
        const content = sanitizeContent(response.content || '');
        if (content) return content;

        // Empty response — retry with simpler prompt and fallback model
        const currentModel = this.providerFactory.getOllamaProvider()?.getModel() || 'unknown';
        if (iteration < 1) {
            // Try fallback model for empty response
            const fallbackProfiles = this.modelRouter.getProfiles().filter((p: any) => p.model !== currentModel);
            if (fallbackProfiles.length > 0) {
                const profile = fallbackProfiles[0];
                const ollama = this.providerFactory.getOllamaProvider();
                if (ollama) {
                    ollama.setModel(profile.model);
                    console.log(`[AGENT] Empty response from ${currentModel}, retrying with ${profile.model}`);
                }
            }
            return this.runWithTools(conversationId, 'Responda a mensagem anterior de forma simples.', iteration + 1);
        }
        console.error(`[AGENT] Empty response from model ${currentModel} after retry`);
        return 'Não consegui gerar uma resposta. Tente novamente.';

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
}
