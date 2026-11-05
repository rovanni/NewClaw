/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S476 (ADR-034 V1, Sync Agent — os testes de aceitação com pastas simuladas)
 *
 * Três instalações (PC, notebook, VPS) em pastas temporárias, cada uma com o próprio banco, `skills/` e `data/`, e uma pasta
 * "sincronizada" comum fazendo o papel do Syncthing (cópia instantânea). A prova real nas três máquinas é a etapa 5 da ADR,
 * feita só com a autorização da operadora para configurar o Syncthing.
 *
 * O que é real: `publicar`, `rodarSincronizacao`, a trava, `criarPacote`/`importarPacote` (ADR-020), o `SkillLearner` (limpeza
 * e desativação) e o `SkillLoader` (o que carrega). Nenhum modelo é chamado.
 *
 * Execução: npx ts-node src/__tests__/regression/S476_SyncAgent_PastasSimuladas.test.ts
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import JSZip from 'jszip';
import Database from 'better-sqlite3';
import * as bk from '../../core/backupDoConhecimento';
import * as sync from '../../core/syncAgent';
import { SkillLearner } from '../../loop/SkillLearner';
import { SkillLoader } from '../../skills/SkillLoader';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}

const OUTRO = process.platform === 'win32' ? 'linux' : 'win32';
const CAMINHO_DO_OUTRO = OUTRO === 'win32' ? 'C:\\Users\\alguem\\bin\\x.exe' : '/home/alguem/bin/x';

interface Inst { nome: string; c: bk.Caminhos; db: string; cfg: sync.ConfiguracaoDoSync }

function criarBanco(arquivo: string): void {
    const db = new Database(arquivo);
    db.exec(`CREATE TABLE memory_nodes (id TEXT PRIMARY KEY, type TEXT, name TEXT, content TEXT, lifecycle_state TEXT, so_desta_maquina INTEGER DEFAULT 0, last_accessed TEXT);
             CREATE TABLE memory_edges (from_node TEXT NOT NULL, to_node TEXT NOT NULL, relation TEXT NOT NULL, weight REAL DEFAULT 1.0, PRIMARY KEY (from_node, to_node, relation));
             CREATE TABLE auto_skills (id TEXT PRIMARY KEY, name TEXT NOT NULL, trigger TEXT NOT NULL, description TEXT NOT NULL, prompt TEXT NOT NULL,
                 tool_sequence TEXT DEFAULT '[]', priority INTEGER DEFAULT 5, hits INTEGER DEFAULT 0, status TEXT DEFAULT 'proposed', source_pattern TEXT,
                 source_tool TEXT, reviewed_at TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')),
                 file_exported INTEGER DEFAULT 0, origem_instalacao TEXT);
             CREATE TABLE messages (id INTEGER PRIMARY KEY, conversation_id TEXT, content TEXT);
             CREATE VIRTUAL TABLE memory_nodes_fts USING fts5(name, content, type, content='memory_nodes');`);
    db.prepare(`INSERT INTO messages (conversation_id, content) VALUES ('web:x', 'CONVERSA_PRIVADA_NAO_VIAJA')`).run();
    db.close();
}

function inst(base: string, nome: string, pasta: string): Inst {
    const raiz = path.join(base, nome.toLowerCase());
    const c: bk.Caminhos = { raiz, dados: path.join(raiz, 'data'), skills: path.join(raiz, 'skills'), workspace: path.join(raiz, 'workspace'), env: path.join(raiz, '.env') };
    fs.mkdirSync(c.dados, { recursive: true });
    fs.mkdirSync(c.skills, { recursive: true });
    const db = path.join(c.dados, 'newclaw.db');
    criarBanco(db);
    return { nome, c, db, cfg: { ligado: true, pasta, nome, intervaloMin: 30 } };
}

