/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S500
 *
 * Achado real (24/11/2026, log de produção): a pessoa mandou só o link de um vídeo e, 17 s depois, "Baixe e me envie esse
 * vídeo". O vídeo foi baixado e enviado DUAS vezes. A segunda mensagem caiu entre os dois desvios do MessageBus:
 *   - o `collect` (textosEmEspera) só junta com uma mensagem que ainda ESPERA a vez na fila — a primeira já estava rodando;
 *   - GoalOrchestrator.trySupplementActiveGoal() só desvia para um goal que JÁ existe — o goal só nasceu 31 s depois do
 *     início do turno (extração, roteador e suficiência rodam antes).
 * Resultado: a segunda mensagem virou um turno separado, com goal próprio, que repetiu o download e o envio.
 *
 * Fix: com o turno em andamento e sem goal, o texto fica guardado no GoalOrchestrator (complementosAntesDoGoal). Quando o
 * turno cria o goal, os textos viram complementos dele (mesmo caminho de S156, consumido pelo GoalExecutionLoop a cada
 * ciclo). Se o turno terminar sem goal, MessageBus.reprocessOrphanedSupplements() os reprocessa como mensagem nova — nada
 * se perde. /cancelar descarta o que chegou junto com o turno cancelado.
 *
 * Este teste roda o MessageBus REAL com os métodos REAIS do GoalOrchestrator (process, guardarComplementoDoTurnoEmAndamento,
 * herdarComplementosAntesDoGoal, consumirComplementosSemGoal, cancelarTurno) e GoalStore real em memória. Só o miolo do turno
 * (processarTurno — extração, LLM, planejamento) é substituído por um falso controlável, pelo mesmo motivo de S155/S156: o
 * construtor do GoalOrchestrator inicializa ReflectionMemory/CaseMemory/GoalExecutionLoop/CapabilityRegistry. Que o
 * processarTurno real chama herdarComplementosAntesDoGoal logo após criar o goal é conferido por inspeção de source.
 *
 * Execução: npx ts-node src/__tests__/regression/S500_ComplementoAntesDoGoal.test.ts
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
process.env.WORKSPACE_DIR = process.env.WORKSPACE_DIR || path.join(os.tmpdir(), 'newclaw-s500');

import Database from 'better-sqlite3';
import type { NormalizedMessage, ChannelAdapter, NormalizedResponse } from '../../channels/ChannelAdapter';
import { MessageBus } from '../../channels/MessageBus';
import { GoalOrchestrator } from '../../loop/GoalOrchestrator';
import { GoalStore } from '../../loop/GoalStore';

