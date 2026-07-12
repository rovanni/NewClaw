/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S82 (Sprint 0.6, Front D — Microauditoria de retenção da ReflectionMemory)
 *
 * Prova que `ReflectionMemory.prune()` — já implementado corretamente, com default de 30
 * dias — nunca é chamado por nenhum código de produção. `MemoryCurator.enforceStorageQuotas()`
 * já poda `agent_traces` (3 dias) e `procedural_executions` (90 dias) no mesmo ciclo
 * (`startAutoCurate`, a cada 30 min), mas não tinha nenhuma referência a `ReflectionMemory`.
 * Evidência de suficiência (ver relatório): busca exaustiva (src/, scripts/, testes,
 * dashboard, docs) não encontrou nenhum consumidor real de `reflection_annotations` com mais
 * de 30 dias — todos os métodos de leitura (`buildContextHint`, `findToolFailures`, etc.) usam
 * janelas de 7-30 dias. Agendar `prune()` com o próprio default já declarado não destrói
 * nenhuma memória útil.
 *
 * Execução: npx ts-node src/__tests__/regression/S82_ReflectionMemory_PruneScheduled.test.ts
 */

import Database from 'better-sqlite3';
import { MemoryManager } from '../../memory/MemoryManager';
import { MemoryCurator } from '../../memory/MemoryCurator';
import { ReflectionMemory } from '../../memory/ReflectionMemory';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  OK ${message}`); passed++; }
    else { console.error(`  FALHOU: ${message}`, detail ?? ''); failed++; }
}

async function main() {
    const db = new (Database as any)(':memory:');
    const memoryManager = new MemoryManager(db);
    const reflectionMemory = new ReflectionMemory(memoryManager);

    console.log('\n=== S82.1 — enforceStorageQuotas() chama reflectionMemory.prune() quando injetado ===');
    {
        let pruneCalled = false;
        let pruneArgUsed: number | undefined = -1;
        const spyReflectionMemory = {
            prune: (olderThanDays?: number) => { pruneCalled = true; pruneArgUsed = olderThanDays; return 0; },
        };
        // MemoryCurator recebe reflectionMemory como 3º parâmetro opcional (Sprint 0.6, Front D).
        // Construção via (MemoryCurator as any) de propósito: ANTES da correção esse parâmetro
        // não existe no construtor real — passar via `any` faz o teste rodar contra o código
        // ATUAL (o argumento extra é simplesmente ignorado pelo JS), então a asserção abaixo
        // falha por COMPORTAMENTO real (spy nunca chamado), não por erro de compilação. Depois
        // da correção, o mesmo construtor real aceita e usa o parâmetro. enforceStorageQuotas é
        // privado — mesmo padrão (loop as any) já usado nos demais testes desta sprint.
        const curator = new (MemoryCurator as any)(memoryManager, undefined, spyReflectionMemory);
        await (curator as any).enforceStorageQuotas();
        assert(pruneCalled, 'reflectionMemory.prune() foi chamado dentro de enforceStorageQuotas() (ANTES da correção: nunca é chamado — MemoryCurator não conhecia ReflectionMemory)');
        assert(
            pruneArgUsed === undefined,
            'prune() foi chamado SEM argumento — usa o próprio default (30 dias) já declarado no método, sem inventar novo número',
            pruneArgUsed
        );
    }

    console.log('\n=== S82.2 — MemoryCurator sem reflectionMemory injetado não quebra (compatibilidade) ===');
    {
        const curator = new MemoryCurator(memoryManager);
        let threw = false;
        try {
            await (curator as any).enforceStorageQuotas();
        } catch {
            threw = true;
        }
        assert(!threw, 'enforceStorageQuotas() não lança quando reflectionMemory não foi injetado (compatibilidade com DashboardServer.ts)');
    }

    console.log('\n=== S82.3 — prune() real remove registros >30 dias e preserva os recentes (comportamento do método em si, não alterado) ===');
    {
        const oldTs = Math.floor((Date.now() - 40 * 24 * 3600 * 1000) / 1000);
        const recentTs = Math.floor((Date.now() - 1 * 24 * 3600 * 1000) / 1000);
        db.prepare(`
            INSERT INTO reflection_annotations (id, trace_id, conversation_id, user_input, intent, tool_used, approved, reason, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime(?, 'unixepoch'))
        `).run('ref_old', 'trace_old', 'conv_test', 'input', 'intent', 'tool', 1, 'reason', oldTs);
        db.prepare(`
            INSERT INTO reflection_annotations (id, trace_id, conversation_id, user_input, intent, tool_used, approved, reason, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime(?, 'unixepoch'))
        `).run('ref_recent', 'trace_recent', 'conv_test', 'input', 'intent', 'tool', 1, 'reason', recentTs);

        reflectionMemory.prune();

        const remaining = db.prepare('SELECT id FROM reflection_annotations').all() as Array<{ id: string }>;
        const ids = remaining.map(r => r.id);
        assert(!ids.includes('ref_old'), 'registro com >30 dias foi removido', ids);
        assert(ids.includes('ref_recent'), 'registro recente (<30 dias) foi preservado', ids);
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S82 RESULTADO: ${passed} passou | ${failed} falhou`);
    // MemoryManager real inicia timers de background reais (AttentionFeedback
    // decay/normalization/monitoring) que mantêm o event loop vivo indefinidamente — sem
    // exit explícito em AMBOS os ramos (sucesso e falha), o processo nunca retorna ao runner.
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => { console.error('ERRO NÃO TRATADO:', err); process.exit(1); });
