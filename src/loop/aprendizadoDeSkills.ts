/**
 * Aprendizado de skills com o que funcionou — ADR-017 (estilo Hermes). Funções puras; módulo-folha.
 *
 * Depois de um goal VALIDADO como concluído, o LLM olha a trajetória (as ações do próprio agente, em ordem, com argumentos e
 * se deram certo) e decide se ela ensinou um procedimento reutilizável; se sim, escreve a skill. Aqui fica tudo o que é
 * determinístico em volta dessa decisão: montar a trajetória (inclusive as ações de dentro dos sub-turnos, pelo rastro de
 * execução), montar o pedido ao LLM, interpretar e validar a resposta (forma, tamanho, nome, ausência de segredo) e escrever o
 * corpo do SKILL.md e o aviso ao usuário. Quem decide "vale aprender?" e "o quê?" é o LLM — nada aqui interpreta texto.
 *
 * O que NÃO entra no pedido ao LLM: as SAÍDAS das ferramentas (o conteúdo de um e-mail, de uma página, de um arquivo). É o que
 * impede que texto de terceiros vire instrução persistente numa skill, e que dados do usuário sejam copiados para ela.
 */
import { descreverArgumentos } from '../shared/argumentosDaChamada';
import { NOME_SENSIVEL, FORMATOS_DE_CREDENCIAL, SENHA_DE_APP } from '../shared/segredos';

export type ModoDeAprendizado = 'automatico' | 'proposta' | 'desligado';

/** `APRENDIZADO_DE_SKILLS`: automatico (padrão) | proposta (comportamento anterior: moldes que esperam aprovação) | desligado. */
export function modoDeAprendizado(valor: string | undefined = process.env.APRENDIZADO_DE_SKILLS): ModoDeAprendizado {
    const v = (valor ?? '').trim().toLowerCase();
    return v === 'proposta' || v === 'desligado' ? v : 'automatico';
}

/** Portão estrutural: trajetória de uma ação só não ensina procedimento (contagem, não interpretação). */
export const MIN_ACOES_BEM_SUCEDIDAS = 2;
const LIMITE_POR_ARGUMENTO = 600;
const LIMITE_DO_ERRO = 300;
const MAX_ACOES = 60;

export interface AcaoDaTrajetoria {
    ferramenta: string;
    argumentos?: string;
    ok: boolean;
    erro?: string;
}

/** O pedaço de um passo do rastro de execução (ExecutionTrace) que interessa aqui. */
export interface PassoDeRastro {
    type: string;
    data: Record<string, unknown>;
}

interface TentativaMinima {
    toolName: string;
    args?: Record<string, unknown>;
    result: string;
    error?: string;
    traceId?: string;
}

const curto = (s: unknown, n: number): string | undefined => {
    if (typeof s !== 'string' || !s.trim()) return undefined;
    const t = s.trim();
    return t.length > n ? `${t.slice(0, n)}…` : t;
};

/**
 * A trajetória na ordem em que aconteceu. Um passo `agentloop` é expandido nas chamadas de ferramenta do sub-turno (tirado do
 * rastro); sem rastro, ele não acrescenta ação nenhuma (só o nome não ensina procedimento).
 */
export function montarTrajetoria(tentativas: TentativaMinima[], rastroDe: (traceId: string) => PassoDeRastro[] | undefined): AcaoDaTrajetoria[] {
    const acoes: AcaoDaTrajetoria[] = [];
    for (const t of tentativas) {
        if (t.toolName === 'agentloop') {
            const passos = t.traceId ? rastroDe(t.traceId) : undefined;
            if (!passos) continue;
            const abertas: AcaoDaTrajetoria[] = [];
            for (const p of passos) {
                const ferramenta = typeof p.data?.tool === 'string' ? p.data.tool : undefined;
                if (!ferramenta) continue;
                if (p.type === 'tool_call') {
                    const a: AcaoDaTrajetoria = { ferramenta, argumentos: descreverArgumentos(p.data.input, LIMITE_POR_ARGUMENTO), ok: false, erro: 'sem resultado registrado' };
                    abertas.push(a);
                    acoes.push(a);
                } else if (p.type === 'tool_result') {
                    const a = abertas.find((x) => x.ferramenta === ferramenta);
                    if (!a) continue;
                    abertas.splice(abertas.indexOf(a), 1);
                    a.ok = p.data.success !== false;
                    a.erro = a.ok ? undefined : curto(p.data.error, LIMITE_DO_ERRO);
                }
            }
            continue;
        }
        const ok = t.result === 'success' || t.result === 'partial';
        acoes.push({ ferramenta: t.toolName, argumentos: descreverArgumentos(t.args, LIMITE_POR_ARGUMENTO), ok, erro: ok ? undefined : curto(t.error, LIMITE_DO_ERRO) });
    }
    return acoes.slice(0, MAX_ACOES);
}

