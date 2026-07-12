/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S57
 * Investigação de log real (05/07/2026, 22:20, Telegram, correlationId=9d357382-7f43-404e-af17-43be9fc56876):
 * usuário pediu "envie um áudio com previsão do tempo para amanha" (sem cidade). O bot
 * respondeu pedindo a cidade ("Para qual cidade ou região você gostaria de saber a previsão do
 * tempo?"), apesar de existir a preferência salva: "Sempre que o usuário perguntar sobre previsão
 * do tempo ou clima sem informar a cidade, considere Belo Horizonte" (mesma preferência do
 * incidente de [[project_session_bugs_jul2026_ab]] / teste S49).
 *
 * Causa raiz — camada diferente da S49/AB: aquele fix cobriu `GoalExecutionLoop.contextualize()`
 * (Q1 do PLANNER), que só roda depois que um goal já foi criado. Mas o audit log deste
 * incidente mostrou `[TOOL-ROUTING] action=clarification_requested` — o `GoalExtractor.classify()`
 * marcou `is_ambiguous=true` e o `GoalOrchestrator` retornou a pergunta de clarificação e ENCERROU
 * o turno ANTES de qualquer goal ser criado, ou seja, antes do planner e do fix da S49 terem
 * qualquer chance de rodar. `GoalExtractor.llmClassify()` decide ambiguidade só com o texto da
 * mensagem + histórico de conversa — nenhuma consulta a memória de preferências acontecia neste
 * ponto do pipeline.
 *
 * Fix: `GoalOrchestrator.process()` agora faz a mesma busca (`MultiLayerRetriever.keywordSearch`,
 * reuso da classe já usada por ContextBuilder e por contextualize()) ANTES de chamar
 * `extractor.classify()`, e injeta preferências relevantes como contexto adicional (mesmo padrão
 * já usado para `recentGoal`/`followUpContext`). `GoalExtractor`'s prompt ganhou uma regra
 * explícita ensinando o LLM a tratar esse contexto de memória como resolvendo a ambiguidade
 * (`is_ambiguous=false`) em vez de confiar em inferência implícita.
 *
 * Escopo tocado: loop/GoalOrchestrator.ts (novo lookup pré-classificação), loop/GoalExtractor.ts
 * (nova regra + exemplo no prompt). Nenhuma mudança em MultiLayerRetriever.ts nem em
 * contextualize() (S49/AB continuam intactos e complementares — cobrem o caso em que o goal
 * SEGUE adiante e o planner precisa do valor real).
 *
 * Execução: npx ts-node src/__tests__/regression/S57_GoalOrchestrator_AmbiguityMemoryLookup.test.ts
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

// Mesmo cuidado documentado em S49/AB: nunca instanciar MemoryManager completo em teste de
// regressão (jobs de background via setInterval travam o runner). DB raw + initializeSchema().
function createInMemoryDb(): Database.Database {
    const db = new (Database as any)(':memory:');
    initializeSchema(db);
    return db;
}

