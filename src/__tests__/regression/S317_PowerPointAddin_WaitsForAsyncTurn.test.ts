/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S317 (add-in do PowerPoint: espera a resposta do turno assíncrono, com retorno visual)
 * `POST /api/chat` responde 202 {turnId}; a resposta só sai por GET /api/chat/outbox?turnId=… (404 = ainda não pronta). O add-in foi escrito
 * para o modelo antigo: apagava a bolha "processando…" na hora e, sem `response`, não mostrava NADA nem consultava a outbox (02/10/2026).
 *
 *   1  → waitForTurnResponse (função pura, relógio e fetch falsos): 404 = aguarda; 200 = devolve; URL; headers; 1ª consulta imediata; onTick.
 *   2  → erros transitórios são tolerados (e zerados por um 404); persistentes viram `unreachable`; 401/403/400 viram `rejected` na hora; limite de tempo.
 *   3  → contrato inesperado (200 sem success) nunca vira "resposta".
 *   4  → estrutura do add-in: a bolha só é removida DEPOIS de esperar; indicador com tempo; nada em silêncio; caminho legado preservado.
 *
 * Execução: npx ts-node src/__tests__/regression/S317_PowerPointAddin_WaitsForAsyncTurn.test.ts
 */
import fs from 'fs';
import path from 'path';
import {
    waitForTurnResponse, PollFetch, PollResponse,
    DEFAULT_POLL_INTERVAL_MS, DEFAULT_MAX_WAIT_MS, DEFAULT_MAX_CONSECUTIVE_ERRORS,
} from '../../../addins/powerpoint-addin/src/taskpane/turnPolling';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}

type Step = { status: number; body?: unknown } | { throw: string };

/** fetch falso que consome um roteiro de respostas e registra cada chamada; o relógio só avança no sleep. */
function harness(script: Step[]) {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const sleeps: number[] = [];
    let clock = 0;
    const fetchFn: PollFetch = async (url, init) => {
        calls.push({ url, headers: init.headers });
        const step = script[Math.min(calls.length - 1, script.length - 1)];
        if ('throw' in step) throw new Error(step.throw);
        const res: PollResponse = { status: step.status, json: async () => step.body };
        return res;
    };
    return {
        calls, sleeps,
        opts: {
            fetchFn, serverUrl: 'http://127.0.0.1:3090', headers: { Authorization: 'Bearer t' }, turnId: 'abc-123',
            sleep: async (ms: number) => { sleeps.push(ms); clock += ms; },
            now: () => clock,
        },
    };
}

