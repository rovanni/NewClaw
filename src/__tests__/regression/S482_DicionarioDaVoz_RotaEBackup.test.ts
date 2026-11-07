/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S482
 * Dicionário da voz (ADR-039, Revisão 2, 07/11/2026): as palavras que a pessoa ensina à interface de voz moram no banco do
 * NewClaw, para irem no backup do conhecimento (ADR-020).
 *
 * PEDIDO (operadora, 07/11/2026): "Se eu fizer backup das minhas informações, isso vai junto? Porque isso é importante."
 * Guardadas na pasta da voz, como a Sprint 1 propunha, ficariam fora do backup. E "se a pessoa digitou errado e enviou sem
 * querer?": a lista inteira é editável, e o "Desfazer" é gravar a lista anterior.
 *
 * O QUE ESTE TESTE COBRE (HTTP real contra um Express real, banco SQLite real com a tabela `memory`):
 *   1. GET sem nada guardado: lista vazia, revisão 0.
 *   2. PUT com a revisão lida: grava, sobe a revisão e limpa a forma (espaços, "ouvia" repetido ou igual à palavra).
 *   3. PUT com revisão velha: 409, nada sobrescrito (duas janelas abertas).
 *   4. Recusas de forma: palavra vazia, duplicada sem diferença de maiúsculas, teto de proteção, sem revisão.
 *   5. "Desfazer": PUT da lista anterior volta ao que era.
 *   6. O valor fica na tabela `memory`, categoria `voz`: está no `data/newclaw.db` que o backup leva inteiro.
 *   7. `GET /api/status` anuncia `contracts.voz_vocabulario`.
 *   8. Valor guardado ilegível é erro 500, nunca uma lista vazia no lugar (Nunca Adivinhar).
 *
 * REGRESSÃO SE: a lista passar a morar fora do banco, um PUT velho sobrescrever o de outra janela, ou um valor estragado
 * virar lista vazia em silêncio (a próxima gravação apagaria o que a pessoa ensinou).
 *
 * Execução: npx ts-node src/__tests__/regression/S482_DicionarioDaVoz_RotaEBackup.test.ts
 */

import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { createVozRouter, CHAVE_DO_VOCABULARIO, TETO_DE_PALAVRAS, VOZ_VOCABULARIO_VERSION, type GuardaDeConfiguracao } from '../../dashboard/routes/voz';
import { createStatusRouter } from '../../dashboard/routes/status';
import type { DashboardContext } from '../../dashboard/routes/types';
import type { NewClawConfig } from '../../core/AgentController';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  OK ${message}`); passed++; }
    else { console.error(`  FALHOU: ${message}`, detail ?? ''); failed++; }
}

/** A mesma tabela e as mesmas consultas de `MemoryManager.getSetting`/`setSetting`. */
function guardaNoBanco(db: Database.Database): GuardaDeConfiguracao {
    db.exec(`CREATE TABLE IF NOT EXISTS memory (key TEXT PRIMARY KEY, value TEXT NOT NULL, category TEXT DEFAULT 'system', updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    return {
        getSetting: (k) => (db.prepare('SELECT value FROM memory WHERE key = ?').get(k) as { value: string } | undefined)?.value ?? null,
        setSetting: (k, v, c = 'system') => { db.prepare('INSERT OR REPLACE INTO memory (key, value, category) VALUES (?, ?, ?)').run(k, v, c); },
    };
}

