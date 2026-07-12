/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S49
 * Investigação de log real (05/07/2026, 14:56, Telegram, goal_1783274167642_xqep6): usuário
 * pediu "Agora envie um áudio da previsão do tempo!" (sem informar cidade). Existe uma
 * preferência salva na memória: "Sempre que o usuário perguntar sobre previsão do tempo ou clima
 * sem informar a cidade, considerar Belo Horizonte, Paraná como cidade padrão." — mas o bot
 * narrou a previsão de SÃO PAULO.
 *
 * Rastreamento no audit log mostrou a causa exata:
 *   1. O planner decidiu os argumentos do step "weather" (incluindo `city`) usando o contexto
 *      de `GoalExecutionLoop.contextualize()`, que fazia SÓ `this.memory.semanticSearch(
 *      goal.userIntent, 3)` — busca PURAMENTE por embedding, limit=3, sem nenhum boost de
 *      keyword ou tier de preferência comportamental.
 *   2. Essa mesma preferência, quando consultada MAIS TARDE (no step seguinte, já dentro de um
 *      turno do AgentLoop, via ContextBuilder + MultiLayerRetriever), teve fusedScore=8.08 via
 *      camada KEYWORD — ou seja, ela EXISTE e é claramente relevante, só não é alcançável por
 *      similaridade de embedding pura o suficiente pra entrar no top-3 do semanticSearch.
 *   3. Resultado: o planner nunca viu essa preferência ao decidir o `city` do step "weather", e
 *      a ferramenta (cujo próprio parâmetro cita "São Paulo" como exemplo na description)
 *      acabou usando uma cidade errada — tarde demais para corrigir, pois o step já tinha rodado
 *      quando a preferência finalmente apareceu no contexto do step seguinte.
 *
 * Correção: `contextualize()` (GoalPlanner Q1) agora complementa `semanticSearch()` com
 * `MultiLayerRetriever.keywordSearch()` — a MESMA classe/método já usado e validado por
 * ContextBuilder nos turnos do AgentLoop — reusando a lógica de match em vez de duplicá-la.
 *
 * Escopo tocado: loop/GoalExecutionLoop.ts (nenhuma tool alterada, nenhuma mudança em
 * MultiLayerRetriever.ts — só um novo call-site do método público já existente).
 *
 * Execução: npx ts-node src/__tests__/regression/S49_GoalPlanner_KeywordMemoryRetrieval.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../memory/memorySchema';
import { MultiLayerRetriever } from '../../memory/MultiLayerRetriever';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

// DB in-memory com o schema real, sem passar pelo construtor de MemoryManager — este último
// inicia jobs de background (AttentionFeedback: decay/norm/monitor via setInterval) que mantêm
// o processo Node vivo indefinidamente, travando o runner de testes (spawnSync nunca retorna).
// Mesmo princípio já usado pelos testes de ReflectionMemory/CaseMemory neste diretório: mock
// mínimo (só o que MultiLayerRetriever precisa — o db) em vez da classe completa.
function createInMemoryDb(): Database.Database {
    const db = new (Database as any)(':memory:');
    initializeSchema(db);
    return db;
}

async function main(): Promise<void> {

console.log('\n=== S49-1 — reproduz o mecanismo exato: keywordSearch encontra a preferência que semanticSearch top-3 perderia ===');
{
    const db = createInMemoryDb();

    // Nó real do incidente (texto reduzido, mesma semântica).
    db.prepare(`
        INSERT INTO memory_nodes (id, type, name, content, confidence, weight)
        VALUES (?, 'preference', ?, ?, 0.9, 1.0)
    `).run(
        'pref_clima_padrao',
        'Clima padrão: Belo Horizonte',
        'Sempre que o usuário perguntar sobre previsão do tempo ou clima sem informar a cidade, considerar Belo Horizonte, Paraná como cidade padrão.'
    );

    // Ruído: outros nós que uma busca semântica pura poderia priorizar em vez da preferência.
    for (let i = 0; i < 5; i++) {
        db.prepare(`
            INSERT INTO memory_nodes (id, type, name, content, confidence, weight)
            VALUES (?, 'fact', ?, ?, 0.5, 1.0)
        `).run(`fact_ruido_${i}`, `Fato genérico ${i}`, `Conteúdo genérico não relacionado número ${i}, sobre outro assunto qualquer.`);
    }

    const retriever = new MultiLayerRetriever(db);
    const userIntent = 'Agora envie um áudio da previsão do tempo!';
    const candidates = retriever.keywordSearch(userIntent, 5);

    const found = candidates.find(c => c.nodeId === 'pref_clima_padrao');
    assert(found !== undefined, 'keywordSearch encontra o nó de preferência de cidade padrão para clima', candidates);
}

console.log('\n=== S49-2 — keywordSearch não depende de embeddings (funciona mesmo sem infra de embedding configurada) ===');
{
    const db = createInMemoryDb();
    db.prepare(`
        INSERT INTO memory_nodes (id, type, name, content, confidence, weight)
        VALUES ('pref_x', 'preference', 'Preferência de clima', 'previsão do tempo padrão Belo Horizonte', 0.9, 1.0)
    `).run();

    const retriever = new MultiLayerRetriever(db);
    const candidates = retriever.keywordSearch('previsão do tempo', 5);
    assert(candidates.some(c => c.nodeId === 'pref_x'), 'match por termo literal ("previsão", "tempo") funciona sem depender de similaridade semântica', candidates);
}

console.log('\n=== S49-3 — fix presente estruturalmente em GoalExecutionLoop.contextualize() ===');
{
    const source = fs.readFileSync(path.join(process.cwd(), 'src', 'loop', 'GoalExecutionLoop.ts'), 'utf-8');
    assert(
        /import \{ MultiLayerRetriever \} from '\.\.\/memory\/MultiLayerRetriever'/.test(source),
        'GoalExecutionLoop.ts importa MultiLayerRetriever (reuso, não duplicação de lógica)',
    );
    const contextualizeMatch = source.match(/private async contextualize\(goal: Goal[\s\S]*?\n    \}\n/);
    assert(contextualizeMatch !== null, 'método contextualize() encontrado no source');
    const body = contextualizeMatch?.[0] ?? '';
    assert(/retriever\.keywordSearch\(goal\.userIntent/.test(body), 'contextualize() chama keywordSearch(goal.userIntent, ...) como complemento ao semanticSearch', body);
    assert(/const allRelevant = \[\.\.\.relevant, \.\.\.keywordRelevant\]/.test(body), 'resultados de keyword e semantic são mesclados (dedup por alreadyIncluded)', body);
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S49 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;

}

main().catch((err) => {
    console.error('S49 erro inesperado:', err);
    process.exitCode = 1;
}).finally(() => {
    // better-sqlite3 :memory: não deixa handles pendentes, mas força a saída explicitamente
    // por segurança — dependências deste teste (schema init) não devem, mas poderiam no futuro,
    // registrar timers/listeners que impeçam o processo de encerrar sozinho (ver nota sobre
    // MemoryManager acima: essa classe faz exatamente isso, por isso este teste a evita).
    process.exit(process.exitCode ?? 0);
});
