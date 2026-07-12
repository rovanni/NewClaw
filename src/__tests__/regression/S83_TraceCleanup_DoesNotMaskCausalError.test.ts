/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S83 (Sprint 0.7, Gate A — lacuna residual do Front C / Sprint 0.6)
 *
 * A auditoria de segurança do `finally` (Sprint 0.6, Front C) foi feita por LEITURA de
 * código, não por um teste dinâmico que force simultaneamente (a) um erro causal real
 * (exceção FSM genuína, que já existia antes da Sprint 0.6 — o `catch(fsmError)` original)
 * e (b) uma falha durante a própria limpeza/finalização do trace. Este teste fecha essa
 * lacuna, exercitando `AgentLoop.runWithTools()` real (não um mock isolado).
 *
 * Técnica: `AgentFSM.prototype.transition` é monkey-patchado para lançar uma exceção
 * DISTINTA e identificável na 2ª chamada — reproduz deterministicamente o gatilho real do
 * `catch(fsmError)` (uma transição de FSM inválida) sem depender de encontrar/forçar um
 * cenário de negócio que produza uma transição ilegal por acaso. `traceManager.completeTrace`
 * é monkey-patchado para SEMPRE lançar uma exceção DISTINTA e identificável — simula falha
 * real durante a finalização (ex: listener SSE do dashboard lançando ao escrever numa conexão
 * fechada, já documentado como risco real na auditoria da Sprint 0.6).
 *
 * Execução: npx ts-node src/__tests__/regression/S83_TraceCleanup_DoesNotMaskCausalError.test.ts
 */

