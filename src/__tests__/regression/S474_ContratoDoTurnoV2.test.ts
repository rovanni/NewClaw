/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S474 (contrato do turno, versão 2 — ADR-033, aprovada em 04/11/2026)
 *
 * A versão 2 acrescenta, sem mudar a 1 (o S457 continua valendo): as etapas reais do objetivo (`trabalho` em `/active`, com
 * `plano`, `revisao` e `desdeRevisao`), os últimos 20 relatos com corte declarado, `resultado` e `provisoria` na outbox,
 * `GET /api/chat/context` (canal, cliente, modelo da última resposta) e o campo `client` de `POST /api/chat`.
 *
 * O que é real aqui: as rotas (`createChatRouter`) por HTTP numa porta efêmera, o `WebChannelAdapter`, o `MessageBus` (aviso
 * de fila, passagem do resultado, gravação do cliente), as projeções (`contratoDoTurno.ts`), o `DashboardMemoryRepository`
 * sobre um SQLite em memória, a `SessionTranscript` num diretório temporário, o `chatWithFallback` do `ProviderFactory`
 * (registro do modelo) e o `getActiveGoalForConversation` do orquestrador. Imitados: o Core (objetivos e o provedor).
 *
 * Limites de exposição (ADR-033 §6): o objetivo do teste tem `toolArgs`, `result`, tentativas e vereditos cheios de
 * marcadores; nenhum pode aparecer em `/active`, `/context` ou na outbox.
 *
 * Execução: npx ts-node src/__tests__/regression/S474_ContratoDoTurnoV2.test.ts
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import express from 'express';
import Database from 'better-sqlite3';
import type { AddressInfo } from 'net';
import type { NormalizedMessage, ChannelAdapter, NormalizedResponse } from '../../channels/ChannelAdapter';

process.env.WORKSPACE_DIR = process.env.WORKSPACE_DIR || path.join(os.tmpdir(), 'newclaw-s474');

/* eslint-disable @typescript-eslint/no-var-requires */
const { createChatRouter, TURN_CONTRACT_VERSION } = require('../../dashboard/routes/chat') as typeof import('../../dashboard/routes/chat');
const { WebChannelAdapter } = require('../../channels/WebChannelAdapter') as typeof import('../../channels/WebChannelAdapter');
const { MessageBus } = require('../../channels/MessageBus') as typeof import('../../channels/MessageBus');
const { DashboardMemoryRepository } = require('../../dashboard/DashboardMemoryRepository') as typeof import('../../dashboard/DashboardMemoryRepository');
const { SessionTranscript } = require('../../session/SessionTranscript') as typeof import('../../session/SessionTranscript');
const { SessionManager } = require('../../session/SessionManager') as typeof import('../../session/SessionManager');
const { ProviderFactory } = require('../../core/ProviderFactory') as typeof import('../../core/ProviderFactory');
const { GoalOrchestrator } = require('../../loop/GoalOrchestrator') as typeof import('../../loop/GoalOrchestrator');
const contrato = require('../../shared/contratoDoTurno') as typeof import('../../shared/contratoDoTurno');
const { executarNoTurno } = require('../../shared/turnCancellation') as typeof import('../../shared/turnCancellation');
/* eslint-enable @typescript-eslint/no-var-requires */

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred: () => boolean, timeoutMs = 3000): Promise<void> {
    const start = Date.now();
    while (!pred() && Date.now() - start < timeoutMs) await sleep(10);
}

const MARCADORES = ['MARCADOR_TOOLARGS', 'MARCADOR_RESULT', 'MARCADOR_TENTATIVA', 'MARCADOR_VEREDITO', 'MARCADOR_RACIOCINIO', 'MARCADOR_PROMPT'];
const vazou = (x: unknown): string[] => { const s = JSON.stringify(x); return MARCADORES.filter((m) => s.includes(m)); };

