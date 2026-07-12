/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S81 (Sprint 0.6, Front C — Lifecycle do ExecutionTraceManager)
 *
 * Prova que `AgentLoop.runWithTools()` deixa um trace ATIVO (nunca completado) no Map de
 * `traceManager` quando o turno sai por um `return` normal dentro do `try` que não passa por
 * nenhum dos 15 `completeTrace(...)` já existentes. O `catch(fsmError)` existente só
 * intercepta EXCEÇÕES lançadas — um `return` não aciona `catch`.
 *
 * Este teste, ao rodar de ponta a ponta com dependências fake mínimas (sem `sessionContext`
 * configurado — cenário real quando o pipeline de sessão não está pronto), reproduz o `return`
 * de guarda em `runWithTools()` ("sessionContext not set — session pipeline is mandatory.").
 * Esse é um 5º ponto de vazamento — além dos 4 já identificados por leitura estática do código
 * (`needs_auth`, e 3 cancelamentos em fases de delivery/síntese/fallback) — confirmando
 * empiricamente que o problema é estrutural (qualquer `return` esquecido vaza), não uma lista
 * fechada de pontos específicos. É exatamente por isso que a correção é um `finally` genérico,
 * não um patch em cada `return` individual.
 *
 * Execução: npx ts-node src/__tests__/regression/S81_ExecutionTrace_LifecycleGuaranteed.test.ts
 */

import Database from 'better-sqlite3';
import { AgentLoop } from '../../loop/AgentLoop';
import { traceManager } from '../../core/ExecutionTrace';
import { MemoryManager } from '../../memory/MemoryManager';
import { ChannelContext } from '../../loop/agentLoopTypes';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  OK ${message}`); passed++; }
    else { console.error(`  FALHOU: ${message}`, detail ?? ''); failed++; }
}

// Provider fake "inteligente": quando chamado COM toolDefs (loop principal de tool-calling),
// devolve um toolCall para exec_command com um comando genuinamente perigoso (não cai no
// isSafeExecCommand). Para qualquer outra chamada (classificação de intenção, etc.), devolve
// uma resposta neutra em texto puro — suficiente para o roteador/parser não travar.
function makeFakeProviderFactory() {
    const chatWithFallback = async (
        _messages: unknown[],
        toolDefs: Array<{ name: string }> | undefined,
    ) => {
        if (toolDefs && toolDefs.length > 0) {
            return {
                status: 'success',
                content: '',
                toolCalls: [{ id: 'call_1', name: 'exec_command', arguments: { command: 'rm -rf /caminho/perigoso' } }],
                attempts: [{ provider: 'fake', model: 'fake', duration: 1, status: 'success' }],
            };
        }
        return {
            status: 'success',
            content: 'ok',
            attempts: [{ provider: 'fake', model: 'fake', duration: 1, status: 'success' }],
        };
    };
    return {
        chatWithFallback,
        getProvider: () => ({ name: 'fake' }),
        getProviderWithModel: () => ({ chat: async () => ({ status: 'success', content: '{}' }) }),
    } as unknown as import('../../core/ProviderFactory').ProviderFactory;
}

function makeFakeMemory() {
    // ReflectionMemory/FSMHistoryStore (construídos internamente por AgentLoop) chamam
    // db.exec/prepare de verdade para criar seu próprio schema — precisa de um SQLite real
    // (mesmo padrão já usado em S21/S78/S79/S80), não um mock de db.
    const db = new (Database as any)(':memory:');
    return {
        semanticSearch: async () => [],
        addMessage: async () => {},
        getDatabase: () => db,
    } as unknown as MemoryManager;
}

async function main() {
    const providerFactory = makeFakeProviderFactory();
    const memory = makeFakeMemory();
    const config = { languageDirective: 'pt-BR', systemPrompt: 'teste S81' };
    const skillLearner = { recordPattern: () => {}, getPatterns: () => [] } as any;
    const skillLoader = { getSkillContextForQuery: async () => '', getAllSkills: () => [], loadAll: () => [] } as any;

    const fakeClassificationMemory = { store: () => {} } as any;
    const fakeDecisionMemory = { store: () => {}, getStats: () => ({}) } as any;
    const agentLoop = new AgentLoop(providerFactory, memory, config, skillLearner, skillLoader, fakeClassificationMemory, fakeDecisionMemory);
    agentLoop.registerTool({
        name: 'exec_command',
        description: 'Executa comando no sistema (perigoso).',
        parameters: {},
        execute: async () => ({ success: true, output: 'não deveria executar neste teste' }),
    });

    const before = traceManager.getStats();

    console.log('\n=== S81.1 — turno real termina por "return" sem completar o trace: trace fica ativo (vazado) no código atual ===');
    const channelContext: ChannelContext = { channel: 'test', chatId: 'test-user-s81' };
    const response = await (agentLoop as any).process('conv-s81', 'execute um comando perigoso no servidor', 'user-s81', channelContext);

    // Não sabemos o id exato do trace criado internamente (startTrace gera um id aleatório),
    // então inspecionamos o Map ativo via getStats()/getRecentTraces() — nenhum consumidor de
    // produção precisa de acesso mais direto que isso (dashboard usa exatamente esses métodos).
    const activeCountAfter = (traceManager as any).traces?.size ?? -1;

    console.log('  resposta do turno:', typeof response === 'string' ? response.slice(0, 120) : JSON.stringify(response).slice(0, 200));
    console.log('  traces ativos (Map interno) após o turno:', activeCountAfter);
    console.log('  stats antes:', before, '| depois:', traceManager.getStats());

    assert(
        activeCountAfter === 0,
        `nenhum trace deve permanecer ativo após o turno terminar (ANTES da correção: ${activeCountAfter} trace(s) ficam ativos para sempre — nada em resumeFromWorkflow()/outro código fecha esse trace)`,
        { activeCountAfter }
    );

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S81 RESULTADO: ${passed} passou | ${failed} falhou`);
    if (failed > 0) process.exit(1);
}

main().catch(err => { console.error('ERRO NÃO TRATADO:', err); process.exit(1); });
