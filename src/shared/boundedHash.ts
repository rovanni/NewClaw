/**
 * boundedHash — hash não-criptográfico (djb2-style) com limite superior de tamanho de input.
 *
 * Consolidado de duas implementações idênticas (ClassificationMemory.ts, UnifiedIntentRouter.ts)
 * — mesma fórmula, só escrita de formas ligeiramente diferentes. Usado só como cache-key/id de
 * rastreamento, nunca como hash de segurança.
 *
 * O limite de tamanho existe porque CodeQL (js/loop-bound-injection) apontou que o loop
 * char-a-char rodava sobre `text.length` sem limite superior — texto vindo de input de usuário
 * (mensagem de chat, janela de contexto recente) pode ser arbitrariamente grande, e o loop é
 * síncrono (bloqueia a event loop) por tempo proporcional ao tamanho. Truncar antes do loop
 * elimina a classe de bug sem mudar a distribuição de hashes pra qualquer input realista (nenhum
 * uso atual precisa de mais que MAX_HASH_INPUT_LEN caracteres pra ter entropia suficiente como
 * cache-key).
 */

const MAX_HASH_INPUT_LEN = 10_000;

export function boundedHash(text: string, maxLen: number = MAX_HASH_INPUT_LEN): string {
    const bounded = text.length > maxLen ? text.slice(0, maxLen) : text;
    let h = 0;
    for (let i = 0; i < bounded.length; i++) {
        h = ((h << 5) - h + bounded.charCodeAt(i)) | 0;
    }
    return Math.abs(h).toString(36);
}
