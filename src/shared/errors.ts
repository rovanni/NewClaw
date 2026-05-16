/**
 * errors — Utilitários de tratamento de erro tipado.
 *
 * Em vez de `catch (e: any)` (que cala o checker), o padrão recomendado é
 * `catch (e) { ... }` com `e: unknown` (default em `strict`) + narrowing
 * via essas funções helper.
 *
 * Uso típico:
 *   try {
 *     // ...
 *   } catch (e) {
 *     log.warn('something_failed', errorMessage(e));
 *   }
 */

/** Extrai a mensagem de um valor capturado em catch (`unknown`). */
export function errorMessage(e: unknown): string {
    if (e instanceof Error) return e.message;
    if (typeof e === 'string') return e;
    if (e === null || e === undefined) return 'unknown error';
    try {
        return JSON.stringify(e);
    } catch {
        return String(e);
    }
}

/** Coage qualquer valor capturado para Error, preservando stack quando possível. */
export function toError(e: unknown): Error {
    if (e instanceof Error) return e;
    return new Error(errorMessage(e));
}

/** Type guard: o valor possui shape de erro do Node (message + opcionalmente code/errno)? */
export function isNodeError(e: unknown): e is NodeJS.ErrnoException {
    return e instanceof Error && ('code' in e || 'errno' in e);
}