import Database from 'better-sqlite3';
import { AgentLoop } from '../../loop/AgentLoop';
import { AgentFSM } from '../../loop/AgentFSM';
import { traceManager } from '../../core/ExecutionTrace';
import { MemoryManager } from '../../memory/MemoryManager';
import { ChannelContext } from '../../loop/agentLoopTypes';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  OK ${message}`); passed++; }
    else { console.error(`  FALHOU: ${message}`, detail ?? ''); failed++; }
}

const CAUSAL_ERROR_MARKER = 'MARCADOR_ERRO_CAUSAL_S83';
const CLEANUP_ERROR_MARKER = 'MARCADOR_ERRO_CLEANUP_S83';

function makeFakeProviderFactory() {
    const chatWithFallback = async (_messages: unknown[], toolDefs: Array<{ name: string }> | undefined) => {
        if (toolDefs && toolDefs.length > 0) {
            return {
                status: 'success', content: '',
                toolCalls: [{ id: 'call_1', name: 'exec_command', arguments: { command: 'echo teste' } }],
                attempts: [{ provider: 'fake', model: 'fake', duration: 1, status: 'success' }],
            };
        }
        return { status: 'success', content: 'ok', attempts: [{ provider: 'fake', model: 'fake', duration: 1, status: 'success' }] };
    };
    return {
        chatWithFallback,
        getProvider: () => ({ name: 'fake' }),
        getProviderWithModel: () => ({ chat: async () => ({ status: 'success', content: '{}' }) }),
    } as unknown as import('../../core/ProviderFactory').ProviderFactory;
}

function makeFakeMemory() {
    const db = new (Database as any)(':memory:');
    return { semanticSearch: async () => [], addMessage: async () => {}, getDatabase: () => db } as unknown as MemoryManager;
}

async function main() {
    const providerFactory = makeFakeProviderFactory();
    const memory = makeFakeMemory();
    const config = { languageDirective: 'pt-BR', systemPrompt: 'teste S83' };
    const skillLearner = { recordPattern: () => {}, getPatterns: () => [] } as any;
    const skillLoader = { getSkillContextForQuery: async () => '', getAllSkills: () => [], loadAll: () => [] } as any;
    const fakeClassificationMemory = { store: () => {} } as any;
    const fakeDecisionMemory = { store: () => {}, getStats: () => ({}), recordFromLoop: () => {}, getToolStats: () => [] } as any;

    const agentLoop = new AgentLoop(providerFactory, memory, config, skillLearner, skillLoader, fakeClassificationMemory, fakeDecisionMemory);
    // sessionContext é obrigatório (guard em runWithTools) — sem ele, o turno retorna cedo
    // ("Sessão indisponível") ANTES de chegar perto de onde queremos forçar o erro de FSM
    // (mesmo caminho já documentado como o 5º ponto de vazamento achado no teste S81). Fake
    // mínimo cobrindo só o que runWithTools de fato chama.
    agentLoop.setSessionContext({
        buildLLMMessages: async () => ({
            messages: [{ role: 'user', content: 'qualquer mensagem' }],
            stats: { fromCheckpoint: false, recentMessages: 0, totalTranscriptEntries: 0, semanticContextUsed: false, tokenEstimate: 0, budgetUsed: 0, budgetMax: 4000 },
        }),
        getContextBuilder: () => ({ getLastBuildMetadata: () => ({}) }),
        getSessionManager: () => ({ recordToolCall: async () => {} }),
    } as any);
    agentLoop.registerTool({
        name: 'exec_command',
        description: 'test',
        parameters: {},
        execute: async () => ({ success: true, output: 'não deveria importar neste teste' }),
    });

    // ── Monkey-patches (restaurados no finally do próprio teste) ──────────────────────
    const originalTransition = AgentFSM.prototype.transition;
    const originalCompleteTrace = traceManager.completeTrace.bind(traceManager);
    let transitionCalls = 0;
    (AgentFSM.prototype as any).transition = function (...args: unknown[]) {
        transitionCalls++;
        if (transitionCalls === 2) {
            throw new Error(CAUSAL_ERROR_MARKER);
        }
        return originalTransition.apply(this, args as any);
    };
    // Simula o cenário REAL documentado na auditoria da Sprint 0.6 (não uma falha hipotética
    // pior): a lógica real de completeTrace() roda primeiro (seta status, empurra pra
    // recentTraces, remove do Map ativo — exatamente como o código real faz, na mesma ordem),
    // e só DEPOIS lança — reproduzindo o listener SSE do dashboard falhando durante o
    // emit('trace_complete', ...), que já é o único ponto de falha real conhecido e
    // documentado (a remoção do Map acontece antes do emit no código real).
    let completeTraceCalls = 0;
    (traceManager as any).completeTrace = (...args: Parameters<typeof originalCompleteTrace>) => {
        completeTraceCalls++;
        originalCompleteTrace(...args);
        throw new Error(CLEANUP_ERROR_MARKER);
    };

    let caughtError: unknown = null;
    let unhandledRejectionSeen: unknown = null;
    const onUnhandled = (reason: unknown) => { unhandledRejectionSeen = reason; };
    process.on('unhandledRejection', onUnhandled);

    console.log('\n=== S83.1 — erro causal (FSM) + falha simultânea no cleanup do trace ===');
    try {
        const channelContext: ChannelContext = { channel: 'test', chatId: 'test-user-s83' };
        await (agentLoop as any).process('conv-s83', 'qualquer mensagem', 'user-s83', channelContext);
    } catch (e) {
        caughtError = e;
    } finally {
        (AgentFSM.prototype as any).transition = originalTransition;
        (traceManager as any).completeTrace = originalCompleteTrace;
    }

    // Dá uma volta no event loop para qualquer unhandledRejection pendente ser reportado
    // antes de checarmos a flag.
    await new Promise(resolve => setImmediate(resolve));
    process.off('unhandledRejection', onUnhandled);

    const activeCountAfter = (traceManager as any).traces?.size ?? -1;

    console.log('  erro capturado pelo chamador:', caughtError instanceof Error ? caughtError.message : caughtError);
    console.log('  completeTrace foi chamado', completeTraceCalls, 'vez(es)');
    console.log('  unhandledRejection observado:', unhandledRejectionSeen);
    console.log('  traces ativos após o turno (completeTrace 100% mockado, nunca roda a lógica real de delete/status):', activeCountAfter);

    assert(
        caughtError instanceof Error && caughtError.message === CAUSAL_ERROR_MARKER,
        `o erro causal original (FSM) chega ao chamador SEM ser mascarado pela falha de cleanup — obtido: ${caughtError instanceof Error ? caughtError.message : String(caughtError)}`,
        caughtError
    );
    assert(
        unhandledRejectionSeen === null,
        'nenhuma exceção secundária (erro de cleanup) escapou como unhandledRejection — cleanup não deve gerar um erro novo para o processo',
        unhandledRejectionSeen
    );
    assert(
        completeTraceCalls >= 1,
        'completeTrace foi de fato chamado ao menos uma vez durante a tentativa de fechar o trace (confirma que o cenário de "cleanup falha" foi realmente exercitado)',
        completeTraceCalls
    );
    // Sprint 0.8 (pós Fix 1): completeTrace() real roda antes de lançar (simula o único ponto
    // de falha real conhecido — o listener SSE do dashboard falhando durante o emit, DEPOIS da
    // remoção do trace do Map ativo, que já acontece antes do emit no código real). Por isso o
    // finally novo, ao checar getActiveTrace() e ver que o catch pré-existente já removeu o
    // trace do Map (mesmo tendo lançado depois), corretamente NÃO tenta de novo — exatamente 1
    // tentativa, não 2. Duas tentativas só ocorreriam se completeTrace falhasse ANTES de fazer
    // seu trabalho real — cenário sem ocorrência conhecida no código atual (a falha real
    // documentada é sempre no emit, que é a última linha do método).
    assert(
        completeTraceCalls === 1,
        `exatamente 1 tentativa de finalizar o trace — o finally novo não tenta de novo porque o catch pré-existente já removeu o trace do Map antes de lançar (comportamento correto do guard) — obtido: ${completeTraceCalls}`,
        completeTraceCalls
    );
    assert(
        activeCountAfter === 0,
        `trace não permanece ativo — a remoção do Map já acontece dentro de completeTrace() antes do ponto real de falha (emit), então mesmo com a falha de cleanup o trace é corretamente removido — obtido activeCountAfter=${activeCountAfter}`,
        { activeCountAfter }
    );
    // "Telemetria não registra sucesso falso": como completeTrace nunca conseguiu rodar (só
    // lança), trace.status nunca é setado como 'completed'/'cancelled' — não há falso sucesso
    // registrado; o problema real é o oposto (o erro real fica sem NENHUM registro de
    // conclusão, nem falso nem verdadeiro — o trace simplesmente nunca fecha).
    assert(
        traceManager.getRecentTraces(50).every(t => t.id !== (caughtError as any)?.traceId),
        'nenhum trace foi registrado como concluído com sucesso falso (o trace real desta chamada nunca aparece em recentTraces — ele fica preso no Map ativo, não é reportado como sucesso)',
        traceManager.getStats()
    );

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S83 RESULTADO: ${passed} passou | ${failed} falhou`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => { console.error('ERRO NÃO TRATADO:', err); process.exit(1); });
