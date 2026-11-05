/**
 * NewClaw Sync Agent — ADR-034 (V1, aceita em 04/11/2026).
 *
 * O conhecimento entre instalações (PC, notebook, VPS) por uma pasta que um programa da pessoa replica (Syncthing, na
 * decisão D3). O NewClaw não sabe qual é o programa: só publica o próprio pacote numa subpasta e importa os das outras.
 *
 * Reaproveita a ADR-020 inteira: o pacote é o de `criarPacote` (com o banco reduzido às tabelas compartilháveis) e a
 * importação é a de `importarPacote` (mesclando, sem sobrescrever nada local), com a regra de skills da ADR-017.
 *
 * Desligado por padrão. Ligar exige `SYNC_LIGADO=true` e `SYNC_PASTA` — configuração da pessoa, nunca presumida.
 *
 * Estado desta instalação (em `data/`, nunca na pasta compartilhada): `sync-instalacao.json` (o UUID, gerado uma vez),
 * `sync-estado.json` (último número publicado, assinatura do que foi publicado, cursores do que já foi importado) e
 * `sync-relatorio.json` (a última rodada, para a tela). A trava `sync.lock` impede duas importações ao mesmo tempo.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import Database from 'better-sqlite3';
import { criarPacote, importarPacote, lerPacote, caminhosDaInstalacao, comTravaDeSync, SincronizacaoEmAndamento, type Caminhos, type RelatorioDeImportacao } from './backupDoConhecimento';
export { comTravaDeSync, SincronizacaoEmAndamento } from './backupDoConhecimento';
import { modoDeAprendizado } from '../loop/aprendizadoDeSkills';
import { createLogger } from '../shared/AppLogger';
import { errorMessage } from '../shared/errors';

const log = createLogger('SyncAgent');

export const FORMATO_DO_MANIFESTO = 1;
/** Pacotes próprios sempre mantidos, além da regra dos cursores (ADR-034 §3). */
export const PACOTES_SEMPRE_MANTIDOS = 5;
/** Pacotes de segurança das importações automáticas mantidos em `data/backups` (ADR-034 §5). */
export const SEGURANCAS_MANTIDAS = 10;
const PREFIXO_DA_SEGURANCA = 'pre-sync';
/** Tabelas que saem desta instalação. Todo o resto do banco (conversas, vetores, traços…) fica aqui. */
const TABELAS_COMPARTILHADAS = ['memory_nodes', 'memory_edges', 'auto_skills'] as const;

// ── Configuração ────────────────────────────────────────────────────────────────────────────────────────────────────

export interface ConfiguracaoDoSync {
    ligado: boolean;
    pasta?: string;
    nome?: string;
    intervaloMin: number;
}

export function configuracaoDoSync(env: NodeJS.ProcessEnv = process.env): ConfiguracaoDoSync {
    const intervalo = Number(env.SYNC_INTERVALO_MIN);
    return {
        ligado: String(env.SYNC_LIGADO ?? '').toLowerCase() === 'true',
        pasta: env.SYNC_PASTA?.trim() || undefined,
        nome: env.SYNC_NOME?.trim() || undefined,
        intervaloMin: Number.isFinite(intervalo) && intervalo >= 1 ? intervalo : 30,
    };
}

/** Nome da subpasta: o nome escolhido (só [a-z0-9-]) e os 8 primeiros caracteres do UUID. */
export function nomeDaSubpasta(nome: string, id: string): string {
    const base = nome.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'instalacao';
    return `${base}-${id.replace(/-/g, '').slice(0, 8)}`;
}

/** O UUID desta instalação, gerado uma vez e guardado em `data/`. Não usa nome de máquina nem de usuário. */
export function idDaInstalacao(c: Caminhos): string {
    const arq = path.join(c.dados, 'sync-instalacao.json');
    try {
        const id = JSON.parse(fs.readFileSync(arq, 'utf8')).id;
        if (typeof id === 'string' && /^[0-9a-f-]{36}$/.test(id)) return id;
    } catch { /* primeira vez */ }
    const id = crypto.randomUUID();
    fs.mkdirSync(c.dados, { recursive: true });
    fs.writeFileSync(arq, JSON.stringify({ id, criadoEm: new Date().toISOString() }, null, 2));
    return id;
}

