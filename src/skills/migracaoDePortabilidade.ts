/**
 * Migração das skills existentes para o cabeçalho de portabilidade — ADR-035 §6 (etapa 5).
 *
 * Uma vez, com relatório, e nunca sozinha: as migrações do `SkillLearner` rodam a cada início, esta só roda quando a
 * operadora pede (`newclaw skills-migrar`), primeiro numa CÓPIA (`--raiz`), e só aplica com `--aplicar`, depois de um
 * pacote de segurança (ADR-020). O relatório diz, por arquivo, o antes e o depois, e lista os caminhos literais que
 * sobraram, com um nome PROPOSTO para cada pasta — só as pastas que ela confirmar entram na tabela e viram `{PASTA:nome}`.
 *
 * O que muda, sem chute:
 * - aprendidas: `sistema_origem` sai da linha "Aprendida automaticamente … (win32)." do corpo, quando existe;
 *   `validada_em` = `sistema_origem@resumo` do corpo já migrado; `plataformas` e `requer` ficam vazios (desconhecidos);
 * - escritas à mão: só `formato_skill: 1`;
 * - caminhos da pasta do NewClaw, do workspace e das skills viram marcadores; pastas pessoais, só as confirmadas.
 */
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { marcarCaminhos, resumoDoCorpo, gravarTabelaDePastas, lerTabelaDePastas, NOME_DE_PASTA, type PastasDaInstalacao } from './SkillLoader';
import { pastaDaSkill } from '../shared/pastaDaSkill';
import { criarPacote, type Caminhos } from '../core/backupDoConhecimento';

export interface ItemDaMigracao {
    pasta: string;
    aprendida: boolean;
    mudou: boolean;
    /** Já tinha `formato_skill`: nada a fazer. */
    jaMigrada: boolean;
    sistemaOrigem?: string;
    camposNovos: string[];
    corpoMudou: boolean;
    antes: string;
    depois: string;
    caminhosLiterais: string[];
}

export interface PastaProposta { caminho: string; nomeProposto: string; skills: string[] }

export interface RelatorioDaMigracao {
    em: string;
    raiz: string;
    aplicado: boolean;
    pacoteDeSeguranca?: string;
    itens: ItemDaMigracao[];
    pastasPropostas: PastaProposta[];
    pastasConfirmadas: Record<string, string>;
}

