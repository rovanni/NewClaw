import { ModelCapability } from './providerTypes';

// Único ponto de detecção de "modelo de código" por nome — usado tanto por guessCapabilities()
// (heurística pura, sem sinal real) quanto por mapOllamaCapabilities() (ver comentário abaixo
// sobre por que precisa disso mesmo com capabilities reais do Ollama).
const CODE_NAME_PATTERN = /(coder|code|deepseek-coder|starcoder|codestral)/;

/**
 * Mapeia as capabilities REAIS que o Ollama devolve em /api/tags (confirmado em produção contra
 * Ollama local: 'completion'|'tools'|'vision'|'thinking'|'insert'|'embedding') para o vocabulário
 * interno. Preferir sempre isto a guessCapabilities() quando o provider expõe o campo — só
 * OpenAI-Compatible genérico (/v1/models não devolve capabilities) precisa da heurística por nome.
 *
 * Exceção: 'code'. O Ollama não tem uma flag real equivalente a "modelo treinado pra código" —
 * 'insert' sinaliza só suporte a fill-in-middle (autocomplete de IDE), um recurso técnico bem mais
 * estreito. Confirmado em produção (2026-07-25): kimi-k2.7-code:cloud, um modelo de código de
 * verdade, reporta capabilities=[vision,thinking,completion,tools] — sem 'insert' — e por isso
 * nunca aparecia na categoria "Código" do Model Router. Por não existir sinal real pra essa
 * categoria específica, complementamos sempre com a detecção por nome (mesmo padrão usado em
 * guessCapabilities), em vez do "ou capabilities reais, ou heurística" que o caller aplicava antes.
 */
export function mapOllamaCapabilities(raw: string[], modelId?: string): ModelCapability[] {
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
    if (modelId && CODE_NAME_PATTERN.test(modelId.toLowerCase())) {
        caps.add('code');
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

    // O segundo padrão cobre a família GLM multimodal, cujo sufixo de visão vem colado à versão
    // (glm-4.6v, glm-4v) em vez de ser um token separado como nas demais — a lista acima exige
    // delimitador e por isso nunca casava. Confirmado com arquivo real (GLM-4.6V-Flash, 2026-08-01).
    if (/(^|[-:/])(vl|vision|llava|gemma3|qwen.?vl|pixtral|moondream)([-:]|$)/.test(id)
        || id.includes('vision')
        || /glm-[\d.]+v([-._]|$)/.test(id)) {
        caps.push('vision');
    }
    if (CODE_NAME_PATTERN.test(id)) {
        caps.push('code');
    }
    if (/(r1|reasoning|qwq|o1|think)/.test(id)) {
        caps.push('reasoning');
    }

    return [...new Set(caps)];
}
