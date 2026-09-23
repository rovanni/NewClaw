/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S289 (issue 043, campanha "sistema não utilizável", 22/09/2026)
 *
 * Achado ao vivo, mesma campanha do S285/S286/S287/S288: um goal pediu para atualizar a posição
 * de RIVER na memória. O LLM chamou `memory_write` sem `action` (nem `content`, que serviria de
 * pista pro fallback interno da tool). `memory_write.ts:112`
 * (`let action = (args.action as string) || (args.content ? 'create' : '');`) produziu
 * `action=''`, que só falhava DENTRO da própria tool, depois de um round-trip completo de LLM,
 * com `Ação "" inválida. Use: create, update, connect, delete, merge, reinforce.` — mensagem que
 * não aponta qual campo faltou nem orienta o replanejador. O goal esgotou o orçamento de replan
 * reformulando a mesma chamada quebrada, apesar de todos os dados necessários já estarem
 * disponíveis na conversa.
 *
 * Nenhum ponto de despacho validava `tool.parameters` (schema já declarado por cada tool, hoje só
 * decorativo/mostrado ao LLM) antes de chamar `tool.execute()`. Fix: `validateToolArgs()`
 * (`src/core/ToolRegistry.ts`) — checagem puramente estrutural (campo obrigatório presente? valor
 * pertence ao enum declarado?), nunca interpretação de significado — chamada por
 * `ProactiveRecovery.tryWithRetry()` ANTES do loop de retry, pra qualquer tool que declare
 * `parameters.required`/`parameters.properties[x].enum`.
 *
 * S289.1 — CONTROLE NEGATIVO: uma chamada bem formada (action='create' + campos válidos) passa
 *   pela validação sem alteração nenhuma e chega normalmente a `tool.execute()`.
 * S289.2 — CASO POSITIVO: reproduz o cenário real exato (nem action, nem content) via
 *   `ProactiveRecovery.execute()` (caminho público, real) — a chamada é barrada ANTES de
 *   `tool.execute()` (zero chamadas), com mensagem listando os valores aceitos.
 * S289.3 — valor fora do enum declarado (`action: 'bogus'`) também é barrado, com a mesma
 *   mensagem estruturada — não é só "campo ausente".
 * S289.4 — CONTROLE DE NÃO-REGRESSÃO: uma tool sem `parameters.required` (schema ausente ou sem a
 *   chave) não é afetada — `validateToolArgs()` devolve `null` e o despacho segue como antes.
 *
 * Execução: npx ts-node src/__tests__/regression/S289_ToolArgsValidation_BlocksEmptyRequiredBeforeDispatch.test.ts
 */