// ── Segredos ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

// Os padrões de credencial vivem num lugar só (ADR-019) — o mesmo conhecimento protege a entrada do chat e as skills.
// Aqui a senha de app (ambígua em prosa) só vale como valor CONCRETO tirado do que a tarefa usou.

/**
 * Valores concretos que não podem aparecer na skill nem ir ao LLM: variáveis de ambiente sensíveis, argumentos sensíveis da
 * trajetória e o que tem cara de senha de app no pedido/argumentos.
 */
export function coletarSegredos(fontes: { textos: string[]; argumentos: unknown[]; env?: NodeJS.ProcessEnv }): string[] {
    const achados = new Set<string>();
    for (const [k, v] of Object.entries(fontes.env ?? {})) {
        if (NOME_SENSIVEL.test(k) && typeof v === 'string' && v.trim().length >= 8) achados.add(v.trim());
    }
    const varrer = (x: unknown, chave?: string): void => {
        if (typeof x === 'string') {
            if (chave && NOME_SENSIVEL.test(chave) && x.trim().length >= 6) achados.add(x.trim());
            for (const m of x.match(SENHA_DE_APP) ?? []) achados.add(m);
            for (const f of FORMATOS_DE_CREDENCIAL) { const m = x.match(f); if (m) achados.add(m[0]); }
        } else if (Array.isArray(x)) x.forEach((y) => varrer(y, chave));
        else if (x && typeof x === 'object') for (const [k, y] of Object.entries(x as Record<string, unknown>)) varrer(y, k);
    };
    fontes.argumentos.forEach((a) => varrer(a));
    fontes.textos.forEach((t) => varrer(t));
    return [...achados].sort((a, b) => b.length - a.length);
}

/** Troca cada segredo conhecido por <SEGREDO> — o LLM nunca recebe o valor. */
export function mascarar(texto: string, segredos: string[]): string {
    let r = texto;
    for (const s of segredos) r = r.split(s).join('<SEGREDO>');
    return r;
}

/** Motivo (sem o valor!) se o texto contém um segredo conhecido ou um formato inconfundível de credencial. */
export function motivoDeSegredo(texto: string, segredos: string[]): string | null {
    if (segredos.some((s) => texto.includes(s))) return 'contém um valor sensível usado na tarefa';
    if (FORMATOS_DE_CREDENCIAL.some((f) => f.test(texto))) return 'contém algo com formato de credencial';
    return null;
}

// ── Pedido ao LLM ────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface EntradaDoAprendizado {
    pedido: string;
    objetivo: string;
    plataforma: string;
    diretivaDeIdioma?: string;
    trajetoria: AcaoDaTrajetoria[];
    skillsExistentes: Array<{ nome: string; descricao: string }>;
    segredos: string[];
}

