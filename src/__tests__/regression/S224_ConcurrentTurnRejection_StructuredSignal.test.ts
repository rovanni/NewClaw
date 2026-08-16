/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S224
 *
 * Última sprint do plano de correção do incidente "River" #2 (S221-S224). A causa raiz da
 * auto-colisão foi fechada pelo S229 (AgentLoop.run() garante cleanup no próprio finally, para
 * QUALQUER chamador — tornou o cleanup explícito do S223 redundante, revertido). Esta sprint cobre
 * o caso que CONTINUA existindo depois do S229: uma rejeição de turno concorrente LEGÍTIMA.
 *
 * Mapeamento de todo chamador de agentLoop.process()/.run() (análise da sprint S229): MessageBus é
 * serializado por conversa via ConversationQueueManager; GoalOrchestrator e GoalExecutionLoop só
 * chamam de forma sequencial (nunca disparam duas chamadas em paralelo consigo mesmos). MAS
 * `AgentController.ts` (Scheduler) chama `agentLoop.process()` DIRETO, sem passar pela fila do
 * MessageBus — se uma tarefa agendada disparar para o mesmo chatId no instante em que um goal do
 * usuário tiver um step interno em andamento, e o Scheduler ganhar a corrida, é o PRÓPRIO
 * GoalExecutionLoop quem recebe `concurrentTurnRejected`. Caso raro, mas real e estrutural — não
 * depende do bug original do River para existir.
 *
 * Por isso este teste simula concorrência GENUÍNA (duas chamadas realmente sobrepostas, via um
 * gate controlável — não duas chamadas sequenciais sem cleanup, que já não colidem mais depois do
 * S229) — para que a rejeição, quando acontece de verdade, não volte a produzir o efeito do
 * incidente: o texto de rejeição ("Ainda estou processando...") sendo tratado como
 * `outcome=success` e alimentando a validação do LLM, que gastava um replan inteiro interpretando
 * uma frase que nunca teve chance de conter o objetivo.
 *
 * O mecanismo é um FATO ESTRUTURAL (`ProcessedResult.concurrentTurnRejected: boolean`), não uma
 * comparação de string sobre o texto da resposta — a mesma categoria de correção que ADR-011 já
 * estabeleceu para `evaluateAgentStepSuccess` ("heurística determinística usa fatos estruturais
 * ... em vez de regex sobre prosa"), e consistente com a regra do projeto "determinismo valida,
 * LLM interpreta": aqui não há interpretação nenhuma, só uma checagem de um booleano.
 *
 * REGRESSÃO SE: o guard de AgentLoop voltar a devolver uma string pura na rejeição (perde o
 * sinal estruturado); ou GoalExecutionLoop voltar a tratar a rejeição como outcome=success; ou a
 * detecção migrar para comparação de texto (`text.includes('processando')` ou similar).
 *
 * Execução: npx ts-node src/__tests__/regression/S224_ConcurrentTurnRejection_StructuredSignal.test.ts
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

/** Provider controlável: a resposta fica pendurada até o teste liberar — permite simular duas
 *  chamadas GENUINAMENTE sobrepostas (a segunda começa com a primeira ainda em voo), em vez de
 *  duas chamadas sequenciais sem cleanup (que, depois do S229, não colidem mais). */
function makeControllableProviderFactory() {
    let release!: () => void;
    const gate = new Promise<void>(res => { release = res; });
    const chatWithFallback = async () => {
        await gate;
        return {
            status: 'success' as const,
            content: 'resposta de teste, sem ferramentas',
            attempts: [{ provider: 'fake', model: 'fake', duration: 1, status: 'success' as const }],
        };
    };
    const factory = {
        chatWithFallback,
        getProvider: () => ({ name: 'fake' }),
        getProviderWithModel: () => ({ chat: async () => ({ status: 'success', content: '{}' }) }),
    } as unknown as import('../../core/ProviderFactory').ProviderFactory;
    return { factory, release };
}

function flushMicrotasks(): Promise<void> {
    return new Promise(resolve => setImmediate(resolve));
}

function makeAgentLoop(providerFactory?: import('../../core/ProviderFactory').ProviderFactory): AgentLoop {
    providerFactory = providerFactory ?? ({
        chatWithFallback: async () => ({
            status: 'success',
            content: 'resposta de teste, sem ferramentas',
            attempts: [{ provider: 'fake', model: 'fake', duration: 1, status: 'success' }],
        }),
        getProvider: () => ({ name: 'fake' }),
        getProviderWithModel: () => ({ chat: async () => ({ status: 'success', content: '{}' }) }),
    } as unknown as import('../../core/ProviderFactory').ProviderFactory);
    const db = new (Database as any)(':memory:');
    const memory = {
        semanticSearch: async () => [],
        addMessage: async () => {},
        getDatabase: () => db,
    } as unknown as MemoryManager;
    const config = { languageDirective: 'pt-BR', systemPrompt: 'teste S224' };
    const skillLearner = { recordPattern: () => {}, getPatterns: () => [] } as any;
    const skillLoader = { getSkillContextForQuery: async () => '', getAllSkills: () => [], loadAll: () => [] } as any;
    const fakeClassificationMemory = { store: () => {} } as any;
    const fakeDecisionMemory = { store: () => {}, getStats: () => ({}) } as any;
    return new AgentLoop(providerFactory, memory, config, skillLearner, skillLoader, fakeClassificationMemory, fakeDecisionMemory);
}

async function main(): Promise<void> {

console.log('\n=== S224-1 — estrutural: ProcessedResult carrega o campo concurrentTurnRejected ===');
{
    const typesSrc = fs.readFileSync(path.join(__dirname, '../../loop/agentLoopTypes.ts'), 'utf-8');
    const start = typesSrc.indexOf('export interface ProcessedResult');
    const end = typesSrc.indexOf('}', start);
    const body = typesSrc.slice(start, end);
    assert(/concurrentTurnRejected\?:\s*boolean/.test(body), 'ProcessedResult declara concurrentTurnRejected como boolean opcional', body);
}

console.log('\n=== S224-2 — estrutural: o guard devolve o sinal estruturado, não mais uma string pura ===');
{
    const source = fs.readFileSync(path.join(__dirname, '../../loop/AgentLoop.ts'), 'utf-8');
    const guardIdx = source.indexOf('Concurrent turn rejected for ${conversationId}');
    assert(guardIdx > 0, 'pré-condição: o guard de turno concorrente foi localizado');
    const window = source.slice(guardIdx, guardIdx + 500);
    assert(
        /return \{ text: '[^']+', concurrentTurnRejected: true \};/.test(window),
        'o guard devolve { text, concurrentTurnRejected: true } — não mais `return \'string\'`',
        window,
    );
}

console.log('\n=== S224-3 — estrutural: GoalExecutionLoop checa o campo estruturado, não o texto ===');
{
    const source = fs.readFileSync(path.join(__dirname, '../../loop/GoalExecutionLoop.ts'), 'utf-8');
    assert(
        /response\.concurrentTurnRejected/.test(source),
        'GoalExecutionLoop lê response.concurrentTurnRejected (fato estruturado)',
    );
    assert(
        !/text\.includes\(.processando/.test(source) && !/text\.includes\(.Ainda estou/.test(source),
        'não existe comparação de string sobre o texto da rejeição em GoalExecutionLoop — sem regex sobre prosa',
    );
    const guardIdx = source.indexOf('response.concurrentTurnRejected');
    const window = source.slice(guardIdx, guardIdx + 700);
    assert(/success: false/.test(window), 'a rejeição é registrada como falha (success: false), não como sucesso trivial', window);
}

console.log('\n=== S224-4 — funcional: concorrência GENUÍNA (ex: Scheduler vs. step de goal em andamento) ainda produz o sinal estruturado ===');
{
    const { factory, release } = makeControllableProviderFactory();
    const agentLoop = makeAgentLoop(factory);
    const conversationId = 'conv-s224-concorrencia-real';
    const ctx: ChannelContext = { channel: 'test', chatId: conversationId };

    // Simula o caso mapeado no S229: uma chamada already-in-flight (ex: o Scheduler, que chama
    // agentLoop.process() direto, sem passar pela fila do MessageBus) — e uma SEGUNDA chamada
    // genuína para a MESMA conversa chegando ENQUANTO a primeira ainda não terminou. Isto não é
    // mais possível por auto-colisão (S223/S229 fecharam isso); é concorrência real entre dois
    // chamadores distintos.
    const firstPromise = agentLoop.process(conversationId, 'chamada já em voo (ex: Scheduler)', conversationId, ctx);
    await flushMicrotasks();

    const rejected = await agentLoop.process(conversationId, 'segunda chamada, genuinamente concorrente', conversationId, ctx);

    assert(typeof rejected !== 'string', 'a rejeição não é mais uma string pura — é um ProcessedResult', rejected);
    assert(
        typeof rejected !== 'string' && rejected.concurrentTurnRejected === true,
        'o resultado rejeitado carrega concurrentTurnRejected=true — é este objeto que chegaria a GoalExecutionLoop se o Scheduler ganhasse a corrida',
        rejected,
    );

    release();
    await firstPromise;
}

console.log('\n=== S224-5 — não-regressão: uma resposta normal (sem rejeição) NÃO carrega o sinal ===');
{
    const agentLoop = makeAgentLoop();
    const conversationId = 'conv-s224-normal';
    const ctx: ChannelContext = { channel: 'test', chatId: conversationId };
    agentLoop.clearActiveTurn(conversationId); // garante que não há trava residual de outro teste

    const normal = await agentLoop.process(conversationId, 'mensagem normal, sem concorrência', conversationId, ctx);
    const flag = typeof normal === 'string' ? undefined : normal.concurrentTurnRejected;
    assert(!flag, 'uma resposta normal não tem concurrentTurnRejected=true — o sinal é específico da rejeição', flag);
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S224 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;

}

main().catch((err) => {
    console.error('S224 erro inesperado:', err);
    process.exitCode = 1;
});
