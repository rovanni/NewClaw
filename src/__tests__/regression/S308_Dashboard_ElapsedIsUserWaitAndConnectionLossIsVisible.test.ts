/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S308 (Sprint 6, issue 048, achado no navegador em 26/09/2026)
 * Dois defeitos do painel, vistos quando um goal durou mais de 1 hora:
 *   (a) "Ainda processando — já faz 2 min" com 1 hora de espera: o servidor devolvia a idade do TURNO (que
 *       recomeça a cada passo do goal), não a da espera do usuário;
 *   (b) com o servidor fora do ar, o último texto de status ficava congelado para sempre: o erro do polling era
 *       engolido sem aviso.
 *
 *   1-5  → servidor (router REAL via Express): elapsedMs de um turno dentro de um goal é a idade do goal.
 *   6    → cliente: `nextPollHealth` (código real do index.html) só manda avisar após 3 falhas seguidas.
 *   7    → cliente: `poll()` real devolve {failed:true} quando a consulta falha e {failed:false} quando funciona.
 *   8    → cliente: o wrapper real avisa "conexão perdida" na 3ª falha, não antes, e para de avisar ao voltar.
 *   9    → o texto existe nos 3 idiomas.
 *
 * Execução: npx ts-node src/__tests__/regression/S308_Dashboard_ElapsedIsUserWaitAndConnectionLossIsVisible.test.ts
 */
process.env.WORKSPACE_DIR = process.env.WORKSPACE_DIR || 'D:/IA/newclaw/workspace';

import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import express from 'express';
import type { AddressInfo } from 'net';
import { createChatRouter } from '../../dashboard/routes/chat';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...args: string[]) => (...args: unknown[]) => Promise<unknown>;

const MIN = 60_000;

interface ActiveItem { conversationId: string; elapsedMs: number; kind: string; status?: string; statusEvent?: unknown }

async function queryActive(turns: Array<{ conversationId: string; elapsedMs: number; statusEvent?: unknown }>,
                           goals: Array<{ id: string; sessionKey: string; status: string; createdAt: number }>): Promise<ActiveItem[]> {
    const ctx = { controller: { agentLoop: { getActiveTurns: () => turns }, goalOrchestrator: { getActiveGoals: () => goals } } };
    const app = express();
    app.use('/api/chat', createChatRouter(ctx as never));
    const server: http.Server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    try {
        const port = (server.address() as AddressInfo).port;
        const res = await fetch(`http://127.0.0.1:${port}/api/chat/active?sessionId=conv_x`, { headers: { Connection: 'close' } });
        return ((await res.json()) as { active: ActiveItem[] }).active;
    } finally {
        // Fecha tudo de forma limpa: `process.exit()` com sockets ainda abertos derruba o Node no Windows
        // (exitCode 0xC0000409, visto na regressão completa).
        (server as http.Server & { closeAllConnections?: () => void }).closeAllConnections?.();
        await new Promise<void>(r => server.close(() => r()));
    }
}

function extractFunction(html: string, name: string): string {
    const start = html.indexOf(`function ${name}(`);
    if (start < 0) throw new Error(`pré-condição falhou: function ${name} não encontrada em index.html`);
    const bodyStart = html.indexOf('{', start);
    let depth = 0;
    for (let i = bodyStart; i < html.length; i++) {
        if (html[i] === '{') depth++;
        else if (html[i] === '}' && --depth === 0) return html.slice(start, i + 1);
    }
    throw new Error(`pré-condição falhou: fim de ${name} não encontrado`);
}

