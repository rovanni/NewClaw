/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S450 (28/10/2026)
 *
 * Texto em SQL vai entre aspas SIMPLES. O better-sqlite3 12 compila o SQLite sem DQS: `"now"` é lido como nome de coluna,
 * não como texto, e o `prepare` lança `no such column: "now"`.
 *
 * ORIGEM: instalação Windows, 26 e 27/10/2026 às 17:00. A primeira tarefa agendada (criada em 25/10) disparava, mas o
 * `UPDATE ... SET last_run = datetime("now")` lançava logo depois: `last_run` nunca era gravado e o log acusava
 * "[Scheduler] Error running task 1" todo dia. O SQL era assim desde maio; nenhuma tarefa tinha rodado até então.
 * A varredura achou mais dois iguais, sem chamador hoje: `AttentionFeedback.getStats` e
 * `MemoryFacade.listNodesForReconciliation`.
 *
 * REGRESSÃO SE: a tarefa agendada disparar sem gravar `last_run`; ou algum SQL do código voltar a comparar, listar ou
 * passar para função um texto entre aspas duplas.
 *
 * Execução: npx ts-node src/__tests__/regression/S450_SqlSemAspasDuplasComoTexto.test.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { SchedulerService } from '../../services/SchedulerService';

let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string, detail?: unknown): void {
    if (cond) { console.log(`  ✅ ${msg}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${msg}`, detail ?? ''); failed++; }
}

const SRC = path.join(__dirname, '..', '..');

function arquivosTs(dir: string): string[] {
    const out: string[] = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== '__tests__') out.push(...arquivosTs(p)); }
        else if (e.name.endsWith('.ts')) out.push(p);
    }
    return out;
}

/** SQL passado a prepare/exec num literal JS de qualquer aspa (inclusive crase multilinha), já sem os escapes do JS. */
function sqlsDoCodigo(): Array<{ arquivo: string; sql: string }> {
    const out: Array<{ arquivo: string; sql: string }> = [];
    for (const arquivo of arquivosTs(SRC)) {
        const texto = fs.readFileSync(arquivo, 'utf-8');
        for (const m of texto.matchAll(/\.(?:prepare|exec)\(\s*(['"`])((?:\\[\s\S]|(?!\1)[^\\])*)\1/g)) {
            out.push({ arquivo: path.relative(SRC, arquivo), sql: m[2].replace(/\\([\s\S])/g, '$1') });
        }
    }
    return out;
}

/** Texto entre aspas duplas usado como VALOR (comparação, lista, argumento). Identificador interpolado (`"${tabela}"`) é válido. */
const TEXTO_EM_ASPAS_DUPLAS = /(?:=|!=|<>|\bIN\s*\(|\bLIKE|\(|,)\s*"(?!\$\{)[^"]*"/i;

async function main(): Promise<void> {
    console.log('\n🧪 S450 — SQL sem aspas duplas como texto\n');

    console.log('Controle: o SQLite do better-sqlite3 instalado rejeita texto entre aspas duplas');
    {
        const db = new Database(':memory:');
        let erro = '';
        try { db.prepare('SELECT datetime("now")').get(); } catch (e) { erro = String(e); }
        assert(/no such column/.test(erro), 'datetime("now") é rejeitado (sem DQS) — o teste abaixo mede o que importa', erro);
        assert(typeof (db.prepare("SELECT datetime('now') AS t").get() as { t: string }).t === 'string', "datetime('now') funciona");
        db.close();
    }

    console.log('\nTarefa agendada dispara e grava last_run');
    {
        const db = new Database(':memory:');
        const svc = new SchedulerService(':memory:', db);
        let chamadas = 0;
        (svc as unknown as { msUntilNext: () => number }).msUntilNext = () => (chamadas++ === 0 ? 5 : 24 * 60 * 60 * 1000);
        let disparou = 0;
        svc.setTriggerHandler(async () => { disparou++; });
        const t = svc.createTask('chat_teste', 'lembrete', '0 17 * * *', 'custom', '{}', 'web');
        await new Promise(r => setTimeout(r, 80));
        svc.stopAll();
        const depois = svc.getTask(t.id);
        assert(disparou === 1, 'o gatilho rodou uma vez', disparou);
        assert(!!depois?.last_run, 'last_run gravado depois do disparo', depois?.last_run);
        db.close();
    }

    console.log('\nOs dois SQL achados na varredura rodam');
    {
        const db = new Database(':memory:');
        db.exec("CREATE TABLE memory_nodes (id TEXT, type TEXT, metadata TEXT); INSERT INTO memory_nodes VALUES ('a','fact','{}'), ('b','legacy_container','{}'), ('c','skill','{}')");
        const sqls = sqlsDoCodigo();
        const contagem = sqls.find(s => s.arquivo.endsWith('AttentionFeedback.ts') && /^SELECT COUNT\(\*\) as cnt FROM memory_nodes WHERE type != .legacy_container.$/.test(s.sql));
        const reconciliacao = sqls.find(s => s.arquivo.endsWith('MemoryFacade.ts') && /^SELECT \* FROM memory_nodes WHERE type IN \(.preference., .fact., .skill.\)$/.test(s.sql));
        const roda = <T>(sql: string | undefined, f: (sql: string) => T): T | string => {
            if (!sql) return 'SQL não encontrado no código';
            try { return f(sql); } catch (e) { return String(e); }
        };
        const nos = roda(contagem?.sql, s => (db.prepare(s).get() as { cnt: number }).cnt);
        const reconciliados = roda(reconciliacao?.sql, s => db.prepare(s).all().length);
        assert(nos === 2, 'AttentionFeedback.getStats: contagem de nós sem o legado', nos);
        assert(reconciliados === 2, 'MemoryFacade.listNodesForReconciliation: preferência, fato e skill', reconciliados);
        db.close();
    }

    console.log('\nGuarda: nenhum SQL do código usa texto entre aspas duplas');
    {
        const sqls = sqlsDoCodigo();
        const ruins = sqls.filter(s => TEXTO_EM_ASPAS_DUPLAS.test(s.sql));
        assert(sqls.length > 50, `a varredura encontrou os SQL do código (${sqls.length})`);
        assert(ruins.length === 0, 'nenhum texto entre aspas duplas', ruins.map(r => `${r.arquivo}: ${r.sql.slice(0, 120)}`));
        assert(TEXTO_EM_ASPAS_DUPLAS.test('UPDATE t SET x = datetime("now")') && !TEXTO_EM_ASPAS_DUPLAS.test('PRAGMA table_info("${tabela}")'),
            'a guarda reconhece o defeito e aceita identificador interpolado');
    }

    console.log(`\n${passed} passaram, ${failed} falharam\n`);
    if (failed > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
