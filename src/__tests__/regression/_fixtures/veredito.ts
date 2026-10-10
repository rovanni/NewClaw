/**
 * Saídas de juiz no formato do motor único (ADR-014), para os testes que simulam o modelo.
 *
 * Os seis juízes antigos liam, cada um, um JSON próprio ({"result":…}, {"isStub":…}, {"risks":…}, {"achieved":…}…).
 * Hoje há UM formato — o do `ValidationEngine` — e um tipo por pergunta; estes helpers escrevem esse formato para cada tipo,
 * para os testes não repetirem o JSON à mão (e não divergirem dele).
 */

const j = (o: object): string => JSON.stringify(o);

/** `resultado_do_passo`: relevant → aprovado; mismatch → reprovado; unverifiable → sem evidência. */
export function vereditoPasso(result: 'relevant' | 'mismatch' | 'unverifiable', confidence = 0.9, reason?: string): string {
    const confere = result === 'relevant' ? 'sim' : result === 'mismatch' ? 'nao' : 'sem_evidencia';
    return j({ estado: result === 'mismatch' ? 'reprovado' : 'aprovado', itens: [{ item: 'o resultado trata do que o passo pediu', confere }], confianca: confidence, motivo: reason ?? '' });
}

/** `conteudo_molde`: isStub=true → reprovado (não é conteúdo real). */
export function vereditoMolde(isStub: boolean, reason?: string): string {
    return j({ estado: isStub ? 'reprovado' : 'aprovado', itens: [], confianca: 0.9, motivo: reason ?? (isStub ? 'classificado como stub' : 'conteúdo real') });
}

/** `risco_do_plano`: sem riscos → aprovado; com riscos → reprovado, e os riscos vão no campo extra. */
export function vereditoRisco(riscos: string[]): string {
    return j({ estado: riscos.length ? 'reprovado' : 'aprovado', itens: [], confianca: 0.9, motivo: riscos.join('; '), riscos: riscos.join(' | ') });
}

/** `conclusao_do_objetivo`: aprovado → resumo; reprovado → motivo (+ sugestões). */
export function vereditoConclusao(achieved: boolean, extras: { summary?: string; reason?: string; suggestions?: string[] } = {}): string {
    return j({
        estado: achieved ? 'aprovado' : 'reprovado', itens: [], confianca: 0.9,
        motivo: achieved ? (extras.summary ?? '') : (extras.reason ?? ''),
        resumo: achieved ? (extras.summary ?? '') : '', sugestoes: (extras.suggestions ?? []).join(' | '),
    });
}
