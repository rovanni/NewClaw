/**
 * SkillDiscovery — Inferência de capacidades e matching de skills por domínio.
 *
 * Propósito:
 *   Separar a linguagem do usuário (ex: "criar apresentação para aula")
 *   das capacidades do domínio (ex: "presentation", "slides", "education").
 *
 * Abordagem:
 *   1. Normalizar os tokens do objetivo (sem acentos, stemming leve PT-BR)
 *   2. Normalizar os tokens das tags e descrição de cada skill
 *   3. Calcular interseção → match por capacidade
 *
 * Critérios de design:
 *   - Zero dependências externas
 *   - Zero embeddings ou vetores
 *   - Zero LLM calls
 *   - Zero regras hardcoded por domínio
 *   - Funciona para qualquer skill que tenha `tags` definidas
 *   - Skills sem `tags` continuam sendo descobertas apenas por triggers (comportamento anterior)
 */

import type { Skill } from './SkillLoader';
import { keywordBoundaryMatches } from '../shared/keywordBoundary';

// ── Resultado de matching ─────────────────────────────────────────────────────

export interface SkillMatch {
    skillName: string;
    score: number;          // 0..1 — fração das capacidades do objetivo cobertas pela skill
    matchedTerms: string[]; // tokens normalizados que fizeram match
    matchedBy: 'trigger' | 'tag' | 'description';
}

// ── Normalização ──────────────────────────────────────────────────────────────

/**
 * Normaliza um único token:
 *   1. Remove diacríticos (é→e, ã→a, ç→c)
 *   2. Lowercase
 *   3. Stemming leve para PT-BR (remove sufixos comuns)
 *
 * Não usa bibliotecas externas — implementado explicitamente para evitar
 * dependências e manter comportamento previsível e testável.
 */
export function normalizeToken(t: string): string {
    const ascii = t
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '') // remove combining diacritics
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');      // mantém apenas alfanumérico

    if (ascii.length < 3) return ascii;

    // Stemming leve: sufixos PT-BR mais comuns
    // Ordem importa: mais específico primeiro
    return ascii
        .replace(/coes$/, 'cao')       // apresentações → apresentacao (dedup com ões)
        .replace(/oes$/, 'ao')         // aviões → aviao
        .replace(/amento(s)?$/, 'ament') // tratamentos → tratament
        .replace(/imento(s)?$/, 'iment') // documentos ficam como document se padrao
        .replace(/mente$/, '')          // facilmente → facil
        .replace(/cao(s)?$/, 'cao')    // criações → criacao (idempotente)
        .replace(/([aeiou])s$/, '$1'); // slides → slide, tags → tag, aulas → aula
}

/**
 * Infere capacidades do objetivo do usuário.
 * Extrai tokens normalizados com comprimento mínimo de 4 chars.
 *
 * "criar slides html para aula" → {"criar", "slide", "html", "para", "aula"}
 *
 * Tokens com < 4 chars são excluídos (artigos, preposições, etc.)
 */
export function inferCapabilities(text: string): Set<string> {
    const tokens = text
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .split(/[\W_]+/)
        .map(t => t.trim())
        .filter(t => t.length >= 4)
        .map(normalizeToken)
        .filter(t => t.length >= 3); // após normalização, mínimo 3

    return new Set(tokens);
}

/**
 * Expande as capacidades de uma skill: tags + tokens da descrição.
 * Tags têm peso primário; descrição serve como fallback mais rico.
 */
export function expandSkillCapabilities(skill: Skill): Set<string> {
    const terms = new Set<string>();

    // Tags são o sinal primário de capacidade
    for (const tag of skill.tags ?? []) {
        for (const part of tag.split(/[-_\s]+/)) {
            const n = normalizeToken(part);
            if (n.length >= 3) terms.add(n);
        }
    }

    // Descrição como fallback (menos estrito — só tokens longos)
    const descTokens = skill.description
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .split(/\W+/)
        .filter(t => t.length >= 5)
        .map(normalizeToken)
        .filter(t => t.length >= 4);

    for (const t of descTokens) terms.add(t);

    return terms;
}

// ── Matching ──────────────────────────────────────────────────────────────────

/**
 * Calcula o match entre um objetivo e uma skill por capacidades.
 * Retorna null se não há interseção.
 */
export function matchSkillByCapabilities(
    skill: Skill,
    goalCapabilities: Set<string>,
): SkillMatch | null {
    if (goalCapabilities.size === 0) return null;
    if (!skill.tags || skill.tags.length === 0) return null; // sem tags = apenas trigger match

    const skillTerms = expandSkillCapabilities(skill);
    const matched: string[] = [];

    for (const cap of goalCapabilities) {
        if (skillTerms.has(cap)) {
            matched.push(cap);
        }
    }

    if (matched.length === 0) return null;

    // Score: fração do vocabulário do objetivo coberta pela skill
    // Normalizado por max(capabilities, 6) para evitar que objetivos longos
    // penalizem skills (um objetivo de 20 tokens não precisa ter 20 matches)
    const score = matched.length / Math.min(goalCapabilities.size, 6);

    return {
        skillName: skill.name,
        score: Math.min(score, 1),
        matchedTerms: matched,
        matchedBy: (skill.tags ?? []).length > 0 ? 'tag' : 'description',
    };
}

// ── Gatilhos (ADR-040) ────────────────────────────────────────────────────────

