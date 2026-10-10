/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S375 ("estou clicando no botão parar mas não está parando", 10/10/2026)
 *
 * Log de produção: o pedido chegou às 10:48:05 e o "Parar" (/cancelar) às 10:48:09 — com o pedido ainda na extração, no
 * roteador e na suficiência. Nessa fase não existe goal nem turno do agente: `cancelActiveGoal` e `agentLoop.cancel` não
 * acharam nada, a resposta foi "nada em andamento" (`clearedPending=0`) e o pedido seguiu: criou o goal e rodou por minutos.
 *
 * Agora o cancelamento vale para o TURNO inteiro: o orquestrador guarda um token por turno desde a chegada da mensagem;
 * cancelar o aborta, e (1) as fases checam o token antes de seguir (nenhum goal é criado, o agente não é chamado) e
 * (2) a chamada ao modelo EM VOO, de qualquer componente, é abortada na hora (AsyncLocalStorage → chatWithFallback).
 *
 * REGRESSÃO SE: o /cancelar voltar a só olhar goal/agente; um turno cancelado antes do goal criar o goal ou chamar o
 * agente; a chamada em voo ignorar o cancelamento; ou o ciclo do goal só olhar o cancelamento depois de um passo.
 *
 * Execução: npx ts-node src/__tests__/regression/S375_StopButton_CancelsTheWholeTurn.test.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { GoalOrchestrator, MENSAGEM_PEDIDO_INTERROMPIDO } from '../../loop/GoalOrchestrator';
import { executarNoTurno, sinalDoTurno, combinarSinais } from '../../shared/turnCancellation';
import { ProviderFactory } from '../../core/ProviderFactory';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}
const lerFonte = (rel: string): string => fs.readFileSync(path.join(process.cwd(), rel), 'utf-8');
const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
    const orig = process.stdout.write.bind(process.stdout);
    (process.stdout.write as unknown) = (): boolean => true;
    try { return await fn(); } finally { process.stdout.write = orig; }
};

/** GoalOrchestrator mínimo: só o que o token de turno e o cancelamento tocam. */
function orquestradorFalso(opts: { goalAtivo?: boolean } = {}) {
    const o = Object.create(GoalOrchestrator.prototype) as any;
    o.turnosAtivos = new Map();
    const abandonados: string[] = [];
    o.goalStore = {
        getActiveBySession: () => opts.goalAtivo ? { id: 'goal_1', status: 'executing' } : null,
        markAbandonReason: () => undefined,
        setStatus: (id: string, st: string) => { if (st === 'abandoned') abandonados.push(id); },
    };
    const chamadasAoAgente: string[] = [];
    o.agentLoop = { process: async (_c: string, msg: string) => { chamadasAoAgente.push(msg); return 'resposta do agente'; } };
    return { o, abandonados, chamadasAoAgente };
}

