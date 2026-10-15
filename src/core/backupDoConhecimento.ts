/**
 * Backup do conhecimento — ADR-020 (Sprint A).
 *
 * Um arquivo único (.zip) com tudo o que a instalação aprendeu: o banco (memória, preferências, skills aprendidas,
 * reflexões, casos), as skills em arquivo, o perfil medido dos juízes e, se a pessoa escolher, o histórico das conversas,
 * o workspace e o .env. Um `manifesto.json` descreve o conteúdo — sem nome de máquina nem de usuário.
 *
 * Funciona entre Windows, Linux e macOS: SQLite e .zip são portáteis. O que não é portátil é CONTEÚDO com caminho de
 * outro sistema (`C:\…`, `/home/…`): restaurado em outro sistema, a skill com esse caminho entra para REVISÃO
 * (`SKILL.md.revisar`, que o SkillLoader não carrega) — nunca reescrita por palpite (Nunca Adivinhar).
 *
 * Segurança: senhas e chaves (.env, cofre, pastas ocultas do workspace) ficam FORA por padrão; o pacote é lido só em
 * memória, com nomes validados (sem travessia de caminho) e teto de tamanho; o banco é validado (integrity_check) e a
 * versão do esquema conferida antes de qualquer escrita; antes de restaurar, o estado atual vira um pacote de segurança.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import JSZip from 'jszip';
import Database from 'better-sqlite3';
import { VERSAO_DO_ESQUEMA } from '../memory/memorySchema';
import { rebuildFtsIndex } from '../memory/graphRepository';

export const VERSAO_DO_FORMATO = 1;
/** Teto do pacote descompactado — protege contra "zip bomb". */
const TETO_DESCOMPACTADO = 2 * 1024 * 1024 * 1024;
const ARQ_MANIFESTO = 'manifesto.json';

export interface OpcoesDoPacote {
    /** Histórico das conversas (data/sessions). */
    historico?: boolean;
    /** Arquivos de trabalho (workspace/), sem as pastas ocultas — elas guardam credenciais (ex.: .hermes). */
    workspace?: boolean;
    /** .env (chaves de API e o cofre de senhas) e as pastas ocultas do workspace. Só com escolha explícita. */
    segredos?: boolean;
}

export interface Manifesto {
    formato: number;
    app: string;
    esquema: number;
    criadoEm: string;
    sistema: NodeJS.Platform;
    conteudo: { banco: boolean; skills: boolean; perfilDosJuizes: boolean; historico: boolean; workspace: boolean; segredos: boolean };
    contagens: { memorias: number; skills: number; conversas: number; arquivosDoWorkspace: number };
}

export interface Caminhos {
    raiz: string;
    dados: string;
    skills: string;
    workspace: string;
    env: string;
}

/** Caminhos da instalação (cwd = raiz do NewClaw, como no resto do app). */
export function caminhosDaInstalacao(raiz: string = process.cwd()): Caminhos {
    return {
        raiz,
        dados: path.join(raiz, 'data'),
        skills: path.resolve(raiz, process.env.SKILLS_DIR || './skills'),
        workspace: path.resolve(raiz, process.env.WORKSPACE_DIR || './workspace'),
        env: path.join(raiz, '.env'),
    };
}

function versaoDoApp(raiz: string): string {
    try { return String(JSON.parse(fs.readFileSync(path.join(raiz, 'package.json'), 'utf8')).version || '?'); } catch { return '?'; }
}

/** Arquivos de uma pasta (recursivo), em caminhos relativos com "/". `semOcultas`: pula pastas/arquivos que começam com ".". */
function listar(pasta: string, semOcultas: boolean): string[] {
    const out: string[] = [];
    if (!fs.existsSync(pasta)) return out;
    const andar = (dir: string, rel: string) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            if (semOcultas && e.name.startsWith('.')) continue;
            if (e.name === 'node_modules' || e.name === '__pycache__') continue;
            const abs = path.join(dir, e.name);
            const r = rel ? `${rel}/${e.name}` : e.name;
            if (e.isDirectory()) andar(abs, r);
            else if (e.isFile()) out.push(r);
        }
    };
    andar(pasta, '');
    return out;
}