export function montarPedidoDeAprendizado(e: EntradaDoAprendizado): string {
    const m = (s: string) => mascarar(s, e.segredos);
    const acoes = e.trajetoria.map((a, i) =>
        `${i + 1}. ${a.ferramenta}${a.argumentos ? ` ${m(a.argumentos)}` : ''} → ${a.ok ? 'deu certo' : `falhou${a.erro ? `: ${m(a.erro)}` : ''}`}`).join('\n');
    const existentes = e.skillsExistentes.length
        ? e.skillsExistentes.map((s) => `- ${s.nome} — ${s.descricao}`).join('\n')
        : '(nenhuma)';
    return [
        'Você revisa uma tarefa que o assistente NewClaw acabou de CONCLUIR (o resultado foi validado) e decide se ela ensinou um',
        'PROCEDIMENTO reutilizável: algo que, da próxima vez, economizaria tentativas — comandos que funcionaram nesta máquina, onde',
        'ficam configurações, a ordem certa, armadilhas encontradas e como foram contornadas.',
        '',
        'Não vale aprender: conversa; pergunta respondida com uma busca simples; tarefa trivial; conteúdo específico daquela vez (o',
        'texto de um documento, a resposta de uma pergunta); ou algo que uma das skills existentes já cobre.',
        '',
        `PEDIDO DO USUÁRIO: """${m(e.pedido)}"""`,
        `OBJETIVO INTERPRETADO: ${m(e.objetivo)}`,
        `PLATAFORMA: ${e.plataforma}`,
        '',
        'AÇÕES DO ASSISTENTE, NA ORDEM (ferramenta, argumentos, resultado). As que falharam mostram o que NÃO fazer.',
        'Os resultados das ferramentas não são mostrados de propósito: a skill descreve COMO fazer, não o que foi encontrado.',
        acoes || '(nenhuma)',
        '',
        'SKILLS QUE JÁ EXISTEM (nome — descrição):',
        existentes,
        '',
        'Regras para a skill:',
        '- Use somente ações que deram certo nesta trajetória; generalize valores daquela vez com marcadores (<arquivo>, <conta>, <pasta>).',
        '- Nunca escreva senhas, tokens, chaves ou dados pessoais; onde a tarefa usou um, escreva <SEGREDO> e diga onde ele fica configurado.',
        `- A skill vale para ${e.plataforma}; diga isso na descrição se os comandos forem específicos do sistema.`,
        '- Escreva como conhecimento (o que funcionou e por quê), não como ordem absoluta.',
        ...(e.diretivaDeIdioma ? [`- ${e.diretivaDeIdioma.trim()} (vale para todos os textos do JSON)`] : []),
        '',
        'Responda SOMENTE com um objeto JSON:',
        '{"aprender": true|false, "motivo": "por que sim ou por que não", "nome": "nome-curto-em-kebab-case", "titulo": "título",',
        ' "descricao": "uma frase: quando usar", "gatilhos": ["palavras", "que", "indicam", "o pedido"], "ferramentas": ["exec_command"],',
        ' "procedimento": "markdown com os passos e comandos", "cuidados": "markdown com armadilhas e como evitar (pode ser vazio)",',
        ' "aviso": "uma frase curta, para o usuário, dizendo o que você aprendeu"}',
        'Se "aprender" for false, preencha só "aprender" e "motivo".',
    ].join('\n');
}

// ── Resposta do LLM ──────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface PropostaDeSkill {
    nome: string;
    titulo: string;
    descricao: string;
    gatilhos: string[];
    ferramentas: string[];
    procedimento: string;
    cuidados: string;
    aviso: string;
}

export type RespostaInterpretada =
    | { tipo: 'nao_aprender'; motivo: string }
    | { tipo: 'aprender'; motivo: string; proposta: PropostaDeSkill }
    | { tipo: 'invalida'; erro: string };