// ── Manifesto e estado ───────────────────────────────────────────────────────────────────────────────────────────────

export interface PacotePublicado {
    numero: number;
    arquivo: string;
    criadoEm: string;
    tamanho: number;
    sha256: string;
    contagens: { memorias: number; skills: number };
}

export interface ManifestoDaInstalacao {
    formato: number;
    id: string;
    nome: string;
    sistema: NodeJS.Platform;
    app: string;
    esquema: number;
    atualizadoEm: string;
    pacotes: PacotePublicado[];
    /** Cursores: o último pacote que ESTA instalação importou de cada uma das outras (id → número). */
    importados: Record<string, number>;
}

interface EstadoLocal {
    ultimoNumero: number;
    assinatura?: string;
    importados: Record<string, number>;
}

function lerJson<T>(arq: string): T | undefined {
    try { return JSON.parse(fs.readFileSync(arq, 'utf8')) as T; } catch { return undefined; }
}

/** Escrita que nunca deixa o arquivo pela metade: temporário e renomeação. */
function escreverAtomico(arq: string, conteudo: string): void {
    const tmp = `${arq}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, conteudo);
    fs.renameSync(tmp, arq);
}

function lerEstado(c: Caminhos): EstadoLocal {
    const e = lerJson<EstadoLocal>(path.join(c.dados, 'sync-estado.json'));
    return { ultimoNumero: Number(e?.ultimoNumero) || 0, assinatura: e?.assinatura, importados: { ...(e?.importados ?? {}) } };
}

function gravarEstado(c: Caminhos, e: EstadoLocal): void {
    fs.mkdirSync(c.dados, { recursive: true });
    escreverAtomico(path.join(c.dados, 'sync-estado.json'), JSON.stringify(e, null, 2));
}

export function lerManifesto(subpasta: string): ManifestoDaInstalacao | undefined {
    const m = lerJson<ManifestoDaInstalacao>(path.join(subpasta, 'manifest.json'));
    if (!m || typeof m.id !== 'string' || !Array.isArray(m.pacotes) || typeof m.importados !== 'object') return undefined;
    return m;
}

function sha256DoArquivo(arq: string): string {
    return crypto.createHash('sha256').update(fs.readFileSync(arq)).digest('hex');
}

const numeroComZeros = (n: number) => String(n).padStart(6, '0');

// ── O que é compartilhável ───────────────────────────────────────────────────────────────────────────────────────────

/** Colunas que dizem O QUE a memória/skill é — não quando foi lida (last_accessed mudaria a cada leitura). */
const COLUNAS_DA_ASSINATURA: Record<string, string[]> = {
    memory_nodes: ['id', 'type', 'name', 'content', 'lifecycle_state', 'epistemic_status', 'identity_scope', 'domain'],
    memory_edges: ['from_node', 'to_node', 'relation'],
    auto_skills: ['id', 'name', 'trigger', 'description', 'prompt', 'status'],
};

function colunasDe(db: Database.Database, tabela: string): string[] {
    try { return (db.prepare(`PRAGMA table_info("${tabela}")`).all() as Array<{ name: string }>).map(c => c.name); } catch { return []; }
}

function arquivosDe(pasta: string, rel = ''): string[] {
    if (!fs.existsSync(pasta)) return [];
    const out: string[] = [];
    for (const e of fs.readdirSync(pasta, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === '__pycache__') continue;
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) out.push(...arquivosDe(path.join(pasta, e.name), r));
        else if (e.isFile()) out.push(r);
    }
    return out.sort();
}

/**
 * Resumo do conhecimento compartilhável: memórias (sem as "só desta máquina"), arestas, skills aprendidas e os arquivos de
 * skills. Muda só quando o conhecimento muda — é o que decide se há pacote novo (ADR-034 §4).
 */
export function assinaturaDoCompartilhavel(c: Caminhos): string {
    const h = crypto.createHash('sha256');
    const arqDb = path.join(c.dados, 'newclaw.db');
    if (fs.existsSync(arqDb)) {
        const db = new Database(arqDb, { readonly: true });
        try {
            for (const tabela of TABELAS_COMPARTILHADAS) {
                const existentes = colunasDe(db, tabela);
                const cols = COLUNAS_DA_ASSINATURA[tabela].filter(k => existentes.includes(k));
                if (cols.length === 0) continue;
                const onde = tabela === 'memory_nodes' && existentes.includes('so_desta_maquina') ? ' WHERE COALESCE(so_desta_maquina, 0) = 0' : '';
                const lista = cols.map(k => `"${k}"`).join(',');
                h.update(`#${tabela}\n`);
                for (const linha of db.prepare(`SELECT ${lista} FROM "${tabela}"${onde} ORDER BY ${lista}`).raw().all()) h.update(JSON.stringify(linha) + '\n');
            }
        } finally { db.close(); }
    }
    h.update('#skills\n');
    for (const f of arquivosDe(c.skills)) h.update(`${f}:${sha256DoArquivo(path.join(c.skills, f))}\n`);
    return h.digest('hex');
}

