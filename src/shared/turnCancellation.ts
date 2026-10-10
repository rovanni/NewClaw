/**
 * Cancelamento do TURNO (botão "Parar" / /cancelar) — módulo-folha, sem dependência de nenhum componente.
 *
 * Achado real (10/10/2026, log de produção): o "Parar" chegou 4 s depois do pedido, ainda na extração/roteador/suficiência
 * — fase em que não existe goal nem turno do agente. Quem sabia cancelar (o goal ativo, a chamada em curso do AgentLoop)
 * não achou nada, o pedido seguiu, criou o goal e rodou por minutos. O cancelamento precisa valer para o turno INTEIRO e
 * alcançar qualquer chamada ao modelo que ele esteja fazendo, em qualquer componente — sem passar o sinal à mão por
 * dezenas de assinaturas.
 *
 * O turno guarda o seu sinal aqui (AsyncLocalStorage); `ProviderFactory.chatWithFallback` o combina com o sinal que a
 * chamada já tinha. Cancelar aborta a chamada em voo na hora, de qualquer componente (planejador, juízes, agente…).
 */
import { AsyncLocalStorage } from 'async_hooks';

const contexto = new AsyncLocalStorage<{ signal: AbortSignal }>();

/** Roda `fn` dentro do turno: toda chamada ao modelo feita por ela (e pelo que ela dispara) enxerga o sinal. */
export function executarNoTurno<T>(signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
    return contexto.run({ signal }, fn);
}

/** O sinal do turno em que o código atual roda; `undefined` fora de um turno (tarefa de fundo, teste, CLI). */
export function sinalDoTurno(): AbortSignal | undefined {
    return contexto.getStore()?.signal;
}

/** Um sinal que dispara quando QUALQUER um dos dois dispara. Sem dependência de `AbortSignal.any` (Node mais antigo). */
export function combinarSinais(a?: AbortSignal, b?: AbortSignal): AbortSignal | undefined {
    if (!a) return b;
    if (!b || a === b) return a;
    const c = new AbortController();
    if (a.aborted || b.aborted) { c.abort(); return c.signal; }
    const aborta = (): void => c.abort();
    a.addEventListener('abort', aborta, { once: true });
    b.addEventListener('abort', aborta, { once: true });
    return c.signal;
}
