/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S457 (conformidade do contrato do turno, versão 1)
 *
 * Origem: ADR-030 (decisão D15, aprovada em 29/10/2026) e ADR-031 (regra 7). O protocolo de acompanhar um turno do chat estava
 * implícito no código e escrito duas vezes (painel e suplemento do PowerPoint). `docs/CONTRATO_DO_TURNO.md` passou a ser a
 * definição pública; este teste é o que impede o documento e o servidor de divergirem.
 *
 * O que é real aqui: as rotas (`createChatRouter`, `createStatusRouter`), a autenticação (`authMiddleware`, `csrfOriginCheck`),
 * os arquivos estáticos, o `WebChannelAdapter` (outbox, `asyncTurns`, progresso, entregas), HTTP de verdade numa porta efêmera,
 * o cliente do suplemento (`turnPolling.ts`) e o cliente público (`turn-client.js`).
 *
 * O que é imitado: o `MessageBus` e o Core. O falso faz exatamente as chamadas que o `MessageBus` real faz ao adapter em cada
 * situação — `send(resposta, rawContext)` ao terminar; ACK de fila e nota de complemento pelo mesmo `send` antes da resposta
 * final (`MessageBus.ts`, comandos prioritários, complemento e `sendAck`); `sendToChat(..., { progresso: true })` nos relatos
 * (ADR-027). Modelo nenhum é chamado.
 *
 * Execução: npx ts-node src/__tests__/regression/S457_ContratoDoTurno_Conformidade.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import express from 'express';
import cookieParser from 'cookie-parser';
import type { AddressInfo } from 'net';
import type { NormalizedMessage } from '../../channels/ChannelAdapter';
import { waitForTurnResponse } from '../../../addins/powerpoint-addin/src/taskpane/turnPolling';

const SENHA = 's457-senha-de-teste';
process.env.DASHBOARD_PASSWORD = SENHA; // antes de carregar auth.ts: é no carregamento que ele liga a autenticação

/* eslint-disable @typescript-eslint/no-var-requires */
const { authMiddleware } = require('../../dashboard/routes/auth') as typeof import('../../dashboard/routes/auth');
const { createAuthRouter } = require('../../dashboard/routes/auth') as typeof import('../../dashboard/routes/auth');
const { csrfOriginCheck } = require('../../dashboard/security') as typeof import('../../dashboard/security');
const { createChatRouter, TURN_CONTRACT_VERSION } = require('../../dashboard/routes/chat') as typeof import('../../dashboard/routes/chat');
const { createStatusRouter } = require('../../dashboard/routes/status') as typeof import('../../dashboard/routes/status');
const { WebChannelAdapter } = require('../../channels/WebChannelAdapter') as typeof import('../../channels/WebChannelAdapter');
/* eslint-enable @typescript-eslint/no-var-requires */

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

const PUBLIC_DIR = path.join(__dirname, '../../dashboard/public');
const CLIENT_PATH = path.join(PUBLIC_DIR, 'turn-client.js');