/**
 * Do banco copiado, um banco novo só com as tabelas compartilháveis — sem conversas, vetores, traços nem as memórias "só
 * desta máquina" (e as arestas delas). Construído do zero, e não apagando do original: tabelas virtuais (FTS, vetores) não
 * podem ser apagadas sem o módulo carregado, e páginas livres guardariam o conteúdo apagado.
 */
export function bancoSoCompartilhavel(copia: string): string {
    const destino = copia.replace(/\.db$/, '') + '-compartilhavel.db';
    try { fs.unlinkSync(destino); } catch { /* ok */ }
    const fonte = new Database(copia, { readonly: true });
    const novo = new Database(destino);
    try {
        novo.pragma(`user_version = ${Number(fonte.pragma('user_version', { simple: true })) || 0}`);
        for (const tabela of TABELAS_COMPARTILHADAS) {
            const ddl = (fonte.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`).get(tabela) as { sql?: string } | undefined)?.sql;
            if (!ddl) continue;
            novo.exec(ddl);
            const cols = colunasDe(fonte, tabela);
            let onde = '';
            if (tabela === 'memory_nodes' && cols.includes('so_desta_maquina')) onde = ' WHERE COALESCE(so_desta_maquina, 0) = 0';
            if (tabela === 'memory_edges' && colunasDe(fonte, 'memory_nodes').includes('so_desta_maquina')) {
                onde = ` WHERE from_node NOT IN (SELECT id FROM memory_nodes WHERE so_desta_maquina = 1) AND to_node NOT IN (SELECT id FROM memory_nodes WHERE so_desta_maquina = 1)`;
            }
            const lista = cols.map(k => `"${k}"`).join(',');
            const inserir = novo.prepare(`INSERT INTO "${tabela}" (${lista}) VALUES (${cols.map(() => '?').join(',')})`);
            novo.transaction(() => {
                for (const linha of fonte.prepare(`SELECT ${lista} FROM "${tabela}"${onde}`).raw().all()) inserir.run(...(linha as unknown[]));
            })();
        }
    } finally { fonte.close(); novo.close(); }
    return destino;
}

// ── Publicar ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface ResultadoDaPublicacao {
    publicado: boolean;
    numero?: number;
    motivo?: string;
    apagados: string[];
}

function versaoDoApp(c: Caminhos): string {
    try { return String(JSON.parse(fs.readFileSync(path.join(c.raiz, 'package.json'), 'utf8')).version || '?'); } catch { return '?'; }
}

/** Subpastas de outras instalações na pasta compartilhada (as que têm `manifest.json` legível). */
function outrasInstalacoes(pasta: string, minha: string): Array<{ dir: string; manifesto?: ManifestoDaInstalacao; erro?: string }> {
    const out: Array<{ dir: string; manifesto?: ManifestoDaInstalacao; erro?: string }> = [];
    for (const e of fs.readdirSync(pasta, { withFileTypes: true })) {
        if (!e.isDirectory() || e.name === minha || e.name.startsWith('.')) continue;
        const dir = path.join(pasta, e.name);
        if (!fs.existsSync(path.join(dir, 'manifest.json'))) continue;
        const manifesto = lerManifesto(dir);
        out.push(manifesto ? { dir, manifesto } : { dir, erro: 'manifest.json ilegível' });
    }
    return out;
}

/**
 * Retenção (ADR-034 §3): apaga só os pacotes próprios que TODAS as instalações conhecidas já passaram (número menor que o
 * menor cursor delas sobre esta), mantendo sempre os 5 mais novos. Instalação sem cursor sobre esta conta como "não
 * recebeu": na dúvida, o pacote fica.
 */
function aplicarRetencao(dir: string, pasta: string, minha: string, idMeu: string, manifesto: ManifestoDaInstalacao): string[] {
    const outras = outrasInstalacoes(pasta, minha).filter(o => o.manifesto);
    const menorCursor = outras.length === 0 ? Infinity : Math.min(...outras.map(o => Number(o.manifesto!.importados?.[idMeu]) || 0));
    const ordenados = [...manifesto.pacotes].sort((a, b) => b.numero - a.numero);
    const manter = new Set(ordenados.slice(0, PACOTES_SEMPRE_MANTIDOS).map(p => p.numero));
    const apagar = ordenados.filter(p => !manter.has(p.numero) && p.numero < menorCursor);
    if (apagar.length === 0) return [];
    manifesto.pacotes = manifesto.pacotes.filter(p => !apagar.some(a => a.numero === p.numero));
    escreverAtomico(path.join(dir, 'manifest.json'), JSON.stringify(manifesto, null, 2));
    for (const p of apagar) { try { fs.unlinkSync(path.join(dir, p.arquivo)); } catch { /* já não existia */ } }
    return apagar.map(p => p.arquivo);
}

/**
 * Publica um pacote novo, se o conhecimento compartilhável mudou desde o último. Ordem (ADR-034 §4): o pacote é escrito como
 * `.NNNNNN.zip.parcial`; fechado, calcula SHA-256 e tamanho; renomeia para `NNNNNN.zip`; só então o manifesto o anuncia
 * (temporário e renomeação). O manifesto nunca aponta para um arquivo inacabado.
 */
export async function publicar(cfg: ConfiguracaoDoSync, c: Caminhos = caminhosDaInstalacao()): Promise<ResultadoDaPublicacao> {
    if (!cfg.pasta || !cfg.nome) return { publicado: false, motivo: 'pasta ou nome desta instalação não configurados', apagados: [] };
    const id = idDaInstalacao(c);
    const minha = nomeDaSubpasta(cfg.nome, id);
    const dir = path.join(cfg.pasta, minha);
    fs.mkdirSync(dir, { recursive: true });
    const estado = lerEstado(c);
    const manifesto: ManifestoDaInstalacao = lerManifesto(dir) ?? {
        formato: FORMATO_DO_MANIFESTO, id, nome: cfg.nome, sistema: process.platform, app: versaoDoApp(c), esquema: 0,
        atualizadoEm: new Date().toISOString(), pacotes: [], importados: {},
    };
    manifesto.importados = { ...estado.importados };
    const assinatura = assinaturaDoCompartilhavel(c);
    if (assinatura === estado.assinatura && manifesto.pacotes.length > 0) {
        const apagados = aplicarRetencao(dir, cfg.pasta, minha, id, manifesto);
        return { publicado: false, motivo: 'sem mudança desde o último pacote', apagados };
    }
    const numero = Math.max(estado.ultimoNumero, ...manifesto.pacotes.map(p => p.numero), 0) + 1;
    const parcial = `.${numeroComZeros(numero)}.zip.parcial`;
    const final = `${numeroComZeros(numero)}.zip`;
    const { manifesto: interno } = await criarPacote(dir, { filtrarBanco: bancoSoCompartilhavel, nomeDoArquivo: parcial, sincronizacao: { id, numero } }, c, 'sync');
    const caminhoParcial = path.join(dir, parcial);
    const tamanho = fs.statSync(caminhoParcial).size;
    const sha256 = sha256DoArquivo(caminhoParcial);
    fs.renameSync(caminhoParcial, path.join(dir, final));
    manifesto.pacotes.push({ numero, arquivo: final, criadoEm: interno.criadoEm, tamanho, sha256, contagens: { memorias: interno.contagens.memorias, skills: interno.contagens.skills } });
    Object.assign(manifesto, { nome: cfg.nome, sistema: process.platform, app: versaoDoApp(c), esquema: interno.esquema, atualizadoEm: new Date().toISOString() });
    escreverAtomico(path.join(dir, 'manifest.json'), JSON.stringify(manifesto, null, 2));
    gravarEstado(c, { ...estado, ultimoNumero: numero, assinatura });
    const apagados = aplicarRetencao(dir, cfg.pasta, minha, id, manifesto);
    log.info(`[SYNC] publicado ${minha}/${final} (${tamanho} bytes, memorias=${interno.contagens.memorias}, skills=${interno.contagens.skills})${apagados.length ? ` — retenção apagou ${apagados.join(', ')}` : ''}`);
    return { publicado: true, numero, apagados };
}

// ── Importar ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface RelatoDaInstalacao {
    subpasta: string;
    id?: string;
    nome?: string;
    sistema?: string;
    ultimoPacote?: number;
    importadoAte?: number;
    /** O pacote ainda não chegou inteiro (manifesto antes do zip, zip pela metade): fica para a próxima rodada. */
    pendente?: string;
    erros: string[];
    entrou?: RelatorioDeImportacao;
}

export interface RelatorioDaRodada {
    em: string;
    instalacao?: { id: string; nome?: string; subpasta?: string };
    publicacao?: ResultadoDaPublicacao;
    instalacoes: RelatoDaInstalacao[];
    /** A pasta não está disponível (desmontada, sem permissão): esta instalação segue funcionando, só a tela avisa. */
    erro?: string;
}

function podeEscrever(pasta: string): boolean {
    try {
        fs.accessSync(pasta, fs.constants.R_OK | fs.constants.W_OK);
        return fs.statSync(pasta).isDirectory();
    } catch { return false; }
}

/** Mantém só os últimos `SEGURANCAS_MANTIDAS` pacotes de segurança das importações automáticas. */
function retencaoDasSegurancas(c: Caminhos): void {
    const dir = path.join(c.dados, 'backups');
    if (!fs.existsSync(dir)) return;
    const meus = fs.readdirSync(dir).filter(f => f.startsWith(`${PREFIXO_DA_SEGURANCA}-`) && f.endsWith('.zip')).sort();
    for (const f of meus.slice(0, Math.max(0, meus.length - SEGURANCAS_MANTIDAS))) { try { fs.unlinkSync(path.join(dir, f)); } catch { /* ok */ } }
}

/**
 * Importa o pacote mais novo de cada outra instalação (ADR-034 §5): cada pacote é uma fotografia completa, então só o mais
 * novo interessa. Confere tamanho, SHA-256 e origem (id do manifesto = id da subpasta = id do manifesto interno, e o número).
 * Incompleto: adiado sem erro alto. Divergente: erro na tela, o pacote não entra. O cursor só avança no fim.
 */
async function importarDasOutras(cfg: ConfiguracaoDoSync, c: Caminhos, idMeu: string, minha: string, dbLocal?: Database.Database): Promise<RelatoDaInstalacao[]> {
    const estado = lerEstado(c);
    const relatos: RelatoDaInstalacao[] = [];
    for (const outra of outrasInstalacoes(cfg.pasta!, minha)) {
        const relato: RelatoDaInstalacao = { subpasta: path.basename(outra.dir), erros: [] };
        relatos.push(relato);
        if (!outra.manifesto) { relato.erros.push(outra.erro ?? 'manifest.json ilegível'); continue; }
        const m = outra.manifesto;
        Object.assign(relato, { id: m.id, nome: m.nome, sistema: m.sistema, importadoAte: estado.importados[m.id] ?? 0 });
        if (m.id === idMeu) { relato.erros.push('a subpasta traz o id desta instalação (cópia da pasta de outra máquina?)'); continue; }
        if (!relato.subpasta.endsWith(`-${m.id.replace(/-/g, '').slice(0, 8)}`)) { relato.erros.push('o id do manifest.json não bate com o nome da subpasta'); continue; }
        const maisNovo = [...m.pacotes].sort((a, b) => b.numero - a.numero)[0];
        if (!maisNovo) continue;
        relato.ultimoPacote = maisNovo.numero;
        if (maisNovo.numero <= (estado.importados[m.id] ?? 0)) continue;
        const arq = path.join(outra.dir, maisNovo.arquivo);
        if (path.dirname(path.resolve(arq)) !== path.resolve(outra.dir)) { relato.erros.push(`nome de pacote fora da subpasta: ${maisNovo.arquivo}`); continue; }
        if (!fs.existsSync(arq)) { relato.pendente = `${maisNovo.arquivo} ainda não chegou`; continue; }
        const tamanho = fs.statSync(arq).size;
        if (tamanho !== maisNovo.tamanho) { relato.pendente = `${maisNovo.arquivo} chegando (${tamanho} de ${maisNovo.tamanho} bytes)`; continue; }
        if (sha256DoArquivo(arq) !== maisNovo.sha256) { relato.erros.push(`${maisNovo.arquivo}: SHA-256 diferente do manifesto — pacote rejeitado`); continue; }
        try {
            const { manifesto: interno } = await lerPacote(arq);
            if (interno.sincronizacao?.id !== m.id || interno.sincronizacao?.numero !== maisNovo.numero) {
                relato.erros.push(`${maisNovo.arquivo}: a origem dentro do pacote não bate com o manifesto — pacote rejeitado`);
                continue;
            }
            relato.entrou = await importarPacote(arq, c, dbLocal, undefined, {
                origemInstalacao: m.nome, modo: modoDeAprendizado(), segurancaSoSeEntrar: true, prefixoDaSeguranca: PREFIXO_DA_SEGURANCA,
            });
            estado.importados[m.id] = maisNovo.numero;
            relato.importadoAte = maisNovo.numero;
            // O cursor só avança depois da importação inteira: uma falha no meio deixa a próxima rodada tentar de novo.
            gravarEstado(c, { ...lerEstado(c), importados: { ...estado.importados } });
        } catch (e) {
            relato.erros.push(`${maisNovo.arquivo}: ${errorMessage(e)}`);
        }
    }
    retencaoDasSegurancas(c);
    return relatos;
}

/** Atualiza só os cursores no manifesto desta instalação (sem pacote novo). */
function publicarCursores(cfg: ConfiguracaoDoSync, c: Caminhos, minha: string): void {
    const dir = path.join(cfg.pasta!, minha);
    const m = lerManifesto(dir);
    if (!m) return;
    m.importados = { ...lerEstado(c).importados };
    m.atualizadoEm = new Date().toISOString();
    escreverAtomico(path.join(dir, 'manifest.json'), JSON.stringify(m, null, 2));
}

/**
 * Uma rodada completa: publica (se mudou), importa as novidades das outras e publica os cursores. Sob a trava. Pasta
 * indisponível não derruba nada: vira `erro` no relatório.
 */
export async function rodarSincronizacao(cfg: ConfiguracaoDoSync = configuracaoDoSync(), c: Caminhos = caminhosDaInstalacao(), dbLocal?: Database.Database): Promise<RelatorioDaRodada> {
    const relatorio: RelatorioDaRodada = { em: new Date().toISOString(), instalacoes: [] };
    try {
        if (!cfg.pasta || !cfg.nome) { relatorio.erro = 'pasta ou nome desta instalação não configurados'; return relatorio; }
        const id = idDaInstalacao(c);
        const minha = nomeDaSubpasta(cfg.nome, id);
        relatorio.instalacao = { id, nome: cfg.nome, subpasta: minha };
        if (!podeEscrever(cfg.pasta)) { relatorio.erro = `pasta de sincronização indisponível ou sem permissão de escrita: ${cfg.pasta}`; return relatorio; }
        await comTravaDeSync(c, async () => {
            relatorio.publicacao = await publicar(cfg, c);
            relatorio.instalacoes = await importarDasOutras(cfg, c, id, minha, dbLocal);
            publicarCursores(cfg, c, minha);
        });
    } catch (e) {
        relatorio.erro = errorMessage(e);
    } finally {
        try { fs.mkdirSync(c.dados, { recursive: true }); escreverAtomico(path.join(c.dados, 'sync-relatorio.json'), JSON.stringify(relatorio, null, 2)); } catch { /* o relatório é só para a tela */ }
    }
    return relatorio;
}

export function ultimoRelatorio(c: Caminhos = caminhosDaInstalacao()): RelatorioDaRodada | undefined {
    return lerJson<RelatorioDaRodada>(path.join(c.dados, 'sync-relatorio.json'));
}

// ── Agendamento ──────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Roda a sincronização a cada `intervaloMin`, só com `SYNC_LIGADO=true`. `aoAtivarSkills` recebe as skills que entraram
 * ativas (o aviso "chegou do PC: X; /skill_desativar X desfaz" da ADR-034, no canal da pessoa).
 */
export class SyncAgent {
    private timer?: NodeJS.Timeout;
    private rodando = false;

    constructor(
        private readonly cfg: () => ConfiguracaoDoSync = () => configuracaoDoSync(),
        private readonly c: Caminhos = caminhosDaInstalacao(),
        private readonly dbLocal?: Database.Database,
        private readonly aoAtivarSkills?: (origem: string, skills: string[]) => void,
    ) {}

    start(): boolean {
        const cfg = this.cfg();
        if (!cfg.ligado) { log.info('[SYNC] desligado (SYNC_LIGADO não é true)'); return false; }
        if (!cfg.pasta || !cfg.nome) { log.warn('[SYNC] SYNC_LIGADO=true, mas falta SYNC_PASTA ou SYNC_NOME — nada é sincronizado'); return false; }
        this.stop();
        this.timer = setInterval(() => { void this.agora(); }, cfg.intervaloMin * 60_000);
        this.timer.unref?.();
        void this.agora();
        log.info(`[SYNC] ligado: pasta=${cfg.pasta} nome=${cfg.nome} a cada ${cfg.intervaloMin} min`);
        return true;
    }

    stop(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = undefined;
    }

    /** "Sincronizar agora" (painel). Uma rodada por vez neste processo; entre processos, a trava. */
    async agora(): Promise<RelatorioDaRodada> {
        if (this.rodando) return { em: new Date().toISOString(), instalacoes: [], erro: new SincronizacaoEmAndamento().message };
        this.rodando = true;
        try {
            const r = await rodarSincronizacao(this.cfg(), this.c, this.dbLocal);
            for (const i of r.instalacoes) {
                const ativadas = i.entrou?.skills.ativadas ?? [];
                if (ativadas.length && this.aoAtivarSkills) { try { this.aoAtivarSkills(i.nome ?? i.subpasta, ativadas); } catch { /* aviso não derruba a rodada */ } }
            }
            if (r.erro) log.warn(`[SYNC] rodada com erro: ${r.erro}`);
            return r;
        } finally { this.rodando = false; }
    }
}