/**
 * ADR-040: um gatilho é uma FRASE que o usuário escreveria ("o que tenho hoje"), e casa inteira, com fronteira de palavra
 * (mesmo helper de DomainRegistry/ModelProfileRegistry). Antes era `includes` de cada palavra solta: "que", "para", "como"
 * casavam em quase toda mensagem e "rea" casava dentro de "área".
 */
export function gatilhoCasa(texto: string, gatilho: string): boolean {
    const g = semAcento(gatilho.trim());
    return g.length > 0 && keywordBoundaryMatches(semAcento(texto), g);
}

/** Forma, não significado: "como está" e "como esta" são a mesma frase escrita com e sem acento (o modelo e a pessoa variam). */
function semAcento(s: string): string {
    return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** Verifica se uma query faz match com uma skill por trigger (frase inteira — ADR-040). */
export function matchSkillByTrigger(skill: Skill, query: string): boolean {
    return (skill.triggers ?? []).some(t => gatilhoCasa(query, t));
}

const METACARACTERES = /[.*+?^${}()|[\]\\]/g;
const METACARACTER_DE_REGEX = '.*+?^${}()[]';

/**
 * ADR-040 — formato do campo `trigger` de `auto_skills`: as frases ESCAPADAS e separadas por `|`. Continua sendo uma regex
 * válida (o caminho do banco, `SkillLearner.scoreSkillMatch`, a usa assim) e volta às mesmas frases em
 * `frasesDoCampoDeGatilhos`. Antes era `frases.join(' ')`, que apagava onde cada frase começava.
 */
export function campoDeGatilhos(frases: string[]): string {
    return frases.map(f => f.trim()).filter(Boolean).map(f => f.replace(METACARACTERES, '\\$&')).join('|');
}

/**
 * As frases de um campo `trigger`. Partes com metacaractere de regex sem escape são do formato antigo (regex escrita à mão,
 * como `(clima|tempo)` ou `(pre[cç]o).*(btc)`): dessas saem as palavras, como antes (`extractTriggerKeywords`), porque não
 * há frase a recuperar. Um campo antigo de palavras separadas por espaço (ADR-017 até 17/11/2026) não tem como ser
 * separado sem adivinhar: volta como UMA frase, e a migração da ADR-040 (D2) regenera os gatilhos dessas skills.
 */
export function frasesDoCampoDeGatilhos(campo: string): string[] {
    const partes: string[] = [];
    let atual = '';
    for (let i = 0; i < campo.length; i++) {
        const c = campo[i];
        if (c === '\\' && i + 1 < campo.length) { atual += c + campo[++i]; continue; }
        if (c === '|') { partes.push(atual); atual = ''; continue; }
        atual += c;
    }
    partes.push(atual);

    const frases: string[] = [];
    const palavrasAntigas: string[] = [];
    for (const parte of partes) {
        let regexAntiga = false;
        for (let i = 0; i < parte.length; i++) {
            if (parte[i] === '\\') { i++; continue; }
            if (METACARACTER_DE_REGEX.includes(parte[i])) { regexAntiga = true; break; }
        }
        if (regexAntiga) {
            palavrasAntigas.push(...parte
                .replace(/\[[^\]]*\]/g, ' ')
                .replace(/[().*+?^${}|\\[\]]/g, ' ')
                .split(/\s+/)
                .filter(s => s.length >= 3 && !/^\d+$/.test(s)));
        } else {
            const frase = parte.replace(/\\(.)/g, '$1').trim();
            if (frase) frases.push(frase);
        }
    }
    return [...new Set([...frases, ...palavrasAntigas.slice(0, 10)])];
}

/**
 * Ponto de entrada principal: descobre skills relevantes para um objetivo.
 *
 * Combina dois mecanismos:
 *   1. Trigger match (comportamento original — mantido sem alteração)
 *   2. Capability match (novo — baseado em tags normalizadas)
 *
 * Skills são deduplicadas (trigger match + capability match = um único resultado).
 */
export function discoverSkills(
    skills: Skill[],
    query: string,
    options: { minScore?: number } = {},
): {
    byTrigger: Skill[];
    byCapability: SkillMatch[];
    all: Skill[];
} {
    const minScore = options.minScore ?? 0.15;
    const byTrigger: Skill[] = [];
    const byCapability: SkillMatch[] = [];
    const triggerNames = new Set<string>();

    // Passo 1: trigger match (original)
    for (const skill of skills) {
        if (matchSkillByTrigger(skill, query)) {
            byTrigger.push(skill);
            triggerNames.add(skill.name);
        }
    }

    // Passo 2: capability match (novo)
    const capabilities = inferCapabilities(query);
    for (const skill of skills) {
        if (triggerNames.has(skill.name)) continue; // já matched por trigger
        const match = matchSkillByCapabilities(skill, capabilities);
        if (match && match.score >= minScore) {
            byCapability.push(match);
        }
    }

    // Ordenar capability matches por score desc
    byCapability.sort((a, b) => b.score - a.score);

    // Skills por capability (para montar lista unificada)
    const capabilitySkillMap = new Map<string, Skill>(
        byCapability.map(m => [m.skillName, skills.find(s => s.name === m.skillName)!])
    );

    const all = [
        ...byTrigger,
        ...byCapability.map(m => capabilitySkillMap.get(m.skillName)!).filter(Boolean),
    ];

    return { byTrigger, byCapability, all };
}