/** Um objetivo com tudo o que NUNCA pode sair pelo contrato preenchido com marcadores. */
function goalComMarcadores(conversa: string, over: Record<string, unknown> = {}): any {
    return {
        id: 'goal_s474_' + conversa, sessionKey: `web:${conversa}`, conversationId: conversa, status: 'executing',
        description: 'MARCADOR_PROMPT pedido cru', planGeneration: 1, requiresAuth: false, createdAt: Date.now(),
        currentPlan: [
            { id: 's1', description: 'Coletar os logs de hoje', status: 'completed', toolName: 'exec_command', toolArgs: { command: 'MARCADOR_TOOLARGS' }, result: 'MARCADOR_RESULT', lastAttemptOutcome: 'success' },
            { id: 's2', description: 'Analisar os registros de erro', status: 'executing', toolName: 'read_file', toolArgs: { path: 'MARCADOR_TOOLARGS' } },
            { id: 's3', description: 'Consolidar o diagnóstico', status: 'pending' },
        ],
        attempts: [{ stepId: 's1', result: 'success', output: 'MARCADOR_TENTATIVA', veredito: 'MARCADOR_VEREDITO', raciocinio: 'MARCADOR_RACIOCINIO' }],
        ...over,
    };
}

async function main(): Promise<void> {
    console.log('\n=== S474-1 — projeções (contratoDoTurno.ts) ===');
    const g = goalComMarcadores('c1');
    const t = contrato.projetarTrabalho(g);
    assert(t.tipo === 'objetivo' && t.estado === 'executando' && t.plano === 1, 'trabalho: tipo, estado e plano', t);
    assert(JSON.stringify(t.etapas) === JSON.stringify([
        { id: 's1', descricao: 'Coletar os logs de hoje', estado: 'concluida' },
        { id: 's2', descricao: 'Analisar os registros de erro', estado: 'executando' },
        { id: 's3', descricao: 'Consolidar o diagnóstico', estado: 'pendente' },
    ]), 'etapas: só id, a descrição inteira e o estado', t.etapas);
    assert(vazou(t).length === 0, 'nenhum marcador na projeção do trabalho', vazou(t));
    assert(contrato.estadoDoTrabalho('blocked', true) === 'aguardando_aprovacao' && contrato.estadoDoTrabalho('blocked', false) === 'executando'
        && contrato.estadoDoTrabalho('replanning', false) === 'replanejando' && contrato.estadoDoTrabalho('abandoned', false) === 'cancelado',
        'estado: blocked com aprovação → aguardando_aprovacao; sem → executando; replanning; abandoned → cancelado');
    const passo = (status: string, outcome?: string) => ({ id: 'x', description: 'd', status, lastAttemptOutcome: outcome });
    assert(contrato.resultadoDaTarefa({ status: 'completed', currentPlan: [passo('completed', 'success'), passo('completed', 'success')] } as any).estado === 'concluido', 'resultado: concluído');
    const parcial = contrato.resultadoDaTarefa({ status: 'completed', currentPlan: [passo('completed', 'partial'), passo('completed', 'success'), passo('skipped')] } as any);
    assert(parcial.estado === 'parcial' && parcial.etapas.total === 3 && parcial.etapas.concluidas === 2, 'resultado: parcial quando uma etapa concluída teve confiança baixa; contagem', parcial);
    assert(contrato.resultadoDaTarefa({ status: 'failed', currentPlan: [] } as any).estado === 'falhou'
        && contrato.resultadoDaTarefa({ status: 'abandoned', currentPlan: [] } as any).estado === 'cancelado', 'resultado: falhou e cancelado');
    assert(contrato.clienteValido('newclaw-ivox') === 'newclaw-ivox' && contrato.clienteValido('Maiúscula') === undefined
        && contrato.clienteValido('a'.repeat(65)) === undefined && contrato.clienteValido(42) === undefined && contrato.clienteValido('') === undefined,
        'client: só [a-z0-9._-], de 1 a 64 caracteres');

    console.log('\n=== S474-2 — getActiveGoalForConversation (orquestrador real) ===');
    const goals = [goalComMarcadores('outra'), goalComMarcadores('c1')];
    const achado = (GoalOrchestrator.prototype as any).getActiveGoalForConversation.call({ goalStore: { getAllActive: () => goals } }, 'c1');
    assert(achado?.id === 'goal_s474_c1', 'acha o objetivo pela parte do usuário da chave, não o de outra conversa', achado?.id);

    // ── HTTP ──────────────────────────────────────────────────────────────────────────────────────────────────────────
    const adapter = new WebChannelAdapter();
    const ativos = new Map<string, any>();
    const recebidas: NormalizedMessage[] = [];
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE conversations (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, provider TEXT DEFAULT 'gemini', created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP);
             CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT, role TEXT, content TEXT, attachments TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);`);
    db.prepare("INSERT INTO conversations (id, user_id, provider, created_at) VALUES ('web:c1', 'c1', 'web', '2026-11-04 12:00:00')").run();
    for (let i = 0; i < 3; i++) db.prepare("INSERT INTO messages (conversation_id, role, content) VALUES ('web:c1', 'user', 'MARCADOR_RESULT conteúdo')").run();
    const repo = new DashboardMemoryRepository(db as any);

    const dirTranscricoes = fs.mkdtempSync(path.join(os.tmpdir(), 's474-'));
    const transcricao = new SessionTranscript(dirTranscricoes, 'web:c1');
    await transcricao.init();
    await transcricao.appendAsync('user', 'primeira, sem cliente');
    await transcricao.appendAsync('user', 'pela voz', { cliente: 'newclaw-ivox' });
    await transcricao.appendAsync('user', 'pelo painel', { cliente: 'painel' });
    const sessaoReal = { getOrCreateSession: async () => transcricao };
    const sessionManager = { clienteDaConversa: (key: unknown) => (SessionManager.prototype as any).clienteDaConversa.call(sessaoReal, key) };

    const controller = {
        getMessageBus: () => ({ processMessage: async (m: NormalizedMessage) => { recebidas.push(m); } }),
        getWebAdapter: () => adapter,
        getSessionManager: () => sessionManager,
        getWorkflowEngine: () => ({ getPendingByConversation: () => [] }),
        agentLoop: { getActiveTurns: () => [] },
        goalOrchestrator: {
            getActiveGoals: () => [...ativos.values()],
            getActiveGoalForConversation: (id: string) => ativos.get(id),
        },
    };
    const app = express();
    app.use(express.json());
    app.use('/api/chat', createChatRouter({ config: {} as any, controller: controller as any, memoryManager: { getDashboardRepository: () => repo } as any } as any));
    const server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const get = async (p: string) => { const r = await fetch(base + p); return { status: r.status, body: await r.json() as any }; };

    try {
        console.log('\n=== S474-3 — trabalho em /active: etapas, revisão, desdeRevisao, troca de plano ===');
        const semObjetivo = await get('/api/chat/active?sessionId=c1');
        assert(semObjetivo.body.success === true && !('trabalho' in semObjetivo.body), 'conversa sem objetivo: trabalho ausente (o contrato não inventa etapas)', semObjetivo.body);
        ativos.set('c1', goalComMarcadores('c1'));
        const a1 = await get('/api/chat/active?sessionId=c1');
        const tr = a1.body.trabalho;
        assert(tr?.tipo === 'objetivo' && tr.estado === 'executando' && tr.plano === 1 && typeof tr.revisao === 'number' && tr.etapas?.length === 3,
            'trabalho: tipo, estado, plano, revisão e as 3 etapas', tr);
        assert(Array.isArray(a1.body.active) && 'pendingAuth' in a1.body && 'pending' in a1.body, 'os campos da versão 1 continuam lá', Object.keys(a1.body));
        const a2 = await get(`/api/chat/active?sessionId=c1&desdeRevisao=${tr.revisao}`);
        assert(a2.body.trabalho?.revisao === tr.revisao && !('etapas' in a2.body.trabalho) && a2.body.trabalho.estado === 'executando',
            'desdeRevisao igual: mesma revisão, sem etapas (consulta leve), estado presente', a2.body.trabalho);
        const g1 = ativos.get('c1');
        g1.currentPlan[1].status = 'completed';
        const a3 = await get(`/api/chat/active?sessionId=c1&desdeRevisao=${tr.revisao}`);
        assert(a3.body.trabalho?.revisao > tr.revisao && a3.body.trabalho.etapas?.[1]?.estado === 'concluida', 'etapa mudou: revisão cresce e as etapas voltam', a3.body.trabalho);
        ativos.set('c1', goalComMarcadores('c1', { planGeneration: 2, currentPlan: [{ id: 'n1', description: 'Plano novo', status: 'pending', toolArgs: { x: 'MARCADOR_TOOLARGS' } }] }));
        const a4 = await get(`/api/chat/active?sessionId=c1&desdeRevisao=${a3.body.trabalho.revisao}`);
        assert(a4.body.trabalho?.plano === 2 && a4.body.trabalho.etapas?.length === 1 && a4.body.trabalho.revisao > a3.body.trabalho.revisao,
            'plano substituído: plano 2, etapas novas, revisão maior', a4.body.trabalho);
        ativos.set('c1', goalComMarcadores('c1', { status: 'blocked', pendingTxnId: 'txn-1' }));
        const a5 = await get('/api/chat/active?sessionId=c1');
        assert(a5.body.trabalho?.estado === 'aguardando_aprovacao', 'objetivo parado esperando aprovação → aguardando_aprovacao', a5.body.trabalho);
        const outra = await get('/api/chat/active?sessionId=outra');
        assert(!('trabalho' in outra.body), 'trabalho de uma conversa não aparece na outra', outra.body);
        assert([a1, a2, a3, a4, a5].every((r) => vazou(r.body).length === 0), 'nenhum marcador (toolArgs, result, tentativa, veredito, raciocínio, prompt) em /active',
            [a1, a2, a3, a4, a5].map((r) => vazou(r.body)));

        console.log('\n=== S474-4 — relatos: últimos 20, do mais antigo ao mais novo, corte declarado ===');
        ativos.set('c1', goalComMarcadores('c1'));
        for (let i = 1; i <= 25; i++) await adapter.sendToChat('c1', { text: `relato ${i}`, format: 'plain', progresso: true });
        const r1 = await get('/api/chat/active?sessionId=c1');
        assert(r1.body.relatos?.length === 20 && r1.body.relatos[0].texto === 'relato 6' && r1.body.relatos[19].texto === 'relato 25' && r1.body.relatosOmitidos === 5,
            '20 relatos, do 6 ao 25, e relatosOmitidos: 5', { n: r1.body.relatos?.length, primeiro: r1.body.relatos?.[0], omitidos: r1.body.relatosOmitidos });
        assert(r1.body.progresso?.texto === 'relato 25', 'progresso (v1) continua sendo o último relato', r1.body.progresso);
        const r2 = await get(`/api/chat/active?sessionId=c1&desdeRevisao=${r1.body.trabalho.revisao}`);
        assert(!('relatos' in r2.body) && r2.body.progresso?.texto === 'relato 25', 'desdeRevisao igual: relatos de fora, progresso (v1) mantido', r2.body);
        await adapter.sendToChat('c1', { text: 'relato 26', format: 'plain', progresso: true });
        const r3 = await get(`/api/chat/active?sessionId=c1&desdeRevisao=${r1.body.trabalho.revisao}`);
        assert(r3.body.trabalho.revisao > r1.body.trabalho.revisao && r3.body.relatos?.[19]?.texto === 'relato 26', 'relato novo: revisão cresce e os relatos voltam', r3.body.trabalho);

        console.log('\n=== S474-5 — outbox: resultado e provisoria ===');
        adapter.registerAsyncTurn('t-fila', 'c1');
        await adapter.send({ text: '🧠 Estou concluindo a tarefa anterior.', format: 'plain', provisoria: true }, 't-fila');
        const depoisDoAviso = await get('/api/chat/active?sessionId=c1');
        assert(depoisDoAviso.body.relatos?.length === 20, 'o aviso de fila não é a resposta final: os relatos do trabalho em curso ficam', depoisDoAviso.body.relatos?.length);
        const aviso = await get('/api/chat/outbox?turnId=t-fila');
        assert(aviso.body.provisoria === true && !('resultado' in aviso.body), 'aviso de fila sai com provisoria: true', aviso.body);
        adapter.registerAsyncTurn('t-obj', 'c1');
        await adapter.send({ text: 'pronto', format: 'markdown', resultado: { estado: 'parcial', etapas: { total: 3, concluidas: 2 } } }, 't-obj');
        const fim = await get('/api/chat/outbox?turnId=t-obj');
        assert(fim.body.resultado?.estado === 'parcial' && fim.body.resultado.etapas.total === 3 && !('provisoria' in fim.body), 'entrega de objetivo traz resultado; sem provisoria', fim.body);
        const depoisDoFim = await get('/api/chat/active?sessionId=c1');
        assert(!('relatos' in depoisDoFim.body) && !('progresso' in depoisDoFim.body), 'a resposta final apaga relatos e progresso', depoisDoFim.body);
        adapter.registerAsyncTurn('t-simples', 'c2');
        await adapter.send({ text: 'oi', format: 'markdown' }, 't-simples');
        const simples = await get('/api/chat/outbox?turnId=t-simples');
        assert(!('resultado' in simples.body) && !('provisoria' in simples.body) && simples.body.response === 'oi', 'conversa simples: entrega da versão 1, sem campos novos', simples.body);

        console.log('\n=== S474-6 — POST /api/chat: client vai em metadata.cliente; fora do formato é ignorado ===');
        const post = async (body: unknown) => fetch(base + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const p1 = await post({ message: 'oi', sessionId: 'c1', client: 'newclaw-ivox' });
        const p2 = await post({ message: 'oi', sessionId: 'c1', client: 'Inválido!' });
        const p3 = await post({ message: 'oi', sessionId: 'c1' });
        await waitFor(() => recebidas.length >= 3);
        assert(p1.status === 202 && p2.status === 202 && p3.status === 202, 'os três são aceitos (client é opcional e só informativo)');
        assert(recebidas[0].metadata?.cliente === 'newclaw-ivox' && recebidas[1].metadata === undefined && recebidas[2].metadata === undefined,
            'cliente válido chega em metadata.cliente; inválido e ausente não criam metadata', recebidas.map((m) => m.metadata));

        console.log('\n=== S474-7 — GET /api/chat/context ===');
        const semModelo = await get('/api/chat/context?sessionId=c1');
        const c = semModelo.body;
        assert(semModelo.status === 200 && c.contrato === TURN_CONTRACT_VERSION && TURN_CONTRACT_VERSION === 2, 'contrato: 2 (a mesma versão de status.contracts.turn)', c);
        assert(c.conversa?.sessionId === 'c1' && c.conversa.id === 'web:c1' && c.conversa.mensagens === 3 && c.conversa.criadaEm === '2026-11-04T12:00:00.000Z',
            'conversa: sessionId, id (chave), mensagens e criadaEm em ISO com Z', c.conversa);
        assert(c.canal === 'web', 'canal lido da chave da conversa', c.canal);
        assert(c.cliente === 'newclaw-ivox', 'cliente: o da primeira mensagem que o trouxe', c.cliente);
        assert(!('modelo' in c), 'modelo ausente quando não se sabe (NUNCA_ADIVINHAR), nunca o configurado', c);
        assert((await get('/api/chat/context?sessionId=desconhecida')).status === 404 && (await get('/api/chat/context')).status === 404, 'conversa desconhecida ou sem sessionId → 404');

        console.log('\n=== S474-8 — modelo da última resposta: registrado pelo chatWithFallback real ===');
        const chamar = (attempts: unknown[], diag: Record<string, unknown>, status = 'success') => (ProviderFactory.prototype as any).chatWithFallback.call(
            { chatWithFallbackImpl: async () => ({ status, content: 'x', attempts }) },
            [{ role: 'user', content: 'MARCADOR_PROMPT' }], undefined, undefined, undefined, undefined, undefined, { diag });
        const turno = (fn: () => Promise<unknown>) => executarNoTurno(new AbortController().signal, fn as () => Promise<unknown>, 'web:c1');
        await chamar([{ provider: 'ollama', model: 'fora-do-turno', duration: 1, status: 'success' }], { component: 'AgentLoop', respostaDaConversa: true });
        assert(contrato.modeloQueRespondeu('web:c1') === undefined, 'fora de um turno nada é registrado');
        await turno(() => chamar([{ provider: 'ollama', model: 'modelo-a', duration: 1, status: 'timeout' }, { provider: 'groq', model: 'modelo-b', duration: 1, status: 'success' }], { component: 'AgentLoop', respostaDaConversa: true }));
        let m = contrato.modeloQueRespondeu('web:c1');
        assert(m?.nome === 'modelo-b' && m.provedor === 'groq' && typeof m.em === 'string', 'troca de provedor: registra o que respondeu (groq/modelo-b), não o primeiro tentado', m);
        await turno(() => chamar([{ provider: 'ollama', model: 'juiz', duration: 1, status: 'success' }], { component: 'ValidationEngine' }));
        assert(contrato.modeloQueRespondeu('web:c1')?.nome === 'modelo-b', 'chamada de juiz (sem respostaDaConversa) não muda o registro');
        await turno(() => chamar([{ provider: 'ollama', model: 'falhou', duration: 1, status: 'error' }], { component: 'AgentLoop', respostaDaConversa: true }, 'error'));
        assert(contrato.modeloQueRespondeu('web:c1')?.nome === 'modelo-b', 'resposta que falhou não muda o registro');
        const comModelo = await get('/api/chat/context?sessionId=c1');
        assert(comModelo.body.modelo?.nome === 'modelo-b' && comModelo.body.modelo.provedor === 'groq', '/context mostra o modelo que respondeu', comModelo.body.modelo);
        assert(vazou(comModelo.body).length === 0 && vazou(c).length === 0, 'nenhum marcador em /context', vazou(comModelo.body));
        await turno(() => chamar([{ provider: 'ollama', model: 'non-streaming-fallback', duration: 1, status: 'success' }], { component: 'AgentLoop', respostaDaConversa: true }));
        m = contrato.modeloQueRespondeu('web:c1');
        assert(m === undefined, 'resposta pelo caminho não-streaming (modelo desconhecido): o registro some em vez de mostrar um palpite', m);
        const fontesDeResposta = [
            ['src/loop/AgentLoop.ts', "component: 'AgentLoop', role: chatProfile?.category, phase, respostaDaConversa: true"],
            ['src/loop/GoalExecutionLoop.ts', "phase: 'delivery-summary', goalId: goal.id, respostaDaConversa: true"],
        ];
        for (const [arq, trecho] of fontesDeResposta) {
            assert(fs.readFileSync(path.join(__dirname, '../../..', arq), 'utf-8').includes(trecho), `${path.basename(arq)} marca a chamada que responde à conversa`);
        }
        const orq = fs.readFileSync(path.join(__dirname, '../../loop/GoalOrchestrator.ts'), 'utf-8');
        assert(orq.includes('turno.signal), chaveDoTurno);'), 'o turno carrega a chave da conversa (canal:usuário), a mesma que /context consulta');
    } finally {
        server.close();
        db.close();
        try { await transcricao.close(); } catch { /* */ }
        fs.rmSync(dirTranscricoes, { recursive: true, force: true });
    }

    console.log('\n=== S474-9 — MessageBus real: aviso de fila provisório, resultado passa, cliente gravado sem mudar decisão ===');
    const chamadas: unknown[][] = [];
    let liberar: (() => void) | null = null;
    let segurar = false;
    const fakeAgentLoop = {
        process: async (...args: unknown[]) => {
            chamadas.push(args);
            if (segurar) await new Promise<void>((r) => { liberar = r; });
            return { text: 'feito', resultado: { estado: 'concluido', etapas: { total: 1, concluidas: 1 } } };
        },
    } as unknown as import('../../loop/AgentLoop').AgentLoop;
    const gravadas: Array<{ texto: string; meta?: unknown }> = [];
    const fakeSession = {
        recordUserMessage: async (_k: unknown, texto: string, meta?: unknown) => { gravadas.push({ texto, meta }); return 1; },
        buildContext: async () => ({ messages: [] as unknown[] }),
        recordAssistantMessage: async () => 2,
    } as unknown as import('../../session/SessionManager').SessionManager;
    const enviados: NormalizedResponse[] = [];
    const fakeAdapter = {
        channelType: 'telegram', displayName: 'fake S474', isConnected: true,
        start: async () => {}, stop: async () => {}, healthCheck: async () => ({ ok: true }),
        send: async (r: NormalizedResponse) => { enviados.push(r); },
        sendTypingIndicator: async () => {},
    };
    const bus = new MessageBus(fakeAgentLoop, fakeSession);
    bus.registerAdapter(fakeAdapter as unknown as ChannelAdapter);
    let seq = 0;
    const msg = (text: string, metadata?: Record<string, unknown>): NormalizedMessage =>
        ({ messageId: `m${++seq}`, channel: 'telegram', userId: 'u474', userName: 'U', type: 'text', text, rawContext: {}, chatId: 'c474', metadata });
    await bus.processMessage(msg('sem cliente'));
    await waitFor(() => enviados.length >= 1);
    await bus.processMessage(msg('com cliente', { cliente: 'newclaw-ivox' }));
    await waitFor(() => enviados.length >= 2);
    assert(enviados[0]?.resultado?.estado === 'concluido' && enviados[0].text === 'feito', 'o resultado que o núcleo devolve chega ao canal', enviados[0]);
    assert(gravadas[0]?.meta === undefined && JSON.stringify(gravadas[1]?.meta) === JSON.stringify({ cliente: 'newclaw-ivox' }), 'cliente gravado na mensagem da conversa; sem cliente, sem meta', gravadas);
    assert(JSON.stringify(chamadas[0]?.slice(0, 1)) === JSON.stringify(chamadas[1]?.slice(0, 1)) && chamadas.every((a) => !JSON.stringify(a).includes('newclaw-ivox')),
        'cliente não chega a quem decide: o núcleo recebe a mesma coisa com e sem ele', chamadas);
    segurar = true;
    await bus.processMessage(msg('primeira'));
    await waitFor(() => chamadas.length >= 3);
    await bus.processMessage(msg('segunda, na fila'));
    await waitFor(() => enviados.some((r) => r.provisoria === true));
    const ack = enviados.find((r) => r.provisoria === true);
    assert(!!ack && ack.text.startsWith('🧠') && !ack.resultado, 'o aviso de fila sai com provisoria: true', ack);
    segurar = false;
    liberar?.();
    await waitFor(() => chamadas.length >= 4);
    await sleep(50);

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S474 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
    console.error('S474 erro inesperado:', err);
    process.exitCode = 1;
});
