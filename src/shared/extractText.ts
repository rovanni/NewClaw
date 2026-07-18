/**
 * extractText — extração leve de texto de uma resposta de LLM (raw ou JSON de controle).
 * Sem estrutura, sem avaliação, sem roteamento — apenas texto legível.
 *
 * Extraído de `loop/ResponseBuilder.ts` (ARCH-003, docs/refatoracao-arquitetural-2026/ARCHITECTURAL_BACKLOG.md) — é a única
 * peça de `ResponseBuilder.ts` consumida por `memory/conversational/CMIIngestionPipeline.ts`,
 * que não precisa (nem deveria depender em runtime) do resto do pipeline de resposta do
 * `AgentLoop` (normalizeResponse, ResponseBuilder, ContextValidator, DecisionPostProcessor —
 * esses continuam em `loop/ResponseBuilder.ts`, que reexporta esta função pra não quebrar seus
 * próprios consumidores em `loop/`).
 */

/** Resultado de extração leve — apenas o texto. */
export type ExtractedText = string;

export function extractText(content: string): ExtractedText {
    if (!content || !content.trim()) return '';

    try {
        const parsed = JSON.parse(content);
        if (parsed?.action?.content) return parsed.action.content;
        if (parsed?.content) return parsed.content;
        if (typeof parsed === 'string') return parsed;
        // thought + tool-action é JSON de controle interno — nunca deve chegar ao usuário
        if (parsed?.thought && parsed?.action && (parsed.action.type === 'tool' || parsed.action.name)) return '';
        if (parsed?.thought && parsed?.action?.type === 'final_answer') return parsed.action.content ?? '';
    } catch { /* não é JSON */ }

    try {
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            if (parsed?.action?.content) return parsed.action.content;
            if (parsed?.content) return parsed.content;
            if (parsed?.thought && parsed?.action && (parsed.action.type === 'tool' || parsed.action.name)) return '';
        }
    } catch { /* não é JSON */ }

    let text = content;
    text = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
    text = text.replace(/<\/?think>/gi, '');
    text = text.replace(/\[TOOL_CALL\][\s\S]*?\[\/TOOL_CALL\]/gi, '');

    const codeFenceMatch = text.match(/^```[\s\S]*?```\s*$/);
    if (codeFenceMatch) {
        text = text.replace(/^```\w*\n?/, '').replace(/\n?```\s*$/, '');
    }

    return text.trim();
}
