/**
 * SkillDiscovery — quais skills servem a um pedido, pelos gatilhos delas (ADR-040).
 *
 * Um gatilho é uma FRASE que a pessoa escreveria ("o que tenho hoje"); casa inteira, com fronteira de palavra e sem
 * diferença de acento. É a única regra de escolha por texto: o agente (AgentLoop), o planejador (GoalOrchestrator →
 * getSkillContextForQuery, GoalExecutionLoop) e o RiskAnalyzer usam esta mesma função.
 *
 * Saiu em 17/11/2026 (ADR-040, decisão da operadora) o casamento por palavra de etiqueta e de descrição
 * (`byCapability`, Sprint 3.7A): nas 443 mensagens reais medidas ele trazia até 26 skills (p90 6), puxadas por "quando",
 * "arquivo", "para" — heurística escolhendo o que o LLM vê. O planejador já recebe o catálogo inteiro (nome + descrição
 * de todas as skills) e escolhe por ele.
 */

import type { Skill } from './SkillLoader';
import { keywordBoundaryMatches } from '../shared/keywordBoundary';

// ── Gatilhos (ADR-040) ────────────────────────────────────────────────────────

/**
 * ADR-040: um gatilho é uma FRASE que o usuário escreveria ("o que tenho hoje"), e casa inteira, com fronteira de palavra
 * (mesmo helper de DomainRegistry/ModelProfileRegistry). Antes era `includes` de cada palavra solta: "que", "para", "como"
 * casavam em quase toda mensagem e "rea" casava dentro de "área".
 */
export function gatilhoCasa(texto: string, gatilho: string): boolean {
    return casaNormalizado(textoSemAcento(texto), gatilho);
}

function casaNormalizado(textoNormalizado: string, gatilho: string): boolean {
    const g = semAcento(gatilho.trim());
    return g.length > 0 && keywordBoundaryMatches(textoNormalizado, g);
}