/** Cópia consistente do banco (Online Backup API — correta mesmo em WAL e com escrita concorrente). */
async function copiaDoBanco(arquivoDoBanco: string): Promise<Buffer | null> {
    if (!fs.existsSync(arquivoDoBanco)) return null;
    const tmp = path.join(os.tmpdir(), `nc-backup-${process.pid}-${Date.now()}.db`);
    const db = new Database(arquivoDoBanco, { readonly: true });
    try { await db.backup(tmp); } finally { db.close(); }
    try { return fs.readFileSync(tmp); } finally { try { fs.unlinkSync(tmp); } catch { /* ok */ } }
}

/** Versão REAL do esquema do banco copiado (PRAGMA user_version) — não a do código que gera o pacote. */
function versaoDoEsquemaDe(arquivoDoBanco: string): number {
    try {
        const db = new Database(arquivoDoBanco, { readonly: true });
        try { return Number(db.pragma('user_version', { simple: true })) || 0; } finally { db.close(); }
    } catch { return 0; }
}

function contarMemorias(arquivoDoBanco: string): number {
    try {
        const db = new Database(arquivoDoBanco, { readonly: true });
        try { return (db.prepare('SELECT COUNT(*) n FROM memory_nodes').get() as { n: number }).n; } finally { db.close(); }
    } catch { return 0; }
}

/** Cria o pacote em `destinoDir`. Devolve o caminho e o manifesto. */
export async function criarPacote(destinoDir: string, opcoes: OpcoesDoPacote = {}, c: Caminhos = caminhosDaInstalacao(), prefixo = 'conhecimento'): Promise<{ arquivo: string; manifesto: Manifesto }> {
    const zip = new JSZip();
    const bancoArq = path.join(c.dados, 'newclaw.db');
    const banco = await copiaDoBanco(bancoArq);
    if (banco) zip.file('data/newclaw.db', banco);
    const perfil = path.join(c.dados, 'validation-judge-profile.json');
    if (fs.existsSync(perfil)) zip.file('data/validation-judge-profile.json', fs.readFileSync(perfil));

    const skills = listar(c.skills, false);
    for (const f of skills) zip.file(`skills/${f}`, fs.readFileSync(path.join(c.skills, f)));

    const sessoes = opcoes.historico ? listar(path.join(c.dados, 'sessions'), false) : [];
    for (const f of sessoes) zip.file(`data/sessions/${f}`, fs.readFileSync(path.join(c.dados, 'sessions', f)));

    const ws = opcoes.workspace ? listar(c.workspace, !opcoes.segredos) : [];
    for (const f of ws) zip.file(`workspace/${f}`, fs.readFileSync(path.join(c.workspace, f)));

    const comEnv = !!opcoes.segredos && fs.existsSync(c.env);
    if (comEnv) zip.file('.env', fs.readFileSync(c.env));

    const manifesto: Manifesto = {
        formato: VERSAO_DO_FORMATO,
        app: versaoDoApp(c.raiz),
        esquema: banco ? versaoDoEsquemaDe(bancoArq) : 0,
        criadoEm: new Date().toISOString(),
        sistema: process.platform,
        conteudo: { banco: !!banco, skills: skills.length > 0, perfilDosJuizes: fs.existsSync(perfil), historico: !!opcoes.historico, workspace: !!opcoes.workspace, segredos: comEnv },
        contagens: {
            memorias: banco ? contarMemorias(bancoArq) : 0,
            skills: new Set(skills.map(f => f.split('/')[0])).size,
            conversas: sessoes.length,
            arquivosDoWorkspace: ws.length,
        },
    };
    zip.file(ARQ_MANIFESTO, JSON.stringify(manifesto, null, 2));

    fs.mkdirSync(destinoDir, { recursive: true });
    const carimbo = manifesto.criadoEm.replace(/[:.]/g, '-').slice(0, 19);
    const arquivo = path.join(destinoDir, `${prefixo}-${carimbo}.zip`);
    fs.writeFileSync(arquivo, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } }));
    return { arquivo, manifesto };
}

/** Nome de entrada do zip seguro: relativo, sem "..", sem unidade, sem barra inicial, dentro das pastas conhecidas. */
export function nomeSeguro(nome: string): boolean {
    const n = nome.replace(/\\/g, '/');
    if (!n || n.startsWith('/') || /^[A-Za-z]:/.test(n) || n.split('/').some(p => p === '..')) return false;
    return n === ARQ_MANIFESTO || n === '.env' || /^(data\/newclaw\.db|data\/validation-judge-profile\.json|data\/sessions\/.+|skills\/.+|workspace\/.+)$/.test(n);
}