// ts-node compila para CommonJS e transformaria `import()` em `require()`, que não carrega módulo ES. O módulo é carregado
// pelo próprio Node a partir do código-fonte (data: URL) — o mesmo arquivo que o navegador recebe.
const importEsm = new Function('u', 'return import(u)') as (u: string) => Promise<any>;
async function loadTurnClient(): Promise<any> {
    const src = fs.readFileSync(CLIENT_PATH, 'utf-8');
    return importEsm('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** O Core imitado: só as chamadas que o MessageBus real faz ao adapter (ver cabeçalho). */
function createFakeCore() {
    const adapter = new WebChannelAdapter();
    const activeTurns = new Map<string, number>();              // conversationId → início
    const pendingTxns: Array<{ id: string; conversationId: string; tool: string; params: Record<string, unknown>; createdAt: number }> = [];
    const held = new Map<string, () => Promise<void>>();       // conversationId → como terminar o turno segurado
    const heldContext = new Map<string, unknown>();            // conversationId → rawContext (turnId) do turno segurado
    let txnSeq = 0;

    const finish = async (conversationId: string) => {
        const done = held.get(conversationId);
        held.delete(conversationId);
        if (done) await done();
    };

    const messageBus = {
        async processMessage(msg: NormalizedMessage): Promise<void> {
            const conv = msg.userId;
            const ctx = msg.rawContext;
            const text = msg.text || '';
            if (text === '/cancelar') {
                // comando prioritário: interrompe o que estiver rodando e responde no próprio turno
                const havia = held.has(conv);
                if (havia) {
                    held.delete(conv);
                    activeTurns.delete(conv);
                }
                const original = heldContext.get(conv);
                if (havia && original) await adapter.send({ text: '⏹ Pedido interrompido.', format: 'plain' }, original);
                await adapter.send({ text: havia ? '⏹ Operação cancelada.' : '⏹ Nada em andamento para cancelar.', format: 'plain' }, ctx);
                return;
            }
            if (text.startsWith('eco:')) {
                await sleep(250); // tempo para o teste ver o turno ANTES da entrega (S457-4)
                await adapter.send({ text: text.slice(4), format: 'plain' }, ctx);
                return;
            }
            if (text === 'lento' || text === 'fila' || text === 'perigo') {
                heldContext.set(conv, ctx);
                if (text === 'fila') {
                    // conversa ocupada: o MessageBus manda o ACK pelo mesmo send() e a resposta final sai depois, mesmo rawContext
                    await adapter.send({ text: '🧠 Estou concluindo a tarefa anterior.', format: 'plain' }, ctx);
                }
                await sleep(20); // classificação: aqui o turno ainda não está em activeTurns
                if (text === 'perigo') {
                    pendingTxns.push({ id: `txn-${++txnSeq}`, conversationId: conv, tool: 'exec_command', params: { command: 'rm -rf /tmp/s457' }, createdAt: Date.now() });
                } else {
                    activeTurns.set(conv, Date.now());
                }
                held.set(conv, async () => {
                    activeTurns.delete(conv);
                    await adapter.send({ text: `fim de ${text}`, format: 'plain' }, ctx);
                });
                return;
            }
            await adapter.send({ text: `resposta: ${text}`, format: 'plain' }, ctx);
        },
    };

    adapter.workflowCallback = async (userId: string, txnId: string, decision: string, requestId: unknown) => {
        const i = pendingTxns.findIndex((t) => t.id === txnId && t.conversationId === userId);
        if (i >= 0) pendingTxns.splice(i, 1);
        await adapter.send({ text: decision === 'approved' ? 'aprovado e executado' : 'rejeitado', format: 'plain' }, requestId);
        await finish(userId);
    };

    const controller = {
        getMessageBus: () => messageBus,
        getWebAdapter: () => adapter,
        getTelegramAdapter: () => null,
        getWorkflowEngine: () => ({
            getPendingByConversation: (id: string) => pendingTxns.filter((t) => t.conversationId === id),
        }),
        agentLoop: {
            getActiveTurns: () => [...activeTurns.entries()].map(([conversationId, t0]) => ({ conversationId, elapsedMs: Date.now() - t0 })),
        },
        goalOrchestrator: { getActiveGoals: () => [] as Array<{ id: string; sessionKey: string; status: string; createdAt: number }> },
    };

    return { adapter, controller, finish, activeTurns };
}

function buildApp(controller: unknown): express.Express {
    const app = express();
    app.set('trust proxy', true); // cada seção usa um X-Forwarded-For próprio: o limite de 10 envios/min é por IP
    app.use(express.json());
    app.use(cookieParser());
    app.use(authMiddleware);
    app.use(csrfOriginCheck);
    app.use(express.static(PUBLIC_DIR, { redirect: false }));
    const ctx = { config: {} as any, controller: controller as any };
    app.use('/api/auth', createAuthRouter());
    app.use('/api', createStatusRouter(ctx as any));
    app.use('/api/chat', createChatRouter(ctx as any));
    return app;
}

async function main(): Promise<void> {
    const core = createFakeCore();
    const app = buildApp(core.controller);
    const server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const { createTurnClient, phaseFromActive, TURN_CONTRACT_VERSION: CLIENT_VERSION, CANCEL_COMMAND } = await loadTurnClient();

    try {
        console.log('\n=== S457-1 — autenticação (seção "Autenticação") ===');
        const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: SENHA }) });
        const loginBody = await login.json() as any;
        assert(login.status === 200 && typeof loginBody.token === 'string', 'POST /api/auth/login com a senha devolve { success, token }', loginBody);
        const token: string = loginBody.token;
        const wrong = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'errada' }) });
        assert(wrong.status === 401, 'senha errada → 401', wrong.status);

        for (const [method, p] of [['GET', '/api/chat/active?sessionId=x'], ['GET', '/api/chat/outbox?turnId=x'], ['POST', '/api/chat'], ['GET', '/api/status']] as const) {
            const r = await fetch(`${base}${p}`, { method, headers: { 'Content-Type': 'application/json' }, body: method === 'POST' ? '{}' : undefined });
            assert(r.status === 401, `${method} ${p.split('?')[0]} sem credencial → 401`, r.status);
        }
        const js = await fetch(`${base}/turn-client.js`);
        assert(js.status === 200 && /javascript/.test(js.headers.get('content-type') || ''), 'GET /turn-client.js é público (estático) e servido como JavaScript', js.headers.get('content-type'));

        const auth = { Authorization: `Bearer ${token}` };
        const ip = (n: number) => ({ 'X-Forwarded-For': `203.0.113.${n}` });
        const crossOrigin = await fetch(`${base}/api/chat`, {
            method: 'POST',
            headers: { ...auth, ...ip(1), 'Content-Type': 'application/json', Origin: 'http://outra-origem.example' },
            body: JSON.stringify({ message: 'eco:bearer', sessionId: 's457-bearer' }),
        });
        assert(crossOrigin.status === 202, 'Bearer de outra origem não é barrado pela checagem de CSRF (ela só vale para cookie)', crossOrigin.status);
        const cookie = await fetch(`${base}/api/chat`, {
            method: 'POST',
            headers: { Cookie: `newclaw_session=${token}`, ...ip(1), 'Content-Type': 'application/json', Origin: 'http://outra-origem.example' },
            body: JSON.stringify({ message: 'eco:cookie', sessionId: 's457-cookie' }),
        });
        assert(cookie.status === 403, 'cookie com Origin de outra origem numa rota que altera estado → 403', cookie.status);

        console.log('\n=== S457-2 — versão (seção "Versão e compatibilidade") ===');
        const status = await (await fetch(`${base}/api/status`, { headers: auth })).json() as any;
        assert(status?.status?.contracts?.turn === TURN_CONTRACT_VERSION, 'GET /api/status anuncia status.contracts.turn', status?.status?.contracts);
        assert(TURN_CONTRACT_VERSION === 1 && CLIENT_VERSION === TURN_CONTRACT_VERSION, 'servidor e cliente público declaram a mesma versão (1)', { servidor: TURN_CONTRACT_VERSION, cliente: CLIENT_VERSION });
        assert(typeof status?.status?.version === 'string', 'status.version (versão do NewClaw) continua presente');
        const doc = fs.readFileSync(path.join(__dirname, '../../../docs/CONTRATO_DO_TURNO.md'), 'utf-8');
        assert(new RegExp(`^# Contrato do turno — versão ${TURN_CONTRACT_VERSION}$`, 'm').test(doc), 'o documento do contrato está na mesma versão do servidor');

        console.log('\n=== S457-3 — enviar (operação 1) ===');
        const sendRaw = async (body: unknown, n: number) => fetch(`${base}/api/chat`, { method: 'POST', headers: { ...auth, ...ip(n), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const vazio = await sendRaw({ message: '', sessionId: 's457-vazio' }, 3);
        assert(vazio.status === 400, 'sem texto e sem anexo → 400', vazio.status);
        const semSessao = await sendRaw({ message: 'eco:padrao' }, 3);
        const semSessaoBody = await semSessao.json() as any;
        assert(semSessao.status === 202 && semSessaoBody.success === true && typeof semSessaoBody.turnId === 'string' && semSessaoBody.sessionId === 'web-session',
            '202 { success, turnId, sessionId }; sessionId omitido vale "web-session"', semSessaoBody);
        const form = new FormData();
        form.append('message', 'eco:multipart');
        form.append('sessionId', 's457-multipart');
        const multipart = await fetch(`${base}/api/chat`, { method: 'POST', headers: { ...auth, ...ip(3) }, body: form });
        assert(multipart.status === 202, 'multipart/form-data também é aceito (o formato do painel)', multipart.status);

        console.log('\n=== S457-4 — estado e entrega de um turno simples (operações 2 e 4, fase accepted → finished) ===');
        const raw = await sendRaw({ message: 'eco:olá', sessionId: 's457-eco' }, 4);
        const { turnId } = await raw.json() as any;
        const active0 = await (await fetch(`${base}/api/chat/active?sessionId=s457-eco&turnId=${turnId}`, { headers: auth })).json() as any;
        assert(active0.success === true && Array.isArray(active0.active) && Array.isArray(active0.pendingAuth) && active0.pending === true,
            'logo após o 202: { success, active[], pendingAuth[], pending: true }', active0);
        assert(phaseFromActive(active0, 's457-eco').phase === 'accepted', 'fase "accepted" na janela antes do trabalho ser rastreável');
        const early = await fetch(`${base}/api/chat/outbox?turnId=${turnId}`, { headers: auth });
        assert(early.status === 404 && ((await early.json()) as any).error === 'not_ready_or_not_found', 'outbox antes da entrega → 404 not_ready_or_not_found');
        await sleep(400);
        const active1 = await (await fetch(`${base}/api/chat/active?sessionId=s457-eco&turnId=${turnId}`, { headers: auth })).json() as any;
        assert(active1.pending === false && phaseFromActive(active1, 's457-eco').phase === 'finished', 'depois da entrega: pending=false e fase "finished"', active1);
        const out1 = await fetch(`${base}/api/chat/outbox?turnId=${turnId}`, { headers: auth });
        const out1Body = await out1.json() as any;
        assert(out1.status === 200 && out1Body.success === true && out1Body.response === 'olá', 'outbox → 200 { success, response }', out1Body);
        const out2 = await fetch(`${base}/api/chat/outbox?turnId=${turnId}`, { headers: auth });
        assert(out2.status === 404, 'a leitura consome: a segunda leitura do mesmo turnId → 404', out2.status);
        const semTurn = await fetch(`${base}/api/chat/outbox`, { headers: auth });
        assert(semTurn.status === 400, 'outbox sem turnId → 400', semTurn.status);
        const semTurnActive = await (await fetch(`${base}/api/chat/active?sessionId=s457-eco`, { headers: auth })).json() as any;
        assert(semTurnActive.pending === false, '/active sem turnId → pending=false');

        console.log('\n=== S457-5 — execução e progresso (fase running, campo progresso) ===');
        const turnos = createTurnClient({ baseUrl: base, headers: { ...auth, ...ip(5) } });
        const lento = await turnos.send({ sessionId: 's457-lento', message: 'lento' });
        assert(lento.kind === 'accepted', 'cliente público: send → accepted', lento);
        await sleep(60);
        await core.adapter.sendToChat('s457-lento', { text: 'metade feita', format: 'plain', progresso: true });
        const st = await turnos.state({ sessionId: 's457-lento', turnId: lento.turnId });
        assert(st.phase === 'running' && st.work?.kind === 'turn' && st.elapsedMs >= 0, 'fase "running" com o trabalho desta conversa em active', st);
        assert(st.progress?.texto === 'metade feita' && typeof st.progress?.em === 'number', 'progresso { texto, em } lido no mesmo polling', st.progress);
        const outro = await turnos.state({ sessionId: 's457-outra-conversa' });
        assert(outro.phase === 'finished', 'trabalho de outra conversa não é sinal deste turno (casamento pelo id exato)', outro);
        await core.finish('s457-lento');
        const fim = await turnos.waitForTurn({ sessionId: 's457-lento', turnId: lento.turnId, intervalMs: 20 });
        assert(fim.kind === 'finished' && fim.delivery?.text === 'fim de lento', 'waitForTurn → finished com a entrega', fim);
        const depois = await (await fetch(`${base}/api/chat/active?sessionId=s457-lento`, { headers: auth })).json() as any;
        assert(!('progresso' in depois), 'o relato de progresso some quando a resposta final sai', depois);

        console.log('\n=== S457-6 — aprovação (fase awaiting_approval, operação 6) ===');
        const turnosAprov = createTurnClient({ baseUrl: base, headers: { ...auth, ...ip(6) } });
        const perigo = await turnosAprov.send({ sessionId: 's457-perigo', message: 'perigo' });
        const fases: string[] = [];
        const esperando = turnosAprov.waitForTurn({
            sessionId: 's457-perigo', turnId: perigo.turnId, intervalMs: 20,
            onState: async (s: any) => {
                fases.push(s.phase);
                if (s.phase === 'awaiting_approval' && fases.filter((f) => f === 'awaiting_approval').length === 1) {
                    const a = s.approvals[0];
                    assert(typeof a.txnId === 'string' && a.tool === 'exec_command' && a.detail === 'rm -rf /tmp/s457' && typeof a.createdAt === 'number',
                        'pendingAuth[] traz { txnId, tool, detail, createdAt } — detail é o comando, não os params inteiros', a);
                    const invalida = await fetch(`${base}/api/chat/auth-decision`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: 's457-perigo', txnId: a.txnId, decision: 'talvez' }) });
                    assert(invalida.status === 400, 'auth-decision com decisão inválida → 400', invalida.status);
                    const d = await turnosAprov.decide({ sessionId: 's457-perigo', txnId: a.txnId, decision: 'approved' });
                    assert(d.kind === 'decided' && d.text === 'aprovado e executado', 'decide(approved) → 200 com o texto que a decisão produziu', d);
                }
            },
        });
        const fimPerigo = await esperando;
        assert(fases.includes('awaiting_approval'), 'a fase "awaiting_approval" foi vista (o goal parado não aparece como running)', fases);
        assert(fimPerigo.kind === 'finished' && fimPerigo.delivery?.text === 'fim de perigo', 'depois da decisão, o turno original termina com a própria entrega', fimPerigo);

        console.log('\n=== S457-7 — cancelamento (operação 5) ===');
        const turnosCancel = createTurnClient({ baseUrl: base, headers: { ...auth, ...ip(7) } });
        assert(CANCEL_COMMAND === '/cancelar', 'o cliente cancela com o comando /cancelar');
        const longo = await turnosCancel.send({ sessionId: 's457-cancel', message: 'lento' });
        await sleep(60);
        const pedido = await turnosCancel.cancel({ sessionId: 's457-cancel' });
        assert(pedido.kind === 'accepted' && pedido.turnId !== longo.turnId, 'o cancelamento é um turno próprio, com turnId próprio', pedido);
        const conf = await turnosCancel.waitForTurn({ sessionId: 's457-cancel', turnId: pedido.turnId, intervalMs: 20 });
        assert(conf.kind === 'finished' && conf.delivery?.text === '⏹ Operação cancelada.', 'a confirmação chega na outbox do turno de cancelamento', conf);
        const cancelado = await turnosCancel.waitForTurn({ sessionId: 's457-cancel', turnId: longo.turnId, intervalMs: 20 });
        assert(cancelado.kind === 'finished' && cancelado.delivery?.text === '⏹ Pedido interrompido.', 'o turno cancelado recebe a própria entrega de interrupção', cancelado);

        console.log('\n=== S457-8 — aviso de fila: um turnId pode receber mais de uma entrega ("Comportamentos", item 1) ===');
        const turnosFila = createTurnClient({ baseUrl: base, headers: { ...auth, ...ip(8) } });
        const fila = await turnosFila.send({ sessionId: 's457-fila', message: 'fila' });
        await sleep(60);
        const primeira = await turnosFila.result(fila.turnId);
        assert(primeira.kind === 'delivered' && primeira.text.startsWith('🧠'), 'a primeira entrega do turnId é o aviso de fila', primeira);
        await core.finish('s457-fila');
        const segunda = await turnosFila.result(fila.turnId);
        assert(segunda.kind === 'delivered' && segunda.text === 'fim de fila', 'a resposta final sai depois, com o MESMO turnId', segunda);
        const fila2 = await turnosFila.send({ sessionId: 's457-fila2', message: 'fila' });
        await sleep(60);
        await core.finish('s457-fila2');
        const unica = await turnosFila.result(fila2.turnId);
        const nada = await turnosFila.result(fila2.turnId);
        assert(unica.text === 'fim de fila' && nada.kind === 'none', 'se ninguém retirou o aviso, a resposta final o substitui na outbox', { unica, nada });

        console.log('\n=== S457-9 — waitForTurn: entrega já retirada, tempo esgotado, servidor fora, sem login ===');
        const turnosW = createTurnClient({ baseUrl: base, headers: { ...auth, ...ip(9) } });
        const ja = await turnosW.send({ sessionId: 's457-ja', message: 'eco:x' });
        await sleep(400);
        await turnosW.result(ja.turnId); // outra aba retirou
        const semEntrega = await turnosW.waitForTurn({ sessionId: 's457-ja', turnId: ja.turnId, intervalMs: 5 });
        assert(semEntrega.kind === 'finished' && semEntrega.delivery === null, 'entrega já retirada → finished com delivery null (ler o histórico)', semEntrega);
        const parado = await turnosW.send({ sessionId: 's457-parado', message: 'lento' });
        let t = 0;
        const esgotou = await turnosW.waitForTurn({ sessionId: 's457-parado', turnId: parado.turnId, maxWaitMs: 100, sleep: async () => { t += 50; }, now: () => t });
        assert(esgotou.kind === 'timeout', 'passou de maxWaitMs → timeout (o turno segue no servidor)', esgotou);
        const ctrl = new AbortController();
        ctrl.abort();
        const abortado = await turnosW.waitForTurn({ sessionId: 's457-parado', turnId: parado.turnId, signal: ctrl.signal });
        assert(abortado.kind === 'aborted', 'signal abortado → aborted', abortado);
        await core.finish('s457-parado');
        const fora = createTurnClient({ baseUrl: 'http://127.0.0.1:1', headers: auth });
        const inalcancavel = await fora.waitForTurn({ sessionId: 'x', turnId: 'y', maxConsecutiveErrors: 2, sleep: async () => {} });
        assert(inalcancavel.kind === 'unreachable' && !!inalcancavel.lastError, 'servidor fora do ar → unreachable com o último erro', inalcancavel);
        const anonimo = createTurnClient({ baseUrl: base });
        const recusado = await anonimo.waitForTurn({ sessionId: 'x', turnId: 'y', sleep: async () => {} });
        assert(recusado.kind === 'rejected' && recusado.status === 401, 'sem credencial → rejected 401, sem insistir', recusado);

        console.log('\n=== S457-10 — limite de envio (seção "Limites de requisição") ===');
        const statuses: number[] = [];
        let retryAfter: string | null = null;
        for (let i = 0; i < 11; i++) {
            const r = await sendRaw({ message: `eco:${i}`, sessionId: 's457-limite' }, 10);
            statuses.push(r.status);
            if (r.status === 429) retryAfter = r.headers.get('retry-after');
        }
        assert(statuses.slice(0, 10).every((s) => s === 202) && statuses[10] === 429 && !!retryAfter, '10 envios por minuto por IP; o 11º → 429 com Retry-After', { statuses, retryAfter });
        const limitado = await createTurnClient({ baseUrl: base, headers: { ...auth, ...ip(10) } }).send({ sessionId: 's457-limite', message: 'eco:mais' });
        assert(limitado.kind === 'rejected' && limitado.status === 429 && limitado.retryAfterSec > 0, 'cliente público: 429 vira rejected com retryAfterSec', limitado);

        console.log('\n=== S457-11 — consumidores existentes continuam compatíveis ===');
        // Suplemento do PowerPoint: o cliente dele, sem alteração, contra as rotas reais.
        const add = await sendRaw({ message: 'eco:do suplemento', sessionId: 'powerpoint-addin-s457' }, 11);
        const addTurn = ((await add.json()) as any).turnId;
        const outcome = await waitForTurnResponse({
            fetchFn: (u, init) => fetch(u, init), serverUrl: base, headers: auth, turnId: addTurn, intervalMs: 20,
        });
        assert(outcome.kind === 'response' && outcome.payload.response === 'do suplemento', 'turnPolling.ts (suplemento) recebe a resposta pelas rotas reais', outcome);
        const addSemLogin = await waitForTurnResponse({ fetchFn: (u, init) => fetch(u, init), serverUrl: base, headers: {}, turnId: addTurn, intervalMs: 5 });
        assert(addSemLogin.kind === 'rejected', 'turnPolling.ts trata 401 como recusa, como antes', addSemLogin);

        // Painel: os campos que o script lê existem nas respostas reais.
        const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf-8');
        const destr = html.match(/const \{([^}]*)\} = await res\.json\(\);\s*renderPendingAuth/);
        assert(!!destr, 'pré-condição: o painel desestrutura a resposta de /api/chat/active');
        const campos = (destr ? destr[1] : '').split(',').map((s) => s.split('=')[0].trim()).filter(Boolean);
        const painelTurnos = createTurnClient({ baseUrl: base, headers: { ...auth, ...ip(12) } });
        const pt = await painelTurnos.send({ sessionId: 's457-painel', message: 'lento' });
        await sleep(60);
        await core.adapter.sendToChat('s457-painel', { text: 'andando', format: 'plain', progresso: true });
        const ativo = await (await fetch(`${base}/api/chat/active?sessionId=s457-painel&turnId=${pt.turnId}`, { headers: auth })).json() as any;
        assert(campos.length >= 4 && campos.every((c) => c in ativo), `todos os campos que o painel lê de /active existem: ${campos.join(', ')}`, { campos, ativo });
        assert(ativo.active.some((a: any) => 'conversationId' in a && 'elapsedMs' in a && 'kind' in a), 'itens de active têm conversationId, elapsedMs e kind (lidos por formatSemanticStatus)');
        await core.finish('s457-painel');
        await sleep(20);
        const outPainel = await (await fetch(`${base}/api/chat/outbox?turnId=${pt.turnId}`, { headers: auth })).json() as any;
        assert(/data\.success/.test(html) && /data\.response/.test(html) && /data\.attachments/.test(html) && 'success' in outPainel && 'response' in outPainel,
            'o painel lê success, response e attachments da outbox, e a resposta real os traz', outPainel);

        console.log('\n=== S457-12 — neutralidade do cliente público (ADR-031) ===');
        const src = fs.readFileSync(CLIENT_PATH, 'utf-8');
        const codigo = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
        assert(!/^\s*import\s/m.test(codigo) && !/require\(/.test(codigo), 'sem dependências: nenhum import nem require');
        assert(!/powerpoint|interface_voz|pipecat|kokoro|document\.|window\./i.test(codigo), 'não conhece cliente, harness, fornecedor de voz nem DOM');
        const p = (body: unknown) => phaseFromActive(body, 'c');
        assert(p({ active: [{ conversationId: 'c', elapsedMs: 1, kind: 'turn' }], pendingAuth: [{ txnId: 't' }], pending: true }).phase === 'awaiting_approval', 'aprovação pendente vem antes de running');
        assert(p({ active: [{ conversationId: 'outra', elapsedMs: 1, kind: 'goal' }], pendingAuth: [], pending: false }).phase === 'finished', 'só outra conversa ativa → finished');
        assert(p({ active: [], pendingAuth: [], pending: false, progresso: { texto: 'velho', em: 1 } }).progress === null, 'em finished, progresso é descartado');
        assert(p(null).phase === 'finished', 'resposta vazia não quebra a função');
    } finally {
        server.close();
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S457 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
    console.error('S457 erro inesperado:', err);
    process.exitCode = 1;
});
