/**
 * SkillLoader — Carrega skills via hot-reload
 * 
 * Skills são definidas em SKILL.md com frontmatter YAML
 * Carregamento síncrono a cada request (1ms por skill)
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { createLogger } from '../shared/AppLogger';
import { errorMessage } from '../shared/errors';
import { probeCommand } from '../utils/crossPlatform';
const log = createLogger('Skillloader');

export interface SkillMeta {
    name: string;
    description: string;
    version?: string;
    triggers?: string[];
    tools?: string[];
    /** Tags de domínio para capability-based discovery (genéricas, em inglês).
     *  Ex: ["presentation", "slides", "export", "document-generation"]
     *  Skills sem tags continuam sendo descobertas apenas por triggers. */
    tags?: string[];
    // ── ADR-035 (formato_skill 1). Campo ausente = desconhecido, nunca presumido. ──
    /** Sistema onde a skill nasceu (`process.platform`). */
    sistemaOrigem?: string;
    /** `sistema@resumo` onde ela já funcionou de verdade, com qual corpo. */
    validadaEm?: Array<{ sistema: string; resumo: string }>;
    /** `todas`, ou os sistemas onde ela faz sentido. */
    plataformas?: string[];
    /** Programas necessários, por nome. */
    requer?: string[];
    /** Instalação do NewClaw onde foi aprendida (`<nome>-<id8>`, ADR-034). */
    instalacaoOrigem?: string;
    formatoSkill?: number;
}

/** Os avisos de portabilidade (ADR-035 §3): calculados uma vez, ao carregar; os dois resumos usam o mesmo campo. */
export interface AvisosDaSkill {
    /** Curtos, para o catálogo: `[feita para win32; falta: himalaya]`. */
    curtos: string[];
    /** Completos, no começo do conteúdo que o agente recebe. */
    linhas: string[];
}

export interface Skill extends SkillMeta {
    content: string;       // Conteúdo completo (injetado quando skill é tarefa primária)
    globalContent: string; // Conteúdo sem seções TASK_ONLY (injetado em contexto parcial)
    /** ADR-035: resumo do corpo (8 primeiros do SHA-256, sem cabeçalho, LF, marcadores sem trocar). */
    resumo?: string;
    avisos?: AvisosDaSkill;
}

// ── ADR-035: portabilidade — funções puras, usadas pelo carregador, pelo aprendizado e pela importação ──────────────────

/** Pastas desta instalação que os marcadores representam. `pastas`: a tabela local `nome → pasta` (D2). */
export interface PastasDaInstalacao {
    newclaw: string;
    workspace: string;
    skills: string;
    pastas: Record<string, string>;
}

/** Nome de pasta pessoal válido no marcador `{PASTA:nome}`: minúsculas, números e hífen. */
export const NOME_DE_PASTA = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** A tabela local de pastas pessoais (`data/pastas-das-skills.json`). Não vai no pacote da ADR-034. */
export function lerTabelaDePastas(dados: string = path.join(process.cwd(), 'data')): Record<string, string> {
    try {
        const t = JSON.parse(fs.readFileSync(path.join(dados, 'pastas-das-skills.json'), 'utf8')) as Record<string, unknown>;
        return Object.fromEntries(Object.entries(t).filter(([k, v]) => NOME_DE_PASTA.test(k) && typeof v === 'string' && v.trim()) as Array<[string, string]>);
    } catch { return {}; }
}

export function gravarTabelaDePastas(tabela: Record<string, string>, dados: string = path.join(process.cwd(), 'data')): void {
    const limpa = Object.fromEntries(Object.entries(tabela).filter(([k, v]) => NOME_DE_PASTA.test(k) && typeof v === 'string' && v.trim()).map(([k, v]) => [k, v.trim()]));
    fs.mkdirSync(dados, { recursive: true });
    fs.writeFileSync(path.join(dados, 'pastas-das-skills.json'), JSON.stringify(limpa, null, 2));
}

/** As pastas desta instalação, lidas do ambiente (as mesmas de `caminhosDaInstalacao`). */
export function pastasDaInstalacao(raiz: string = process.cwd()): PastasDaInstalacao {
    return {
        newclaw: raiz,
        workspace: path.resolve(raiz, process.env.WORKSPACE_DIR || './workspace'),
        skills: path.resolve(raiz, process.env.SKILLS_DIR || './skills'),
        pastas: lerTabelaDePastas(path.join(raiz, 'data')),
    };
}

