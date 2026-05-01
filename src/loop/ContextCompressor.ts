/**
 * ContextCompressor — DEPRECATED: Compression is now handled by SessionManager.maybeCompress()
 * 
 * This class is kept as a utility for SessionManager, which delegates LLM-based
 * summarization to this compressor while managing checkpoints and transcripts
 * independently.
 * 
 * DO NOT use this class directly in AgentLoop — use SessionContext instead.
 */

import { ProviderFactory, LLMMessage } from '../core/ProviderFactory';
import { createLogger } from '../shared/AppLogger';
const log = createLogger('Contextcompressor');

const MAX_CONTEXT_CHARS = 12000; // ~3000 tokens max for context

export class ContextCompressor {
    private providerFactory: ProviderFactory;

    constructor(providerFactory: ProviderFactory) {
        this.providerFactory = providerFactory;
    }

    /**
     * Compress messages if they exceed the context limit.
     * Keeps system message + last 2 messages intact, summarizes the rest.
     */
    async compress(messages: LLMMessage[]): Promise<LLMMessage[]> {
        const totalChars = messages.reduce((sum, m) => sum + (m.content?.length || 0), 0);
        
        // No compression needed
        if (totalChars <= MAX_CONTEXT_CHARS || messages.length <= 4) {
            return messages;
        }

        log.info(`Compressing ${messages.length} messages (${Math.round(totalChars / 4)} tokens) → keeping last 4`);

        // Keep system message + last 4 messages
        const systemMsg = messages.find(m => m.role === 'system');
        const recentMessages = messages.slice(-4);
        const oldMessages = messages.filter(m => m.role !== 'system').slice(0, -4);

        if (oldMessages.length === 0) {
            return messages;
        }

        // Summarize old messages
        const summary = await this.summarize(oldMessages);

        const compressed: LLMMessage[] = [];
        if (systemMsg) compressed.push(systemMsg);
        
        compressed.push({
            role: 'system',
            content: `[Resumo da conversa anterior]\n${summary}`
        });

        compressed.push(...recentMessages);

        const newTotal = compressed.reduce((sum, m) => sum + (m.content?.length || 0), 0);
        log.info(`${totalChars} → ${newTotal} chars (saved ${Math.round((1 - newTotal / totalChars) * 100)}%)`);

        return compressed;
    }

    private async summarize(messages: LLMMessage[]): Promise<string> {
        const conversationText = messages
            .filter(m => m.role !== 'system')
            .map(m => `${m.role === 'user' ? 'Usuário' : 'Assistente'}: ${m.content?.slice(0, 500)}`)
            .join('\n');

        const summaryPrompt: LLMMessage[] = [
            { role: 'system', content: 'Você é um assistente de resumo. Resuma a conversa em português de forma concisa, mantendo fatos, decisões e informações importantes. Máximo 200 palavras.' },
            { role: 'user', content: `Resuma esta conversa:\n\n${conversationText}` }
        ];

        try {
            const response = await this.providerFactory.getProvider().chat(summaryPrompt);
            return response.content || 'Conversa anterior resumida.';
        } catch {
            // Fallback: just keep key points from each message
            return messages
                .filter(m => m.role === 'user')
                .map(m => `- ${m.content?.slice(0, 100)}`)
                .join('\n');
        }
    }
}