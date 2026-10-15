/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S400 (ADR-020, Sprint B)
 * Importar o conhecimento de OUTRA instalação mesclando: entra só o que falta; nada local é apagado nem trocado.
 *
 * ORIGEM: a mantenedora tem duas instalações (Windows e Linux) que aprenderam coisas diferentes e perguntou como levar a
 * "inteligência" de uma para a outra. Restaurar (Sprint A) SOBRESCREVE — copiar o banco do Linux para o Windows apagaria o
 * que o Windows aprendeu. Importar precisa mesclar.
 *
 * REGRESSÃO SE: um nó/skill/preferência local for sobrescrito ou apagado; um nó repetido (mesmo id, ou mesmo nome+conteúdo)
 * for duplicado; um nó estrutural (identidade, domínio) de outra instalação entrar; uma memória ou skill com caminho de
 * outro sistema entrar ATIVA; o .env/cofre ou o perfil dos juízes forem copiados; ou o que entrou não aparecer na busca.
 *
 * Execução: npx ts-node src/__tests__/regression/S400_ImportarMesclando.test.ts
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import JSZip from 'jszip';
import Database from 'better-sqlite3';
import * as bk from '../../core/backupDoConhecimento';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}

const OUTRO = process.platform === 'win32' ? 'linux' : 'win32';
const CAMINHO_DO_OUTRO = OUTRO === 'win32' ? 'C:/Users/alguem/bin/himalaya.exe' : '/home/alguem/bin/himalaya';

function banco(arquivo: string, nos: Array<[string, string, string, string]>, arestas: Array<[string, string, string]> = [], skillsAprendidas: string[] = []): void {
    const db = new Database(arquivo);
    db.exec(`CREATE TABLE memory_nodes (id TEXT PRIMARY KEY, type TEXT, name TEXT, content TEXT, lifecycle_state TEXT, confidence REAL);
             CREATE TABLE memory_edges (from_node TEXT NOT NULL, to_node TEXT NOT NULL, relation TEXT NOT NULL, weight REAL DEFAULT 1.0, PRIMARY KEY (from_node, to_node, relation));
             CREATE TABLE auto_skills (id TEXT PRIMARY KEY, name TEXT, trigger TEXT, description TEXT, prompt TEXT, status TEXT);
             CREATE VIRTUAL TABLE memory_nodes_fts USING fts5(name, content, type, content='memory_nodes');`);
    const ins = db.prepare('INSERT INTO memory_nodes (id, type, name, content) VALUES (?, ?, ?, ?)');
    for (const n of nos) ins.run(...n);
    const ia = db.prepare('INSERT INTO memory_edges (from_node, to_node, relation) VALUES (?, ?, ?)');
    for (const a of arestas) ia.run(...a);
    const is = db.prepare('INSERT INTO auto_skills (id, name, trigger, description, prompt, status) VALUES (?, ?, ?, ?, ?, ?)');
    for (const s of skillsAprendidas) is.run(s, s, 'gatilho', 'descrição', 'procedimento', 'active');
    db.exec(`INSERT INTO memory_nodes_fts(memory_nodes_fts) VALUES('rebuild')`);
    db.close();
}

function skill(c: bk.Caminhos, nome: string, texto: string): void {
    fs.mkdirSync(path.join(c.skills, nome), { recursive: true });
    fs.writeFileSync(path.join(c.skills, nome, 'SKILL.md'), texto);
}

function inst(raiz: string): bk.Caminhos {
    const c: bk.Caminhos = { raiz, dados: path.join(raiz, 'data'), skills: path.join(raiz, 'skills'), workspace: path.join(raiz, 'workspace'), env: path.join(raiz, '.env') };
    fs.mkdirSync(c.dados, { recursive: true });
    return c;
}

