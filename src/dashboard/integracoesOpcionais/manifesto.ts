/**
 * Manifesto de integração opcional, formato 1 (ADR-030, Etapa 5; ADR-031, nota de 30/10/2026).
 *
 * Cada integração opcional publica um `newclaw-integracao.json` no próprio repositório. O núcleo conhece só este formato:
 * nada aqui sabe qual integração é. Como o núcleo vai executar comandos descritos num arquivo baixado, a validação é
 * estrita — campo desconhecido, comando fora do formato ou espaço reservado desconhecido → recusa com o motivo.
 */

export const FORMATO = 1;

/** Espaços reservados que o núcleo preenche; qualquer outro `{...}` num comando é recusado. */
export const RESERVADOS = ['{python}', '{newclaw_url}', '{pasta}', '{escolhas}'] as const;

export interface PorPlataforma<T> { win32?: T; outros: T }

export interface Requisito {
    nome: string;
    comando: string[];
    como_instalar: PorPlataforma<string>;
}

export interface Manifesto {
    formato: number;
    id: string;
    nome: string;
    descricao: string;
    site: string;
    pacote: string;
    pasta: string;
    python: PorPlataforma<string>;
    precisa: Requisito[];
    opcoes: string[];
    licencas: string[];
    instalar: string[];
    iniciar: PorPlataforma<string[]>;
    abrir: string;
    saude: string;
}

/** Uma escolha que a integração oferece (saída do comando `opcoes`). */
export interface Opcao {
    id: string;
    rotulo: string;
    opcoes: { valor: string; rotulo: string; detalhe?: string }[];
    visivel_se?: Record<string, string>;
    nota?: string;
}

export class ManifestoInvalido extends Error {}

const CAMPOS = ['formato', 'id', 'nome', 'descricao', 'site', 'pacote', 'pasta', 'python', 'precisa', 'opcoes', 'licencas',
    'instalar', 'iniciar', 'abrir', 'saude'];
const RE_ID = /^[a-z0-9][a-z0-9-]{1,40}$/;
const RE_PASTA = /^[A-Za-z0-9][A-Za-z0-9._-]{0,59}$/;
const RE_PROGRAMA = /^[A-Za-z0-9][A-Za-z0-9._-]{0,40}$/;  // nome de programa no PATH, sem caminho
const RE_ESCOLHA_ID = /^[a-z][a-z0-9_]{0,30}$/;

function texto(v: unknown, campo: string): string {
    if (typeof v !== 'string' || !v.trim()) throw new ManifestoInvalido(`'${campo}' precisa ser um texto`);
    return v;
}

function urlHttps(v: unknown, campo: string, hosts: readonly string[]): string {
    const s = texto(v, campo);
    let u: URL;
    try { u = new URL(s); } catch { throw new ManifestoInvalido(`'${campo}' não é um endereço válido`); }
    if (u.protocol !== 'https:') throw new ManifestoInvalido(`'${campo}' precisa ser https`);
    if (!hosts.includes(u.hostname)) throw new ManifestoInvalido(`'${campo}' aponta para ${u.hostname}, fora dos hosts permitidos`);
    return s;
}

function urlLocal(v: unknown, campo: string): string {
    const s = texto(v, campo);
    let u: URL;
    try { u = new URL(s); } catch { throw new ManifestoInvalido(`'${campo}' não é um endereço válido`); }
    if (!['http:', 'https:'].includes(u.protocol) || !['127.0.0.1', 'localhost'].includes(u.hostname)) {
        throw new ManifestoInvalido(`'${campo}' precisa ser um endereço desta máquina (127.0.0.1 ou localhost)`);
    }
    return s;
}

/** Um comando: lista de argumentos (sem shell). Só os espaços reservados conhecidos podem aparecer entre chaves. */
function comando(v: unknown, campo: string, primeiro: 'python' | 'relativo'): string[] {
    if (!Array.isArray(v) || v.length === 0 || !v.every((a) => typeof a === 'string')) {
        throw new ManifestoInvalido(`'${campo}' precisa ser uma lista de argumentos`);
    }
    for (const a of v as string[]) {
        const chaves = a.match(/\{[^}]*\}/g) || [];
        for (const c of chaves) {
            if (!(RESERVADOS as readonly string[]).includes(c)) throw new ManifestoInvalido(`'${campo}' usa ${c}, que não existe`);
        }
        if (a.includes('{escolhas}') && a !== '{escolhas}') throw new ManifestoInvalido(`'${campo}': {escolhas} precisa ser um argumento sozinho`);
    }
    const p0 = (v as string[])[0];
    if (primeiro === 'python' && p0 !== '{python}') throw new ManifestoInvalido(`'${campo}' precisa começar com {python}`);
    if (primeiro === 'relativo' && (p0.startsWith('/') || p0.includes('..') || /^[A-Za-z]:/.test(p0) || p0.includes('{'))) {
        throw new ManifestoInvalido(`'${campo}' precisa começar com um caminho dentro da pasta da integração`);
    }
    return v as string[];
}