function memoria(i: Inst, id: string, conteudo: string, soDaqui = 0): void {
    const db = new Database(i.db);
    db.prepare(`INSERT INTO memory_nodes (id, type, name, content, so_desta_maquina) VALUES (?, 'fact', ?, ?, ?)`).run(id, id, conteudo, soDaqui);
    db.close();
}
function temMemoria(i: Inst, id: string): boolean {
    const db = new Database(i.db, { readonly: true });
    try { return !!db.prepare('SELECT 1 FROM memory_nodes WHERE id = ?').get(id); } finally { db.close(); }
}
function contar(i: Inst, tabela: string): number {
    const db = new Database(i.db, { readonly: true });
    try { return (db.prepare(`SELECT COUNT(*) n FROM ${tabela}`).get() as { n: number }).n; } finally { db.close(); }
}
function skillAprendida(i: Inst, pasta: string, nome: string, corpo: string, status = 'active'): void {
    const db = new Database(i.db);
    db.prepare(`INSERT INTO auto_skills (id, name, trigger, description, prompt, status, source_pattern, file_exported) VALUES (?, ?, 'g', 'd', ?, ?, ?, ?)`)
        .run(`skill_${pasta}_${i.nome}`, nome, corpo, status, pasta, status === 'active' ? 1 : 0);
    db.close();
    fs.mkdirSync(path.join(i.c.skills, pasta), { recursive: true });
    fs.writeFileSync(path.join(i.c.skills, pasta, status === 'active' ? 'SKILL.md' : 'SKILL.md.revisar'), `---\nname: ${nome}\ndescription: d\n---\n${corpo}\n`);
}
function statusDaSkill(i: Inst, pasta: string): { status: string; origem: string | null } | undefined {
    const db = new Database(i.db, { readonly: true });
    try { return db.prepare(`SELECT status, origem_instalacao AS origem FROM auto_skills WHERE source_pattern = ? ORDER BY created_at LIMIT 1`).get(pasta) as { status: string; origem: string | null } | undefined; } finally { db.close(); }
}
const subpastaDe = (i: Inst) => path.join(i.cfg.pasta!, sync.nomeDaSubpasta(i.nome, sync.idDaInstalacao(i.c)));
const rodar = (i: Inst, modo = 'automatico') => { process.env.APRENDIZADO_DE_SKILLS = modo; return sync.rodarSincronizacao(i.cfg, i.c); };
const relatoDe = (r: sync.RelatorioDaRodada, nome: string) => r.instalacoes.find(x => x.nome === nome);

