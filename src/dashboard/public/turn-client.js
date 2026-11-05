/**
 * turn-client.js — cliente público do contrato do turno (docs/CONTRATO_DO_TURNO.md), versão 2 (ADR-033; aditiva sobre a 1).
 *
 * Por que existe: o protocolo de acompanhar um turno do chat (enviar → aceito → em andamento → aprovação → resposta) estava
 * escrito duas vezes, no painel (`index.html`, startTurnPolling/fetchAndRenderOutbox) e no suplemento do PowerPoint
 * (`src/taskpane/turnPolling.ts`, hoje no repositório newclaw-powerpoint), com diferenças entre as cópias. Cada cliente novo seria mais uma
 * (ADR-030, D15; ADR-031, regra 7). Este módulo é a implementação única do contrato para quem quiser usá-la — painel, suplemento
 * e harnesses migram para ele em etapas próprias, cada uma com a própria regressão.
 *
 * Regras do módulo:
 *  - Sem dependências e sem DOM: só `fetch` (injetável), para rodar no navegador e no Node (o teste de conformidade S457 o roda
 *    contra as rotas reais).
 *  - Não conhece nenhum cliente específico: nada de prefixo de sessão, de canal ou de fornecedor de voz.
 *  - Decide "terminou?" só por sinais estruturais do servidor (`/api/chat/active` e `/api/chat/outbox`), nunca pelo texto da
 *    resposta.
 *  - Não guarda histórico nem estado entre turnos: quem tem a verdade da conversa é o NewClaw (`/api/conversations`).
 *
 * Servido pelo próprio NewClaw em `/turn-client.js` (arquivo estático, como `shared.js`). Uso:
 *
 *   import { createTurnClient } from '/turn-client.js';
 *   const turnos = createTurnClient({ headers: { Authorization: 'Bearer …' } });
 *   const aceito = await turnos.send({ sessionId, message: 'Olá' });
 *   if (aceito.kind === 'accepted') {
 *     const fim = await turnos.waitForTurn({ sessionId, turnId: aceito.turnId, onState: s => mostrar(s.phase) });
 *   }
 */

/** Versão do contrato que este módulo implementa. O servidor anuncia a dele em `GET /api/status` → `status.contracts.turn`. */
export const TURN_CONTRACT_VERSION = 2;

/** Intervalo padrão entre consultas — o mesmo do painel (40/min; o limite geral do servidor é 120/min por IP). */
export const DEFAULT_POLL_INTERVAL_MS = 1500;
/** Espera máxima padrão — a mesma do suplemento (um objetivo com replanejamento já levou 28 min). */
export const DEFAULT_MAX_WAIT_MS = 45 * 60 * 1000;
/** Falhas seguidas (rede, 5xx, 429) toleradas antes de desistir — ≈ 22 s com o intervalo padrão. */
export const DEFAULT_MAX_CONSECUTIVE_ERRORS = 15;
/** Consultas extras à outbox quando o turno já saiu de `/active`: cobre a corrida entre os dois sinais. */
export const DEFAULT_RESULT_RETRIES = 3;

/** Comando de cancelamento do NewClaw (comando prioritário: não passa pela fila nem pelo modelo). */
export const CANCEL_COMMAND = '/cancelar';

function realSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readJson(res) {
  try { return await res.json(); } catch { return null; }
}

/** 400, 401 e 403 são recusas definitivas (pedido inválido, sem login, origem recusada): tentar de novo não muda nada. */
function isDefinitiveRejection(status) {
  return status === 400 || status === 401 || status === 403;
}

/**
 * Traduz a resposta de `GET /api/chat/active` para a fase do turno. Função pura, exportada para os testes.
 *
 * Ordem das perguntas (é o contrato, seção "Fases"):
 *  1. há ação perigosa esperando decisão nesta conversa → `awaiting_approval` (o trabalho está PARADO; não é "em andamento");
 *  2. esta conversa tem turno ou objetivo em execução → `running`;
 *  3. o turno foi aceito mas ainda não virou nada rastreável (classificação, fila) → `accepted`;
 *  4. nada disso → `finished`: a resposta está na outbox (ou, se já consumida, no histórico).
 *
 * A conversa é casada pelo id exato. Não cai em "qualquer conversa ativa" (o painel faz isso hoje, como reserva): para um
 * cliente que acompanha UM turno, trabalho de outra conversa não é sinal deste.
 */