/** Resumo do corpo (§5): sem cabeçalho, CRLF→LF, marcadores sem trocar. Mesmo conteúdo, mesmo resumo em qualquer sistema. */
export function resumoDoCorpo(corpo: string): string {
    return crypto.createHash('sha256').update(corpo.replace(/\r\n/g, '\n').trim()).digest('hex').slice(0, 8);
}

/**
 * Troca os marcadores pelo valor desta instalação, com o separador do sistema (§2). O resto do caminho depois do marcador,
 * até o primeiro espaço, aspas ou fim de linha, também ganha o separador. Marcador desconhecido e `{PASTA:nome}` sem pasta
 * configurada ficam como estão; os nomes sem pasta voltam em `semPasta`.
 */
export function expandirMarcadores(texto: string, p: PastasDaInstalacao, sep: string = path.sep): { texto: string; semPasta: string[] } {
    const semPasta = new Set<string>();
    const fixos: Record<string, string> = { NEWCLAW: p.newclaw, WORKSPACE: p.workspace, SKILLS: p.skills };
    const saida = texto.replace(/\{(NEWCLAW|WORKSPACE|SKILLS|PASTA:([a-z0-9][a-z0-9-]{0,39}))\}([^\s"'`<>|]*)/g, (inteiro, marcador: string, nome: string | undefined, resto: string) => {
        const base = nome !== undefined ? p.pastas[nome] : fixos[marcador];
        if (base === undefined) { if (nome !== undefined) semPasta.add(nome); return inteiro; }
        const limpo = base.replace(/[\\/]+$/, '');
        return limpo + resto.replace(/[\\/]/g, sep);
    });
    return { texto: saida, semPasta: [...semPasta] };
}

/**
 * O inverso, ao aprender (§2): troca os prefixos CONHECIDOS desta instalação pelos marcadores. Troca exata de prefixo, o
 * mais longo primeiro; no Windows sem diferença de maiúsculas. Caminho fora das pastas conhecidas fica literal.
 */
export function marcarCaminhos(texto: string, p: PastasDaInstalacao, plataforma: NodeJS.Platform = process.platform): string {
    const pares: Array<[string, string]> = [
        ...Object.entries(p.pastas).map(([nome, pasta]) => [pasta, `{PASTA:${nome}}`] as [string, string]),
        [p.skills, '{SKILLS}'], [p.workspace, '{WORKSPACE}'], [p.newclaw, '{NEWCLAW}'],
    ];
    const ordenados = pares.filter(([pasta]) => pasta && pasta.length > 2).map(([pasta, m]) => [pasta.replace(/[\\/]+$/, ''), m] as [string, string])
        .sort((a, b) => b[0].length - a[0].length);
    let saida = texto;
    for (const [pasta, marcador] of ordenados) {
        const variantes = [...new Set([pasta, pasta.replace(/\\/g, '/'), pasta.replace(/\//g, '\\')])];
        for (const v of variantes) {
            const re = new RegExp(v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?=$|[\\\\/\\s"\'`<>|,;:)\\]]|\\.(?:\\s|$))', plataforma === 'win32' ? 'gi' : 'g');
            saida = saida.replace(re, marcador);
        }
    }
    return saida;
}

type EstadoDoRequisito = 'encontrado' | 'falta' | 'nao_verificado';
const cacheDeRequisitos = new Map<string, { estado: EstadoDoRequisito; em: number }>();
const TTL_DOS_REQUISITOS_MS = 5 * 60_000;

/** `requer` (§3): três estados, nunca "provavelmente tem". Nome fora de [A-Za-z0-9._+-] não é sondado. */
export function estadoDoRequisito(programa: string, sondar: (p: string) => ReturnType<typeof probeCommand> = probeCommand): EstadoDoRequisito {
    if (!/^[A-Za-z0-9._+-]{1,64}$/.test(programa)) return 'nao_verificado';
    const c = cacheDeRequisitos.get(programa);
    if (c && Date.now() - c.em < TTL_DOS_REQUISITOS_MS) return c.estado;
    const r = sondar(programa);
    const estado: EstadoDoRequisito = r.kind === 'found' ? 'encontrado' : r.kind === 'absent' ? 'falta' : 'nao_verificado';
    cacheDeRequisitos.set(programa, { estado, em: Date.now() });
    return estado;
}

/** Os avisos de uma skill neste sistema (§3). Sem os campos novos: nenhum aviso, como antes. */
export function avisosDaSkill(meta: SkillMeta, resumo: string, semPasta: string[], plataforma: string = process.platform,
    requisito: (p: string) => EstadoDoRequisito = p => estadoDoRequisito(p)): AvisosDaSkill {
    const curtos: string[] = [];
    const linhas: string[] = [];
    const plats = (meta.plataformas ?? []).map(s => s.toLowerCase());
    const excluiEste = plats.length > 0 && !plats.includes('todas') && !plats.includes(plataforma);
    if (excluiEste) {
        curtos.push(`feita para ${plats.join(', ')}`);
        linhas.push(`Esta skill foi feita só para ${plats.join(', ')}; este sistema é ${plataforma}; os passos podem não existir aqui.`);
    } else if (meta.validadaEm && meta.validadaEm.length > 0) {
        const aqui = meta.validadaEm.filter(v => v.sistema === plataforma);
        const valeAqui = aqui.some(v => v.resumo === resumo);
        const comEsteCorpo = meta.validadaEm.filter(v => v.resumo === resumo).map(v => v.sistema);
        if (!valeAqui && aqui.length > 0) {
            curtos.push('validada numa versão anterior');
            linhas.push(`Validada em ${plataforma} numa versão anterior desta skill; o texto mudou desde então. Confira os comandos.`);
        } else if (!valeAqui) {
            const onde = comEsteCorpo.length ? comEsteCorpo : [...new Set(meta.validadaEm.map(v => v.sistema))];
            const anterior = comEsteCorpo.length ? '' : ' (numa versão anterior desta skill)';
            curtos.push(`ainda não validada em ${plataforma}`);
            linhas.push(`Validada em ${onde.join(', ')}${anterior}; ainda não neste sistema (${plataforma}). Confira os comandos.`);
        }
    }
    const faltam: string[] = [];
    const naoVerificados: string[] = [];
    for (const p of meta.requer ?? []) {
        const e = requisito(p);
        if (e === 'falta') faltam.push(p); else if (e === 'nao_verificado') naoVerificados.push(p);
    }
    if (faltam.length) { curtos.push(`falta: ${faltam.join(', ')}`); linhas.push(`Falta neste sistema: ${faltam.join(', ')}.`); }
    if (naoVerificados.length) { curtos.push(`não verificado: ${naoVerificados.join(', ')}`); linhas.push(`Requisito não verificado: ${naoVerificados.join(', ')}.`); }
    for (const nome of semPasta) {
        curtos.push(`pasta não configurada: ${nome}`);
        linhas.push(`A pasta '${nome}' não está configurada nesta instalação (Skills → Pastas). O marcador {PASTA:${nome}} ficou como está.`);
    }
    return { curtos, linhas };
}

/**
 * ADR-035 §5 ("funcionou aqui"): acrescenta `sistema@resumo` a `validada_em` no cabeçalho do SKILL.md, sem tocar no corpo.
 * Devolve o texto novo, ou `undefined` se não houver cabeçalho. A entrada já existente não se repete.
 */
export function acrescentarValidacao(texto: string, sistema: string, resumo: string): string | undefined {
    const m = texto.replace(/^\uFEFF/, '').match(/^---(\r?\n)([\s\S]*?)\r?\n---/);
    if (!m) return undefined;
    const eol = m[1];
    const entrada = `${sistema}@${resumo}`;
    const linhas = m[2].split(/\r?\n/);
    const i = linhas.findIndex(l => /^validada_em\s*:/.test(l));
    if (i >= 0) {
        const atuais = linhas[i].split(':').slice(1).join(':').split(',').map(s => s.trim()).filter(Boolean);
        if (atuais.includes(entrada)) return texto;
        linhas[i] = `validada_em: ${[...atuais, entrada].join(', ')}`;
    } else {
        linhas.push(`validada_em: ${entrada}`);
    }
    if (!linhas.some(l => /^formato_skill\s*:/.test(l))) linhas.push('formato_skill: 1');
    const limpo = texto.replace(/^\uFEFF/, '');
    return `---${eol}${linhas.join(eol)}${eol}---` + limpo.slice(m[0].length);
}

/** Linha do catálogo: `- nome: descrição [avisos curtos]` — a mesma para o roteador e para o planejador. */
export function linhaDoCatalogo(s: Skill, recuo = ''): string {
    const avisos = s.avisos?.curtos.length ? ` [${s.avisos.curtos.join('; ')}]` : '';
    return `${recuo}- ${s.name}: ${s.description}${avisos}`;
}

export class SkillLoader {
    private skillsDir: string;
    private cache: Map<string, Skill> = new Map();
    private lastLoadTime = 0;
    // TTL de 10s: hot-reload ainda funciona para edições de skills entre requests,
    // mas evita o I/O repetido quando loadAll() é chamado múltiplas vezes no mesmo ciclo de goal.
    private static readonly CACHE_TTL_MS = 10_000;

    /** ADR-035: pastas para os marcadores. Padrão: as desta instalação, lidas do ambiente a cada carga. */
    private readonly pastas: () => PastasDaInstalacao;

    constructor(skillsDir: string = './skills', pastas?: () => PastasDaInstalacao) {
        this.skillsDir = skillsDir;
        this.pastas = pastas ?? (() => pastasDaInstalacao());
    }

    /**
     * Carrega todas as skills do diretório.
     * Hot-reload com TTL: relê do FS a cada 10s. Chamadas dentro do mesmo segundo retornam o cache.
     */
    loadAll(): Skill[] {
        const t0 = Date.now();
        const cacheAge = t0 - this.lastLoadTime;
        if (this.cache.size > 0 && cacheAge < SkillLoader.CACHE_TTL_MS) {
            log.info(`[SKILLLOAD] loaded=${this.cache.size} cached=${this.cache.size} duration_ms=0`);
            return Array.from(this.cache.values());
        }
        // Obs #8: registra quantas skills estavam em cache antes do clear (hot-reload descarta sempre)
        const prevCacheSize = this.cache.size;
        this.cache.clear();

        const skillsDir = this.resolveSkillsDir();
        if (!skillsDir) {
            log.info('Diretório de skills não encontrado:', this.skillsDir);
            log.info(`[SKILLLOAD] loaded=0 cached=${prevCacheSize} duration_ms=${Date.now() - t0}`);
            return [];
        }

        const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
        let pastas: PastasDaInstalacao | undefined;
        try { pastas = this.pastas(); } catch { pastas = undefined; }

        for (const entry of entries) {
            if (!entry.isDirectory()) continue;

            const skillPath = path.join(skillsDir, entry.name, 'SKILL.md');
            if (!fs.existsSync(skillPath)) continue;

            try {
                const skill = this.loadSkill(skillPath, pastas);
                if (skill) {
                    this.cache.set(skill.name, skill);
                    log.info(`Carregada: ${skill.name} - ${skill.description}`);
                }
            } catch (error) {
                log.error(`Erro ao carregar ${entry.name}:`, errorMessage(error));
            }
        }

        const duration_ms = Date.now() - t0;
        this.lastLoadTime = t0;
        log.info(`[SKILLLOAD] loaded=${this.cache.size} cached=${prevCacheSize} duration_ms=${duration_ms}`);
        return Array.from(this.cache.values());
    }

    private resolveSkillsDir(): string | null {
        if (fs.existsSync(this.skillsDir)) {
            return this.skillsDir;
        }

        const legacyDir = './workspace/skills';
        const defaultDir = './skills';

        if (this.skillsDir === legacyDir && fs.existsSync(defaultDir)) {
            log.info(`Fallback automático: usando ${defaultDir} no lugar de ${legacyDir}`);
            this.skillsDir = defaultDir;
            return this.skillsDir;
        }

        return null;
    }

    /**
     * Carrega uma skill individual
     */
    private loadSkill(skillPath: string, pastas?: PastasDaInstalacao): Skill | null {
        const content = fs.readFileSync(skillPath, 'utf-8');
        const meta = this.parseFrontmatter(content);

        if (!meta.name) {
            log.warn(`SKILL.md sem nome: ${skillPath}`);
            return null;
        }

        const corpo = this.stripFrontmatter(content);
        // ADR-035: o arquivo em disco guarda os marcadores; o agente recebe os caminhos desta instalação.
        const resumo = resumoDoCorpo(corpo);
        const expandido = pastas ? expandirMarcadores(corpo, pastas) : { texto: corpo, semPasta: [] };
        const avisos = avisosDaSkill(meta, resumo, expandido.semPasta);
        const cabecalhoDeAvisos = avisos.linhas.length ? avisos.linhas.map(l => `> ⚠️ ${l}`).join('\n') + '\n\n' : '';
        const fullContent = cabecalhoDeAvisos + expandido.texto;
        return {
            ...meta,
            content: fullContent,
            globalContent: this.stripTaskOnlySections(fullContent),
            resumo,
            avisos,
        };
    }

    /**
     * Remove seções marcadas com <!-- TASK_ONLY_START --> ... <!-- TASK_ONLY_END -->
     * do conteúdo da skill. Essas seções só são injetadas quando a skill é a
     * tarefa primária do turno (alta confiança de intenção).
     */
    private stripTaskOnlySections(content: string): string {
        return content
            .replace(/<!--\s*TASK_ONLY_START\s*-->[\s\S]*?<!--\s*TASK_ONLY_END\s*-->/g, '')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
    }

    /**
     * Parser de frontmatter YAML simples
     */
    private parseFrontmatter(content: string): SkillMeta {
        const cleanContent = content.replace(/^\uFEFF/, '');
        const match = cleanContent.match(/^---\r?\n([\s\S]*?)\r?\n---/);
        if (!match) return { name: '', description: '' };

        const frontmatter = match[1];
        const meta: SkillMeta = { name: '', description: '' };
        let inTagsList = false; // flag para parsear tags em formato lista YAML

        for (const line of frontmatter.split('\n')) {
            // Detectar início de lista de tags (formato multi-linha YAML)
            if (/^tags:\s*$/.test(line.trim())) {
                inTagsList = true;
                meta.tags = [];
                continue;
            }
            if (inTagsList) {
                const listItem = line.match(/^\s+-\s+(.+)/);
                if (listItem) {
                    meta.tags!.push(listItem[1].trim());
                    continue;
                }
                inTagsList = false; // fim da lista
            }
            const [key, ...values] = line.split(':');
            const value = values.join(':').trim();
            
            switch (key.trim()) {
                case 'name':
                    meta.name = value;
                    break;
                case 'description':
                    meta.description = value;
                    break;
                case 'version':
                    meta.version = value;
                    break;
                case 'triggers':
                    meta.triggers = value.split(',').map(s => s.trim());
                    break;
                case 'tools':
                    meta.tools = value.split(',').map(s => s.trim());
                    break;
                // ADR-035: linhas planas, listas separadas por vírgula. Valor vazio = desconhecido.
                case 'sistema_origem':
                    if (value) meta.sistemaOrigem = value;
                    break;
                case 'validada_em':
                    meta.validadaEm = value.split(',').map(s => s.trim()).filter(s => /^[a-z0-9]+@[0-9a-f]{8}$/.test(s))
                        .map(s => { const [sistema, resumo] = s.split('@'); return { sistema, resumo }; });
                    if (meta.validadaEm.length === 0) delete meta.validadaEm;
                    break;
                case 'plataformas':
                    if (value) meta.plataformas = value.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
                    break;
                case 'requer':
                    if (value) meta.requer = value.split(',').map(s => s.trim()).filter(Boolean);
                    break;
                case 'instalacao_origem':
                    if (value) meta.instalacaoOrigem = value;
                    break;
                case 'formato_skill':
                    if (/^\d+$/.test(value)) meta.formatoSkill = Number(value);
                    break;
                case 'tags':
                    // Suporta dois formatos:
                    //   tags: presentation, slides, export          (linha única CSV)
                    //   tags:\n  - presentation\n  - slides         (lista YAML)
                    meta.tags = value
                        ? value.split(',').map(s => s.trim()).filter(Boolean)
                        : [];
                    break;
            }
        }

        return meta;
    }


    /**
     * Remove frontmatter do conteúdo
     */
    private stripFrontmatter(content: string): string {
        const cleanContent = content.replace(/^\uFEFF/, '');
        return cleanContent.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim();
    }

    /**
     * Retorna skill pelo nome
     */
    getSkill(name: string): Skill | undefined {
        return this.cache.get(name);
    }

    /**
     * Retorna todas as skills
     */
    getAllSkills(): Skill[] {
        return Array.from(this.cache.values());
    }

    /**
     * Retorna resumo das skills para o router
     */
    getSkillSummaries(): string {
        const skills = this.getAllSkills();
        if (skills.length === 0) return '';

        return skills.map(s => linhaDoCatalogo(s)).join('\n');
    }

    /**
     * Retorna skill names para detecção de intenção
     */
    getSkillNames(): string[] {
        return Array.from(this.cache.keys());
    }
}
