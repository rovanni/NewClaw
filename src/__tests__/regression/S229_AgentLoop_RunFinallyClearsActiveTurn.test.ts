/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S229
 *
 * Origem: regressão S101 (achada ao validar S221-S224). O `finally` de `AgentLoop.run()` estava
 * vazio no working tree, com o comentário:
 *
 *   // Cleanup movido para clearActiveTurn (via MessageBus) para suportar Outbox
 *
 * Evidência de que a premissa desse comentário não corresponde ao código real: `grep` em
 * `src/channels/WebChannelAdapter.ts` e `src/dashboard/routes/chat.ts` (onde vive o Outbox —
 * `asyncTurns`, `outbox`) não encontra NENHUMA leitura de `activeTurns`, `activeTurnStates` ou
 * `turnStartTimes` fora de comentários. São dois mecanismos independentes. Sem a chamada,
 * `clearActiveTurn()` (que já existe e já faz a limpeza certa) nunca era invocado por ninguém —
 * confirmado por busca exaustiva antes desta correção — deixando o guard de turno concorrente
 * preso até `TURN_STALE_MS` (7min). Causa raiz do incidente River #2 (ver S223) e da regressão
 * neste teste (S101).
 *
 * Correção: `run()` volta a chamar `this.clearActiveTurn(conversationId)` no `finally` — reusa o
 * método existente (não duplica os 3 `.delete()` inline, como o código pré-regressão fazia).
 *
 * Escopo estritamente limitado ao cleanup do AgentLoop — não toca em S226/S227 (Outbox/frontend).
 *
 * Execução: npx ts-node src/__tests__/regression/S229_AgentLoop_RunFinallyClearsActiveTurn.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { AgentLoop } from '../../loop/AgentLoop';
import { MemoryManager } from '../../memory/MemoryManager';
import { ChannelContext } from '../../loop/agentLoopTypes';
import { WebChannelAdapter } from '../../channels/WebChannelAdapter';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

/** Provider controlável: a chamada ao LLM fica pendurada em `gate` até o teste liberar
 *  (`release()`) ou forçar falha (`fail()`) — permite inspecionar o estado de AgentLoop
 *  NO MEIO de um turno, sem depender de sleep/timeout arbitrário. */
function makeControllableProviderFactory() {
    let release!: () => void;
    let fail!: (err: Error) => void;
    const gate = new Promise<void>((res, rej) => { release = res; fail = (e) => rej(e); });
    const chatWithFallback = async () => {
        await gate;
        return {
            status: 'success' as const,
            content: 'resposta de teste S229',
            attempts: [{ provider: 'fake', model: 'fake', duration: 1, status: 'success' as const }],
        };
    };
    const factory = {
        chatWithFallback,
        getProvider: () => ({ name: 'fake' }),
        getProviderWithModel: () => ({ chat: async () => ({ status: 'success', content: '{}' }) }),
    } as unknown as import('../../core/ProviderFactory').ProviderFactory;
    return { factory, release, fail };
}

function makeAgentLoop(providerFactory: import('../../core/ProviderFactory').ProviderFactory): AgentLoop {
    const db = new (Database as any)(':memory:');
    const memory = {
        semanticSearch: async () => [],
        addMessage: async () => {},
        getDatabase: () => db,
    } as unknown as MemoryManager;
    const config = { languageDirective: 'pt-BR', systemPrompt: 'teste S229' };
    const skillLearner = { recordPattern: () => {}, getPatterns: () => [] } as any;
    const skillLoader = { getSkillContextForQuery: async () => '', getAllSkills: () => [], loadAll: () => [] } as any;
    const fakeClassificationMemory = { store: () => {} } as any;
    const fakeDecisionMemory = { store: () => {}, getStats: () => ({}) } as any;
    return new AgentLoop(providerFactory, memory, config, skillLearner, skillLoader, fakeClassificationMemory, fakeDecisionMemory);
}

/** Drena a fila de microtasks (todas as promises já resolvidas, ex: os `await` dos fakes) sem
 *  usar um tempo fixo — um `setImmediate` só roda depois que TODO microtask pendente já rodou. */
function flushMicrotasks(): Promise<void> {
    return new Promise(resolve => setImmediate(resolve));
}