async function main(): Promise<void> {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-s476-'));
    const pasta = path.join(base, 'NewClaw-Sync');
    fs.mkdirSync(pasta);
    const pc = inst(base, 'PC', pasta);
    const nb = inst(base, 'Notebook', pasta);
    const vps = inst(base, 'VPS', pasta);
    try {
        console.log('\n=== S476-1 — configuração e identidade ===');
        const cfg = sync.configuracaoDoSync({ SYNC_LIGADO: 'true', SYNC_PASTA: ' /x ', SYNC_NOME: 'PC', SYNC_INTERVALO_MIN: '0' });
        assert(cfg.ligado && cfg.pasta === '/x' && cfg.intervaloMin === 30, 'SYNC_* lidos; intervalo inválido volta ao padrão (30 min)', cfg);
        assert(!sync.configuracaoDoSync({}).ligado, 'desligado por padrão');
        const id = sync.idDaInstalacao(pc.c);
        assert(sync.idDaInstalacao(pc.c) === id && /^[0-9a-f-]{36}$/.test(id), 'UUID gerado uma vez e guardado em data/');
        assert(/^pc-[0-9a-f]{8}$/.test(sync.nomeDaSubpasta('PC', id)) && sync.nomeDaSubpasta('Notebook da Lú!', id).startsWith('notebook-da-lu-'), 'subpasta <nome>-<id8>, só [a-z0-9-]');

        console.log('\n=== S476-2 — publicar: ordem, manifesto, privacidade, sem mudança sem pacote ===');
        memoria(pc, 'm-pc-1', 'Cidade padrão: Cornélio Procópio');
        memoria(pc, 'm-pc-local', 'SO_DESTA_MAQUINA_NAO_VIAJA', 1);
        skillAprendida(pc, 'aprendida_relatorio', 'relatorio-do-pc', 'Gerar o relatório diário.');
        const p1 = await sync.publicar(pc.cfg, pc.c);
        const dirPc = subpastaDe(pc);
        const mPc = sync.lerManifesto(dirPc)!;
        assert(p1.publicado && p1.numero === 1 && fs.existsSync(path.join(dirPc, '000001.zip')), 'primeiro pacote: 000001.zip', p1);
        assert(!fs.readdirSync(dirPc).some(f => f.endsWith('.parcial')), 'nenhum .parcial sobra depois da publicação');
        assert(mPc.pacotes.length === 1 && mPc.pacotes[0].tamanho === fs.statSync(path.join(dirPc, '000001.zip')).size && /^[0-9a-f]{64}$/.test(mPc.pacotes[0].sha256),
            'o manifesto anuncia o pacote com tamanho e SHA-256 do arquivo', mPc.pacotes[0]);
        const zip = await JSZip.loadAsync(fs.readFileSync(path.join(dirPc, '000001.zip')));
        const tmpDb = path.join(base, 'pkg.db');
        fs.writeFileSync(tmpDb, await zip.file('data/newclaw.db')!.async('nodebuffer'));
        const pkg = new Database(tmpDb, { readonly: true });
        const tabelas = (pkg.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{ name: string }>).map(t => t.name).sort();
        const conteudo = JSON.stringify(pkg.prepare('SELECT * FROM memory_nodes').all());
        pkg.close();
        const bytes = fs.readFileSync(tmpDb).toString('latin1');
        assert(JSON.stringify(tabelas) === JSON.stringify(['auto_skills', 'memory_edges', 'memory_nodes']), 'o banco do pacote só tem as tabelas compartilháveis', tabelas);
        assert(!conteudo.includes('SO_DESTA_MAQUINA') && !bytes.includes('SO_DESTA_MAQUINA_NAO_VIAJA') && !bytes.includes('CONVERSA_PRIVADA'),
            'memória "só desta máquina" e conversas não viajam, nem em páginas livres');
        const interno = JSON.parse(await zip.file('manifesto.json')!.async('string'));
        assert(interno.sincronizacao?.id === id && interno.sincronizacao?.numero === 1, 'o manifesto interno traz a origem (id e número)', interno.sincronizacao);
        const p2 = await sync.publicar(pc.cfg, pc.c);
        assert(!p2.publicado && /sem mudança/.test(p2.motivo ?? ''), 'sem mudança, sem pacote novo', p2);
        const db = new Database(pc.db); db.prepare(`UPDATE memory_nodes SET last_accessed = 'agora' WHERE id = 'm-pc-1'`).run(); db.close();
        assert(!(await sync.publicar(pc.cfg, pc.c)).publicado, 'ler uma memória (last_accessed) não é mudança de conhecimento');

        console.log('\n=== S476-3 — aceitação 1, 2 e 3: PC → notebook, notebook → VPS, VPS → PC ===');
        const r1 = await rodar(nb);
        assert(temMemoria(nb, 'm-pc-1') && !temMemoria(nb, 'm-pc-local'), '1: o notebook importa a memória do PC (a "só desta máquina" não)', relatoDe(r1, 'PC'));
        assert(fs.existsSync(path.join(nb.c.skills, 'aprendida_relatorio', 'SKILL.md')) && statusDaSkill(nb, 'aprendida_relatorio')?.status === 'active'
            && statusDaSkill(nb, 'aprendida_relatorio')?.origem === 'PC' && !!relatoDe(r1, 'PC')?.entrou?.skills.ativadas.includes('relatorio-do-pc'),
            '1: no modo automático, a skill ativa do PC entra ativa, com origem_instalacao = PC e o aviso', statusDaSkill(nb, 'aprendida_relatorio'));
        memoria(nb, 'm-nb-1', 'Notebook: anotação de viagem');
        await rodar(nb);
        await rodar(vps);
        assert(temMemoria(vps, 'm-nb-1') && temMemoria(vps, 'm-pc-1'), '2: a VPS importa do notebook (e do PC)');
        memoria(vps, 'm-vps-1', 'VPS: o serviço x roda na porta 8080');
        await rodar(vps);
        const r3 = await rodar(pc);
        assert(temMemoria(pc, 'm-vps-1') && temMemoria(pc, 'm-nb-1'), '3: o PC importa da VPS e do notebook', r3.instalacoes.map(i => [i.nome, i.importadoAte, i.erros]));
        assert(contar(pc, 'messages') === 1, 'as conversas do PC continuam só as dele');

        console.log('\n=== S476-4 — aceitação 7: o mesmo pacote importado 10 vezes = 1 vez ===');
        const antes = [contar(nb, 'memory_nodes'), contar(nb, 'memory_edges'), contar(nb, 'auto_skills')];
        const pacotePc = path.join(dirPc, sync.lerManifesto(dirPc)!.pacotes.slice(-1)[0].arquivo);
        for (let k = 0; k < 10; k++) await bk.importarPacote(pacotePc, nb.c, undefined, path.join(base, 'seg-idem'), { origemInstalacao: 'PC', modo: 'automatico', segurancaSoSeEntrar: true });
        const depois = [contar(nb, 'memory_nodes'), contar(nb, 'memory_edges'), contar(nb, 'auto_skills')];
        assert(JSON.stringify(antes) === JSON.stringify(depois), 'contagens iguais depois de 10 importações', { antes, depois });
        assert(!fs.existsSync(path.join(base, 'seg-idem')) || fs.readdirSync(path.join(base, 'seg-idem')).length === 0, 'nada entrou: nenhum pacote de segurança fica');
        // Skill que diverge entre as instalações: a local fica, e o relatório diz (achado do review de 05/11/2026).
        const arqNb = path.join(nb.c.skills, 'aprendida_relatorio', 'SKILL.md');
        const antesDaEdicao = fs.readFileSync(arqNb);
        fs.writeFileSync(arqNb, antesDaEdicao.toString('utf8') + '\nEditada no notebook.\n');
        const relDif = await bk.importarPacote(pacotePc, nb.c, undefined, path.join(base, 'seg-dif'), { origemInstalacao: 'PC', modo: 'automatico' });
        assert(relDif.skills.comDiferenca.includes('aprendida_relatorio') && fs.readFileSync(arqNb, 'utf8').includes('Editada no notebook.'),
            'skill diferente aqui: a local fica e aparece em comDiferenca', relDif.skills);
        fs.writeFileSync(arqNb, antesDaEdicao);

        console.log('\n=== S476-5 — aceitação 4: máquina desligada por vários pacotes recupera com o mais novo ===');
        for (let k = 0; k < 3; k++) { memoria(pc, `m-pc-lote-${k}`, `lote ${k}`); await sync.publicar(pc.cfg, pc.c); }
        const rVolta = await rodar(vps);
        assert([0, 1, 2].every(k => temMemoria(vps, `m-pc-lote-${k}`)) && relatoDe(rVolta, 'PC')?.importadoAte === relatoDe(rVolta, 'PC')?.ultimoPacote,
            'a VPS, voltando, importa só o mais novo e recebe tudo (fotografia completa)', relatoDe(rVolta, 'PC'));

        console.log('\n=== S476-6 — retenção pelos cursores ===');
        for (let k = 0; k < 8; k++) { memoria(pc, `m-ret-${k}`, `ret ${k}`); await sync.publicar(pc.cfg, pc.c); }
        const mRet = sync.lerManifesto(dirPc)!;
        const numeros = mRet.pacotes.map(p => p.numero);
        const cursorNb = sync.lerManifesto(subpastaDe(nb))!.importados[id] ?? 0;
        assert(numeros.length >= sync.PACOTES_SEMPRE_MANTIDOS && numeros.every(n => n >= cursorNb || numeros.slice(-sync.PACOTES_SEMPRE_MANTIDOS).includes(n)),
            'retenção: só some o que todas já passaram; os 5 mais novos sempre ficam', { numeros, cursorNb });
        assert(mRet.pacotes.every(p => fs.existsSync(path.join(dirPc, p.arquivo))) && fs.readdirSync(dirPc).filter(f => f.endsWith('.zip')).length === mRet.pacotes.length,
            'manifesto e arquivos coincidem depois da retenção');
        const ultimoConfirmado = sync.lerManifesto(subpastaDe(vps))!.importados[id];
        assert(!ultimoConfirmado || numeros.some(n => n >= ultimoConfirmado), 'o último pacote confirmado por cada uma continua lá (ou um mais novo)');

        console.log('\n=== S476-7 — aceitação 5: pacote incompleto fica para a próxima rodada ===');
        memoria(pc, 'm-incompleto', 'chega depois');
        await sync.publicar(pc.cfg, pc.c);
        const mInc = sync.lerManifesto(dirPc)!;
        const novo = mInc.pacotes.slice(-1)[0];
        const arqNovo = path.join(dirPc, novo.arquivo);
        const bytesNovo = fs.readFileSync(arqNovo);
        fs.unlinkSync(arqNovo);
        const rFalta = await rodar(nb);
        assert(!temMemoria(nb, 'm-incompleto') && /ainda não chegou/.test(relatoDe(rFalta, 'PC')?.pendente ?? '') && relatoDe(rFalta, 'PC')!.erros.length === 0,
            'manifesto chegou antes do zip: adiado, sem erro', relatoDe(rFalta, 'PC'));
        fs.writeFileSync(arqNovo, bytesNovo.subarray(0, Math.floor(bytesNovo.length / 2)));
        const rMetade = await rodar(nb);
        assert(!temMemoria(nb, 'm-incompleto') && /chegando/.test(relatoDe(rMetade, 'PC')?.pendente ?? ''), 'zip pela metade: adiado', relatoDe(rMetade, 'PC'));
        fs.writeFileSync(arqNovo, bytesNovo);
        await rodar(nb);
        assert(temMemoria(nb, 'm-incompleto'), 'completo na rodada seguinte: importado');

        console.log('\n=== S476-8 — aceitação 6: hash errado e origem divergente são rejeitados ===');
        memoria(pc, 'm-hash', 'pacote adulterado');
        await sync.publicar(pc.cfg, pc.c);
        const mHash = sync.lerManifesto(dirPc)!;
        const alvo = mHash.pacotes.slice(-1)[0];
        const original = fs.readFileSync(path.join(dirPc, alvo.arquivo));
        const adulterado = Buffer.from(original); adulterado[adulterado.length - 30] ^= 0xff;
        fs.writeFileSync(path.join(dirPc, alvo.arquivo), adulterado);
        const rHash = await rodar(nb);
        assert(!temMemoria(nb, 'm-hash') && relatoDe(rHash, 'PC')!.erros.some(e => /SHA-256 diferente/.test(e)), 'SHA-256 errado: erro na tela, não entra', relatoDe(rHash, 'PC')?.erros);
        // Origem divergente: o zip de OUTRA instalação colocado no lugar, com tamanho e SHA atualizados no manifesto.
        const pacoteVps = path.join(subpastaDe(vps), sync.lerManifesto(subpastaDe(vps))!.pacotes.slice(-1)[0].arquivo);
        fs.copyFileSync(pacoteVps, path.join(dirPc, alvo.arquivo));
        const mFalso = sync.lerManifesto(dirPc)!;
        const falso = mFalso.pacotes.find(p => p.numero === alvo.numero)!;
        falso.tamanho = fs.statSync(path.join(dirPc, alvo.arquivo)).size;
        falso.sha256 = require('crypto').createHash('sha256').update(fs.readFileSync(path.join(dirPc, alvo.arquivo))).digest('hex');
        fs.writeFileSync(path.join(dirPc, 'manifest.json'), JSON.stringify(mFalso));
        const rOrigem = await rodar(nb);
        assert(relatoDe(rOrigem, 'PC')!.erros.some(e => /origem dentro do pacote não bate/.test(e)), 'origem divergente: rejeitado', relatoDe(rOrigem, 'PC')?.erros);
        fs.writeFileSync(path.join(dirPc, alvo.arquivo), original);
        falso.tamanho = original.length;
        falso.sha256 = require('crypto').createHash('sha256').update(original).digest('hex');
        fs.writeFileSync(path.join(dirPc, 'manifest.json'), JSON.stringify(mFalso));
        await rodar(nb);
        assert(temMemoria(nb, 'm-hash'), 'restaurado o pacote certo, a rodada seguinte o importa');

        console.log('\n=== S476-9 — aceitação 8: uma sincronização por vez; trava abandonada é retomada ===');
        const lock = path.join(nb.c.dados, 'sync.lock');
        fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, em: 'agora' }));
        const rTrava = await rodar(nb);
        assert(/em andamento/.test(rTrava.erro ?? '') && fs.existsSync(lock), 'trava de processo vivo: a segunda rodada recebe "em andamento" e não toca na trava', rTrava.erro);
        let mesmaTrava = false;
        try { await sync.comTravaDeSync(nb.c, async () => 1); } catch (e) { mesmaTrava = e instanceof sync.SincronizacaoEmAndamento; }
        assert(mesmaTrava, 'a importação manual (comTravaDeSync) também espera a vez');
        fs.writeFileSync(lock, JSON.stringify({ pid: 2147483646, em: 'antes' }));
        const rRetoma = await rodar(nb);
        assert(!rRetoma.erro && !fs.existsSync(lock), 'trava de processo que morreu: retomada e liberada no fim', rRetoma.erro);
        const dentro = sync.comTravaDeSync(nb.c, async () => { await new Promise(r => setTimeout(r, 50)); return 'ok'; });
        const enquanto = await rodar(nb);
        assert((await dentro) === 'ok' && /em andamento/.test(enquanto.erro ?? ''), 'rodada automática durante uma importação manual: recusada, sem esperar às cegas');

        console.log('\n=== S476-10 — aceitação 9: skills seguem APRENDIZADO_DE_SKILLS e o que foi decidido aqui ===');
        skillAprendida(pc, 'aprendida_modo', 'skill-do-modo', 'Procedimento X.');
        await sync.publicar(pc.cfg, pc.c);
        const insts: Record<string, Inst> = {};
        for (const modo of ['automatico', 'proposta', 'desligado']) {
            const d = inst(base, `dest-${modo}`, pasta);
            insts[modo] = d;
            await rodar(d, modo);
            const ativo = fs.existsSync(path.join(d.c.skills, 'aprendida_modo', 'SKILL.md'));
            const proposto = fs.existsSync(path.join(d.c.skills, 'aprendida_modo', 'SKILL.md.revisar'));
            const st = statusDaSkill(d, 'aprendida_modo')?.status;
            assert(modo === 'automatico' ? ativo && !proposto && st === 'active' : !ativo && proposto && st === 'proposed',
                `APRENDIZADO_DE_SKILLS=${modo}: ${modo === 'automatico' ? 'entra ativa' : 'entra proposta'}`, { ativo, proposto, st });
        }
        const carregador = new SkillLoader(insts.proposta.c.skills); carregador.loadAll();
        assert(!carregador.getSkill('skill-do-modo'), 'a proposta não age: o SkillLoader não a carrega');
        // Limpeza do SkillLearner: proposta importada de um padrão já ativo aqui continua.
        const conhecido = Object.keys((SkillLearner as unknown as { SKILL_DEFS: Record<string, unknown> }).SKILL_DEFS)[0];
        skillAprendida(pc, conhecido, `conhecida-${conhecido}`, 'corpo do PC');
        await sync.publicar(pc.cfg, pc.c);
        const dProp = insts.proposta;
        skillAprendida(dProp, `${conhecido}_local`, `local-${conhecido}`, 'corpo local');
        const dbProp = new Database(dProp.db); dbProp.prepare(`UPDATE auto_skills SET source_pattern = ? WHERE id = ?`).run(conhecido, `skill_${conhecido}_local_${dProp.nome}`); dbProp.close();
        await rodar(dProp, 'proposta');
        const dbL = new Database(dProp.db);
        new SkillLearner(dbL, dProp.c.skills);
        const sobrou = dbL.prepare(`SELECT status FROM auto_skills WHERE source_pattern = ? AND origem_instalacao = 'PC'`).get(conhecido) as { status: string } | undefined;
        dbL.close();
        assert(sobrou?.status === 'proposed', 'a limpeza do SkillLearner não apaga a proposta importada (padrão já ativo aqui)', sobrou);
        // Desativar aqui e reimportar: não volta ativa.
        const dAuto = insts.automatico;
        const dbA = new Database(dAuto.db);
        const nome = new SkillLearner(dbA, dAuto.c.skills).deactivateSkillByName('skill-do-modo');
        dbA.close();
        assert(nome === 'skill-do-modo' && !fs.existsSync(path.join(dAuto.c.skills, 'aprendida_modo', 'SKILL.md')), '/skill_desativar desfaz uma importada');
        memoria(pc, 'm-reimport', 'força pacote novo'); await sync.publicar(pc.cfg, pc.c);
        await rodar(dAuto, 'automatico');
        assert(!fs.existsSync(path.join(dAuto.c.skills, 'aprendida_modo', 'SKILL.md')) && statusDaSkill(dAuto, 'aprendida_modo')?.status === 'inactive',
            'reimportar não reativa o que foi desativado aqui', statusDaSkill(dAuto, 'aprendida_modo'));
        // Skill com caminho de outro sistema: fica proposta mesmo no automático.
        const dOutro = inst(base, 'dest-outro-sistema', path.join(base, 'pasta-outro'));
        fs.mkdirSync(dOutro.cfg.pasta!, { recursive: true });
        const origemOutro = inst(base, 'origem-outro', dOutro.cfg.pasta!);
        skillAprendida(origemOutro, 'aprendida_caminho', 'skill-caminho', `Rode ${CAMINHO_DO_OUTRO} --ajuda`);
        await sync.publicar(origemOutro.cfg, origemOutro.c);
        const dirOutro = subpastaDe(origemOutro);
        const mOutro = sync.lerManifesto(dirOutro)!;
        const arqOutro = path.join(dirOutro, mOutro.pacotes[0].arquivo);
        const z = await JSZip.loadAsync(fs.readFileSync(arqOutro));
        const mi = JSON.parse(await z.file('manifesto.json')!.async('string')); mi.sistema = OUTRO;
        z.file('manifesto.json', JSON.stringify(mi));
        fs.writeFileSync(arqOutro, await z.generateAsync({ type: 'nodebuffer' }));
        mOutro.pacotes[0].tamanho = fs.statSync(arqOutro).size;
        mOutro.pacotes[0].sha256 = require('crypto').createHash('sha256').update(fs.readFileSync(arqOutro)).digest('hex');
        fs.writeFileSync(path.join(dirOutro, 'manifest.json'), JSON.stringify(mOutro));
        await rodar(dOutro, 'automatico');
        assert(fs.existsSync(path.join(dOutro.c.skills, 'aprendida_caminho', 'SKILL.md.revisar')) && !fs.existsSync(path.join(dOutro.c.skills, 'aprendida_caminho', 'SKILL.md'))
            && statusDaSkill(dOutro, 'aprendida_caminho')?.status === 'proposed', 'com caminho de outro sistema: proposta, mesmo no automático');

        console.log('\n=== S476-11 — aceitação 10: falha no meio — banco intacto, cursor parado, a rodada seguinte completa ===');
        memoria(pc, 'm-falha', 'falha injetada'); await sync.publicar(pc.cfg, pc.c);
        const cursorAntes = JSON.parse(fs.readFileSync(path.join(nb.c.dados, 'sync-estado.json'), 'utf8')).importados[id];
        const contagemAntes = contar(nb, 'memory_nodes');
        const real = new Database(nb.db);
        const quebrado = new Proxy(real, { get: (alvo, k) => k === 'transaction' ? () => () => { throw new Error('falha injetada no meio da importação'); } : (alvo as any)[k]?.bind?.(alvo) ?? (alvo as any)[k] });
        const rFalha = await sync.rodarSincronizacao(nb.cfg, nb.c, quebrado as unknown as Database.Database);
        real.close();
        const cursorDepois = JSON.parse(fs.readFileSync(path.join(nb.c.dados, 'sync-estado.json'), 'utf8')).importados[id];
        assert(relatoDe(rFalha, 'PC')!.erros.some(e => /falha injetada/.test(e)) && cursorDepois === cursorAntes && contar(nb, 'memory_nodes') === contagemAntes,
            'erro na tela, cursor não avançou, banco intacto', { erros: relatoDe(rFalha, 'PC')?.erros, cursorAntes, cursorDepois });
        await rodar(nb);
        assert(temMemoria(nb, 'm-falha'), 'a rodada seguinte completa');

        console.log('\n=== S476-12 — aceitação 11: o pacote de segurança anterior restaura o estado ===');
        const segurancas = fs.readdirSync(path.join(nb.c.dados, 'backups')).filter(f => f.startsWith('pre-sync-')).sort();
        assert(segurancas.length >= 1 && segurancas.length <= sync.SEGURANCAS_MANTIDAS, `pacotes de segurança só quando algo entrou, no máximo ${sync.SEGURANCAS_MANTIDAS}`, segurancas.length);
        const ultimaSeg = path.join(nb.c.dados, 'backups', segurancas[segurancas.length - 1]);
        const rest = await bk.restaurarPacote(ultimaSeg, {}, nb.c, path.join(base, 'seg-rest'));
        const restaurado = new Database(path.join(nb.c.dados, 'newclaw.db.restore'), { readonly: true });
        const temNoRestaurado = !!restaurado.prepare(`SELECT 1 FROM memory_nodes WHERE id = 'm-falha'`).get();
        const temAnterior = !!restaurado.prepare(`SELECT 1 FROM memory_nodes WHERE id = 'm-hash'`).get();
        restaurado.close();
        assert(rest.banco && !temNoRestaurado && temAnterior, 'restaurar a segurança volta ao estado anterior à importação (sem m-falha, com o que já havia)');
        fs.unlinkSync(path.join(nb.c.dados, 'newclaw.db.restore')); fs.unlinkSync(path.join(nb.c.dados, '.restore-pending'));

        console.log('\n=== S476-13 — aceitação 12: pasta indisponível não derruba a instalação ===');
        const semPasta = await sync.rodarSincronizacao({ ...nb.cfg, pasta: path.join(base, 'desmontada') }, nb.c);
        assert(/indisponível/.test(semPasta.erro ?? '') && temMemoria(nb, 'm-pc-1'), 'pasta desmontada: só o relatório avisa; nada lança, nada se perde', semPasta.erro);
        assert(!!sync.ultimoRelatorio(nb.c)?.erro, 'o último relatório (para a tela) traz o aviso');
        const semCfg = await sync.rodarSincronizacao({ ligado: true, intervaloMin: 30 }, nb.c);
        assert(/não configurados/.test(semCfg.erro ?? ''), 'sem pasta ou nome: nada é presumido');
        const agente = new sync.SyncAgent(() => ({ ligado: false, intervaloMin: 30 }), nb.c);
        assert(agente.start() === false, 'SyncAgent desligado não agenda nada');
    } finally {
        delete process.env.APRENDIZADO_DE_SKILLS;
        fs.rmSync(base, { recursive: true, force: true });
    }
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S476 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    if (failed > 0) process.exitCode = 1;
}

main().catch((e) => { console.error('S476 erro inesperado:', e); process.exitCode = 1; });