async function main(): Promise<void> {

console.log('\n=== S375-1 — o caso do log: cancelar com o pedido ainda ANTES de existir o goal ===');
{
    const { o, abandonados, chamadasAoAgente } = orquestradorFalso({ goalAtivo: false });
    let sinalDoPedido: AbortSignal | undefined;
    let seguiu = false;
    // A fase lenta (extração/roteador/suficiência) simulada: espera, e só depois tenta seguir.
    o.processarTurno = async (_c: string, msg: string, _u: string, _ctx: unknown, _r: unknown, _op: unknown, signal: AbortSignal) => {
        sinalDoPedido = signal;
        await new Promise(r => setTimeout(r, 80));
        if (signal.aborted) return MENSAGEM_PEDIDO_INTERROMPIDO;
        seguiu = true;
        return o.entregarAoAgente(signal, 'c', msg, 'conv_1', undefined);
    };
    const pedido = o.process('conv_1', 'Consegue fazer uma analise sobre o River?', 'conv_1', { channel: 'web', userId: 'conv_1' });
    await new Promise(r => setTimeout(r, 20));
    const r = o.cancelarTurno('web', 'conv_1');
    assert(r.turno === true && r.goal === null, 'havia um turno em andamento (e nenhum goal) — o cancelamento o ACHA (antes: "nada em andamento")', r);
    const resposta = await pedido;
    assert(resposta === MENSAGEM_PEDIDO_INTERROMPIDO && !seguiu, 'o pedido termina interrompido, sem seguir para a próxima fase', resposta);
    assert(chamadasAoAgente.length === 0 && abandonados.length === 0, 'o agente não foi chamado e nenhum goal foi criado');
    assert(sinalDoPedido?.aborted === true, 'o sinal do turno ficou abortado');
    assert(o.turnosAtivos.size === 0, 'o turno sai do registro ao terminar (nada vaza)');
}

console.log('\n=== S375-2 — sem turno nem goal: "nada em andamento" continua verdadeiro ===');
{
    const { o } = orquestradorFalso();
    const r = o.cancelarTurno('web', 'conv_2');
    assert(r.turno === false && r.goal === null, 'nada a cancelar → nada achado', r);
}

console.log('\n=== S375-3 — com goal ativo: o turno é abortado E o goal abandonado ===');
{
    const { o, abandonados } = orquestradorFalso({ goalAtivo: true });
    let sinal: AbortSignal | undefined;
    o.processarTurno = async (_c: string, _m: string, _u: string, _x: unknown, _r: unknown, _op: unknown, signal: AbortSignal) => {
        sinal = signal; await new Promise(r => setTimeout(r, 50)); return 'fim';
    };
    const p = o.process('conv_3', 'x', 'conv_3', { channel: 'web', userId: 'conv_3' });
    await new Promise(r => setTimeout(r, 10));
    const r = o.cancelarTurno('web', 'conv_3');
    await p;
    assert(r.turno === true && r.goal?.id === 'goal_1' && abandonados[0] === 'goal_1' && sinal?.aborted === true, 'turno abortado e goal abandonado', { r, abandonados });
}

console.log('\n=== S375-4 — entregarAoAgente: turno cancelado nunca chama o agente ===');
{
    const { o, chamadasAoAgente } = orquestradorFalso();
    const ctrl = new AbortController();
    assert(await o.entregarAoAgente(ctrl.signal, 'c', 'oi', 'u') === 'resposta do agente' && chamadasAoAgente.length === 1, 'turno vivo: entrega ao agente');
    ctrl.abort();
    assert(await o.entregarAoAgente(ctrl.signal, 'c', 'oi', 'u') === MENSAGEM_PEDIDO_INTERROMPIDO && chamadasAoAgente.length === 1, 'turno cancelado: não chama o agente');
}

console.log('\n=== S375-5 — a chamada ao modelo EM VOO, de qualquer componente, é abortada pelo cancelamento do turno ===');
{
    const ctrl = new AbortController();
    assert(sinalDoTurno() === undefined, 'fora de um turno não há sinal (tarefa de fundo/teste não é afetada)');
    const pf = new ProviderFactory({ defaultProvider: 'ollama', ollamaUrl: 'http://fake-ollama.invalid', ollamaModel: 'm' } as any);
    ctrl.abort();
    const r = await quiet(() => executarNoTurno(ctrl.signal, () => pf.chatWithFallback([{ role: 'user', content: 'oi' }], undefined, 'ollama', 5000)));
    assert(r.status === 'cancelled' && r.attempts.length === 0, 'turno cancelado: a chamada nem sai (status=cancelled, nenhuma tentativa)', r.status);

    const a = new AbortController(), b = new AbortController();
    const c = combinarSinais(a.signal, b.signal)!;
    assert(!c.aborted, 'combinação viva');
    b.abort();
    assert(c.aborted, 'combinarSinais dispara quando QUALQUER um dispara');
    assert(combinarSinais(undefined, a.signal) === a.signal && combinarSinais(a.signal, undefined) === a.signal, 'um só sinal passa direto');
}

console.log('\n=== S375-6 — encaixe no código: comando, checkpoints e ciclo do goal ===');
{
    const cmd = lerFonte('src/core/agentControllerCommands.ts');
    assert(/goalOrchestrator\.cancelarTurno\(msg\.channel, msg\.userId\)/.test(cmd), '/cancelar usa cancelarTurno (turno + goal), não só o goal');
    const orq = lerFonte('src/loop/GoalOrchestrator.ts');
    const iSuf = orq.indexOf('ADR-015: suficiência do pedido');
    assert(/signal\.aborted\) return MENSAGEM_PEDIDO_INTERROMPIDO;\s*\n\s*\n\s*\/\/ ── ADR-015/.test(orq), 'checkpoint ANTES da suficiência');
    assert(/verificarSuficiencia\(message, recentMessages, conversationId, signal\)/.test(orq), 'o sinal chega ao juiz de suficiência (abortado em voo)');
    assert(/cancelado antes de existir o goal: nada é criado/.test(orq) && orq.indexOf('cancelado antes de existir o goal') > iSuf, 'checkpoint antes de criar o goal');
    assert(!/this\.agentLoop\.process\(conversationId/.test(orq.replace(/return this\.agentLoop\.process\(conversationId, message, userId, context\);\s*\n\s*\}\s*\n\s*\n\s*private async processarTurno/, '')),
        'nenhuma entrega direta ao agente fora de entregarAoAgente');
    const loop = lerFonte('src/loop/GoalExecutionLoop.ts');
    assert(/foi abandonado antes do ciclo/.test(loop), 'o ciclo do goal olha o cancelamento no INÍCIO, não só depois de um passo');
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S375 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;
}

main().catch((err) => { console.error('S375 erro inesperado:', err); process.exitCode = 1; });