async function main(): Promise<void> {

console.log('\n=== S57-1 — GoalOrchestrator.ts: lookup de preferência roda ANTES de extractor.classify() ===');
{
    const source = fs.readFileSync(path.join(process.cwd(), 'src', 'loop', 'GoalOrchestrator.ts'), 'utf-8');
    assert(
        /import \{ MultiLayerRetriever \} from '\.\.\/memory\/MultiLayerRetriever'/.test(source),
        'GoalOrchestrator.ts importa MultiLayerRetriever (reuso da mesma classe do ContextBuilder/contextualize())',
    );
    const lookupIdx = source.indexOf("retriever.keywordSearch(message, 5)");
    const classifyIdx = source.indexOf('const classification = await this.extractor.classify(');
    assert(lookupIdx > -1, 'busca de preferência por keyword existe, usando a mensagem atual (não goal.userIntent — ainda não existe goal aqui)');
    assert(classifyIdx > -1, 'chamada extractor.classify() encontrada no source');
    assert(lookupIdx > -1 && classifyIdx > -1 && lookupIdx < classifyIdx, 'lookup de preferência roda ANTES da classificação — a única forma de evitar a pergunta de clarificação desnecessária');
    assert(
        /type IN \('preference', 'trait'\)/.test(source),
        "filtra por type IN ('preference','trait') — mesmos tipos que ContextBuilder trata como 'tier1:pref'",
    );
}

console.log('\n=== S57-2 — GoalExtractor.ts: prompt ensina o LLM a resolver ambiguidade via memória injetada ===');
{
    const source = fs.readFileSync(path.join(process.cwd(), 'src', 'loop', 'GoalExtractor.ts'), 'utf-8');
    assert(
        /Preferência salva na memória resolve o dado faltante/.test(source),
        'regra explícita existe: preferência salva resolve o dado faltante (is_ambiguous=false)',
    );
    assert(
        /MEMÓRIA — preferências salvas do usuário relevantes a esta mensagem/.test(source),
        'prompt reconhece o marcador exato usado pelo GoalOrchestrator ao injetar o contexto',
    );
}

console.log('\n=== S57-3 — reprodução isolada: keywordSearch + filtro de tipo encontram a preferência de cidade padrão ===');
{
    const db = createInMemoryDb();
    db.prepare(`
        INSERT INTO memory_nodes (id, type, name, content, confidence, weight)
        VALUES (?, 'preference', ?, ?, 0.9, 1.0)
    `).run(
        'pref_clima_padrao',
        'Clima padrão: Belo Horizonte',
        'Sempre que o usuário perguntar sobre previsão do tempo ou clima sem informar a cidade, considere Belo Horizonte.'
    );
    // Ruído — nó não relacionado que uma busca ingênua poderia trazer junto.
    db.prepare(`
        INSERT INTO memory_nodes (id, type, name, content, confidence, weight)
        VALUES ('fact_ruido', 'fact', 'Fato genérico', 'Conteúdo qualquer sobre outro assunto, sem relação nenhuma.', 0.5, 1.0)
    `).run();

    const retriever = new MultiLayerRetriever(db);
    const message = 'envie um áudio com previsão do tempo para amanha';
    const candidateIds = retriever.keywordSearch(message, 5).slice(0, 3).map(c => c.nodeId);
    assert(candidateIds.includes('pref_clima_padrao'), 'keywordSearch encontra o nó de preferência a partir da mensagem SEM goal ainda criado', candidateIds);

    // Reproduz exatamente a query SQL do fix.
    const placeholders = candidateIds.map(() => '?').join(',');
    const rows = db.prepare(
        `SELECT content FROM memory_nodes WHERE id IN (${placeholders}) AND type IN ('preference', 'trait') AND (lifecycle_state IS NULL OR lifecycle_state = 'ACTIVE')`
    ).all(...candidateIds) as Array<{ content: string }>;
    assert(rows.length === 1, 'filtro type IN (preference,trait) exclui o nó de ruído tipo "fact", mantém só a preferência', rows);
    assert(rows[0]?.content.includes('Belo Horizonte'), 'conteúdo retornado é exatamente a preferência de cidade padrão', rows);
}

console.log('\n=== S57-4 — mensagem sem nenhuma preferência relevante não injeta contexto vazio/ruído ===');
{
    const db = createInMemoryDb();
    db.prepare(`
        INSERT INTO memory_nodes (id, type, name, content, confidence, weight)
        VALUES ('fact_ruido', 'fact', 'Fato genérico', 'Conteúdo qualquer sem relação com o pedido.', 0.5, 1.0)
    `).run();

    const retriever = new MultiLayerRetriever(db);
    const candidateIds = retriever.keywordSearch('gerar slides de aula de excel', 5).slice(0, 3).map(c => c.nodeId);
    const placeholders = candidateIds.length > 0 ? candidateIds.map(() => '?').join(',') : "''";
    const rows = candidateIds.length > 0
        ? db.prepare(`SELECT content FROM memory_nodes WHERE id IN (${placeholders}) AND type IN ('preference', 'trait') AND (lifecycle_state IS NULL OR lifecycle_state = 'ACTIVE')`).all(...candidateIds) as Array<{ content: string }>
        : [];
    assert(rows.length === 0, 'nenhuma preferência é injetada quando não há match relevante (sem falso positivo)', rows);
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S57 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;

}

main().catch((err) => {
    console.error('S57 erro inesperado:', err);
    process.exitCode = 1;
}).finally(() => {
    process.exit(process.exitCode ?? 0);
});