export interface PacoteLido { manifesto: Manifesto; zip: JSZip; avisos: string[] }

/** Lê e valida um pacote sem escrever nada. Lança erro com mensagem para o usuário se não puder ser usado. */
export async function lerPacote(arquivo: string): Promise<PacoteLido> {
    const zip = await JSZip.loadAsync(fs.readFileSync(arquivo));
    let total = 0;
    for (const [nome, entrada] of Object.entries(zip.files)) {
        if (entrada.dir) continue;
        if (!nomeSeguro(nome)) throw new Error(`o arquivo contém um item fora do formato esperado ("${nome.slice(0, 80)}") — restauração cancelada`);
        total += ((entrada as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize) ?? 0;
    }
    if (total > TETO_DESCOMPACTADO) throw new Error('o pacote é grande demais para ser restaurado com segurança');
    const m = zip.file(ARQ_MANIFESTO);
    if (!m) throw new Error('não é um backup do NewClaw (falta o manifesto)');
    const manifesto = JSON.parse(await m.async('string')) as Manifesto;
    if (typeof manifesto.formato !== 'number' || manifesto.formato > VERSAO_DO_FORMATO) {
        throw new Error('este backup foi feito por uma versão mais nova do NewClaw — atualize antes de restaurar');
    }
    if ((manifesto.esquema ?? 0) > VERSAO_DO_ESQUEMA) {
        throw new Error('o banco deste backup é de uma versão mais nova do NewClaw — atualize antes de restaurar');
    }
    const avisos: string[] = [];
    if (manifesto.sistema !== process.platform) {
        avisos.push(`o backup veio de outro sistema (${manifesto.sistema}); skills com caminhos daquele sistema entram para revisão`);
    }
    if (manifesto.conteudo?.segredos) avisos.push('o backup contém senhas e chaves (.env)');
    return { manifesto, zip, avisos };
}

/** O texto tem caminho absoluto típico do sistema `origem` (e o destino é outro)? */
export function temCaminhoDeOutroSistema(texto: string, origem: string, destino: string = process.platform): boolean {
    if (origem === destino) return false;
    if (origem === 'win32') return /(^|[\s"'`(=])[A-Za-z]:[\\/]/.test(texto);
    if (origem === 'darwin') return /(^|[\s"'`(=])\/Users\//.test(texto);
    return /(^|[\s"'`(=])\/home\//.test(texto);   // linux e afins
}

export interface RelatorioDeRestauracao {
    banco: boolean;
    skills: number;
    skillsParaRevisar: string[];
    conversas: number;
    arquivosDoWorkspace: number;
    env: boolean;
    pacoteDeSeguranca: string;
}

/**
 * Restaura um pacote. O banco NÃO é trocado com o NewClaw aberto: fica em `data/newclaw.db.restore` + `.restore-pending`,
 * aplicado no próximo boot (mesmo mecanismo do restore de banco já existente). Skills, perfil, histórico e workspace são
 * escritos na hora (sobrescrevem os de mesmo nome; não apagam o que só existe aqui). O .env só com `restaurarSegredos`.
 */
export async function restaurarPacote(arquivo: string, opcoes: { restaurarSegredos?: boolean } = {}, c: Caminhos = caminhosDaInstalacao(), pastaDeSeguranca?: string): Promise<RelatorioDeRestauracao> {
    const { manifesto, zip } = await lerPacote(arquivo);

    // 1. Valida o banco ANTES de mexer em qualquer coisa.
    const bancoNoPacote = zip.file('data/newclaw.db');
    let bancoTmp = '';
    if (bancoNoPacote) {
        bancoTmp = path.join(os.tmpdir(), `nc-restore-${process.pid}-${Date.now()}.db`);
        fs.writeFileSync(bancoTmp, await bancoNoPacote.async('nodebuffer'));
        const db = new Database(bancoTmp, { readonly: true });
        try {
            const ok = (db.prepare('PRAGMA integrity_check').get() as { integrity_check?: string } | undefined)?.integrity_check;
            if (ok !== 'ok') throw new Error('o banco do backup está corrompido — restauração cancelada');
            const versao = Number(db.pragma('user_version', { simple: true })) || 0;
            if (versao > VERSAO_DO_ESQUEMA) throw new Error('o banco deste backup é de uma versão mais nova do NewClaw — atualize antes de restaurar');
        } finally { db.close(); }
    }

    // 2. Estado atual vira pacote de segurança (com segredos: é local e serve para desfazer tudo).
    const seguranca = await criarPacote(pastaDeSeguranca ?? path.join(c.dados, 'backups'), { historico: true, segredos: true }, c, 'pre-restauracao');

    // 3. Banco: agendado para o próximo boot.
    if (bancoTmp) {
        fs.mkdirSync(c.dados, { recursive: true });
        fs.copyFileSync(bancoTmp, path.join(c.dados, 'newclaw.db.restore'));
        fs.writeFileSync(path.join(c.dados, '.restore-pending'), JSON.stringify({ source: 'newclaw.db.restore', timestamp: new Date().toISOString(), origem: 'conhecimento' }));
        try { fs.unlinkSync(bancoTmp); } catch { /* ok */ }
    }

    // 4. Demais arquivos.
    const relatorio: RelatorioDeRestauracao = { banco: !!bancoTmp, skills: 0, skillsParaRevisar: [], conversas: 0, arquivosDoWorkspace: 0, env: false, pacoteDeSeguranca: seguranca.arquivo };
    const skillsRestauradas = new Set<string>();
    for (const [nome, entrada] of Object.entries(zip.files)) {
        if (entrada.dir || nome === ARQ_MANIFESTO || nome === 'data/newclaw.db') continue;
        const conteudo = await entrada.async('nodebuffer');
        let destino: string | null = null;
        if (nome === 'data/validation-judge-profile.json') destino = path.join(c.dados, 'validation-judge-profile.json');
        else if (nome.startsWith('data/sessions/')) { destino = path.join(c.dados, 'sessions', nome.slice('data/sessions/'.length)); relatorio.conversas++; }
        else if (nome.startsWith('workspace/')) { destino = path.join(c.workspace, nome.slice('workspace/'.length)); relatorio.arquivosDoWorkspace++; }
        else if (nome === '.env') { if (!opcoes.restaurarSegredos) continue; destino = c.env; relatorio.env = true; }
        else if (nome.startsWith('skills/')) {
            const rel = nome.slice('skills/'.length);
            destino = path.join(c.skills, rel);
            const pasta = rel.split('/')[0];
            skillsRestauradas.add(pasta);
            if (rel.endsWith('/SKILL.md') && temCaminhoDeOutroSistema(conteudo.toString('utf8'), manifesto.sistema)) {
                destino += '.revisar';   // o SkillLoader só lê SKILL.md — fica inativa até alguém revisar
                relatorio.skillsParaRevisar.push(pasta);
            }
        }
        if (!destino) continue;
        // Defesa extra: o destino resolvido precisa ficar dentro da instalação.
        const resolvido = path.resolve(destino);
        if (!resolvido.startsWith(path.resolve(c.raiz)) && !resolvido.startsWith(c.skills) && !resolvido.startsWith(c.workspace)) continue;
        fs.mkdirSync(path.dirname(resolvido), { recursive: true });
        fs.writeFileSync(resolvido, conteudo);
    }
    relatorio.skills = skillsRestauradas.size;
    return relatorio;
}

// ── Sprint B: importar mesclando (outra instalação) ─────────────────────────────────────────────────────────────────────

/** Nós estruturais: cada instalação tem os seus — nunca importados. */
const TIPOS_ESTRUTURAIS = new Set(['identity', 'domain', 'legacy_container']);
const ID_ESTRUTURAL = /^(core_|domain_|user_identity|time_)/;

export interface RelatorioDeImportacao {
    memorias: { importadas: number; jaExistiam: number; preferenciasEmConflito: string[]; paraRevisar: number; estruturaisIgnoradas: number };
    arestas: number;
    skillsAprendidas: number;
    skills: { novas: number; iguais: number; comDiferenca: string[]; paraRevisar: string[] };
    conversas: number;
    arquivosDoWorkspace: number;
    pacoteDeSeguranca: string;
}

function colunas(db: Database.Database, tabela: string): string[] {
    try { return (db.prepare(`PRAGMA table_info("${tabela}")`).all() as Array<{ name: string }>).map(c => c.name); } catch { return []; }
}

/**
 * Importa o conhecimento de OUTRA instalação sem sobrescrever nem apagar nada local (ADR-020, Sprint B). `dbLocal`: a
 * conexão do próprio app quando chamado pelo painel (escreve no banco em uso, como qualquer operação do app); sem ela,
 * abre o arquivo do banco. O .env/cofre e o perfil dos juízes nunca entram — são desta instalação.
 */
export async function importarPacote(arquivo: string, c: Caminhos = caminhosDaInstalacao(), dbLocal?: Database.Database, pastaDeSeguranca?: string): Promise<RelatorioDeImportacao> {
    const { manifesto, zip } = await lerPacote(arquivo);
    const origem = manifesto.sistema;

    // Banco do pacote: arquivo temporário, validado antes de qualquer escrita local.
    const bancoNoPacote = zip.file('data/newclaw.db');
    let bancoTmp = '';
    if (bancoNoPacote) {
        bancoTmp = path.join(os.tmpdir(), `nc-import-${process.pid}-${Date.now()}.db`);
        fs.writeFileSync(bancoTmp, await bancoNoPacote.async('nodebuffer'));
        const chk = new Database(bancoTmp, { readonly: true });
        try {
            const ok = (chk.prepare('PRAGMA integrity_check').get() as { integrity_check?: string } | undefined)?.integrity_check;
            if (ok !== 'ok') throw new Error('o banco do backup está corrompido — importação cancelada');
        } finally { chk.close(); }
    }

    const seguranca = await criarPacote(pastaDeSeguranca ?? path.join(c.dados, 'backups'), { historico: true, segredos: true }, c, 'pre-importacao');
    const rel: RelatorioDeImportacao = {
        memorias: { importadas: 0, jaExistiam: 0, preferenciasEmConflito: [], paraRevisar: 0, estruturaisIgnoradas: 0 },
        arestas: 0, skillsAprendidas: 0,
        skills: { novas: 0, iguais: 0, comDiferenca: [], paraRevisar: [] },
        conversas: 0, arquivosDoWorkspace: 0, pacoteDeSeguranca: seguranca.arquivo,
    };

    // 1. Memória, arestas e skills aprendidas.
    if (bancoTmp) {
        const fonte = new Database(bancoTmp, { readonly: true });
        const local = dbLocal ?? new Database(path.join(c.dados, 'newclaw.db'));
        try {
            if (!dbLocal) local.pragma('busy_timeout = 5000');
            const nosFonte = colunas(fonte, 'memory_nodes');
            const colsNos = colunas(local, 'memory_nodes').filter(k => nosFonte.includes(k));
            const arestasFonte = colunas(fonte, 'memory_edges');
            const colsArestas = colunas(local, 'memory_edges').filter(k => arestasFonte.includes(k));
            const skillsFonte = colunas(fonte, 'auto_skills');
            const colsSkills = colunas(local, 'auto_skills').filter(k => skillsFonte.includes(k));
            const lista = (cs: string[]) => cs.map(k => `"${k}"`).join(',');
            const marcas = (cs: string[]) => cs.map(() => '?').join(',');
            const existeId = local.prepare('SELECT 1 FROM memory_nodes WHERE id = ?');
            const repete = local.prepare('SELECT 1 FROM memory_nodes WHERE name = ? AND content = ?');
            const prefLocal = local.prepare(`SELECT 1 FROM memory_nodes WHERE type = 'preference' AND name = ?`);
            const transacao = local.transaction(() => {
                if (colsNos.includes('id')) {
                    const inserir = local.prepare(`INSERT INTO memory_nodes (${lista(colsNos)}) VALUES (${marcas(colsNos)})`);
                    for (const no of fonte.prepare(`SELECT ${lista(colsNos)} FROM memory_nodes`).all() as Array<Record<string, unknown>>) {
                        const id = String(no.id ?? '');
                        const tipo = String(no.type ?? '');
                        if (TIPOS_ESTRUTURAIS.has(tipo) || ID_ESTRUTURAL.test(id)) { rel.memorias.estruturaisIgnoradas++; continue; }
                        if (existeId.get(id) || repete.get(no.name, no.content)) { rel.memorias.jaExistiam++; continue; }
                        if (tipo === 'preference' && prefLocal.get(no.name)) { rel.memorias.preferenciasEmConflito.push(String(no.name)); continue; }
                        if (colsNos.includes('lifecycle_state') && temCaminhoDeOutroSistema(String(no.content ?? ''), origem)) {
                            no.lifecycle_state = 'REVISAR';   // guardada, mas fora das buscas até ser revisada
                            rel.memorias.paraRevisar++;
                        }
                        inserir.run(...colsNos.map(k => no[k]));
                        rel.memorias.importadas++;
                    }
                }
                if (colsArestas.includes('from_node') && colsArestas.includes('to_node')) {
                    const inserirAresta = local.prepare(`INSERT OR IGNORE INTO memory_edges (${lista(colsArestas)}) VALUES (${marcas(colsArestas)})`);
                    for (const a of fonte.prepare(`SELECT ${lista(colsArestas)} FROM memory_edges`).all() as Array<Record<string, unknown>>) {
                        if (!existeId.get(a.from_node) || !existeId.get(a.to_node)) continue;
                        rel.arestas += inserirAresta.run(...colsArestas.map(k => a[k])).changes;
                    }
                }
                if (colsSkills.includes('id')) {
                    const inserirSkill = local.prepare(`INSERT OR IGNORE INTO auto_skills (${lista(colsSkills)}) VALUES (${marcas(colsSkills)})`);
                    for (const s of fonte.prepare(`SELECT ${lista(colsSkills)} FROM auto_skills`).all() as Array<Record<string, unknown>>) {
                        rel.skillsAprendidas += inserirSkill.run(...colsSkills.map(k => s[k])).changes;
                    }
                }
            });
            transacao();
            if (rel.memorias.importadas > 0) rebuildFtsIndex(local);   // o FTS não tem gatilhos (memorySchema.ts)
        } finally {
            fonte.close();
            if (!dbLocal) local.close();
            try { fs.unlinkSync(bancoTmp); } catch { /* ok */ }
        }
    }

    // 2. Arquivos: skills, histórico e workspace — só o que falta; nada local é sobrescrito.
    const pastasDeSkill = new Map<string, { nova: boolean; igual: boolean; diferente: boolean; revisar: boolean }>();
    for (const [nome, entrada] of Object.entries(zip.files)) {
        if (entrada.dir) continue;
        if (nome.startsWith('skills/')) {
            const relativo = nome.slice('skills/'.length);
            const pasta = relativo.split('/')[0];
            const st = pastasDeSkill.get(pasta) ?? { nova: false, igual: false, diferente: false, revisar: false };
            const conteudo = await entrada.async('nodebuffer');
            let destino = path.join(c.skills, relativo);
            if (fs.existsSync(destino)) {
                if (fs.readFileSync(destino).equals(conteudo)) { st.igual = true; pastasDeSkill.set(pasta, st); continue; }
                destino += '.importada';   // a local fica; a importada ao lado, para comparar
                st.diferente = true;
            } else {
                st.nova = true;
                if (relativo.endsWith('/SKILL.md') && temCaminhoDeOutroSistema(conteudo.toString('utf8'), origem)) { destino += '.revisar'; st.revisar = true; }
            }
            fs.mkdirSync(path.dirname(destino), { recursive: true });
            fs.writeFileSync(destino, conteudo);
            pastasDeSkill.set(pasta, st);
        } else if (nome.startsWith('data/sessions/') || nome.startsWith('workspace/')) {
            const destino = nome.startsWith('workspace/')
                ? path.join(c.workspace, nome.slice('workspace/'.length))
                : path.join(c.dados, 'sessions', nome.slice('data/sessions/'.length));
            if (fs.existsSync(destino)) continue;
            fs.mkdirSync(path.dirname(destino), { recursive: true });
            fs.writeFileSync(destino, await entrada.async('nodebuffer'));
            if (nome.startsWith('workspace/')) rel.arquivosDoWorkspace++; else rel.conversas++;
        }
        // .env, perfil dos juízes e o banco (tratado acima): nunca copiados numa importação.
    }
    for (const [pasta, st] of pastasDeSkill) {
        if (st.revisar) rel.skills.paraRevisar.push(pasta);
        else if (st.diferente) rel.skills.comDiferenca.push(pasta);
        else if (st.nova) rel.skills.novas++;
        else if (st.igual) rel.skills.iguais++;
    }
    return rel;
}