// A letra da unidade não pode vir logo depois de outra letra: "https://" não é "s:/" (achado no plano real, 04/11/2026).
const CAMINHO_LITERAL = /(?:(?<![A-Za-z0-9])[A-Za-z]:[\\/]|(?<![\w.:/])\/(?:home|Users)\/)[^\s"'`<>|)\]…]*/g;
// O corpo das aprendidas grava o nome do sistema como texto ("(windows)" nas reais); o cabeçalho usa o nome do Node.
const LINHA_DA_ORIGEM = /^>\s*Aprendida automaticamente.*\((windows|win32|linux|macos|darwin)\)\.?\s*$/im;
const NOME_DO_NODE: Record<string, string> = { windows: 'win32', win32: 'win32', linux: 'linux', macos: 'darwin', darwin: 'darwin' };

/** Caminho com pelo menos uma pasta depois da raiz (`D:\` sozinho, de um texto cortado, não é pasta de ninguém). */
function caminhoUtil(caminho: string): boolean {
    return caminho.replace(/^[A-Za-z]:[\\/]|^\//, '').split(/[\\/]/).filter(Boolean).length >= 1;
}

/** Junta as pastas aninhadas na de cima: `D:\Aulas\2026` vai com `D:\Aulas` (o resto do caminho fica depois do marcador). */
function juntarAninhadas(porPasta: Map<string, Set<string>>): Map<string, Set<string>> {
    const chave = (p: string) => p.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
    const ordenadas = [...porPasta.keys()].sort((a, b) => chave(a).length - chave(b).length);
    const juntas = new Map<string, Set<string>>();
    for (const p of ordenadas) {
        const pai = [...juntas.keys()].find(q => chave(p) === chave(q) || chave(p).startsWith(chave(q) + '/'));
        const alvo = pai ?? p;
        if (!juntas.has(alvo)) juntas.set(alvo, new Set());
        for (const s of porPasta.get(p)!) juntas.get(alvo)!.add(s);
    }
    return juntas;
}

function separarCabecalho(texto: string): { cabecalho: string; corpo: string; eol: string } | undefined {
    const limpo = texto.replace(/^﻿/, '');
    const m = limpo.match(/^---(\r?\n)([\s\S]*?)\r?\n---\r?\n?/);
    if (!m) return undefined;
    return { cabecalho: m[2], corpo: limpo.slice(m[0].length), eol: m[1] };
}

/** A pasta (o diretório) de cada caminho literal, com um nome proposto (o último pedaço, em [a-z0-9-]). */
function pastaDoCaminho(caminho: string): string {
    const limpo = caminho.replace(/[\\/]+$/, '');
    const partes = limpo.split(/[\\/]/);
    const ultimo = partes[partes.length - 1];
    return /\.[A-Za-z0-9]{1,6}$/.test(ultimo) ? partes.slice(0, -1).join(limpo.includes('\\') ? '\\' : '/') : limpo;
}

function nomeProposto(caminho: string, usados: Set<string>): string {
    const ultimo = caminho.split(/[\\/]/).filter(Boolean).pop() ?? 'pasta';
    let base = ultimo.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'pasta';
    if (!/^[a-z0-9]/.test(base)) base = `p-${base}`;
    let nome = base;
    for (let n = 2; usados.has(nome); n++) nome = `${base}-${n}`;
    usados.add(nome);
    return nome;
}

/** `prefixos`: numa CÓPIA, os caminhos da instalação original — são eles que aparecem nos corpos e viram marcadores. */
function pastasDe(c: Caminhos, confirmadas: Record<string, string>, prefixos?: Partial<Caminhos>): PastasDaInstalacao {
    return { newclaw: prefixos?.raiz ?? c.raiz, workspace: prefixos?.workspace ?? c.workspace, skills: prefixos?.skills ?? c.skills, pastas: { ...lerTabelaDePastas(c.dados), ...confirmadas } };
}

/** O que a migração faria, sem escrever nada. */
export function planejarMigracao(c: Caminhos, pastasConfirmadas: Record<string, string> = {}, prefixos?: Partial<Caminhos>): RelatorioDaMigracao {
    const confirmadas = Object.fromEntries(Object.entries(pastasConfirmadas).filter(([k, v]) => NOME_DE_PASTA.test(k) && v));
    const pastas = pastasDe(c, confirmadas, prefixos);
    const aprendidasNoBanco = new Set<string>();
    const arqDb = path.join(c.dados, 'newclaw.db');
    if (fs.existsSync(arqDb)) {
        const db = new Database(arqDb, { readonly: true });
        try {
            for (const l of db.prepare('SELECT name, source_pattern FROM auto_skills').all() as Array<{ name: string; source_pattern: string | null }>) {
                aprendidasNoBanco.add(pastaDaSkill(l.source_pattern ?? l.name));
            }
        } catch { /* sem a tabela */ } finally { db.close(); }
    }
    const itens: ItemDaMigracao[] = [];
    const porPasta = new Map<string, Set<string>>();
    const dirs = fs.existsSync(c.skills) ? fs.readdirSync(c.skills, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort() : [];
    for (const pasta of dirs) {
        const arq = path.join(c.skills, pasta, 'SKILL.md');
        if (!fs.existsSync(arq)) continue;
        const antes = fs.readFileSync(arq, 'utf8');
        const partes = separarCabecalho(antes);
        const item: ItemDaMigracao = { pasta, aprendida: pasta.startsWith('aprendida_') || aprendidasNoBanco.has(pasta), mudou: false, jaMigrada: false,
            camposNovos: [], corpoMudou: false, antes, depois: antes, caminhosLiterais: [] };
        itens.push(item);
        if (!partes) continue;
        if (/^formato_skill\s*:/m.test(partes.cabecalho)) { item.jaMigrada = true; continue; }
        const corpo = marcarCaminhos(partes.corpo, pastas);
        item.corpoMudou = corpo !== partes.corpo;
        const campos: string[] = [];
        if (item.aprendida) {
            const lida = corpo.match(LINHA_DA_ORIGEM)?.[1]?.toLowerCase();
            const origem = lida ? NOME_DO_NODE[lida] : undefined;
            if (origem && !/^sistema_origem\s*:/m.test(partes.cabecalho)) {
                item.sistemaOrigem = origem;
                campos.push(`sistema_origem: ${origem}`);
                if (!/^validada_em\s*:/m.test(partes.cabecalho)) campos.push(`validada_em: ${origem}@${resumoDoCorpo(corpo)}`);
            }
        }
        campos.push('formato_skill: 1');
        item.camposNovos = campos;
        item.depois = `---${partes.eol}${partes.cabecalho}${partes.eol}${campos.join(partes.eol)}${partes.eol}---${partes.eol}${corpo}`;
        item.mudou = item.depois !== antes;
        item.caminhosLiterais = [...new Set((corpo.match(CAMINHO_LITERAL) ?? []).map(c => c.replace(/[.,;:]+$/, '')).filter(caminhoUtil))];
        for (const cam of item.caminhosLiterais) {
            const p = pastaDoCaminho(cam);
            if (!porPasta.has(p)) porPasta.set(p, new Set());
            porPasta.get(p)!.add(pasta);
        }
    }
    const usados = new Set(Object.keys(pastas.pastas));
    const pastasPropostas = [...juntarAninhadas(porPasta)].map(([caminho, skills]) => ({ caminho, nomeProposto: nomeProposto(caminho, usados), skills: [...skills].sort() }));
    return { em: new Date().toISOString(), raiz: c.raiz, aplicado: false, itens, pastasPropostas, pastasConfirmadas: confirmadas };
}

/**
 * Aplica o plano: pacote de segurança antes, arquivos reescritos, linhas de `auto_skills` atualizadas (corpo com marcadores,
 * `sistema_origem`, `validada_em`) para o SKILL.md regerado do banco manter o cabeçalho, e as pastas confirmadas na tabela.
 */
export async function aplicarMigracao(c: Caminhos, pastasConfirmadas: Record<string, string> = {}, prefixos?: Partial<Caminhos>): Promise<RelatorioDaMigracao> {
    const plano = planejarMigracao(c, pastasConfirmadas, prefixos);
    const seguranca = await criarPacote(path.join(c.dados, 'backups'), { segredos: false }, c, 'pre-migracao-skills');
    plano.pacoteDeSeguranca = seguranca.arquivo;
    const arqDb = path.join(c.dados, 'newclaw.db');
    const db = fs.existsSync(arqDb) ? new Database(arqDb) : undefined;
    try {
        const cols = db ? (db.prepare(`PRAGMA table_info(auto_skills)`).all() as Array<{ name: string }>).map(x => x.name) : [];
        for (const item of plano.itens.filter(i => i.mudou)) {
            fs.writeFileSync(path.join(c.skills, item.pasta, 'SKILL.md'), item.depois);
            if (!db || !cols.includes('sistema_origem')) continue;
            const corpo = separarCabecalho(item.depois)?.corpo.trim() ?? '';
            const linha = (db.prepare('SELECT id, name, source_pattern FROM auto_skills').all() as Array<{ id: string; name: string; source_pattern: string | null }>)
                .find(l => pastaDaSkill(l.source_pattern ?? l.name) === item.pasta);
            if (!linha) continue;
            const validada = item.camposNovos.find(f => f.startsWith('validada_em: '))?.slice('validada_em: '.length) ?? null;
            db.prepare('UPDATE auto_skills SET prompt = ?, sistema_origem = COALESCE(sistema_origem, ?), validada_em = COALESCE(validada_em, ?) WHERE id = ?')
                .run(corpo, item.sistemaOrigem ?? null, validada, linha.id);
        }
    } finally { db?.close(); }
    if (Object.keys(plano.pastasConfirmadas).length) gravarTabelaDePastas({ ...lerTabelaDePastas(c.dados), ...plano.pastasConfirmadas }, c.dados);
    plano.aplicado = true;
    return plano;
}

/** O relatório para a operadora revisar (Markdown). */
export function relatorioEmMarkdown(r: RelatorioDaMigracao): string {
    const mudam = r.itens.filter(i => i.mudou);
    const linhas: string[] = [
        `# Migração das skills — ADR-035 (${r.aplicado ? 'APLICADA' : 'só planejada, nada foi escrito'})`,
        '',
        `Data: ${r.em}. Pasta: \`${r.raiz}\`.${r.pacoteDeSeguranca ? ` Pacote de segurança: \`${r.pacoteDeSeguranca}\`.` : ''}`,
        '',
        `- Skills lidas: ${r.itens.length}; mudam: ${mudam.length}; já migradas: ${r.itens.filter(i => i.jaMigrada).length}.`,
        `- Aprendidas com o sistema de origem no corpo: ${r.itens.filter(i => i.sistemaOrigem).length}.`,
        `- Com caminho trocado por marcador: ${r.itens.filter(i => i.corpoMudou).length}.`,
        `- Com caminho literal que sobrou: ${r.itens.filter(i => i.caminhosLiterais.length).length}.`,
        '',
        '## Pastas pessoais encontradas (nome PROPOSTO — confirme ou troque)',
        '',
    ];
    if (r.pastasPropostas.length === 0) linhas.push('Nenhuma.');
    for (const p of r.pastasPropostas) linhas.push(`- \`${p.caminho}\` → \`{PASTA:${p.nomeProposto}}\` (em: ${p.skills.join(', ')})`);
    if (Object.keys(r.pastasConfirmadas).length) {
        linhas.push('', '## Pastas confirmadas nesta execução', '');
        for (const [n, c] of Object.entries(r.pastasConfirmadas)) linhas.push(`- \`{PASTA:${n}}\` = \`${c}\``);
    }
    linhas.push('', 'Para confirmar uma pasta: `newclaw skills-migrar --pasta nome=CAMINHO` (repita para cada uma).', '', '## Por skill', '');
    for (const i of r.itens) {
        if (i.jaMigrada) { linhas.push(`### ${i.pasta} — já tinha \`formato_skill\``, ''); continue; }
        if (!i.mudou) { linhas.push(`### ${i.pasta} — sem mudança`, ''); continue; }
        linhas.push(`### ${i.pasta}${i.aprendida ? ' (aprendida)' : ''}`, '', `- Campos novos: ${i.camposNovos.map(c => `\`${c}\``).join(', ')}`,
            `- Corpo: ${i.corpoMudou ? 'caminhos trocados por marcadores' : 'igual'}`);
        if (i.caminhosLiterais.length) linhas.push(`- Caminhos literais que sobraram: ${i.caminhosLiterais.map(c => `\`${c}\``).join(', ')}`);
        if (i.corpoMudou) {
            const a = i.antes.split(/\r?\n/), d = i.depois.split(/\r?\n/);
            const dif = d.filter(l => !a.includes(l) && !/^(sistema_origem|validada_em|formato_skill):/.test(l)).slice(0, 12);
            if (dif.length) linhas.push('', '```diff', ...a.filter(l => !d.includes(l)).slice(0, 12).map(l => `- ${l}`), ...dif.map(l => `+ ${l}`), '```');
        }
        linhas.push('');
    }
    return linhas.join('\n');
}
