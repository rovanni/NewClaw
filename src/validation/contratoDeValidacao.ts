/**
 * Contrato de validação (ADR-014, Sprint M0.1).
 *
 * Um único motor (`ValidationEngine`) executa todas as validações por LLM; cada TIPO de validação é um descritor —
 * dados, não código: a pergunta, as entradas com o papel de cada uma, o checklist, o modo de raciocínio, o modelo e o
 * adaptador para o formato que o consumidor já usa. É o princípio do MCP (contrato declarativo que o cliente descobre)
 * aplicado às decisões internas: uma correção feita no motor vale para todos os tipos, e é impossível chamar uma
 * validação sem as entradas que ela declarou (princípio "Informação Completa para Decidir").
 *
 * Este módulo é folha: só tipos, o registro de descritores e a leitura estrutural da saída do modelo. Não chama LLM.
 */

/** Papel de uma entrada no julgamento — define a seção do prompt e se pode ser cortada. */
export type PapelDaEntrada =
    /** O que está sendo julgado. Nunca cortado. */
    | 'objeto'
    /** Contra o que se julga (saídas de ferramenta, arquivo gerado). Nunca cortado. */
    | 'fonte_de_verdade'
    /** O pedido do usuário. Nunca cortado; nunca é evidência. */
    | 'contexto_do_usuario'
    /** O que já foi tentado, o que falhou, o que foi entregue. Pode ter corte declarado. */
    | 'contexto_da_execucao';

export interface EntradaDeclarada {
    nome: string;
    /** Rótulo legível da seção no prompt (ex.: "Resposta ao usuário", "Plano"). */
    rotulo: string;
    papel: PapelDaEntrada;
    obrigatoria: boolean;
    /** Só para `contexto_da_execucao`: trecho máximo, sempre declarado no prompt. */
    corteMaxChars?: number;
}

/** Quanto o modelo raciocina antes de responder. `livre` = o padrão do modelo (comportamento de hoje). */
export type ModoDeRaciocinio = 'desligado' | 'livre';

/** Verificações determinísticas que o motor sabe executar sobre a saída do modelo, declaradas pelo nome. */
export type PreVerificacao =
    /** Todo item marcado `sim`/`nao` precisa citar um trecho que existe literalmente numa fonte de verdade. */
    | 'citacao_existe_na_fonte';

export interface ItemJulgado {
    item: string;
    confere: 'sim' | 'nao' | 'sem_evidencia';
    evidencia?: string;
    trecho?: string;
    /** Preenchido pela pré-verificação `citacao_existe_na_fonte`. */
    citacaoConfere?: boolean;
}

export type EstadoDoVeredito = 'aprovado' | 'reprovado' | 'nao_avaliavel';

export interface VereditoPadrao {
    estado: EstadoDoVeredito;
    itens: ItemJulgado[];
    confianca?: number;
    motivo?: string;
    /** Observação do modelo: informação que faltou para decidir. Só observabilidade. */
    faltou?: string;
    /** Observação do modelo: outro problema que dificultou a decisão. Só observabilidade. */
    dificuldade?: string;
    /** Por que o motor não chegou a um veredito do modelo (entrada ausente, orçamento, falha). */
    naoAvaliavelPorque?: string;
    avaliacaoId?: string;
}

export interface DescritorDeValidacao<TAdaptado = VereditoPadrao> {
    /** Identificador estável do tipo (ex.: 'saida_contra_evidencia'). Vira `validacao_<tipo>` no gravador de voo. */
    tipo: string;
    /** O que exatamente está sendo decidido. */
    pergunta: string;
    entradas: EntradaDeclarada[];
    /** Perguntas que o modelo responde, uma a uma. */
    checklist: string[];
    /**
     * Como o estado sai: `modelo` = o modelo diz aprovado/reprovado; `itens` = derivado dos itens
     * (algum `nao` → reprovado; algum `sem_evidencia` → nao_avaliavel; todos `sim` → aprovado; nenhum → aprovado).
     */
    agregacao: 'modelo' | 'itens';
    preVerificacoes?: PreVerificacao[];
    raciocinio: ModoDeRaciocinio;
    /** Chave da configuração que escolhe o modelo (ex.: 'OBSERVER_MODEL'). Vazia/ausente = modelo padrão do provedor. */
    modeloConfig?: string;
    /** Traduz o veredito padrão para o formato que o consumidor de hoje já usa. */
    adaptador?: (v: VereditoPadrao) => TAdaptado;
}

// ── Registro de tipos ────────────────────────────────────────────────────────────────────────────

const PAPEIS_SEM_CORTE: ReadonlySet<PapelDaEntrada> = new Set(['objeto', 'fonte_de_verdade', 'contexto_do_usuario']);

