/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S223 (reescrito após S229)
 *
 * Histórico: a versão original deste teste (incidente "River" #2, 11/08/2026) provava que dois
 * steps internos `agentloop` na mesma conversa, sem uma chamada explícita a
 * `agentLoop.clearActiveTurn()` entre eles, colidiam — "Concurrent turn rejected". A correção da
 * época foi `GoalExecutionLoop` chamar `clearActiveTurn()` no próprio `finally`, logo após cada
 * step interno.
 *
 * S229 fechou a causa raiz um nível abaixo: `AgentLoop.run()` agora garante esse cleanup no seu
 * PRÓPRIO `finally`, sempre — sucesso ou exceção, para QUALQUER chamador, não só
 * `GoalExecutionLoop`. Análise dos 4 pontos que confirmam a duplicação (ver relatório da sprint):
 * (1) `process()` sempre passa pelo `finally` de `run()`; (2) nada em `GoalExecutionLoop` lê
 * `activeTurns` depois da chamada; (3) o cleanup do `GoalExecutionLoop` sempre operava numa chave
 * já vazia (roda estritamente DEPOIS do finally de `run()`, porque `await` só resolve depois que
 * a promise—incluindo o finally dela—já terminou); (4) logo, era puro no-op. A chamada explícita
 * foi revertida de `GoalExecutionLoop.ts`.
 *
 * Este teste passa a provar o CONTRATO ATUAL: dois steps internos sequenciais (o padrão real de
 * `GoalExecutionLoop` — sempre aguarda um step terminar antes do próximo) não colidem mais,
 * MESMO sem nenhuma chamada explícita de cleanup entre eles — porque `run()` já cuida disso
 * sozinho. Não reproduz mais um vazamento que não deveria mais existir.
 *
 * Execução: npx ts-node src/__tests__/regression/S223_AgentLoop_NestedGoalStepReleasesTurn.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { AgentLoop } from '../../loop/AgentLoop';
import { MemoryManager } from '../../memory/MemoryManager';
import { ChannelContext } from '../../loop/agentLoopTypes';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

function makeFakeProviderFactory() {
    const chatWithFallback = async () => ({
        status: 'success',
        content: 'resposta de teste, sem ferramentas',
        attempts: [{ provider: 'fake', model: 'fake', duration: 1, status: 'success' }],
    });
    return {
        chatWithFallback,
        getProvider: () => ({ name: 'fake' }),
        getProviderWithModel: () => ({ chat: async () => ({ status: 'success', content: '{}' }) }),
    } as unknown as import('../../core/ProviderFactory').ProviderFactory;
}

function makeFakeMemory() {
    const db = new (Database as any)(':memory:');
    return {
        semanticSearch: async () => [],
        addMessage: async () => {},
        getDatabase: () => db,
    } as unknown as MemoryManager;
}

function makeAgentLoop(): AgentLoop {
    const providerFactory = makeFakeProviderFactory();
    const memory = makeFakeMemory();
    const config = { languageDirective: 'pt-BR', systemPrompt: 'teste S223' };
    const skillLearner = { recordPattern: () => {}, getPatterns: () => [] } as any;
    const skillLoader = { getSkillContextForQuery: async () => '', getAllSkills: () => [], loadAll: () => [] } as any;
    const fakeClassificationMemory = { store: () => {} } as any;
    const fakeDecisionMemory = { store: () => {}, getStats: () => ({}) } as any;
    return new AgentLoop(providerFactory, memory, config, skillLearner, skillLoader, fakeClassificationMemory, fakeDecisionMemory);
}

const REJECTION_TEXT = 'Ainda estou processando sua mensagem anterior. Aguarde um momento.';

async function main(): Promise<void> {

console.log('\n=== S223-1 — estrutural: GoalExecutionLoop não chama mais clearActiveTurn (redundante pós-S229) ===');
{
    const source = fs.readFileSync(path.join(__dirname, '../../loop/GoalExecutionLoop.ts'), 'utf-8');
    assert(
        !/this\.agentLoop\.clearActiveTurn\(/.test(source),
        'a chamada explícita a clearActiveTurn foi removida — o cleanup agora é responsabilidade única de AgentLoop.run()',
    );
    const callIdx = source.indexOf('await this.agentLoop.process(');
    assert(callIdx > 0, 'pré-condição: a chamada a agentLoop.process() continua existindo');
    const window = source.slice(Math.max(0, callIdx - 300), callIdx + 50);
    assert(!/try\s*\{[\s\S]*await this\.agentLoop\.process\(/.test(window), 'a chamada não está mais dentro de um try/finally próprio — sem lógica nova só para preservar o teste antigo');
}

console.log('\n=== S223-2 — comportamento real: dois steps internos SEQUENCIAIS não colidem mais, sem cleanup explícito ===');
{
    const agentLoop = makeAgentLoop();
    const conversationId = 'conv-s223-sequencial';
    const ctx: ChannelContext = { channel: 'test', chatId: conversationId };

    // Padrão real de GoalExecutionLoop: cada step é totalmente aguardado antes do próximo
    // começar (nunca dispara dois em paralelo). Nenhuma chamada a clearActiveTurn entre eles —
    // AgentLoop.run() já cuida disso sozinho, no seu próprio finally.
    const first = await agentLoop.process(conversationId, 'primeiro step do goal', conversationId, ctx);
    const firstText = typeof first === 'string' ? first : first.text;
    assert(firstText !== REJECTION_TEXT, 'primeiro step interno completa normalmente');

    const second = await agentLoop.process(conversationId, 'segundo step do goal (replan)', conversationId, ctx);
    const secondText = typeof second === 'string' ? second : second.text;
    assert(
        secondText !== REJECTION_TEXT,
        'segundo step interno TAMBÉM completa normalmente — sem cleanup explícito, só com o finally de run() (S229)',
        secondText,
    );

    const third = await agentLoop.process(conversationId, 'terceiro step do goal (mais um replan)', conversationId, ctx);
    const thirdText = typeof third === 'string' ? third : third.text;
    assert(thirdText !== REJECTION_TEXT, 'terceiro step interno também completa — o padrão se sustenta por quantos steps o goal precisar', thirdText);
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S223 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;

}

main().catch((err) => {
    console.error('S223 erro inesperado:', err);
    process.exitCode = 1;
});