async function main(): Promise<void> {

console.log('\n=== S229-1 — estrutural: o finally de run() chama this.clearActiveTurn(conversationId) ===');
{
    const source = fs.readFileSync(path.join(__dirname, '../../loop/AgentLoop.ts'), 'utf-8');
    const runStart = source.indexOf('public async run(');
    const runEnd = source.indexOf('\n    }\n', runStart);
    const runBody = source.slice(runStart, runEnd);

    assert(!/Cleanup movido para clearActiveTurn \(via MessageBus\)/.test(runBody), 'o comentário que justificava o finally vazio não está mais lá');
    assert(
        /\}\s*finally\s*\{[\s\S]*this\.clearActiveTurn\(conversationId\)/.test(runBody),
        'o finally chama this.clearActiveTurn(conversationId)',
        runBody.slice(runBody.indexOf('finally')),
    );
}

console.log('\n=== S229-2 — funcional: run() registra activeTurn ao COMEÇAR, antes de terminar ===');
{
    const { factory, release } = makeControllableProviderFactory();
    const agentLoop = makeAgentLoop(factory);
    const conversationId = 'conv-s229-inflight';
    const ctx: ChannelContext = { channel: 'test', chatId: conversationId };

    const runPromise = agentLoop.run(conversationId, 'mensagem de teste', conversationId, ctx);
    await flushMicrotasks();

    const activeDuring = agentLoop.getActiveTurns().some(t => t.conversationId === conversationId);
    assert(activeDuring, 'enquanto o LLM ainda não respondeu (gate seguro), activeTurn JÁ está registrado', agentLoop.getActiveTurns());

    release();
    await runPromise;
}

// S229-3/4 miram exatamente o que este sprint mudou: o try/finally de run() em torno da chamada
// a runWithTools() — não o comportamento interno de runWithTools (imenso, não é o alvo). Por
// isso runWithTools é substituído por um dublê controlável: prova run()/finally/clearActiveTurn
// isoladamente do resto do AgentLoop, sem depender de sessionContext ou de qualquer outra
// dependência profunda de runWithTools (que nada aqui alterou).
function makeAgentLoopWithControllableRunWithTools(): { agentLoop: AgentLoop; resolveWith: (v: string) => void; rejectWith: (e: Error) => void } {
    const { factory } = makeControllableProviderFactory();
    const agentLoop = makeAgentLoop(factory);
    let resolveFn!: (v: string) => void;
    let rejectFn!: (e: Error) => void;
    const gate = new Promise<string>((res, rej) => { resolveFn = res; rejectFn = rej; });
    (agentLoop as unknown as { runWithTools: (...args: unknown[]) => Promise<string> }).runWithTools = async () => gate;
    return { agentLoop, resolveWith: resolveFn, rejectWith: rejectFn };
}

console.log('\n=== S229-3 — funcional: run() termina por SUCESSO → activeTurn é removido ===');
{
    const { agentLoop, resolveWith } = makeAgentLoopWithControllableRunWithTools();
    const conversationId = 'conv-s229-success';
    const ctx: ChannelContext = { channel: 'test', chatId: conversationId };

    const runPromise = agentLoop.run(conversationId, 'mensagem de teste', conversationId, ctx);
    await flushMicrotasks();
    assert(
        (agentLoop as unknown as { activeTurnStates: Map<string, unknown> }).activeTurnStates.has(conversationId),
        'pré-condição: activeTurnStates registrado (run() faz isso ANTES de chamar runWithTools) enquanto ainda está em andamento',
    );

    resolveWith('resposta de teste S229');
    const result = await runPromise;

    assert((typeof result === 'string' ? result : result.text) === 'resposta de teste S229', 'run() resolveu com o valor real de runWithTools, sem interferência do finally');
    assert(!(agentLoop as unknown as { activeTurnStates: Map<string, unknown> }).activeTurnStates.has(conversationId), 'após sucesso, activeTurnStates foi removido pelo finally');
}

console.log('\n=== S229-4 — funcional: run() termina por ERRO → activeTurn TAMBÉM é removido ===');
{
    const { agentLoop, rejectWith } = makeAgentLoopWithControllableRunWithTools();
    const conversationId = 'conv-s229-error';
    const ctx: ChannelContext = { channel: 'test', chatId: conversationId };

    const runPromise = agentLoop.run(conversationId, 'mensagem de teste', conversationId, ctx);
    await flushMicrotasks();
    assert(
        (agentLoop as unknown as { activeTurnStates: Map<string, unknown> }).activeTurnStates.has(conversationId),
        'pré-condição: activeTurnStates registrado antes de runWithTools rejeitar',
    );

    rejectWith(new Error('S229: falha simulada em runWithTools'));
    let threw = false;
    try {
        await runPromise;
    } catch {
        threw = true;
    }

    assert(threw, 'run() de fato propagou a exceção (finally não engole o erro nem o substitui)');
    assert(
        !(agentLoop as unknown as { activeTurnStates: Map<string, unknown> }).activeTurnStates.has(conversationId),
        'mesmo com erro, activeTurnStates foi removido — finally é garantido em ambos os caminhos',
    );
}

console.log('\n=== S229-5 — funcional: clearActiveTurn() é REALMENTE o caminho usado pelo finally (não uma cópia inline) ===');
{
    const { factory, release } = makeControllableProviderFactory();
    const agentLoop = makeAgentLoop(factory);
    const conversationId = 'conv-s229-spy';
    const ctx: ChannelContext = { channel: 'test', chatId: conversationId };

    let calledWith: string | undefined;
    const original = agentLoop.clearActiveTurn.bind(agentLoop);
    agentLoop.clearActiveTurn = ((id: string) => { calledWith = id; return original(id); }) as typeof agentLoop.clearActiveTurn;

    const runPromise = agentLoop.run(conversationId, 'mensagem de teste', conversationId, ctx);
    await flushMicrotasks();
    release();
    await runPromise;

    assert(calledWith === conversationId, 'o finally chamou o MÉTODO clearActiveTurn (spy interceptou a chamada), não uma limpeza duplicada por fora dele', calledWith);
}

console.log('\n=== S229-6 — não-regressão: concorrência LEGÍTIMA continua bloqueada enquanto o turno roda ===');
{
    const { factory, release } = makeControllableProviderFactory();
    const agentLoop = makeAgentLoop(factory);
    const conversationId = 'conv-s229-concurrent';
    const ctx: ChannelContext = { channel: 'test', chatId: conversationId };

    const firstPromise = agentLoop.run(conversationId, 'primeira mensagem', conversationId, ctx);
    await flushMicrotasks();

    // Segunda mensagem para a MESMA conversa, com a primeira ainda em andamento (gate seguro) —
    // isto é concorrência real (duas mensagens do usuário ao mesmo tempo), não o caso do S223
    // (steps internos do mesmo goal). O lock precisa continuar recusando.
    const secondResult = await agentLoop.run(conversationId, 'segunda mensagem, concorrente de verdade', conversationId, ctx);
    const secondText = typeof secondResult === 'string' ? secondResult : secondResult.text;
    const secondRejected = typeof secondResult !== 'string' && secondResult.concurrentTurnRejected === true;

    assert(secondRejected, 'a segunda mensagem, chegando enquanto a primeira genuinamente ainda roda, continua sendo rejeitada como turno concorrente', secondText);

    release();
    await firstPromise;
    assert(!agentLoop.getActiveTurns().some(t => t.conversationId === conversationId), 'depois que a primeira termina, a trava é liberada normalmente');
}

console.log('\n=== S229-7 — o Outbox (WebChannelAdapter) funciona sem NENHUMA relação com os mapas do AgentLoop ===');
{
    // Prova por construção: WebChannelAdapter é instanciado e exercitado sozinho, sem nenhum
    // AgentLoop envolvido — se o Outbox dependesse de activeTurns/activeTurnStates/
    // turnStartTimes, isto nem compilaria/rodaria.
    const webAdapter = new WebChannelAdapter();
    const turnId = 'turn-s229-outbox';
    webAdapter.registerAsyncTurn(turnId, 'session-s229-outbox');
    assert(webAdapter.hasPendingAsyncTurn(turnId), 'Outbox registra o turno normalmente, sem AgentLoop');

    await webAdapter.send({ text: 'resposta via outbox', format: 'plain' }, turnId);
    assert(!webAdapter.hasPendingAsyncTurn(turnId), 'Outbox resolve o turno normalmente');

    const consumed = webAdapter.consumeOutbox(turnId);
    assert(consumed?.text === 'resposta via outbox', 'Outbox entrega a resposta normalmente — nenhuma das asserções acima tocou AgentLoop.activeTurns em momento algum');
}

console.log('\n=== S229-8 — estrutural: confirma a premissa citada no S101/S229 — Outbox nunca lê os mapas do AgentLoop ===');
{
    const webAdapterSrc = fs.readFileSync(path.join(__dirname, '../../channels/WebChannelAdapter.ts'), 'utf-8');
    const chatRouteSrc = fs.readFileSync(path.join(__dirname, '../../dashboard/routes/chat.ts'), 'utf-8');
    const codeOnly = (src: string) => src.split('\n').filter(l => !l.trim().startsWith('*') && !l.trim().startsWith('//')).join('\n');

    assert(!/activeTurns|activeTurnStates|turnStartTimes/.test(codeOnly(webAdapterSrc)), 'WebChannelAdapter.ts não referencia os mapas do AgentLoop fora de comentários');
    assert(!/activeTurns|activeTurnStates|turnStartTimes/.test(codeOnly(chatRouteSrc)), 'chat.ts não referencia os mapas do AgentLoop fora de comentários');
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S229 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;

}

main().catch((err) => {
    console.error('S229 erro inesperado:', err);
    process.exitCode = 1;
});