async function main(): Promise<void> {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-s400-'));
    try {
        // Instalação LOCAL (a que recebe).
        const local = inst(path.join(base, 'local'));
        banco(path.join(local.dados, 'newclaw.db'), [
            ['core_identity', 'identity', 'identidade', 'Sou o NewClaw desta máquina'],
            ['n-comum', 'fact', 'clima', 'Cidade padrão: Cornélio Procópio'],
            ['pref-local', 'preference', 'idioma_das_respostas', 'Responder em português'],
        ], [], ['skill_local']);
        skill(local, 'igual', 'Conteúdo idêntico');
        skill(local, 'diferente', 'Versão LOCAL da skill');
        fs.writeFileSync(path.join(local.dados, 'validation-judge-profile.json'), '{"local":true}');
        fs.writeFileSync(local.env, 'OPENROUTER_API_KEY=chave-local-sintetica\n');

        // Instalação de ORIGEM (o outro computador).
        const origem = inst(path.join(base, 'origem'));
        banco(path.join(origem.dados, 'newclaw.db'), [
            ['core_identity', 'identity', 'identidade', 'Sou o NewClaw da OUTRA máquina'],
            ['domain_x', 'domain', 'dominio', 'domínio estrutural'],
            ['n-comum', 'fact', 'clima', 'conteúdo diferente com o mesmo id'],
            ['n-duplicado', 'fact', 'clima', 'Cidade padrão: Cornélio Procópio'],
            ['n-novo', 'fact', 'river', 'A criptomoeda River caiu 6% na semana'],
            ['n-novo2', 'project', 'aulas', 'Aulas de Engenharia na UENP às terças'],
            ['pref-outra', 'preference', 'idioma_das_respostas', 'Responder em inglês'],
            ['n-caminho', 'infrastructure', 'himalaya', `Binário em ${CAMINHO_DO_OUTRO}`],
        ], [['n-novo', 'n-novo2', 'related_to'], ['n-novo', 'nao-existe', 'related_to']], ['skill_local', 'skill_da_origem']);
        skill(origem, 'igual', 'Conteúdo idêntico');
        skill(origem, 'diferente', 'Versão da OUTRA máquina');
        skill(origem, 'nova', 'Resuma em 3 tópicos.');
        skill(origem, 'com-caminho', `Use ${CAMINHO_DO_OUTRO} para ler o e-mail.`);
        fs.writeFileSync(path.join(origem.dados, 'validation-judge-profile.json'), '{"origem":true}');
        fs.writeFileSync(origem.env, 'OPENROUTER_API_KEY=chave-da-origem-sintetica\n');
        const { arquivo } = await bk.criarPacote(path.join(base, 'pacotes'), { segredos: true }, origem);
        // O pacote veio do OUTRO sistema operacional.
        const z = await JSZip.loadAsync(fs.readFileSync(arquivo));
        const m = JSON.parse(await z.file('manifesto.json')!.async('string'));
        z.file('manifesto.json', JSON.stringify({ ...m, sistema: OUTRO }));
        fs.writeFileSync(arquivo, await z.generateAsync({ type: 'nodebuffer' }));

        const rel = await bk.importarPacote(arquivo, local, undefined, path.join(base, 'seguranca'));
        const db = new Database(path.join(local.dados, 'newclaw.db'), { readonly: true });
        const no = (id: string) => db.prepare('SELECT * FROM memory_nodes WHERE id = ?').get(id) as Record<string, unknown> | undefined;

        console.log('\n=== S400-1 — nada local é trocado; nada repetido é duplicado ===');
        assert(no('core_identity')?.content === 'Sou o NewClaw desta máquina', 'a identidade local fica (nó estrutural da outra máquina não entra)');
        assert(!no('domain_x') && rel.memorias.estruturaisIgnoradas === 2, 'nós estruturais da outra máquina ficam de fora', rel.memorias);
        assert(no('n-comum')?.content === 'Cidade padrão: Cornélio Procópio', 'mesmo id: a versão local é mantida');
        assert(!no('n-duplicado'), 'mesmo nome+conteúdo com outro id: não duplica');
        assert(no('pref-local')?.content === 'Responder em português' && !no('pref-outra') && rel.memorias.preferenciasEmConflito.includes('idioma_das_respostas'),
            'preferência em conflito: a local vence e o conflito é relatado', rel.memorias.preferenciasEmConflito);

        console.log('\n=== S400-2 — o que falta entra (memória, arestas, skills aprendidas) ===');
        assert(!!no('n-novo') && !!no('n-novo2') && rel.memorias.importadas === 3, 'memórias novas entram', rel.memorias);
        const arestas = db.prepare('SELECT COUNT(*) n FROM memory_edges').get() as { n: number };
        assert(arestas.n === 1 && rel.arestas === 1, 'a aresta entre nós existentes entra; a que aponta para nó ausente não', { arestas: arestas.n, rel: rel.arestas });
        const skillsDb = (db.prepare('SELECT id FROM auto_skills ORDER BY id').all() as Array<{ id: string }>).map(r => r.id);
        assert(skillsDb.join(',') === 'skill_da_origem,skill_local' && rel.skillsAprendidas === 1, 'skills aprendidas ausentes entram, sem duplicar', skillsDb);

        console.log('\n=== S400-3 — conteúdo de outro sistema: guardado, mas para revisão ===');
        assert(no('n-caminho')?.lifecycle_state === 'REVISAR' && rel.memorias.paraRevisar === 1, 'memória com caminho de outro sistema entra com lifecycle_state=REVISAR (fora das buscas)', no('n-caminho'));
        assert(fs.existsSync(path.join(local.skills, 'com-caminho', 'SKILL.md.revisar')) && !fs.existsSync(path.join(local.skills, 'com-caminho', 'SKILL.md')) && rel.skills.paraRevisar.includes('com-caminho'),
            'skill nova com caminho de outro sistema fica inativa (SKILL.md.revisar)');

        console.log('\n=== S400-4 — skills em arquivo ===');
        assert(fs.readFileSync(path.join(local.skills, 'nova', 'SKILL.md'), 'utf8') === 'Resuma em 3 tópicos.' && rel.skills.novas === 1, 'skill nova entra ativa', rel.skills);
        assert(rel.skills.iguais === 1 && !fs.existsSync(path.join(local.skills, 'igual', 'SKILL.md.importada')), 'skill igual é ignorada');
        assert(fs.readFileSync(path.join(local.skills, 'diferente', 'SKILL.md'), 'utf8') === 'Versão LOCAL da skill'
            && fs.readFileSync(path.join(local.skills, 'diferente', 'SKILL.md.importada'), 'utf8') === 'Versão da OUTRA máquina'
            && rel.skills.comDiferenca.includes('diferente'), 'mesmo nome, conteúdo diferente: a local fica e a importada vai para .importada, para comparar');

        console.log('\n=== S400-5 — o que é desta instalação nunca é copiado ===');
        assert(fs.readFileSync(local.env, 'utf8').includes('chave-local-sintetica') && !fs.readFileSync(local.env, 'utf8').includes('origem'), 'o .env (chaves, cofre) local fica intacto — mesmo com segredos no pacote');
        assert(fs.readFileSync(path.join(local.dados, 'validation-judge-profile.json'), 'utf8') === '{"local":true}', 'o perfil dos juízes local fica (mede os modelos DESTA instalação)');
        assert(fs.existsSync(rel.pacoteDeSeguranca) && /pre-importacao-/.test(rel.pacoteDeSeguranca), 'antes de importar, o estado atual vira pacote de segurança');

        console.log('\n=== S400-6 — o que entrou é encontrado pela busca textual ===');
        const achou = db.prepare(`SELECT rowid FROM memory_nodes_fts WHERE memory_nodes_fts MATCH 'criptomoeda'`).all();
        assert(achou.length === 1, 'o índice FTS foi reconstruído (ele não tem gatilhos) e acha a memória importada', achou);
        db.close();

        console.log('\n=== S400-7 — painel e linha de comando ligados ===');
        const ler = (...p: string[]) => fs.readFileSync(path.join(process.cwd(), ...p), 'utf-8');
        assert(/\/backup\/conhecimento\/importar/.test(ler('src', 'dashboard', 'routes', 'maintenance.ts')), 'rota de importar');
        const tela = ler('src', 'dashboard', 'public', 'config', 'views', 'BackupView.js');
        assert(/data-import=/.test(tela) && tela.indexOf('inspectKnowledgeBackup(name)') < tela.indexOf('importKnowledgeBackup(name)'), 'a tela mostra o conteúdo antes de importar');
        assert(/async import\(args = \[\]\)/.test(ler('bin', 'newclaw')), 'newclaw import <a.zip>');
        const textos = ler('src', 'dashboard', 'public', 'shared.js');
        for (const k of ['bkp_conh_import_btn', 'bkp_conh_import_confirm', 'bkp_conh_imported_toast']) {
            assert((textos.match(new RegExp(`\\b${k}:`, 'g')) || []).length === 3, `texto "${k}" nas 3 línguas`);
        }
    } finally {
        try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* ok */ }
    }
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S400 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    process.exit(failed > 0 ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
