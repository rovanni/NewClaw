/**
 * keywordBoundaryMatches — verifica se `keyword` aparece em `text` com boundary de palavra
 * consciente de português (acentos), evitando colisão de SUBSTRING ACIDENTAL dentro de outra
 * palavra não relacionada.
 *
 * Extraído de UnifiedIntentRouter.ts (que já tinha essa lógica só pra suas próprias keywords
 * curtas de comando/risco — "'format' não pode casar dentro de 'informatica'") e generalizado
 * com uma opção nova: `allowPluralS` (default true). A maioria das keywords de
 * DomainRegistry.ts é um substantivo no SINGULAR usado como stem, contando com `.includes()`
 * pra também casar a forma plural regular ("aula" casando dentro de "aulas", "projeto" dentro
 * de "projetos") — um boundary estrito nos dois lados quebraria TODOS esses casos. A exceção
 * permite exatamente um "s" de plural regular logo após a keyword, mas nada além disso: rejeita
 * "gostoso" (não é "gosto"+s+fim, é "gosto"+s+"o"), "calorias" (não é "calor"+s, é "calor"+"i..."),
 * "solução"/"resolver" (nem chegam a ter boundary válido de nenhum lado). `allowPluralS: false`
 * restaura o comportamento ESTRITO original (nenhuma exceção) — usado por
 * UnifiedIntentRouter.ts, cujas keywords (tickers de cripto, comandos) não são substantivos que
 * pluralizam nesse contexto; preserva 100% do comportamento já testado ali.
 *
 * Ver shared/contentStubPatterns.ts / shared/placeholderPatterns.ts / loop/planning/
 * toolAliasResolver.ts para o mesmo padrão de consolidação já aplicado neste projeto.
 */

const PT_LETTER = 'a-záàãâéêíóõôúç';

function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface KeywordBoundaryOptions {
    /** Permite um "s" de plural regular logo após a keyword (default: true). */
    allowPluralS?: boolean;
}

export function buildKeywordBoundaryRegex(keyword: string, opts: KeywordBoundaryOptions = {}): RegExp {
    const allowPluralS = opts.allowPluralS ?? true;
    const escaped = escapeRegExp(keyword.toLowerCase());
    const rightBoundary = allowPluralS
        ? `(?:$|[^${PT_LETTER}]|s(?=$|[^${PT_LETTER}]))`
        : `(?:$|[^${PT_LETTER}])`;
    return new RegExp(`(?:^|[^${PT_LETTER}])${escaped}${rightBoundary}`, 'i');
}

export function keywordBoundaryMatches(text: string, keyword: string, opts: KeywordBoundaryOptions = {}): boolean {
    return buildKeywordBoundaryRegex(keyword, opts).test(text);
}
