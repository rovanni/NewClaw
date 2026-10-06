/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S342 (issue 063)
 *
 * O SQLite grava `CURRENT_TIMESTAMP` em UTC sem fuso ("2026-10-06 17:33:34"); a API de conversas devolvia o texto cru
 * e o painel fazia `new Date(texto)`, que lê como hora LOCAL. 06/10/2026, teste pelo painel: conversas de 14:33
 * (Brasília) apareciam como 17:33; conversas criadas no próprio navegador apareciam certas — horários misturados.
 * Junto: o painel fixava 'pt-BR' na formatação de data/hora e na voz (ditado e leitura), ignorando o idioma escolhido
 * (en-US/es-ES).
 *
 * REGRESSÃO SE: a API voltar a devolver data sem fuso; o conversor alterar texto que já tem fuso; algum ponto do
 * painel voltar a fixar 'pt-BR' em formatação de data/hora ou voz.
 *
 * Execução: npx ts-node src/__tests__/regression/S342_DashboardTimestamps_UtcAndLanguage.test.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../memory/memorySchema';
import { addMessage } from '../../memory/conversationRepository';
import { DashboardMemoryRepository } from '../../dashboard/DashboardMemoryRepository';
import { sqliteUtcToIso } from '../../shared/sqliteTimestamp';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}

console.log('\n=== S342-1 — conversor: só o formato do SQLite, sempre como UTC ===');
assert(sqliteUtcToIso('2026-10-06 17:33:34') === '2026-10-06T17:33:34.000Z', 'SQLite → ISO com Z');
assert(sqliteUtcToIso('2026-10-06 17:33:34.5') === '2026-10-06T17:33:34.500Z', 'com fração de segundo');
assert(sqliteUtcToIso('2026-10-06T14:33:34-03:00') === '2026-10-06T14:33:34-03:00', 'texto com fuso volta inalterado');
assert(sqliteUtcToIso('2026-10-06T17:33:34.000Z') === '2026-10-06T17:33:34.000Z', 'ISO com Z volta inalterado');
assert(sqliteUtcToIso(null) === null && sqliteUtcToIso(undefined) === undefined, 'null/undefined preservados');
assert(new Date(sqliteUtcToIso('2026-10-06 17:33:34') as string).getTime() === Date.UTC(2026, 9, 6, 17, 33, 34), 'instante correto, independente do fuso da máquina');

console.log('\n=== S342-2 — API do painel (repositório real, SQLite real) devolve datas com fuso ===');
{
    const db = new (Database as any)(':memory:');
    initializeSchema(db);
    db.prepare("INSERT INTO conversations (id, user_id, provider) VALUES ('web:conv_t', 'conv_t', 'web')").run();
    addMessage(db, 'web:conv_t', 'user', 'Quantos itens tem a lista?');
    const repo = new DashboardMemoryRepository(db);
    const [conv] = repo.listWebConversations();
    const [msg] = repo.getMessagesByConversation('web:conv_t', 10);
    const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
    assert(iso.test(conv.created_at) && iso.test(conv.updated_at), 'conversa: created_at/updated_at em ISO-8601 UTC', conv);
    assert(iso.test(msg.created_at), 'mensagem: created_at em ISO-8601 UTC', msg);
    assert(Math.abs(new Date(conv.updated_at).getTime() - Date.now()) < 60_000, 'updated_at lido pelo navegador ≈ agora (não deslocado pelo fuso)', conv.updated_at);
}

console.log('\n=== S342-2b — nós de memória (lista, busca, detalhe) também saem com fuso ===');
{
    const db = new (Database as any)(':memory:');
    initializeSchema(db);
    const repo = new DashboardMemoryRepository(db);
    repo.createNode('n_s342', 'fact', 'Lista de compras', 'arroz, feijão, café');
    const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
    const [listed] = repo.listNodes();
    const found = repo.searchNodes('compras');
    const detail = repo.getNodeWithEdges('n_s342');
    assert(iso.test(listed.updated_at), 'listNodes: updated_at ISO UTC', listed);
    assert(found.length > 0 && found.every(n => iso.test(n.updated_at)), 'searchNodes: updated_at ISO UTC', found);
    assert(!!detail && iso.test(detail.node.updated_at), 'getNodeWithEdges: updated_at ISO UTC', detail?.node);
}

console.log("\n=== S342-3 — painel: nenhuma data/hora ou voz com 'pt-BR' fixo ===");
{
    const pub = path.join(process.cwd(), 'src', 'dashboard', 'public');
    const files = ['index.html', 'traces.html', 'memory.html', path.join('config', 'views', 'BackupView.js')];
    for (const f of files) {
        const src = fs.readFileSync(path.join(pub, f), 'utf-8');
        assert(!/toLocale(Date|Time)?String\(\s*'pt-BR'/.test(src), `${f}: formatação de data/hora sem 'pt-BR' fixo`);
    }
    const index = fs.readFileSync(path.join(pub, 'index.html'), 'utf-8');
    assert(/recognition\.lang = newclawGetLang\(\)/.test(index), 'ditado usa o idioma do painel');
    assert(/u\.lang = lang;/.test(index) && /const lang = newclawGetLang\(\);/.test(index), 'leitura em voz alta usa o idioma do painel');
    assert(/alert\(t\('voice_input_unsupported'\)\)/.test(index) && !/Reconhecimento de voz não suportado\. Use Chrome/.test(index), 'aviso de ditado indisponível traduzido (sem texto fixo em pt-BR)');
    assert(/newclaw-lang-changed', \(\) => \{ syncServerState\(\); renderSidebar\(\); renderChat\(\); \}/.test(index), 'trocar o idioma re-renderiza horários sem recarregar');
    const memoryHtml = fs.readFileSync(path.join(pub, 'memory.html'), 'utf-8');
    assert(/toLocaleString\(newclawGetLang\(\)\)/.test(memoryHtml), 'memória: data do nó formatada no idioma do painel (não texto cru do SQLite)');
    // Cache do navegador com horário adiantado pelo bug: sem ressincronização única, a hora certa (mais antiga)
    // nunca substituiria a errada — e mensagens novas do servidor deixariam de ser puxadas por horas.
    assert(/forceUtcResync \|\| serverUpdatedAt > \(local\.updatedAt \|\| 0\)/.test(index)
        && /if \(forceUtcResync\) localStorage\.setItem\(UTC_FIX_KEY, '1'\)/.test(index),
        'ressincronização única pelo servidor corrige o cache antigo do navegador');
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S342 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;
