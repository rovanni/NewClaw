/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S382 (auditoria da suíte, 10/10/2026): outbox assíncrono e turnos do canal web.
 *
 * Origem: `src/__tests__/integration/Outbox.test.js` (commit d7740b7, 16/08/2026) foi escrito para o Jest e importava `dist/`
 * (build ignorado pelo Git). O Jest nunca foi dependência do projeto e nenhum script o executava — o arquivo falhava ao carregar
 * (`describe is not defined`). Os 7 casos cobrem comportamento REAL e vivo (`WebChannelAdapter.storeOutbox/consumeOutbox/
 * registerAsyncTurn/waitForResponse`, consumido por `routes/chat.ts`) e nunca foram executados.
 *
 * Convertido para o formato da suíte (ts-node sobre `src/`, asserção que propaga a falha) e ENDURECIDO: nos casos 3, 5 e 7 o original
 * usava `if (consumed) expect(...)` — se a resposta viesse `undefined` a checagem do texto era simplesmente pulada. Aqui a existência
 * e o conteúdo são exigidos sempre.
 *
 * Execução: npx ts-node src/__tests__/regression/S382_WebChannelAdapter_OutboxAndAsyncTurns.test.ts
 */
import { WebChannelAdapter } from '../../channels/WebChannelAdapter';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}

const wait = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

async function comAdaptador(corpo: (adapter: WebChannelAdapter) => Promise<void>): Promise<void> {
    const adapter = new WebChannelAdapter();
    try { await corpo(adapter); } finally { await adapter.stop(); }
}

async function main(): Promise<void> {

console.log('\n=== S382-1 — turno registrado: a resposta chega à outbox e o texto é o enviado ===');
await comAdaptador(async (adapter) => {
    adapter.registerAsyncTurn('turn-123', 'session-123');
    await adapter.send({ text: 'Hello', format: 'plain' }, 'turn-123');
    const consumed = adapter.consumeOutbox('turn-123');
    assert(consumed !== undefined, 'a resposta do turno registrado está na outbox');
    assert(consumed?.text === 'Hello', 'o texto consumido é o enviado', consumed);
});

console.log('\n=== S382-2 — turno desconhecido/em andamento: consumo devolve undefined (vira 404 no endpoint) ===');
await comAdaptador(async (adapter) => {
    assert(adapter.consumeOutbox('unknown-turn') === undefined, 'turnId sem resposta → undefined');
});

console.log('\n=== S382-3 — consumo único: depois de retirada, a resposta some da memória ===');
await comAdaptador(async (adapter) => {
    adapter.registerAsyncTurn('turn-456', 'session-456');
    await adapter.send({ text: 'Done', format: 'plain' }, 'turn-456');
    const primeira = adapter.consumeOutbox('turn-456');
    assert(primeira?.text === 'Done', 'primeiro consumo devolve a resposta', primeira);
    assert(adapter.consumeOutbox('turn-456') === undefined, 'segundo consumo → undefined (memória limpa)');
});

console.log('\n=== S382-4 — chamada duplicada: o primeiro request consome, o segundo não encontra ===');
await comAdaptador(async (adapter) => {
    adapter.registerAsyncTurn('turn-dup', 'session-dup');
    await adapter.send({ text: 'Dup', format: 'plain' }, 'turn-dup');
    const c1 = adapter.consumeOutbox('turn-dup');
    const c2 = adapter.consumeOutbox('turn-dup');
    assert(c1?.text === 'Dup', 'primeira chamada recebe a resposta', c1);
    assert(c2 === undefined, 'segunda chamada para o mesmo turnId não recebe nada');
});

console.log('\n=== S382-5 — vários turnos na mesma sessão: cada turnId é isolado ===');
await comAdaptador(async (adapter) => {
    adapter.registerAsyncTurn('turn-A', 'session-ab');
    adapter.registerAsyncTurn('turn-B', 'session-ab');
    await adapter.send({ text: 'Response A', format: 'plain' }, 'turn-A');
    await adapter.send({ text: 'Response B', format: 'plain' }, 'turn-B');
    const a = adapter.consumeOutbox('turn-A');
    const b = adapter.consumeOutbox('turn-B');
    assert(a?.text === 'Response A', 'turno A recebe a resposta A', a);
    assert(b?.text === 'Response B', 'turno B recebe a resposta B', b);
});

console.log('\n=== S382-6 — sem requisição HTTP original: a resposta chega à outbox para consumo eventual ===');
await comAdaptador(async (adapter) => {
    await adapter.send({ text: 'Orphaned Outbox', format: 'plain' }, 'turn-no-http');
    const consumed = adapter.consumeOutbox('turn-no-http');
    assert(consumed?.text === 'Orphaned Outbox', 'turno nunca registrado também entrega pela outbox', consumed);
});

console.log('\n=== S382-7 — fluxo síncrono legado: resposta atrasada após o timeout vira entrega órfã da sessão ===');
await comAdaptador(async (adapter) => {
    const espera = adapter.waitForResponse('turn-orphaned', 'session-orphaned', 10).catch(() => undefined);
    await wait(30); // o timeout de 10 ms expira nativamente
    await adapter.send({ text: 'Late Response', format: 'plain' }, 'turn-orphaned');
    await espera;
    const orfas = (adapter as unknown as { orphanedDeliveries: Map<string, Array<{ text: string }>> }).orphanedDeliveries.get('session-orphaned');
    assert(Array.isArray(orfas) && orfas.length === 1, 'a entrega atrasada ficou guardada para a sessão', orfas);
    assert(orfas?.[0]?.text === 'Late Response', 'o texto guardado é o da resposta atrasada', orfas);
});

console.log(`\n${'─'.repeat(60)}`);
console.log(`S382 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;
}

main().catch(e => { console.error(e); process.exit(1); });
