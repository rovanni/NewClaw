import { OpenAIProvider } from './OpenAIProvider';

/**
 * Groq fala a mesma API OpenAI-Compatible que `OpenAIProvider` já implementa (a própria Groq
 * descreve o endpoint como "OpenAI-compatible format") — herda `chat()`/`discoverModels()`
 * inteiros em vez de reimplementá-los (D-07, docs/ARCHITECTURE/INVENTARIO_DUPLICACAO_2026-08-24.md).
 * Mesmo padrão já usado por `OpenRouterProvider` (`OpenAIProvider.ts`) — não uma abstração nova.
 *
 * Mesma comparação estrutural feita para `DeepSeekProvider` (ver comentário lá) — nenhum
 * comportamento herdado é ilegítimo pra Groq. A conversão de imagem herdada fecha o mesmo risco
 * do S192: a Groq expõe modelos `llama-3.2-*-vision` no catálogo, e nada impedia
 * `visionProfile.provider` apontar pra cá sem a imagem nunca chegar ao modelo.
 */
export class GroqProvider extends OpenAIProvider {
    constructor(apiKey: string, model: string = 'llama-3.3-70b-versatile') {
        super(apiKey, model, 'https://api.groq.com/openai/v1', 'groq');
        this.name = 'groq';
    }
}