let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string, detail?: unknown): void {
    if (cond) { console.log(`  ✅ ${msg}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${msg}`, detail ?? ''); failed++; }
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function waitFor(pred: () => boolean, timeoutMs = 3000): Promise<void> {
    const start = Date.now();
    while (!pred() && Date.now() - start < timeoutMs) await sleep(10);
}

const SESSAO = 'telegram:u500';

function makeGoalInput(intent: string) {
    return {
        sessionKey: SESSAO, conversationId: 'u500', userIntent: intent, objective: intent, status: 'active',
        currentPlan: [], attempts: [], blockers: [], toolsTried: [], strategiesTried: [], nextAction: null, cycleFocus: null,
        retryBudget: 5, replanBudget: 3, confidence: 0.85, requiresAuth: false, authorizationScope: [], pendingTxnId: null,
        expiresAt: Date.now() + 600_000, completedAt: null, isConstruction: false, roadmap: [], currentMilestoneIndex: 0,
        allowRoadmapAdjustment: false, successCriteria: [], sentArtifacts: [],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
}

type Modo = 'goal' | 'conversa';

/** Visão dos privados do GoalOrchestrator usados pela bancada. */
interface Interno {
    turnosAtivos: Map<string, AbortController>;
    complementosAntesDoGoal: Map<string, string[]>;
    goalStore: GoalStore;
    processarTurno: (conversationId: string, message: string) => Promise<string>;
    herdarComplementosAntesDoGoal(sessionKey: string, goalId: string): void;
}

/** Bancada: MessageBus real + GoalOrchestrator real sem o construtor; o turno espera `liberar()` antes de "criar o goal". */
function montar() {
    const db = new Database(':memory:');
    const goalStore = new GoalStore(db as never);
    const orq = Object.create(GoalOrchestrator.prototype) as GoalOrchestrator;
    // Campos privados que o construtor (não executado aqui) inicializaria.
    const interno = orq as unknown as Interno;
    interno.turnosAtivos = new Map();
    interno.complementosAntesDoGoal = new Map();
    interno.goalStore = goalStore;

    const turnos: string[] = [];                 // texto com que cada turno começou
    const consumidosPeloGoal: string[][] = [];   // o que o "GoalExecutionLoop" leu como complemento
    let modo: Modo = 'goal';
    let liberar: (() => void) | null = null;
    interno.processarTurno = async (_conv: string, message: string) => {
        turnos.push(message);
        if (turnos.length === 1) await new Promise<void>((r) => { liberar = r; });   // fase de extração/roteador/suficiência
        if (modo === 'conversa') return 'resposta de conversa';
        const goal = goalStore.create(makeGoalInput(message));
        interno.herdarComplementosAntesDoGoal(SESSAO, goal.id);
        // O que o GoalExecutionLoop faz no checkpoint de ciclo (S156).
        consumidosPeloGoal.push(goalStore.consumeSupplements(goal.id));
        goalStore.setStatus(goal.id, 'executing');
        goalStore.setStatus(goal.id, 'completed');
        return 'vídeo enviado';
    };

    const fakeAgentLoop = { process: async () => 'nunca deveria ser chamado' } as unknown as import('../../loop/AgentLoop').AgentLoop;
    const fakeSession = {
        recordUserMessage: async () => 1,
        buildContext: async () => ({ messages: [] as unknown[] }),
        recordAssistantMessage: async () => 2,
    } as unknown as import('../../session/SessionManager').SessionManager;
    const enviados: NormalizedResponse[] = [];
    const fakeAdapter = {
        channelType: 'telegram', displayName: 'fake S500', isConnected: true,
        start: async () => {}, stop: async () => {}, healthCheck: async () => ({ ok: true }),
        send: async (r: NormalizedResponse) => { enviados.push(r); },
        sendTypingIndicator: async () => {},
    };
    const bus = new MessageBus(fakeAgentLoop, fakeSession);
    bus.registerAdapter(fakeAdapter as unknown as ChannelAdapter);
    bus.setGoalOrchestrator(orq);
    let seq = 0;
    const msg = (text: string): NormalizedMessage =>
        ({ messageId: `m${++seq}`, channel: 'telegram', userId: 'u500', userName: 'U', type: 'text', text, rawContext: {}, chatId: 'c500' });
    return {
        db, orq, interno, goalStore, bus, msg, turnos, consumidosPeloGoal, enviados,
        setModo: (m: Modo) => { modo = m; },
        liberar: () => liberar?.(),
        turnoParado: () => liberar !== null,
    };
}

async function main() {
    console.log('\n=== S500-1 — caso real: link e "Baixe e me envie esse vídeo" viram UM goal ===');
    {
        const b = montar();
        await b.bus.processMessage(b.msg('https://exemplo.test/video/123'));
        await waitFor(() => b.turnoParado());
        await b.bus.processMessage(b.msg('Baixe e me envie esse vídeo'));
        await waitFor(() => b.enviados.some((r) => r.text.startsWith('📎')));
        assert(b.enviados.some((r) => r.text.startsWith('📎 Anotado')), 'a segunda mensagem recebe o aviso de "Anotado" na hora', b.enviados.map((r) => r.text));
        assert(!b.enviados.some((r) => r.provisoria === true), 'nada de aviso de fila: a segunda mensagem não foi enfileirada como pedido novo', b.enviados);
        b.liberar();
        await waitFor(() => b.enviados.some((r) => r.text === 'vídeo enviado'));
        await sleep(100);
        assert(b.turnos.length === 1, 'só UM turno rodou (antes do fix: dois, cada um baixando e enviando o vídeo)', b.turnos);
        assert(b.consumidosPeloGoal.length === 1 && JSON.stringify(b.consumidosPeloGoal[0]) === JSON.stringify(['Baixe e me envie esse vídeo']),
            'o goal do primeiro turno herdou a segunda mensagem como complemento', b.consumidosPeloGoal);
        assert(b.enviados.filter((r) => r.text === 'vídeo enviado').length === 1, 'uma única entrega', b.enviados.map((r) => r.text));
        assert(b.interno.complementosAntesDoGoal.size === 0, 'nada sobra guardado depois do turno');
        b.db.close();
    }

    console.log('\n=== S500-2 — turno vira conversa (sem goal): o complemento é reprocessado como mensagem nova ===');
    {
        const b = montar();
        b.setModo('conversa');
        await b.bus.processMessage(b.msg('oi, tudo bem?'));
        await waitFor(() => b.turnoParado());
        await b.bus.processMessage(b.msg('e a previsão do tempo?'));
        b.liberar();
        await waitFor(() => b.turnos.length >= 2);
        await sleep(100);
        assert(JSON.stringify(b.turnos) === JSON.stringify(['oi, tudo bem?', 'e a previsão do tempo?']),
            'a mensagem guardada não se perde: vira o turno seguinte, na ordem', b.turnos);
        assert(b.enviados.filter((r) => r.text === 'resposta de conversa').length === 2, 'as duas mensagens são respondidas', b.enviados.map((r) => r.text));
        b.db.close();
    }

    console.log('\n=== S500-3 — métodos do GoalOrchestrator isolados ===');
    {
        const b = montar();
        const { orq, interno } = b;
        assert(orq.guardarComplementoDoTurnoEmAndamento('telegram', 'u500', 'x') === false,
            'sem turno em andamento não guarda nada (MessageBus segue o fluxo normal)');
        interno.turnosAtivos.set(SESSAO, new AbortController());
        assert(orq.guardarComplementoDoTurnoEmAndamento('telegram', 'u500', 'primeiro') === true, 'com turno em andamento guarda');
        orq.guardarComplementoDoTurnoEmAndamento('telegram', 'u500', 'segundo');
        assert(orq.consumirComplementosSemGoal('telegram', 'u500').length === 0,
            'enquanto o turno roda, consumirComplementosSemGoal não entrega nada (ainda podem ir para o goal)');
        assert(orq.guardarComplementoDoTurnoEmAndamento('telegram', 'outra-pessoa', 'z') === false, 'turno de outra pessoa não captura');
        interno.turnosAtivos.delete(SESSAO);
        const sobra = orq.consumirComplementosSemGoal('telegram', 'u500');
        assert(JSON.stringify(sobra) === JSON.stringify(['primeiro', 'segundo']), 'turno encerrado sem goal: devolve tudo, na ordem', sobra);
        assert(orq.consumirComplementosSemGoal('telegram', 'u500').length === 0, 'consumo é destrutivo');

        interno.turnosAtivos.set(SESSAO, new AbortController());
        orq.guardarComplementoDoTurnoEmAndamento('telegram', 'u500', 'vai ser cancelado');
        orq.cancelarTurno('telegram', 'u500');
        assert(orq.guardarComplementoDoTurnoEmAndamento('telegram', 'u500', 'depois do cancelar') === false, 'turno cancelado não captura mais');
        interno.turnosAtivos.delete(SESSAO);
        assert(orq.consumirComplementosSemGoal('telegram', 'u500').length === 0, '/cancelar descarta o que chegou junto com o turno cancelado');
        b.db.close();
    }

    console.log('\n=== S500-4 — source: o processarTurno real entrega os complementos ao goal logo após criá-lo ===');
    {
        const src = fs.readFileSync(path.join(__dirname, '../../loop/GoalOrchestrator.ts'), 'utf-8');
        const criar = src.indexOf('const goal = this.goalStore.create({');
        const fimCriar = src.indexOf('});', criar);
        const herdar = src.indexOf('this.herdarComplementosAntesDoGoal(sessionKey, goal.id);', fimCriar);
        assert(criar > 0 && herdar > fimCriar && src.slice(fimCriar, herdar).trim() === '});',
            'herdarComplementosAntesDoGoal é a primeira coisa depois de goalStore.create() (antes de qualquer await/gate)');
        const bus = fs.readFileSync(path.join(__dirname, '../../channels/MessageBus.ts'), 'utf-8');
        const reproc = bus.slice(bus.indexOf('private async reprocessOrphanedSupplements'));
        assert(reproc.includes('consumirComplementosSemGoal('), 'a rede de segurança do MessageBus também recolhe os guardados sem goal');
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S500 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
    console.error('S500 erro inesperado:', err);
    process.exitCode = 1;
});