function porPlataforma<T>(v: unknown, campo: string, cada: (x: unknown, c: string) => T): PorPlataforma<T> {
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new ManifestoInvalido(`'${campo}' precisa ter 'outros' (e opcionalmente 'win32')`);
    const o = v as Record<string, unknown>;
    for (const k of Object.keys(o)) if (k !== 'win32' && k !== 'outros') throw new ManifestoInvalido(`'${campo}.${k}' não existe`);
    return { ...(o.win32 !== undefined ? { win32: cada(o.win32, `${campo}.win32`) } : {}), outros: cada(o.outros, `${campo}.outros`) };
}

/** Valida o manifesto inteiro. `hosts`: de onde o pacote pode vir (do catálogo). */
export function validarManifesto(bruto: unknown, hosts: readonly string[]): Manifesto {
    if (!bruto || typeof bruto !== 'object' || Array.isArray(bruto)) throw new ManifestoInvalido('o manifesto precisa ser um objeto JSON');
    const m = bruto as Record<string, unknown>;
    for (const k of Object.keys(m)) if (!CAMPOS.includes(k)) throw new ManifestoInvalido(`campo desconhecido: '${k}'`);
    if (m.formato !== FORMATO) throw new ManifestoInvalido(`formato ${String(m.formato)} não suportado (este NewClaw entende o ${FORMATO})`);
    const id = texto(m.id, 'id');
    if (!RE_ID.test(id)) throw new ManifestoInvalido(`'id' fora do formato: ${id}`);
    const pasta = texto(m.pasta, 'pasta');
    if (!RE_PASTA.test(pasta)) throw new ManifestoInvalido(`'pasta' fora do formato: ${pasta}`);
    if (!Array.isArray(m.precisa)) throw new ManifestoInvalido(`'precisa' precisa ser uma lista`);
    const precisa = m.precisa.map((r, i) => {
        const o = (r ?? {}) as Record<string, unknown>;
        for (const k of Object.keys(o)) if (!['nome', 'comando', 'como_instalar'].includes(k)) throw new ManifestoInvalido(`campo desconhecido: 'precisa[${i}].${k}'`);
        return {
            nome: texto(o.nome, `precisa[${i}].nome`),
            comando: comando(o.comando, `precisa[${i}].comando`, 'python'),
            como_instalar: porPlataforma(o.como_instalar, `precisa[${i}].como_instalar`, texto),
        };
    });
    return {
        formato: FORMATO, id, pasta, precisa,
        nome: texto(m.nome, 'nome'),
        descricao: texto(m.descricao, 'descricao'),
        site: urlHttps(m.site, 'site', ['github.com']),
        pacote: urlHttps(m.pacote, 'pacote', hosts),
        python: porPlataforma(m.python, 'python', (v, c) => {
            const s = texto(v, c);
            if (!RE_PROGRAMA.test(s)) throw new ManifestoInvalido(`'${c}' precisa ser só o nome do programa`);
            return s;
        }),
        opcoes: comando(m.opcoes, 'opcoes', 'python'),
        licencas: comando(m.licencas, 'licencas', 'python'),
        instalar: comando(m.instalar, 'instalar', 'python'),
        iniciar: porPlataforma(m.iniciar, 'iniciar', (v, c) => comando(v, c, 'relativo')),
        abrir: urlLocal(m.abrir, 'abrir'),
        saude: urlLocal(m.saude, 'saude'),
    };
}

export function daPlataforma<T>(p: PorPlataforma<T>, plataforma: NodeJS.Platform): T {
    return plataforma === 'win32' && p.win32 !== undefined ? p.win32 : p.outros;
}

/**
 * Confere as escolhas da pessoa contra a lista que a própria integração ofereceu e as transforma em argumentos
 * (`--id valor`). Escolha escondida (`visivel_se` não satisfeito) é ignorada; valor fora da lista é recusado.
 */
export function argumentosDasEscolhas(oferecidas: Opcao[], escolhas: Record<string, unknown>): string[] {
    const porId = new Map(oferecidas.map((o) => [o.id, o]));
    for (const k of Object.keys(escolhas)) if (!porId.has(k)) throw new ManifestoInvalido(`escolha desconhecida: '${k}'`);
    const args: string[] = [];
    for (const o of oferecidas) {
        if (!RE_ESCOLHA_ID.test(o.id)) throw new ManifestoInvalido(`a integração ofereceu uma escolha com id fora do formato: '${o.id}'`);
        const visivel = !o.visivel_se || Object.entries(o.visivel_se).every(([k, v]) => escolhas[k] === v);
        if (!visivel) continue;
        const valor = escolhas[o.id];
        if (typeof valor !== 'string' || !o.opcoes.some((x) => x.valor === valor)) {
            throw new ManifestoInvalido(`escolha '${o.id}': valor fora da lista oferecida`);
        }
        args.push(`--${o.id}`, valor);
    }
    return args;
}

/** Preenche os espaços reservados. `{escolhas}` vira os argumentos já conferidos. */
export function montarComando(modelo: string[], valores: { python: string; newclaw_url: string; pasta: string; escolhas: string[] }): string[] {
    const saida: string[] = [];
    for (const a of modelo) {
        if (a === '{escolhas}') { saida.push(...valores.escolhas); continue; }
        saida.push(a.replace('{python}', valores.python).replace('{newclaw_url}', valores.newclaw_url).replace('{pasta}', valores.pasta));
    }
    return saida;
}