/** Forma, não significado: "como está" e "como esta" são a mesma frase escrita com e sem acento (o modelo e a pessoa variam). */
function semAcento(s: string): string {
    return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

// O mesmo texto (mensagem ou passo de goal, às vezes de milhares de caracteres) é comparado com todas as skills em
// sequência: normaliza uma vez só, não uma por gatilho.
let ultimoTexto: { de: string; para: string } = { de: '', para: '' };
function textoSemAcento(texto: string): string {
    if (ultimoTexto.de !== texto) ultimoTexto = { de: texto, para: semAcento(texto) };
    return ultimoTexto.para;
}

/** Verifica se uma query faz match com uma skill por trigger (frase inteira — ADR-040). */
export function matchSkillByTrigger(skill: Skill, query: string): boolean {
    const texto = textoSemAcento(query);
    return (skill.triggers ?? []).some(t => casaNormalizado(texto, t));
}

const METACARACTERES = /[.*+?^${}()|[\]\\]/g;
/** Letras do português (as de `shared/keywordBoundary`) e dígitos: o que conta como "dentro de uma palavra" na regex antiga. */
const LETRA = 'a-z0-9áàãâéêíóõôúç';
const METACARACTER_DE_REGEX = '.*+?^${}()[]';

/**
 * ADR-040 — formato do campo `trigger` de `auto_skills`: as frases ESCAPADAS e separadas por `|`. Continua sendo uma regex
 * válida (o caminho do banco, `SkillLearner.scoreSkillMatch`, a usa assim) e volta às mesmas frases em
 * `frasesDoCampoDeGatilhos`. Antes era `frases.join(' ')`, que apagava onde cada frase começava.
 */
export function campoDeGatilhos(frases: string[]): string {
    return frases.map(f => f.trim()).filter(Boolean).map(f => f.replace(METACARACTERES, '\\$&')).join('|');
}

/** As partes de um campo `trigger`, separadas pelos `|` sem escape (o escape fica na parte). */
function partesDoCampo(campo: string): string[] {
    const partes: string[] = [];
    let atual = '';
    for (let i = 0; i < campo.length; i++) {
        const c = campo[i];
        if (c === '\\' && i + 1 < campo.length) { atual += c + campo[++i]; continue; }
        if (c === '|') { partes.push(atual); atual = ''; continue; }
        atual += c;
    }
    partes.push(atual);
    return partes;
}

/** Forma do campo: tem metacaractere de regex sem escape → regex escrita à mão (formato antigo). O formato novo nunca tem. */
function ehRegexAntiga(campo: string): boolean {
    for (let i = 0; i < campo.length; i++) {
        if (campo[i] === '\\') { i++; continue; }
        if (METACARACTER_DE_REGEX.includes(campo[i])) return true;
    }
    return false;
}

/**
 * ADR-040 — um campo `trigger` do banco casa com o texto? Formato novo: as frases, pela MESMA regra do SKILL.md
 * (`gatilhoCasa`: frase inteira, fronteira de palavra, sem diferença de acento). Regex escrita à mão (formato antigo, das
 * skills que só vivem no banco, como `(pre[cç]o).*(btc)`): continua avaliada como regex, porque é o que ela é.
 * Regex inválida: não casa.
 */
export function campoCasa(campo: string, texto: string): boolean {
    if (!campo.trim()) return false;
    if (ehRegexAntiga(campo)) {
        // A regex antiga casava pedaço de palavra: "(…|ada|…)" casava "nada" (95 de 443 mensagens reais na "Consulta Cripto",
        // 17/11/2026). Com a fronteira nas pontas, o que ela casa tem de começar e terminar em palavra inteira.
        try { return new RegExp(`(?:^|[^${LETRA}])(?:${campo})(?:$|[^${LETRA}])`, 'i').test(texto.toLowerCase()); } catch { return false; }
    }
    const t = textoSemAcento(texto);
    return frasesDoCampoDeGatilhos(campo).some(f => casaNormalizado(t, f));
}

/**
 * ADR-040 (D2): o mesmo SKILL.md com a linha `triggers:` do cabeçalho trocada pelas frases (lista plana separada por
 * vírgula, ADR-035). Sem a linha, ela entra logo depois de `description:`. O resto do arquivo (corpo, outros campos,
 * quebras de linha) fica como estava. Sem cabeçalho, o texto volta igual.
 */
export function comLinhaDeGatilhos(skillMd: string, frases: string[]): string {
    const cab = /^(﻿?---\r?\n)([\s\S]*?)(\r?\n---)/.exec(skillMd);
    if (!cab) return skillMd;
    const quebra = cab[2].includes('\r\n') ? '\r\n' : '\n';
    const linha = `triggers: ${frases.join(',')}`;
    // Uma lista em bloco (`triggers:` seguida de linhas `  - x`) sai inteira.
    const semAntiga = cab[2].replace(/^triggers:[^\r\n]*(\r?\n[ \t]+-[^\r\n]*)*/m, '\u0000');
    // Substituição por função: uma frase com "$" não vira padrão de substituição.
    const novoCab = semAntiga.includes('\u0000')
        ? semAntiga.replace('\u0000', () => linha)
        : /^description:[^\r\n]*/m.test(semAntiga)
            ? semAntiga.replace(/^(description:[^\r\n]*)/m, (d) => `${d}${quebra}${linha}`)
            : `${semAntiga}${quebra}${linha}`;
    return skillMd.slice(0, cab.index) + cab[1] + novoCab + cab[3] + skillMd.slice(cab.index + cab[0].length);
}

/**
 * As frases de um campo `trigger`. Campo com metacaractere de regex sem escape é do formato antigo (regex escrita à mão,
 * como `(clima|tempo)` ou `(pre[cç]o).*(btc)`): dele saem as palavras, como antes (`extractTriggerKeywords`), porque não
 * há frase a recuperar. Um campo antigo de palavras separadas por espaço (ADR-017 até 17/11/2026) não tem como ser
 * separado sem adivinhar: volta como UMA frase, e a migração da ADR-040 (D2) regenera os gatilhos dessas skills.
 */
export function frasesDoCampoDeGatilhos(campo: string): string[] {
    const partes = partesDoCampo(campo);
    // O formato novo nunca tem metacaractere sem escape. Basta uma parte com um para o campo inteiro ser regex antiga:
    // aí vale a extração de antes, no campo todo (palavras com 3+ letras, sem número, até 10).
    if (ehRegexAntiga(campo)) {
        return [...new Set(campo
            .replace(/\[[^\]]*\]/g, ' ')
            .replace(/[().*+?^${}|\\[\]]/g, ' ')
            .split(/\s+/)
            .filter(s => s.length >= 3 && !/^\d+$/.test(s)))].slice(0, 10);
    }
    return [...new Set(partes.map(p => p.replace(/\\(.)/g, '$1').trim()).filter(Boolean))];
}

/**
 * As skills cujos gatilhos (frases) aparecem no texto, na ordem em que vieram. Mesma regra para o agente e o planejador.
 */
export function discoverSkills(skills: Skill[], query: string): Skill[] {
    return skills.filter(skill => matchSkillByTrigger(skill, query));
}
