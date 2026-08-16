/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S227
 *
 * Origem: teste real no Windows (12/08/2026, 18:07-18:11) — resposta computada pelo backend em
 * 13s, nunca exibida na tela. S226 expôs `pending` em `GET /api/chat/active` (via
 * `WebChannelAdapter.asyncTurns`), mas até esta sprint `poll()`, no dashboard, nunca lia esse
 * campo: `active=[]` era interpretado como "terminou" mesmo durante a janela — alguns segundos —
 * em que a classificação (`GoalExtractor`/`UnifiedIntentRouter`) ainda não tinha criado nenhum
 * Goal/activeTurn rastreável. O `turnId` era abandonado (`fetchAndRenderOutbox` esgotava os 5
 * retries de 500ms contra um Outbox que ainda nem existia, e caía no fallback `syncFromServer()`)
 * antes mesmo da resposta real chegar.
 *
 * Correção: `poll()` passa a mandar `turnId` também na query de `/api/chat/active` e trata
 * `pending=true` como "ainda em andamento", exatamente como um `mine` (turno/goal) truthy — sem
 * mexer em `fetchAndRenderOutbox`, nos retries, no `syncFromServer` ou no ciclo de vida do
 * `turnId` (`setPendingTurn`/`getPendingTurn`/`clearPendingTurn`).
 *
 * Este teste NÃO reimplementa `poll()` — extrai o corpo REAL da função de dentro de
 * `index.html` e o executa via `AsyncFunction`, injetando só as dependências externas (fakes).
 * Se o texto-fonte de `poll()` divergir do que este teste espera, a extração falha ruidosamente
 * (assert de pré-condição), em vez de silenciosamente testar código morto.
 *
 * Execução: npx ts-node src/__tests__/regression/S227_Frontend_PollRespectsPendingSignal.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...args: string[]) => (...args: unknown[]) => Promise<unknown>;

/** Extrai o corpo REAL de `poll()` de dentro de index.html — não reimplementa a lógica. */
function extractPollBody(): string {
    const html = fs.readFileSync(path.join(__dirname, '../../dashboard/public/index.html'), 'utf-8');
    const startMarker = 'const poll = async () => {';
    const endMarker = '\n      poll();';
    const startIdx = html.indexOf(startMarker);
    if (startIdx < 0) throw new Error('pré-condição falhou: "const poll = async () => {" não encontrado em index.html');
    const bodyStart = startIdx + startMarker.length;
    const endIdx = html.indexOf(endMarker, bodyStart);
    if (endIdx < 0) throw new Error('pré-condição falhou: marcador de fim de poll() não encontrado');
    let body = html.slice(bodyStart, endIdx);
    // Remove o "};" de fechamento da própria arrow function (o body real termina antes dele).
    body = body.replace(/\}\s*;\s*$/, '');
    return body;
}

interface PollHarness {
    call: () => Promise<void>;
    calls: {
        fetchUrl?: string;
        stopTurnPollingCalled: boolean;
        fetchAndRenderOutboxCalledWith?: string;
        showStatusCalls: Array<{ type: string; text: string }>;
    };
}

function buildPollHarness(mockResponse: { success: boolean; active: unknown[]; pendingAuth?: unknown[]; pending?: boolean }, sessionId: string, turnId: string): PollHarness {
    const body = extractPollBody();
    const calls: PollHarness['calls'] = { stopTurnPollingCalled: false, showStatusCalls: [] };

    const newclawFetch = async (url: string) => {
        calls.fetchUrl = url;
        return { status: 200, json: async () => mockResponse };
    };
    const renderPendingAuth = (_pendingAuth: unknown[]) => {};
    const formatSemanticStatus = (item: { kind?: string }) => ({ type: 'processing', text: `status-de-${item?.kind ?? 'desconhecido'}` });
    const showStatus = (type: string, text: string) => { calls.showStatusCalls.push({ type, text }); };
    const stopTurnPolling = () => { calls.stopTurnPollingCalled = true; };
    const t = (key: string) => key;
    const fetchAndRenderOutbox = async (id: string) => { calls.fetchAndRenderOutboxCalledWith = id; };

    const pollFn = new AsyncFunction(
        'newclawFetch', 'renderPendingAuth', 'formatSemanticStatus', 'showStatus', 'stopTurnPolling', 't', 'fetchAndRenderOutbox',
        'sessionId', 'turnId',
        body,
    );

    return {
        call: () => pollFn(newclawFetch, renderPendingAuth, formatSemanticStatus, showStatus, stopTurnPolling, t, fetchAndRenderOutbox, sessionId, turnId) as Promise<void>,
        calls,
    };
}