async function main(): Promise<void> {
    console.log('\n[1] 404 = ainda não pronta; 200 = devolve');
    {
        const h = harness([{ status: 404 }, { status: 404 }, { status: 404 }, { status: 200, body: { success: true, response: 'Olá!', attachments: [{ fileName: 'a.pptx', data: 'QUJD' }] } }]);
        const ticks: number[] = [];
        const r = await waitForTurnResponse({ ...h.opts, onTick: (ms) => ticks.push(ms) });
        assert(r.kind === 'response' && (r as any).payload.response === 'Olá!', 'após 3 × 404, devolve a resposta do 200', r);
        assert(JSON.stringify((r as any).payload.attachments) === JSON.stringify([{ fileName: 'a.pptx', data: 'QUJD' }]), 'os anexos da outbox passam intactos');
        assert(h.calls.length === 4, `4 consultas (3 × 404 + 1 × 200); foram ${h.calls.length}`);
        assert(h.sleeps.length === 3 && h.sleeps.every(ms => ms === DEFAULT_POLL_INTERVAL_MS), `espera ${DEFAULT_POLL_INTERVAL_MS} ms entre consultas (e não antes da 1ª)`, h.sleeps);
        assert(ticks.length === 4 && ticks[0] === 0 && ticks.every((t, i) => i === 0 || t > ticks[i - 1]), 'onTick: 1ª chamada imediata (0 ms) e o tempo decorrido só cresce', ticks);
        assert(h.calls[0].url === 'http://127.0.0.1:3090/api/chat/outbox?turnId=abc-123', 'a URL é /api/chat/outbox?turnId=…', h.calls[0].url);
        assert(h.calls.every(c => c.headers.Authorization === 'Bearer t'), 'o header Authorization vai em toda consulta');
        const weird = harness([{ status: 200, body: { success: true, response: 'x' } }]);
        await waitForTurnResponse({ ...weird.opts, turnId: 'a b&c=d/é' });
        assert(weird.calls[0].url.endsWith('turnId=' + encodeURIComponent('a b&c=d/é')), 'turnId com caracteres especiais é codificado na URL', weird.calls[0].url);
        const noThrow = harness([{ status: 404 }, { status: 200, body: { success: true, response: 'ok' } }]);
        const r2 = await waitForTurnResponse({ ...noThrow.opts, onTick: () => { throw new Error('interface quebrou'); } });
        assert(r2.kind === 'response', 'uma exceção em onTick (a interface) não derruba a espera');
    }

    console.log('\n[2] erros, autenticação e limite de tempo');
    {
        const h1 = harness([{ throw: 'rede caiu' }, { throw: 'rede caiu' }, { status: 200, body: { success: true, response: 'voltou' } }]);
        const r1 = await waitForTurnResponse({ ...h1.opts, maxConsecutiveErrors: 3 });
        assert(r1.kind === 'response', 'dois erros de rede seguidos (limite 3) são tolerados e a espera continua');
        const h2 = harness([{ throw: 'x' }, { status: 404 }, { throw: 'x' }, { status: 404 }, { throw: 'x' }, { status: 404 }, { status: 200, body: { success: true, response: 'ok' } }]);
        const r2 = await waitForTurnResponse({ ...h2.opts, maxConsecutiveErrors: 2 });
        assert(r2.kind === 'response', 'um 404 zera a contagem de erros consecutivos (404 é o estado normal da espera)');
        const h3 = harness([{ throw: 'ECONNREFUSED 127.0.0.1:3090' }]);
        const r3 = await waitForTurnResponse({ ...h3.opts, maxConsecutiveErrors: 4 });
        assert(r3.kind === 'unreachable' && /ECONNREFUSED/.test((r3 as any).lastError) && h3.calls.length === 4, 'erro persistente → unreachable com o último erro, após o limite', r3);
        const h4 = harness([{ status: 503 }, { status: 429 }, { status: 503 }]);
        const r4 = await waitForTurnResponse({ ...h4.opts, maxConsecutiveErrors: 3 });
        assert(r4.kind === 'unreachable' && /HTTP 503/.test((r4 as any).lastError), '5xx e 429 contam como erro transitório até estourar o limite', r4);
        for (const status of [401, 403, 400]) {
            const h = harness([{ status }]);
            const r = await waitForTurnResponse(h.opts);
            assert(r.kind === 'rejected' && (r as any).status === status && h.calls.length === 1, `HTTP ${status} → rejected imediatamente (1 consulta, sem insistir)`, r);
        }
        const h5 = harness([{ status: 404 }]);
        const r5 = await waitForTurnResponse({ ...h5.opts, maxWaitMs: 10_000 });
        assert(r5.kind === 'timeout' && (r5 as any).elapsedMs >= 10_000, 'sem resposta até o limite → timeout com o tempo decorrido', r5);
        assert(DEFAULT_POLL_INTERVAL_MS === 3000 && DEFAULT_MAX_WAIT_MS === 20 * 60 * 1000 && DEFAULT_MAX_CONSECUTIVE_ERRORS === 15, 'padrões: 3 s, 20 min, 15 erros (20 consultas/min cabem nos 120/min do servidor)');
    }

    console.log('\n[3] contrato inesperado nunca vira resposta');
    {
        const h = harness([{ status: 200, body: { success: false } }]);
        const r = await waitForTurnResponse({ ...h.opts, maxConsecutiveErrors: 3 });
        assert(r.kind === 'unreachable' && /sem success/.test((r as any).lastError), '200 com success=false não é "resposta"; vira erro', r);
        for (const body of [null, undefined, 'texto', 42, []]) {
            const hb = harness([{ status: 200, body }]);
            const rb = await waitForTurnResponse({ ...hb.opts, maxConsecutiveErrors: 2 });
            assert(rb.kind === 'unreachable', `corpo inválido (${JSON.stringify(body)}) nunca é aceito como resposta`);
        }
    }

    console.log('\n[4] estrutura do add-in: o defeito não volta');
    const root = path.resolve(__dirname, '..', '..', '..', 'addins', 'powerpoint-addin', 'src', 'taskpane');
    const src = fs.readFileSync(path.join(root, 'powerpoint.ts'), 'utf8');
    const a = src.indexOf('async function sendMessage');
    const body = src.slice(a, src.indexOf('async function insertSlidesFromAttachment'));
    assert(/import \{ waitForTurnResponse \} from "\.\/turnPolling";/.test(src), 'powerpoint.ts importa waitForTurnResponse');
    const branch = body.indexOf('res.status === 202 && data.turnId');
    assert(branch > -1, 'trata o 202 com turnId');
    const afterBranch = body.slice(branch);
    assert(afterBranch.indexOf('waitForTurnResponse(') > -1 && afterBranch.indexOf('waitForTurnResponse(') < afterBranch.indexOf('statusBubble.remove()'), 'a bolha de status só é removida DEPOIS de esperar a resposta (o defeito original apagava na hora)');
    const beforeBranch = body.slice(0, branch);
    const removesBefore = (beforeBranch.match(/statusBubble\.remove\(\)/g) ?? []).length;
    assert(removesBefore === 1 && /!res\.ok \|\| !data\.success[\s\S]{0,80}statusBubble\.remove\(\)/.test(beforeBranch), 'antes do 202 só há a remoção no caminho de ERRO do POST (nunca no de sucesso)', removesBefore);
    assert(/onTick:\s*\(elapsedMs\)\s*=>\s*\{\s*statusBubble\.textContent\s*=\s*processingText\(elapsedMs\)/.test(body), 'a cada consulta a bolha é atualizada com o tempo decorrido (processingText)');
    const procText = src.slice(src.indexOf('function processingText'), a);
    assert(/\$\{time\}/.test(procText) && /alguns minutos/.test(procText) && /Dashboard/.test(procText), 'o texto mostra o tempo e dicas progressivas (alguns minutos; aprovação no Dashboard)');
    for (const kind of ['timeout', 'unreachable', 'rejected']) {
        assert(new RegExp(`outcome\\.kind === "${kind}"[\\s\\S]{0,260}addMessage\\("error"`).test(body), `desfecho "${kind}" vira uma mensagem de erro visível, com o id do turno`);
    }
    assert(/addMessage\("status", "O newclaw terminou, mas não devolveu nenhum texto\."\)/.test(body), 'resposta vazia nunca é silêncio: o usuário é avisado');
    assert(/let reply: \{[^}]*\} = data;/.test(body), 'caminho legado preservado: servidor antigo que responde no próprio POST continua funcionando');
    assert(/statusBubble\.style\.whiteSpace = "pre-line"/.test(body), 'a bolha aceita as duas linhas (tempo + dica)');

    console.log(`\n${passed} passou, ${failed} falhou`);
    process.exitCode = failed === 0 ? 0 : 1;
}

main().catch(err => { console.error('ERRO NÃO TRATADO:', err); process.exitCode = 1; });
