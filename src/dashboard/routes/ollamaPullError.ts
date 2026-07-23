import { errorMessage } from '../../shared/errors';

export interface OllamaPullFailure {
    status: number;
    error: string;
}

/**
 * Interpreta a resposta de erro que o /api/pull do Ollama devolve quando o nome do modelo é
 * inválido/incompleto. Confirmado ao vivo contra Ollama real (23/07/2026): nomes de família sem
 * tag completa (ex: "kimi", "glm", "deepseek", "llama") falham rápido com
 * `{"error":"pull model manifest: file does not exist"}` e status 500 — 500 é o status errado do
 * ponto de vista da nossa API (é o pedido do usuário que está malformado, não o servidor
 * quebrando), então normalizamos pra 400 com uma mensagem acionável.
 */
export function interpretOllamaPullFailure(model: string, rawErrorText: string): OllamaPullFailure {
    const friendly = /manifest|does not exist|not found/i.test(rawErrorText)
        ? `Modelo "${model}" não encontrado. Nomes de família sozinhos (ex: "kimi", "gemma") não bastam — use a tag completa (ex: "kimi-k2.6:cloud"). Veja a aba "Disponíveis na nuvem" pra conferir nomes válidos.`
        : `Pull failed: ${rawErrorText.slice(0, 200)}`;
    return { status: 400, error: friendly };
}

/**
 * Interpreta uma exceção (rede, abort/timeout) na chamada ao /api/pull. Confirmado ao vivo:
 * alguns nomes de família ambíguos (ex: "gemma", "qwen" — sem sufixo de versão) fazem o Ollama
 * ficar tentando resolver o manifest indefinidamente, sem nunca responder — sem timeout aqui,
 * o botão "Instalar" do dashboard ficaria preso pra sempre. AbortSignal.timeout() no fetch da
 * rota gera um AbortError, tratado aqui com uma mensagem específica em vez do genérico
 * "The operation was aborted".
 */
export function interpretOllamaPullException(model: string, err: unknown): OllamaPullFailure {
    const msg = errorMessage(err);
    if (/abort/i.test(msg)) {
        return {
            status: 408,
            error: `Tempo esgotado tentando puxar "${model}". Se for um nome incompleto/ambíguo (ex: "gemma" ou "qwen" sem versão), o Ollama pode ficar tentando resolver sem nunca responder — use o nome completo (veja a aba "Disponíveis na nuvem").`,
        };
    }
    return { status: 500, error: msg };
}