async function main(): Promise<void> {
    const now = Date.now();

    console.log('\n=== S308-1 — turno dentro de um goal: o tempo mostrado é o da espera (idade do goal) ===');
    {
        const active = await queryActive(
            [{ conversationId: 'conv_a', elapsedMs: 2 * MIN, statusEvent: { status: 'thinking' } }],
            [{ id: 'goal_1', sessionKey: 'web:conv_a', status: 'executing', createdAt: now - 65 * MIN }],
        );
        const item = active.find(a => a.conversationId === 'conv_a');
        assert(!!item && item.elapsedMs >= 64 * MIN, `elapsedMs ≈ 65 min, não 2 min (${Math.round((item?.elapsedMs ?? 0) / MIN)} min)`, item);
        assert(item?.kind === 'turn' && !!item.statusEvent, 'continua kind=turn com o statusEvent do passo (o status semântico não muda)', item);
        assert(active.length === 1, 'a conversa aparece uma vez só', active);
    }

    console.log('\n=== S308-2 — só turno (sem goal): inalterado ===');
    {
        const active = await queryActive([{ conversationId: 'conv_b', elapsedMs: 3 * MIN }], []);
        assert(active.length === 1 && active[0].elapsedMs === 3 * MIN && active[0].kind === 'turn', 'idade do turno preservada', active);
    }

    console.log('\n=== S308-3 — só goal (sem turno): idade do goal, kind=goal ===');
    {
        const active = await queryActive([], [{ id: 'goal_3', sessionKey: 'web:conv_c', status: 'executing', createdAt: now - 10 * MIN }]);
        assert(active.length === 1 && active[0].kind === 'goal' && active[0].elapsedMs >= 9 * MIN, 'idade do goal', active);
    }

    console.log('\n=== S308-4 — goal blocked não conta (nem some na lista, nem infla o turno) ===');
    {
        const active = await queryActive(
            [{ conversationId: 'conv_d', elapsedMs: 2 * MIN }],
            [{ id: 'goal_4', sessionKey: 'web:conv_d', status: 'blocked', createdAt: now - 90 * MIN }],
        );
        assert(active.length === 1 && active[0].elapsedMs === 2 * MIN, 'turno com 2 min, sem herdar a idade do goal parado', active);
    }

    console.log('\n=== S308-5 — goal de OUTRA conversa não afeta o turno ===');
    {
        const active = await queryActive(
            [{ conversationId: 'conv_e', elapsedMs: 1 * MIN }],
            [{ id: 'goal_5', sessionKey: 'web:conv_outra', status: 'executing', createdAt: now - 50 * MIN }],
        );
        const turn = active.find(a => a.conversationId === 'conv_e');
        assert(turn?.elapsedMs === 1 * MIN, 'o turno mantém a própria idade', active);
    }

    const html = fs.readFileSync(path.join(__dirname, '../../dashboard/public/index.html'), 'utf-8');

    console.log('\n=== S308-6 — nextPollHealth (código real): só avisa após 3 falhas seguidas ===');
    const threshold = (html.match(/const POLL_FAILURES_BEFORE_WARNING = (\d+);/) ?? [])[1];
    assert(threshold === '3', 'limite de 3 falhas seguidas (≈ 5 s de polling)', threshold);
    const nextPollHealth = new Function('POLL_FAILURES_BEFORE_WARNING', `${extractFunction(html, 'nextPollHealth')}; return nextPollHealth;`)(Number(threshold)) as
        (prev: number, failed: boolean) => { failures: number; warn: boolean };
    {
        let h = nextPollHealth(0, true);
        assert(h.failures === 1 && !h.warn, '1ª falha: não avisa');
        h = nextPollHealth(h.failures, true);
        assert(h.failures === 2 && !h.warn, '2ª falha: não avisa');
        h = nextPollHealth(h.failures, true);
        assert(h.failures === 3 && h.warn, '3ª falha seguida: avisa');
        h = nextPollHealth(h.failures, true);
        assert(h.warn, 'continua avisando enquanto falha');
        h = nextPollHealth(h.failures, false);
        assert(h.failures === 0 && !h.warn, 'uma consulta que funciona zera o contador e o aviso');
    }

    console.log('\n=== S308-7 — poll() real devolve {failed} conforme a consulta falha ou funciona ===');
    const pollStart = 'const poll = async () => {';
    const pollBodyStart = html.indexOf(pollStart) + pollStart.length;
    let pollBody = html.slice(pollBodyStart, html.indexOf('\n      poll();', pollBodyStart));
    pollBody = pollBody.replace(/\}\s*;\s*$/, '');
    const buildPoll = (fetchImpl: () => Promise<unknown>) => new AsyncFunction(
        'newclawFetch', 'renderPendingAuth', 'formatSemanticStatus', 'showStatus', 'stopTurnPolling', 't', 'fetchAndRenderOutbox', 'sessionId', 'turnId', pollBody,
    ).bind(null, fetchImpl, () => {}, () => ({ type: 'processing', text: 'x' }), () => {}, () => {}, (k: string) => k, async () => {}, 'sess', 'turn') as () => Promise<{ failed: boolean } | undefined>;
    {
        const ok = await buildPoll(async () => ({ status: 200, json: async () => ({ success: true, active: [{ conversationId: 'sess', elapsedMs: 1, kind: 'goal' }], pending: false }) }))();
        assert(ok?.failed === false, 'consulta que funciona → {failed:false}', ok);
        const bad = await buildPoll(async () => { throw new TypeError('Failed to fetch'); })();
        assert(bad?.failed === true, 'servidor fora do ar (fetch lança) → {failed:true}', bad);
    }

    console.log('\n=== S308-8 — wrapper real: avisa na 3ª falha, não antes, e para de avisar ao voltar ===');
    {
        const marker = 'const pollWithHealth = async () => {';
        const wStart = html.indexOf(marker);
        if (wStart < 0) throw new Error('pré-condição falhou: pollWithHealth não encontrado');
        const wBodyStart = wStart + marker.length;
        const wBody = html.slice(wBodyStart, html.indexOf('\n      turnPollingTimer = setInterval(pollWithHealth', wBodyStart)).replace(/\}\s*;\s*$/, '');
        const shown: Array<{ type: string; text: string }> = [];
        let pollResult: { failed: boolean } = { failed: true };
        const build = new AsyncFunction('poll', 'nextPollHealth', 'showStatus', 't',
            `let consecutivePollFailures = 0; const pollWithHealth = async () => {${wBody}}; return pollWithHealth;`);
        const pollWithHealth = (await build(async () => pollResult, nextPollHealth, (type: string, text: string) => shown.push({ type, text }), (k: string) => k)) as () => Promise<void>;
        await pollWithHealth(); await pollWithHealth();
        assert(shown.length === 0, 'duas falhas: a tela ainda não avisa', shown);
        await pollWithHealth();
        assert(shown.length === 1 && shown[0].type === 'error' && shown[0].text === 'status_connection_lost', '3ª falha: showStatus("error", status_connection_lost)', shown);
        pollResult = { failed: false };
        await pollWithHealth();
        await pollWithHealth();
        assert(shown.length === 1, 'com o servidor de volta, o aviso não se repete', shown);
        pollResult = { failed: true };
        await pollWithHealth(); await pollWithHealth();
        assert(shown.length === 1, 'o contador recomeçou do zero após a recuperação (2 falhas novas, sem aviso)', shown);
    }

    console.log('\n=== S308-9 — o texto existe nos 3 idiomas ===');
    {
        const shared = fs.readFileSync(path.join(__dirname, '../../dashboard/public/shared.js'), 'utf-8');
        assert((shared.match(/status_connection_lost:/g) ?? []).length === 3, 'status_connection_lost em pt-BR, en-US e es-ES', (shared.match(/status_connection_lost:/g) ?? []).length);
    }

    console.log(`\nS308 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    process.exitCode = failed > 0 ? 1 : 0;
}
main().catch(e => { console.error(e); process.exitCode = 1; });
