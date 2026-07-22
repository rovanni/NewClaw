import { ModelCapability } from './providerTypes';

/**
 * Infere capacidades a partir do NOME do modelo. Heurística declarada, não detecção real —
 * a maioria dos endpoints de discovery (/api/tags, /v1/models) não devolve capacidades.
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