export function phaseFromActive(body, sessionId) {
  const active = Array.isArray(body && body.active) ? body.active : [];
  const approvals = Array.isArray(body && body.pendingAuth) ? body.pendingAuth : [];
  const accepted = !!(body && body.pending);
  const mine = active.find((a) => a && a.conversationId === sessionId) || null;
  const progress = body && body.progresso ? body.progresso : null;

  let phase;
  if (approvals.length > 0) phase = 'awaiting_approval';
  else if (mine) phase = 'running';
  else if (accepted) phase = 'accepted';
  else phase = 'finished';

  return {
    phase,
    elapsedMs: mine ? mine.elapsedMs || 0 : 0,
    work: mine ? { kind: mine.kind, status: mine.status } : null,
    approvals,
    progress: phase === 'finished' ? null : progress,
    // v2 (ADR-033 §2–§3): o objetivo desta conversa (estado, plano, revisão e, se mudou, as etapas) e os últimos relatos.
    // `plan.steps` ausente com `sinceRevision` igual: nada mudou, vale o que o cliente já tinha.
    plan: body && body.trabalho ? {
      state: body.trabalho.estado,
      generation: body.trabalho.plano,
      revision: body.trabalho.revisao,
      steps: Array.isArray(body.trabalho.etapas)
        ? body.trabalho.etapas.map((e) => ({ id: e.id, description: e.descricao, state: e.estado }))
        : undefined,
    } : null,
    reports: body && Array.isArray(body.relatos) ? body.relatos.map((r) => ({ text: r.texto, at: r.em })) : undefined,
    reportsOmitted: body && typeof body.relatosOmitidos === 'number' ? body.relatosOmitidos : undefined,
  };
}

/**
 * @param {object} [options]
 * @param {string} [options.baseUrl] Endereço do NewClaw ('' = mesma origem).
 * @param {Function} [options.fetch] Implementação de fetch (padrão: o global).
 * @param {object} [options.headers] Cabeçalhos de cada chamada — por exemplo `Authorization: Bearer <token>`.
 * @param {string} [options.client] v2: nome do cliente (`[a-z0-9._-]`, até 64), enviado em cada mensagem. Só informativo.
 */