async function main(): Promise<void> {

console.log('\n=== S227-1 — active=[] com pending=true: poll() NÃO conclui, NÃO abandona o turnId ===');
{
    const sessionId = 'session-s227-pending';
    const turnId = 'turn-s227-pending';
    const harness = buildPollHarness({ success: true, active: [], pending: true }, sessionId, turnId);

    await harness.call();

    assert(harness.calls.stopTurnPollingCalled === false, 'poll() NÃO chama stopTurnPolling() enquanto pending=true', harness.calls);
    assert(harness.calls.fetchAndRenderOutboxCalledWith === undefined, 'poll() NÃO chama fetchAndRenderOutbox() enquanto pending=true — turnId não é abandonado', harness.calls);
    assert(
        !!harness.calls.fetchUrl && harness.calls.fetchUrl.includes(`sessionId=${encodeURIComponent(sessionId)}`) && harness.calls.fetchUrl.includes(`turnId=${encodeURIComponent(turnId)}`),
        'a query enviada para /api/chat/active contém tanto sessionId quanto turnId',
        harness.calls.fetchUrl,
    );
    assert(harness.calls.showStatusCalls.length > 0, 'poll() continua mostrando algum status (não fica mudo) enquanto aguarda', harness.calls.showStatusCalls);
}

console.log('\n=== S227-2 — active=[] com pending=false: poll() conclui e busca o Outbox (comportamento correto) ===');
{
    const sessionId = 'session-s227-terminou';
    const turnId = 'turn-s227-terminou';
    const harness = buildPollHarness({ success: true, active: [], pending: false }, sessionId, turnId);

    await harness.call();

    assert(harness.calls.stopTurnPollingCalled === true, 'poll() chama stopTurnPolling() quando pending=false e active=[]', harness.calls);
    assert(harness.calls.fetchAndRenderOutboxCalledWith === turnId, 'poll() chama fetchAndRenderOutbox(turnId) com o turnId correto', harness.calls);
}

console.log('\n=== S227-3 — não-regressão: active contém o turno (mine truthy), pending=false — comportamento anterior preservado ===');
{
    const sessionId = 'session-s227-ativo';
    const turnId = 'turn-s227-ativo';
    const harness = buildPollHarness(
        { success: true, active: [{ conversationId: sessionId, elapsedMs: 1000, kind: 'goal', status: 'executing' }], pending: false },
        sessionId,
        turnId,
    );

    await harness.call();

    assert(harness.calls.stopTurnPollingCalled === false, 'poll() NÃO conclui quando existe um turno/goal ativo para esta sessão (mine truthy)', harness.calls);
    assert(harness.calls.fetchAndRenderOutboxCalledWith === undefined, 'poll() não busca o Outbox enquanto mine estiver ativo');
    assert(harness.calls.showStatusCalls.length > 0, 'poll() mostra o status semântico do turno ativo');
}

console.log('\n=== S227-4 — não-regressão: active=[] e pending AUSENTE da resposta (contrato antigo) ainda conclui — default seguro ===');
{
    const sessionId = 'session-s227-sem-pending';
    const turnId = 'turn-s227-sem-pending';
    // Simula uma resposta que não inclui `pending` (ex: servidor antigo, ou chamada sem turnId
    // no S226) — o destructuring default (`pending = false`) precisa manter o comportamento
    // seguro de sempre: sem sinal de "ainda em andamento", conclui normalmente.
    const harness = buildPollHarness({ success: true, active: [] }, sessionId, turnId);

    await harness.call();

    assert(harness.calls.stopTurnPollingCalled === true, 'sem o campo pending na resposta, poll() continua concluindo normalmente (default seguro, sem regressão)');
    assert(harness.calls.fetchAndRenderOutboxCalledWith === turnId, 'e busca o Outbox normalmente');
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S227 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;

}

main().catch((err) => {
    console.error('S227 erro inesperado:', err);
    process.exitCode = 1;
});