async function main(): Promise<void> {
    const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 's482-'));
    const db = new Database(path.join(pasta, 'newclaw.db'));
    const guarda = guardaNoBanco(db);
    const app = express();
    app.use(express.json());
    const ctx = { memoryManager: guarda } as unknown as DashboardContext;
    app.use('/api/voz', createVozRouter(ctx, () => new Date('2026-11-07T12:00:00.000Z')));
    app.use('/api', createStatusRouter({ config: { language: 'pt-BR' } as NewClawConfig }));
    const server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
    const pedir = async (metodo: string, rota: string, corpo?: unknown) => {
        const r = await fetch(base + rota, { method: metodo, headers: { 'Content-Type': 'application/json' }, body: corpo === undefined ? undefined : JSON.stringify(corpo) });
        return { status: r.status, corpo: await r.json() as Record<string, any> };
    };

    try {
        console.log('\n1. Nada guardado');
        const vazio = await pedir('GET', '/voz/vocabulario');
        assert(vazio.status === 200 && vazio.corpo.revisao === 0 && Array.isArray(vazio.corpo.palavras) && vazio.corpo.palavras.length === 0, 'lista vazia, revisão 0', vazio);

        console.log('\n2. Aprender "River" (eu ouvia "Rigger")');
        const um = await pedir('PUT', '/voz/vocabulario', { revisao: 0, palavras: [{ palavra: '  River ', ouvia: ['Rigger', 'rigger', 'River', '  River   AEM '] }] });
        const p = um.corpo.palavras?.[0];
        assert(um.status === 200 && um.corpo.revisao === 1, 'grava e sobe a revisão para 1', um);
        assert(p?.palavra === 'River', 'espaços em volta saem', p);
        assert(JSON.stringify(p?.ouvia) === JSON.stringify(['Rigger', 'River AEM']), '"ouvia" sem repetição, sem a própria palavra e com espaços juntados', p?.ouvia);
        assert(p?.vezes === 1 && p?.criadaEm === '2026-11-07T12:00:00.000Z', 'vezes 1 e data do servidor quando não veio', p);

        console.log('\n3. Duas janelas: a segunda grava com a revisão velha');
        const velho = await pedir('PUT', '/voz/vocabulario', { revisao: 0, palavras: [] });
        assert(velho.status === 409 && velho.corpo.revisao === 1 && velho.corpo.palavras?.length === 1, '409, e a resposta traz a lista atual', velho);
        const depois = await pedir('GET', '/voz/vocabulario');
        assert(depois.corpo.palavras?.[0]?.palavra === 'River', 'nada foi sobrescrito', depois.corpo);

        console.log('\n4. Recusas de forma');
        const semRevisao = await pedir('PUT', '/voz/vocabulario', { palavras: [] });
        assert(semRevisao.status === 400, 'sem revisão: 400', semRevisao.corpo);
        const vaziaP = await pedir('PUT', '/voz/vocabulario', { revisao: 1, palavras: [{ palavra: '   ' }] });
        assert(vaziaP.status === 400, 'palavra vazia: 400', vaziaP.corpo);
        const dup = await pedir('PUT', '/voz/vocabulario', { revisao: 1, palavras: [{ palavra: 'River' }, { palavra: 'river' }] });
        assert(dup.status === 400 && /duas vezes/.test(dup.corpo.error), 'duplicada (sem diferença de maiúsculas): 400', dup.corpo);
        const muitas = await pedir('PUT', '/voz/vocabulario', { revisao: 1, palavras: Array.from({ length: TETO_DE_PALAVRAS + 1 }, (_, i) => ({ palavra: `p${i}` })) });
        assert(muitas.status === 400, `mais de ${TETO_DE_PALAVRAS} palavras: 400`, muitas.corpo);
        const vezesRuim = await pedir('PUT', '/voz/vocabulario', { revisao: 1, palavras: [{ palavra: 'X', vezes: 0 }] });
        assert(vezesRuim.status === 400, 'vezes 0: 400', vezesRuim.corpo);
        assert((await pedir('GET', '/voz/vocabulario')).corpo.revisao === 1, 'nenhuma recusa gravou nada');

        console.log('\n5. Editar ("Rivre" digitado errado) e Desfazer');
        const antes = (await pedir('GET', '/voz/vocabulario')).corpo;
        const editado = await pedir('PUT', '/voz/vocabulario', { revisao: antes.revisao, palavras: [{ ...antes.palavras[0], palavra: 'Rivre' }] });
        assert(editado.status === 200 && editado.corpo.palavras[0].palavra === 'Rivre' && editado.corpo.palavras[0].criadaEm === antes.palavras[0].criadaEm, 'edita a palavra e mantém a data de criação', editado.corpo);
        const desfeito = await pedir('PUT', '/voz/vocabulario', { revisao: editado.corpo.revisao, palavras: antes.palavras });
        assert(desfeito.status === 200 && desfeito.corpo.palavras[0].palavra === 'River' && desfeito.corpo.revisao === 3, 'Desfazer: a lista anterior volta (revisão 3)', desfeito.corpo);

        console.log('\n6. Guardado no banco que o backup leva');
        const linha = db.prepare('SELECT value, category FROM memory WHERE key = ?').get(CHAVE_DO_VOCABULARIO) as { value: string; category: string } | undefined;
        assert(linha?.category === 'voz' && JSON.parse(linha.value).palavras[0].palavra === 'River', 'tabela memory, categoria voz, no data/newclaw.db', linha);

        console.log('\n7. Anúncio no /api/status');
        const st = await pedir('GET', '/status');
        assert(st.corpo.status?.contracts?.voz_vocabulario === VOZ_VOCABULARIO_VERSION, 'contracts.voz_vocabulario', st.corpo.status?.contracts);

        console.log('\n8. Valor estragado não vira lista vazia');
        guarda.setSetting(CHAVE_DO_VOCABULARIO, '{"isto": "não é a forma"}', 'voz');
        const estragado = await pedir('GET', '/voz/vocabulario');
        assert(estragado.status === 500 && estragado.corpo.success === false, 'GET: 500 com o motivo', estragado.corpo);
        const sobre = await pedir('PUT', '/voz/vocabulario', { revisao: 0, palavras: [] });
        assert(sobre.status === 500, 'PUT não sobrescreve o valor estragado', sobre.corpo);

        console.log('\n9. Sem memória do NewClaw');
        const app2 = express();
        app2.use(express.json());
        app2.use('/api/voz', createVozRouter({} as DashboardContext));
        const s2 = app2.listen(0);
        await new Promise((r) => s2.once('listening', r));
        const r2 = await fetch(`http://127.0.0.1:${(s2.address() as { port: number }).port}/api/voz/vocabulario`);
        assert(r2.status === 503, '503, sem inventar lista', r2.status);
        s2.close();
    } finally {
        server.close();
        db.close();
    }

    console.log(`\n${passed} passaram, ${failed} falharam`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