export function createTurnClient(options = {}) {
  const baseUrl = (options.baseUrl || '').replace(/\/+$/, '');
  const fetchFn = options.fetch || globalThis.fetch;
  const headers = options.headers || {};
  const client = options.client || undefined;
  if (typeof fetchFn !== 'function') throw new Error('turn-client: nenhuma implementação de fetch disponível');

  const url = (path) => baseUrl + path;
  const jsonHeaders = () => Object.assign({ 'Content-Type': 'application/json' }, headers);

  /** Envia uma mensagem. `files` (opcional): lista de `{ blob, fileName }`, enviada como multipart — exige `FormData`. */
  async function send({ sessionId, message, files } = {}) {
    let init;
    if (files && files.length > 0) {
      const form = new FormData();
      form.append('message', message || '');
      form.append('sessionId', sessionId);
      if (client) form.append('client', client);
      for (const f of files) form.append('files', f.blob, f.fileName);
      init = { method: 'POST', headers: Object.assign({}, headers), body: form };
    } else {
      init = { method: 'POST', headers: jsonHeaders(), body: JSON.stringify(Object.assign({ message: message || '', sessionId }, client ? { client } : {})) };
    }
    const res = await fetchFn(url('/api/chat'), init);
    const body = await readJson(res);
    if (res.status === 202 && body && body.turnId) {
      return { kind: 'accepted', turnId: body.turnId, sessionId: body.sessionId };
    }
    const retryAfter = res.headers && typeof res.headers.get === 'function' ? res.headers.get('Retry-After') : null;
    return {
      kind: 'rejected',
      status: res.status,
      error: body && body.error ? body.error : `HTTP ${res.status}`,
      retryAfterSec: retryAfter ? Number(retryAfter) : undefined,
    };
  }

  /**
   * Estado atual do turno (uma consulta a `/api/chat/active`). Lança em falha de rede ou status inesperado.
   * v2: `sinceRevision` (a `plan.revision` que o cliente já tem) faz o servidor omitir etapas e relatos que não mudaram.
   */
  async function state({ sessionId, turnId, sinceRevision }) {
    const q = '?sessionId=' + encodeURIComponent(sessionId) + (turnId ? '&turnId=' + encodeURIComponent(turnId) : '')
      + (typeof sinceRevision === 'number' ? '&desdeRevisao=' + sinceRevision : '');
    const res = await fetchFn(url('/api/chat/active' + q), { method: 'GET', headers: Object.assign({}, headers) });
    if (res.status !== 200) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return phaseFromActive(await readJson(res), sessionId);
  }

  /**
   * Retira a resposta do turno da outbox. A leitura CONSOME a entrega: uma segunda leitura do mesmo turnId devolve `none`.
   * `none` (404) quer dizer "ainda não pronta, já consumida ou turnId desconhecido" — o contrato não distingue os três.
   */
  async function result(turnId) {
    const res = await fetchFn(url('/api/chat/outbox?turnId=' + encodeURIComponent(turnId)), {
      method: 'GET', headers: Object.assign({}, headers),
    });
    if (res.status === 404) return { kind: 'none' };
    const body = await readJson(res);
    if (res.status === 200 && body && body.success === true) {
      return {
        kind: 'delivered', text: body.response || '', attachments: body.attachments || [], options: body.options,
        // v2 (ADR-033 §5): o resultado que o núcleo decidiu (só em entrega de objetivo) e o aviso de fila provisório.
        outcome: body.resultado
          ? { state: body.resultado.estado, steps: { total: body.resultado.etapas.total, done: body.resultado.etapas.concluidas } }
          : undefined,
        provisional: body.provisoria === true,
      };
    }
    const err = new Error(res.status === 200 ? 'resposta 200 sem success' : `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }

  /**
   * v2 (ADR-033 §4): o que o servidor sabe da conversa — versão do contrato, canal, cliente e o modelo da última resposta.
   * `none` (404): conversa ainda sem mensagem gravada ou desconhecida. Campo que o servidor não sabe vem ausente.
   */
  async function context({ sessionId }) {
    const res = await fetchFn(url('/api/chat/context?sessionId=' + encodeURIComponent(sessionId)), {
      method: 'GET', headers: Object.assign({}, headers),
    });
    if (res.status === 404) return { kind: 'none' };
    const body = await readJson(res);
    if (res.status === 200 && body && body.success === true) {
      return {
        kind: 'context', contract: body.contrato, channel: body.canal, client: body.cliente,
        conversation: body.conversa
          ? { sessionId: body.conversa.sessionId, id: body.conversa.id, createdAt: body.conversa.criadaEm, messages: body.conversa.mensagens }
          : undefined,
        model: body.modelo ? { name: body.modelo.nome, provider: body.modelo.provedor, at: body.modelo.em } : undefined,
      };
    }
    const err = new Error(res.status === 200 ? 'resposta 200 sem success' : `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }

  /** Pede o cancelamento do que esta conversa estiver fazendo. A confirmação chega como a resposta de um turno próprio. */
  function cancel({ sessionId }) {
    return send({ sessionId, message: CANCEL_COMMAND });
  }

  /** Aprova ou rejeita uma ação perigosa pendente (`approvals[].txnId` do estado). Espera o texto que a decisão produziu. */
  async function decide({ sessionId, txnId, decision }) {
    const res = await fetchFn(url('/api/chat/auth-decision'), {
      method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ sessionId, txnId, decision }),
    });
    const body = await readJson(res);
    if (res.status === 200 && body && body.success === true) {
      return { kind: 'decided', text: body.response || '', attachments: body.attachments || [] };
    }
    return { kind: 'rejected', status: res.status, error: body && body.error ? body.error : `HTTP ${res.status}` };
  }

  /**
   * Acompanha um turno até a resposta.
   *
   * Resultado:
   *  - `{ kind: 'finished', delivery }` — `delivery` é a entrega da outbox, ou `null` se ela não estava lá (já consumida por
   *    outra aba, servidor reiniciado). Com `null`, a fonte de verdade é o histórico: `GET /api/conversations/:id/messages`,
   *    com o `id` que `GET /api/conversations` lista para este `sessionId` (não o próprio `sessionId`).
   *  - `{ kind: 'timeout' }` — passou de `maxWaitMs`; o turno continua no servidor e pode ser retomado com o mesmo turnId.
   *  - `{ kind: 'unreachable', lastError }` — falhas seguidas demais; idem.
   *  - `{ kind: 'rejected', status }` — 400/401/403: sem login, pedido inválido.
   *  - `{ kind: 'aborted' }` — `signal` abortado por quem chamou (fechar a janela não cancela o turno; para isso, `cancel()`).
   *
   * `onState(estado)` é chamado a cada consulta bem-sucedida com o retorno de `phaseFromActive` mais `turnId`; exceção dentro
   * dele é ignorada (a interface não derruba a espera).
   *
   * v2: uma entrega `provisional` (o aviso de fila) não encerra a espera — a resposta final sai depois com o mesmo turnId.
   * `onProvisional(entrega)` recebe o aviso, para a interface mostrá-lo enquanto espera.
   */
  async function waitForTurn({
    sessionId, turnId, onState, onProvisional, signal,
    intervalMs = DEFAULT_POLL_INTERVAL_MS,
    maxWaitMs = DEFAULT_MAX_WAIT_MS,
    maxConsecutiveErrors = DEFAULT_MAX_CONSECUTIVE_ERRORS,
    resultRetries = DEFAULT_RESULT_RETRIES,
    sleep = realSleep,
    now = Date.now,
  }) {
    const start = now();
    let consecutiveErrors = 0;
    let lastError = '';
    let provisionalSeen = false;
    const elapsed = () => now() - start;

    for (;;) {
      if (signal && signal.aborted) return { kind: 'aborted', elapsedMs: elapsed() };
      if (elapsed() >= maxWaitMs) return { kind: 'timeout', elapsedMs: elapsed() };

      let current = null;
      try {
        current = await state({ sessionId, turnId });
        consecutiveErrors = 0;
      } catch (err) {
        if (err && isDefinitiveRejection(err.status)) return { kind: 'rejected', status: err.status, elapsedMs: elapsed() };
        consecutiveErrors++;
        lastError = err && err.message ? err.message : String(err);
      }

      if (current) {
        if (onState) {
          try { onState(Object.assign({ turnId }, current)); } catch { /* a interface não pode derrubar a espera */ }
        }
        if (current.phase === 'finished') {
          for (let attempt = 0; attempt <= resultRetries; attempt++) {
            try {
              const r = await result(turnId);
              if (r.kind === 'delivered' && r.provisional) {
                if (onProvisional) {
                  try { onProvisional(r); } catch { /* a interface não pode derrubar a espera */ }
                }
                provisionalSeen = true;
                break;
              }
              if (r.kind === 'delivered') return { kind: 'finished', delivery: r, elapsedMs: elapsed() };
            } catch (err) {
              if (err && isDefinitiveRejection(err.status)) return { kind: 'rejected', status: err.status, elapsedMs: elapsed() };
              lastError = err && err.message ? err.message : String(err);
            }
            if (attempt < resultRetries) await sleep(intervalMs);
          }
          if (provisionalSeen) { provisionalSeen = false; await sleep(intervalMs); continue; }
          return { kind: 'finished', delivery: null, elapsedMs: elapsed() };
        }
      }

      if (consecutiveErrors >= maxConsecutiveErrors) return { kind: 'unreachable', lastError, elapsedMs: elapsed() };
      await sleep(intervalMs);
    }
  }

  return { send, state, result, context, cancel, decide, waitForTurn };
}