/** Valida um descritor na hora do registro — erro de contrato aparece no boot/teste, não no meio de um julgamento. */
export function validarDescritor(d: DescritorDeValidacao<unknown>): string[] {
    const erros: string[] = [];
    if (!/^[a-z][a-z0-9_]*$/.test(d.tipo)) erros.push(`tipo "${d.tipo}" deve ser snake_case`);
    if (!d.pergunta.trim()) erros.push('pergunta vazia');
    if (!d.entradas.some(e => e.papel === 'objeto')) erros.push('nenhuma entrada com papel "objeto"');
    const nomes = new Set<string>();
    for (const e of d.entradas) {
        if (nomes.has(e.nome)) erros.push(`entrada "${e.nome}" repetida`);
        nomes.add(e.nome);
        if (e.corteMaxChars !== undefined && PAPEIS_SEM_CORTE.has(e.papel)) {
            erros.push(`entrada "${e.nome}" (papel ${e.papel}) não pode ter corte — só contexto_da_execucao`);
        }
    }
    if (d.checklist.length === 0) erros.push('checklist vazio');
    if (d.preVerificacoes?.includes('citacao_existe_na_fonte') && !d.entradas.some(e => e.papel === 'fonte_de_verdade')) {
        erros.push('citacao_existe_na_fonte exige ao menos uma entrada fonte_de_verdade');
    }
    return erros;
}

export class RegistroDeValidacoes {
    private readonly porTipo = new Map<string, DescritorDeValidacao<unknown>>();

    registrar(d: DescritorDeValidacao<unknown>): void {
        const erros = validarDescritor(d);
        if (erros.length) throw new Error(`Descritor de validação "${d.tipo}" inválido: ${erros.join('; ')}`);
        if (this.porTipo.has(d.tipo)) throw new Error(`Tipo de validação "${d.tipo}" já registrado`);
        this.porTipo.set(d.tipo, d);
    }

    obter(tipo: string): DescritorDeValidacao<unknown> | undefined {
        return this.porTipo.get(tipo);
    }

    /** Lista para o painel e para o recenseamento (S356). */
    tipos(): readonly DescritorDeValidacao<unknown>[] {
        return [...this.porTipo.values()];
    }
}

// ── Leitura estrutural da saída do modelo ────────────────────────────────────────────────────────

const CONFERE: ReadonlySet<string> = new Set(['sim', 'nao', 'sem_evidencia']);
const ESTADOS: ReadonlySet<string> = new Set(['aprovado', 'reprovado']);

/**
 * Lê a saída do modelo. Estrutural: só existência, tipo e valores permitidos — o texto não é interpretado.
 * Devolve null quando a forma não confere (o motor trata como não avaliável; uma saída malformada nunca é "consertada").
 */
export function lerSaidaDoModelo(saida: string): Omit<VereditoPadrao, 'estado'> & { estadoDoModelo?: 'aprovado' | 'reprovado' } | null {
    const limpo = saida.replace(/```json\n?/gi, '').replace(/```\n?/g, '');
    const inicio = limpo.indexOf('{');
    const fim = limpo.lastIndexOf('}');
    if (inicio < 0 || fim <= inicio) return null;
    let bruto: Record<string, unknown>;
    try { bruto = JSON.parse(limpo.slice(inicio, fim + 1)); } catch { return null; }
    if (!bruto || typeof bruto !== 'object') return null;

    const itensBrutos = Array.isArray(bruto.itens) ? bruto.itens : [];
    const itens: ItemJulgado[] = [];
    for (const x of itensBrutos) {
        if (!x || typeof x !== 'object') return null;
        const o = x as Record<string, unknown>;
        const item = typeof o.item === 'string' ? o.item.trim() : '';
        const confere = typeof o.confere === 'string' ? o.confere.trim().toLowerCase() : '';
        if (!item || !CONFERE.has(confere)) return null;
        itens.push({
            item,
            confere: confere as ItemJulgado['confere'],
            evidencia: typeof o.evidencia === 'string' ? o.evidencia : undefined,
            trecho: typeof o.trecho === 'string' ? o.trecho : undefined,
        });
    }
    const estado = typeof bruto.estado === 'string' ? bruto.estado.trim().toLowerCase() : '';
    const texto = (v: unknown, max = 500): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
    const conf = typeof bruto.confianca === 'number' && bruto.confianca >= 0 && bruto.confianca <= 1 ? bruto.confianca : undefined;
    return {
        itens,
        estadoDoModelo: ESTADOS.has(estado) ? estado as 'aprovado' | 'reprovado' : undefined,
        confianca: conf,
        motivo: texto(bruto.motivo, 1000),
        faltou: texto(bruto.faltou),
        dificuldade: texto(bruto.dificuldade),
    };
}

/** Estado derivado dos itens (agregacao 'itens'). */
export function agregarPorItens(itens: ItemJulgado[]): EstadoDoVeredito {
    if (itens.some(i => i.confere === 'nao')) return 'reprovado';
    if (itens.some(i => i.confere === 'sem_evidencia')) return 'nao_avaliavel';
    return 'aprovado';
}

// ── Pré-verificações determinísticas ─────────────────────────────────────────────────────────────

const normalizar = (s: string): string => s.replace(/\*\*|`/g, '').replace(/[“”"']/g, '"').replace(/\s+/g, ' ').trim().toLowerCase();

/** O trecho citado existe literalmente nas fontes? Fragmentos separados por "…" conferidos um a um. */
export function citacaoExiste(trecho: string, fontes: string[]): boolean {
    const alvo = normalizar(fontes.join('\n'));
    const partes = trecho.split(/…|\.\.\./).map(normalizar).filter(p => p.length >= 4);
    return partes.length > 0 && partes.every(p => alvo.includes(p));
}
