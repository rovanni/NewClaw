/**
 * turnPolling — espera pela resposta de um turno do chat (função PURA, sem DOM nem Office.js).
 *
 * Por que existe: `POST /api/chat` responde `202 { success, turnId, sessionId }` e processa em segundo plano; a resposta só sai por
 * `GET /api/chat/outbox?turnId=…`, que devolve 404 enquanto não estiver pronta (o dashboard web faz exatamente isso). O add-in foi
 * escrito para o modelo antigo, em que a resposta vinha no próprio POST: apagava a bolha "processando…" na hora e, sem `response`,
 * não mostrava NADA — nem retorno visual nem a resposta (achado em 02/10/2026, quando o add-in foi usado pela 1ª vez desde 14/07).
 *
 * Fica num módulo próprio porque o Office.js não roda fora do PowerPoint; assim a política de espera (404 = ainda não pronta, erros
 * transitórios, limite de tempo, erro de autenticação) é testável a partir da suíte de regressão da raiz (S317).
 */

/** O mínimo que precisamos de uma resposta HTTP (compatível com `Response` do fetch), para poder injetar um falso nos testes. */
export interface PollResponse {
  status: number;
  json(): Promise<unknown>;
}

export type PollFetch = (url: string, init: { method: string; headers: Record<string, string> }) => Promise<PollResponse>;

export interface TurnPayload {
  success: boolean;
  response?: string;
  attachments?: unknown[];
  options?: unknown;
}

export type TurnOutcome =
  | { kind: "response"; payload: TurnPayload; elapsedMs: number }
  | { kind: "timeout"; elapsedMs: number }
  | { kind: "unreachable"; elapsedMs: number; lastError: string }
  | { kind: "rejected"; elapsedMs: number; status: number };

export interface TurnPollOptions {
  fetchFn: PollFetch;
  serverUrl: string;
  headers: Record<string, string>;
  turnId: string;
  /** Intervalo entre consultas. Padrão 3 s (20/min; o limite geral do servidor é 120/min por IP). */
  intervalMs?: number;
  /** Tempo máximo de espera. Padrão 45 min (um goal com replan levou 28 min em 02/10/2026; depois dele o botão "Verificar resposta" retoma a espera). */
  maxWaitMs?: number;
  /** Erros de rede/5xx CONSECUTIVOS tolerados antes de desistir. Padrão 15 (≈ 45 s com o intervalo padrão). */
  maxConsecutiveErrors?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Chamada a cada consulta com o tempo decorrido, para a interface mostrar que está trabalhando. Exceção aqui é ignorada. */
  onTick?: (elapsedMs: number) => void;
}

export const DEFAULT_POLL_INTERVAL_MS = 3000;
export const DEFAULT_MAX_WAIT_MS = 45 * 60 * 1000;
export const DEFAULT_MAX_CONSECUTIVE_ERRORS = 15;

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForTurnResponse(opts: TurnPollOptions): Promise<TurnOutcome> {
  const intervalMs = opts.intervalMs !== undefined ? opts.intervalMs : DEFAULT_POLL_INTERVAL_MS;
  const maxWaitMs = opts.maxWaitMs !== undefined ? opts.maxWaitMs : DEFAULT_MAX_WAIT_MS;
  const maxErrors = opts.maxConsecutiveErrors !== undefined ? opts.maxConsecutiveErrors : DEFAULT_MAX_CONSECUTIVE_ERRORS;
  const sleep = opts.sleep || realSleep;
  const now = opts.now || Date.now;
  const url = `${opts.serverUrl}/api/chat/outbox?turnId=${encodeURIComponent(opts.turnId)}`;
  const start = now();
  let consecutiveErrors = 0;
  let lastError = "";

  for (;;) {
    const elapsedMs = now() - start;
    if (opts.onTick) {
      try { opts.onTick(elapsedMs); } catch { /* a interface não pode derrubar a espera */ }
    }
    if (elapsedMs >= maxWaitMs) return { kind: "timeout", elapsedMs };

    try {
      const res = await opts.fetchFn(url, { method: "GET", headers: opts.headers });
      if (res.status === 200) {
        const body = (await res.json()) as TurnPayload | null;
        if (body && body.success === true) return { kind: "response", payload: body, elapsedMs: now() - start };
        consecutiveErrors++;                    // 200 sem success: contrato inesperado — conta como erro, não como "pronta"
        lastError = "resposta 200 sem success";
      } else if (res.status === 404) {
        consecutiveErrors = 0;                  // "ainda não pronta" é o estado normal da espera
      } else if (res.status === 401 || res.status === 403 || res.status === 400) {
        return { kind: "rejected", elapsedMs: now() - start, status: res.status };
      } else {
        consecutiveErrors++;                    // 429, 5xx…: transitório até estourar o limite
        lastError = `HTTP ${res.status}`;
      }
    } catch (err) {
      consecutiveErrors++;
      lastError = err instanceof Error ? err.message : String(err);
    }

    if (consecutiveErrors >= maxErrors) return { kind: "unreachable", elapsedMs: now() - start, lastError };
    await sleep(intervalMs);
  }
}
