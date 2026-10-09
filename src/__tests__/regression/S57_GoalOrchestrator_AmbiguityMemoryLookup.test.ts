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
 * o turno ANTES de qualquer goal ser criado. Nenhuma consulta a memória de preferências acontecia
 * neste ponto do pipeline.
 *
 * Fix original: `GoalOrchestrator.process()` passou a buscar preferências ANTES de chamar
 * `extractor.classify()` e a injetá-las como contexto; o prompt do `GoalExtractor` ganhou a regra
 * "preferência salva resolve o dado faltante".
 *
 * Campanha 069 (09/10/2026): a busca era por PALAVRA-CHAVE (3 primeiros resultados) — "Vai chover amanhã de manhã?"
 * não tem palavra em comum com "Clima padrão: <cidade>", a preferência não chegou e o modelo inventou uma cidade.
 * Agora a classificação recebe TODAS as preferências ativas, da fonte única (MemoryManager.getPreferences), no
 * mesmo bloco do agente (ContextBuilder.blocoDePreferencias); o LLM decide qual se aplica. O que este teste protege
 * continua o mesmo: as preferências chegam à classificação ANTES dela rodar.
 *
 * Execução: npx ts-node src/__tests__/regression/S57_GoalOrchestrator_AmbiguityMemoryLookup.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../memory/memorySchema';
import { MemoryManager } from '../../memory/MemoryManager';
import { ContextBuilder } from '../../loop/ContextBuilder';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

// Mesmo cuidado documentado em S49/AB: nunca instanciar MemoryManager completo em teste de
// regressão (jobs de background via setInterval travam o runner). DB raw + initializeSchema(); o método
// getPreferences() é chamado sobre um objeto com só o `db` — é o código real, sem os jobs.
function createInMemoryDb(): Database.Database {
    const db = new (Database as any)(':memory:');
    initializeSchema(db);
    return db;
}
const preferenciasDe = (db: Database.Database) => MemoryManager.prototype.getPreferences.call({ db } as any);

async function main(): Promise<void> {

console.log('\n=== S57-1 — GoalOrchestrator.ts: preferências chegam ANTES de extractor.classify() ===');
{
    const source = fs.readFileSync(path.join(process.cwd(), 'src', 'loop', 'GoalOrchestrator.ts'), 'utf-8');
    const lookupIdx = source.indexOf('this.memory.getPreferences()');
    const classifyIdx = source.indexOf('const classification = await this.extractor.classify(');
    assert(lookupIdx > -1, 'a classificação usa a fonte única de preferências (MemoryManager.getPreferences)');
    assert(classifyIdx > -1, 'chamada extractor.classify() encontrada no source');
    assert(lookupIdx > -1 && classifyIdx > -1 && lookupIdx < classifyIdx, 'preferências entram ANTES da classificação — a única forma de evitar a pergunta de clarificação desnecessária');
    assert(/ContextBuilder\.blocoDePreferencias\(/.test(source) && !/keywordSearch\(message/.test(source),
        'mesmo bloco do agente, sem busca por palavra-chave escolhendo quais preferências entram');
}

console.log('\n=== S57-2 — GoalExtractor.ts: prompt ensina o LLM a resolver ambiguidade via memória injetada ===');
{
    const source = fs.readFileSync(path.join(process.cwd(), 'src', 'loop', 'GoalExtractor.ts'), 'utf-8');
    assert(
        /Preferência salva na memória resolve o dado faltante/.test(source),
        'regra explícita existe: preferência salva resolve o dado faltante (is_ambiguous=false)',
    );
    assert(
        /\$\{ContextBuilder\.CABECALHO_PREFERENCIAS\}/.test(source),
        'prompt reconhece o bloco pela MESMA constante usada para montá-lo (sem cópia do texto que possa divergir)',
    );
    assert(/ehBlocoDePreferencias\(m\)\s*\?\s*`Memória: \$\{m\.content\}`/.test(source),
        'o bloco de preferências vai inteiro ao classificador (as demais mensagens de contexto seguem em trecho de 300)');
}

console.log('\n=== S57-3 — a preferência de cidade padrão chega mesmo sem palavra em comum com o pedido ===');
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
    // Ruído — nó não relacionado que não é preferência.
    db.prepare(`
        INSERT INTO memory_nodes (id, type, name, content, confidence, weight)
        VALUES ('fact_ruido', 'fact', 'Fato genérico', 'Conteúdo qualquer sobre outro assunto, sem relação nenhuma.', 0.5, 1.0)
    `).run();

    const prefs = preferenciasDe(db);
    assert(prefs.length === 1 && prefs[0].id === 'pref_clima_padrao', 'getPreferences traz a preferência e não o fato', prefs.map((p: any) => p.id));
    const bloco = ContextBuilder.blocoDePreferencias(prefs.map((p: any) => ({ nome: p.name, texto: p.content })), ContextBuilder.MAX_MEMORY_CHARS_COMPLETO);
    assert(bloco.startsWith(ContextBuilder.CABECALHO_PREFERENCIAS) && bloco.includes('Belo Horizonte'),
        'o bloco leva a preferência — "Vai chover amanhã de manhã?" (sem palavra em comum) não depende mais de busca por palavra');
}

console.log('\n=== S57-4 — sem preferência salva, nada é injetado; preferência inativa não entra ===');
{
    const db = createInMemoryDb();
    db.prepare(`
        INSERT INTO memory_nodes (id, type, name, content, confidence, weight)
        VALUES ('fact_ruido', 'fact', 'Fato genérico', 'Conteúdo qualquer sem relação com o pedido.', 0.5, 1.0)
    `).run();
    assert(ContextBuilder.blocoDePreferencias(preferenciasDe(db).map((p: any) => ({ nome: p.name, texto: p.content })), 3200) === '',
        'sem preferência salva → bloco vazio (nada de contexto vazio/ruído)');
    db.prepare(`
        INSERT INTO memory_nodes (id, type, name, content, confidence, weight, lifecycle_state)
        VALUES ('pref_antiga', 'preference', 'Antiga', 'Preferência que foi arquivada.', 0.9, 1.0, 'ARCHIVED')
    `).run();
    assert(preferenciasDe(db).length === 0, 'preferência fora do estado ACTIVE não entra');
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S57 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;

}

main().catch((err) => {
    console.error('S57 erro inesperado:', err);
    process.exitCode = 1;
});