function primeiroObjeto(texto: string): Record<string, unknown> | null {
    const limpo = texto.replace(/```(?:json)?/gi, '').trim();
    const tentar = (s: string) => { try { const o = JSON.parse(s); return o && typeof o === 'object' && !Array.isArray(o) ? o : null; } catch { return null; } };
    const direto = tentar(limpo);
    if (direto) return direto;
    const i = limpo.indexOf('{'), j = limpo.lastIndexOf('}');
    return i >= 0 && j > i ? tentar(limpo.slice(i, j + 1)) : null;
}

/** Nome de pasta/skill: minúsculas, sem acento, palavras unidas por hífen. */
export function normalizarNome(s: string): string {
    return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
}

const texto = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const lista = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => texto(x)).filter(Boolean) : []);

/** Forma e tamanho; nada aqui julga o conteúdo. */
export function interpretarResposta(bruta: string): RespostaInterpretada {
    const o = primeiroObjeto(bruta);
    if (!o) return { tipo: 'invalida', erro: 'resposta sem JSON' };
    if (typeof o.aprender !== 'boolean') return { tipo: 'invalida', erro: 'campo "aprender" ausente ou não booleano' };
    const motivo = texto(o.motivo).slice(0, 500);
    if (!o.aprender) return { tipo: 'nao_aprender', motivo: motivo || '(sem motivo)' };
    const p: PropostaDeSkill = {
        nome: normalizarNome(texto(o.nome)),
        titulo: texto(o.titulo),
        descricao: texto(o.descricao),
        gatilhos: lista(o.gatilhos).map((g) => g.toLowerCase()).filter((g) => g.length >= 2 && g.length <= 40).slice(0, 12),
        ferramentas: lista(o.ferramentas).filter((f) => /^[a-z][a-z0-9_]{1,40}$/.test(f)).slice(0, 12),
        procedimento: texto(o.procedimento),
        cuidados: texto(o.cuidados),
        aviso: texto(o.aviso),
    };
    const problemas = [
        p.nome.length < 3 ? 'nome' : '',
        p.titulo.length < 3 || p.titulo.length > 100 ? 'titulo' : '',
        p.descricao.length < 10 || p.descricao.length > 300 ? 'descricao' : '',
        p.gatilhos.length === 0 ? 'gatilhos' : '',
        p.procedimento.length < 40 || p.procedimento.length > 8000 ? 'procedimento' : '',
        p.cuidados.length > 4000 ? 'cuidados' : '',
        p.aviso.length < 5 || p.aviso.length > 300 ? 'aviso' : '',
    ].filter(Boolean);
    if (problemas.length) return { tipo: 'invalida', erro: `campos fora da forma: ${problemas.join(', ')}` };
    return { tipo: 'aprender', motivo, proposta: p };
}

/** Motivo para recusar uma proposta bem formada (nome repetido, segredo). */
export function motivoParaRecusar(p: PropostaDeSkill, opcoes: { nomesExistentes: string[]; segredos: string[] }): string | null {
    const existentes = new Set(opcoes.nomesExistentes.map(normalizarNome));
    if (existentes.has(p.nome)) return `já existe uma skill chamada "${p.nome}"`;
    const tudo = [p.nome, p.titulo, p.descricao, p.gatilhos.join(' '), p.procedimento, p.cuidados, p.aviso].join('\n');
    return motivoDeSegredo(tudo, opcoes.segredos);
}

/** Corpo do SKILL.md (o cabeçalho YAML é do SkillLearner, que é dono do formato). A origem fica declarada no topo. */
export function montarCorpoDaSkill(p: PropostaDeSkill, origem: { pedido: string; plataforma: string; data: string; segredos: string[] }): string {
    const pedido = mascarar(origem.pedido, origem.segredos).replace(/\s+/g, ' ').trim();
    return [
        `# ${p.titulo}`,
        '',
        `> Aprendida automaticamente pelo NewClaw em ${origem.data}, ao concluir: "${pedido.length > 160 ? `${pedido.slice(0, 160)}…` : pedido}" (${origem.plataforma}).`,
        `> É conhecimento de uma execução que deu certo, não uma regra. Revise, edite ou desative no painel (Skills) ou com /skill_desativar ${p.nome}.`,
        '',
        '## Procedimento',
        '',
        p.procedimento,
        ...(p.cuidados ? ['', '## Cuidados', '', p.cuidados] : []),
        '',
    ].join('\n');
}

/** O aviso vem do LLM, no idioma do usuário; o comando de desfazer é literal (não depende de idioma). */
export function textoDoAviso(p: PropostaDeSkill): string {
    return `💡 ${p.aviso}\n↩️ /skill_desativar ${p.nome}`;
}
