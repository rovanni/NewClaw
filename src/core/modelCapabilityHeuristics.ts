import { ModelCapability } from './providerTypes';

/**
 * Mapeia as capabilities REAIS que o Ollama devolve em /api/tags (confirmado em produção contra
 * Ollama local: 'completion'|'tools'|'vision'|'thinking'|'insert'|'embedding') para o vocabulário
 * interno. Preferir sempre isto a guessCapabilities() quando o provider expõe o campo — só
 * OpenAI-Compatible genérico (/v1/models não devolve capabilities) precisa da heurística por nome.
 */
export function mapOllamaCapabilities(raw: string[]): ModelCapability[] {
    const caps = new Set<ModelCapability>();
    for (const c of raw) {
        switch (c) {
            case 'completion': caps.add('chat'); break;
            case 'tools':      caps.add('tool_calling'); break;
            case 'vision':     caps.add('vision'); break;
            case 'thinking':   caps.add('reasoning'); break;
            case 'insert':     caps.add('code'); break;
            case 'embedding':  caps.add('embedding'); break;
        }
    }
    return [...caps];
}

/** Formata um context window em tokens pro rótulo curto usado na UI (ex: 262144 → "256K"). */
export function formatContextWindow(tokens?: number): string {
    if (!tokens) return '—';
    if (tokens >= 1_000_000) return `${Math.round(tokens / 1_000_000)}M`;
    if (tokens >= 1_000) return `${Math.round(tokens / 1024)}K`;
    return String(tokens);
}

/**
 * Infere capacidades a partir do NOME do modelo. Heurística declarada, não detecção real —
 * usada apenas quando o provider (ex: OpenAI-Compatible genérico) não expõe capabilities reais.
 * Ver docs/issues/014-model-registry-roadmap-fatias-2-4.md item 3 para evolução futura.
 */
export function guessCapabilities(modelId: string): ModelCapability[] {
    const id = modelId.toLowerCase();
    const isEmbeddingOnly = /(embed|embedding|nomic|bge-|e5-)/.test(id);

    // Modelos de embedding são de propósito único — não servem chat/tool calling. Retornar cedo
    // evita que a UI (Model Router) os sugira como opção pra categoria "chat".
    if (isEmbeddingOnly) return ['embedding'];

    const caps: ModelCapability[] = ['chat', 'tool_calling'];

    if (/(^|[-:/])(vl|vision|llava|gemma3|qwen.?vl|pixtral|moondream)([-:]|$)/.test(id) || id.includes('vision')) {
        caps.push('vision');
    }
    if (/(coder|code|deepseek-coder|starcoder|codestral)/.test(id)) {
        caps.push('code');
    }
    if (/(r1|reasoning|qwq|o1|think)/.test(id)) {
        caps.push('reasoning');
    }

    return [...new Set(caps)];
}