import Database from 'better-sqlite3';
import { MemoryManager } from '../../memory/MemoryManager';
import { MemoryWriteTool } from '../../tools/memory_write';
import { EmbeddingService } from '../../memory/EmbeddingService';
import { ProactiveRecovery, ToolExecutorLike } from '../../loop/ProactiveRecovery';
import { validateToolArgs } from '../../core/ToolRegistry';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  OK ${message}`); passed++; }
    else { console.error(`  FALHOU: ${message}`, detail ?? ''); failed++; }
}

/** Envolve uma tool real contando quantas vezes execute() de fato roda — pra provar que S289.2
 *  barra ANTES do dispatch, não depois de uma execução que falha por dentro. Precisa preservar
 *  `parameters` (spread do objeto original) — é o schema que `validateToolArgs()` lê; um wrapper
 *  que só reexporta `execute()` faria o próprio teste esconder o schema da validação. */
function countingWrapper(tool: ToolExecutorLike): { wrapped: ToolExecutorLike; calls: () => number } {
    let calls = 0;
    return {
        wrapped: { ...tool, execute: async (args: Record<string, unknown>) => { calls++; return tool.execute(args); } },
        calls: () => calls,
    };
}

async function main(): Promise<void> {

const originalFetch = global.fetch;
(global as unknown as { fetch: typeof fetch }).fetch = (async (url: string) => {
    if (String(url).includes('/api/embeddings')) {
        return { ok: true, json: async () => ({ embedding: [0.1, 0.2, 0.3, 0.4] }) } as Response;
    }
    throw new Error(`fetch não mockado para: ${url}`);
}) as typeof fetch;

try {

const recovery = new ProactiveRecovery();

console.log('\n=== S289.1 — CONTROLE NEGATIVO: chamada bem formada chega normalmente a tool.execute() ===');
{
    const db = new (Database as any)(':memory:');
    new EmbeddingService(db);
    const mm = new MemoryManager(db, 'http://mock-ollama:11434');
    const tool = new MemoryWriteTool(mm);
    const { wrapped, calls } = countingWrapper(tool);

    const result = await recovery.execute(
        'memory_write',
        { action: 'create', id: 'fact_test_river', type: 'fact', name: 'Posição RIVER', content: 'Posição RIVER — 530 tokens, preço médio US$ 5,30' },
        () => wrapped,
        new Set<string>(),
    );

    assert(result.result.success === true, 'chamada bem formada foi executada com sucesso', result.result);
    assert(calls() === 1, `tool.execute() foi chamado exatamente 1 vez — obtido ${calls()}`, calls());
    db.close();
}

console.log('\n=== S289.2 — CASO POSITIVO: memory_write sem action nem content é barrado ANTES do dispatch (cenário real do incidente) ===');
{
    const db = new (Database as any)(':memory:');
    new EmbeddingService(db);
    const mm = new MemoryManager(db, 'http://mock-ollama:11434');
    const tool = new MemoryWriteTool(mm);
    const { wrapped, calls } = countingWrapper(tool);

    const result = await recovery.execute(
        'memory_write',
        { id: 'fact_river_update' }, // nem action, nem content — reproduz o incidente real
        () => wrapped,
        new Set<string>(),
    );

    assert(result.result.success === false, 'chamada sem action foi rejeitada', result.result);
    assert(calls() === 0, `tool.execute() NUNCA foi chamado (barrado antes do dispatch) — obtido ${calls()} chamada(s)`, calls());
    assert(
        !!result.result.error && result.result.error.includes('action'),
        `mensagem de erro identifica o campo que faltou ("action") — obtido: "${result.result.error}"`,
        result.result.error,
    );
    assert(
        !!result.result.error && result.result.error.includes('create') && result.result.error.includes('reinforce'),
        `mensagem de erro lista os valores aceitos do enum (create..reinforce) — obtido: "${result.result.error}"`,
        result.result.error,
    );
    assert(
        !result.result.error?.startsWith('Ação ""'),
        'a mensagem NÃO é mais o erro genérico antigo de dentro da tool ("Ação \\"\\" inválida") — foi barrado um passo antes, com mensagem melhor',
        result.result.error,
    );
    db.close();
}

console.log('\n=== S289.3 — valor fora do enum declarado também é barrado, com mensagem estruturada ===');
{
    const db = new (Database as any)(':memory:');
    new EmbeddingService(db);
    const mm = new MemoryManager(db, 'http://mock-ollama:11434');
    const tool = new MemoryWriteTool(mm);
    const { wrapped, calls } = countingWrapper(tool);

    const result = await recovery.execute(
        'memory_write',
        { action: 'bogus', id: 'fact_x', content: 'x' },
        () => wrapped,
        new Set<string>(),
    );

    assert(result.result.success === false, 'action fora do enum foi rejeitado', result.result);
    assert(calls() === 0, `tool.execute() NUNCA foi chamado para valor de enum inválido — obtido ${calls()} chamada(s)`, calls());
    assert(
        !!result.result.error && result.result.error.includes('bogus') && result.result.error.includes('Valores aceitos'),
        `mensagem de erro nomeia o valor inválido e lista as opções — obtido: "${result.result.error}"`,
        result.result.error,
    );
    db.close();
}

console.log('\n=== S289.4 — CONTROLE DE NÃO-REGRESSÃO: validateToolArgs() é neutro para tools sem schema declarado ===');
{
    assert(validateToolArgs({}, { qualquer: 'coisa' }) === null, 'tool sem parameters: validação sempre passa (null)');
    assert(validateToolArgs({ parameters: {} }, { qualquer: 'coisa' }) === null, 'tool com parameters vazio (sem required/properties): validação sempre passa (null)');
    assert(
        validateToolArgs({ parameters: { required: ['x'] } }, { x: 'valor real' }) === null,
        'tool com required declarado e campo presente e não-vazio: validação passa (null)',
    );
}

} finally {
    (global as unknown as { fetch: typeof fetch }).fetch = originalFetch;
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S289 RESULTADO: ${passed} passou | ${failed} falhou`);
process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => { console.error('ERRO NÃO TRATADO:', err); process.exit(1); });
