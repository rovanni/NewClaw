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

/** `risco_do_plano`: sem riscos e plano intacto → aprovado; com riscos (ou plano alterado) → reprovado, e os riscos vão no campo extra. */
export function vereditoRisco(riscos: string[], planoAlterado = false): string {
    return j({ estado: riscos.length || planoAlterado ? 'reprovado' : 'aprovado', itens: [], confianca: 0.9, motivo: riscos.join('; '), riscos: riscos.join(' | ') });
}

/**
 * No `RiskAnalyzer` o MESMO modelo responde ao revisor (que lê `{"risks","plan"}`) e ao juiz de risco do motor. Para os
 * testes que configuram só a revisão: o veredito do juiz equivalente a ela (riscos, ou plano novo, reprovam). Texto que
 * não é JSON volta como está — o juiz o recebe sem formato, como receberia do modelo.
 */
export function vereditoRiscoDaRevisao(revisao: string): string {
    let o: { risks?: unknown; plan?: unknown };
    try { o = JSON.parse(revisao); } catch { return revisao; }
    const riscos = Array.isArray(o?.risks) ? o.risks.map(String) : [];
    return vereditoRisco(riscos, Array.isArray(o?.plan) && o.plan.length > 0);
}

/** `qualidade_da_resposta`: aprovado/reprovado, com o tipo de falha e a correção sugerida (campos extras). */
export function vereditoQualidade(approved: boolean, extras: { reason?: string; confidence?: number; failureType?: string; suggestedFix?: string; faltou?: string } = {}): string {
    return j({
        estado: approved ? 'aprovado' : 'reprovado', itens: [], confianca: extras.confidence ?? 0.5, motivo: extras.reason ?? '',
        tipo_de_falha: extras.failureType ?? (approved ? 'none' : 'other'), correcao_sugerida: extras.suggestedFix ?? '',
        ...(extras.faltou ? { faltou: extras.faltou } : {}),
    });
}

/** `saida_contra_evidencia` (grounding): cada afirmação com a citação LITERAL da fonte (`trecho`), como o motor confere. */
export function vereditoGrounding(itens: Array<{ afirmacao: string; confere: 'sim' | 'nao' | 'sem_evidencia'; evidencia?: string; trecho?: string }>, extras: { faltou?: string } = {}): string {
    return j({
        estado: 'aprovado',
        itens: itens.map(i => ({ item: i.afirmacao, confere: i.confere, evidencia: i.evidencia ?? '', trecho: i.trecho ?? '' })),
        confianca: 0.9, motivo: '', ...(extras.faltou ? { faltou: extras.faltou } : {}),
    });
}

/** Orçamento que o motor pede ao provedor (`getBudgetAuxiliar`) — as fábricas simuladas declaram este, fixo. */
export const orcamentoDeTeste = (): { timeoutMs: number; origem: 'padrao'; latenciaTipicaMs: null } => ({ timeoutMs: 45_000, origem: 'padrao', latenciaTipicaMs: null });

/** Um trecho LITERAL das fontes de verdade do prompt do juiz — para a citação (`trecho`) que o motor confere existir. */
export function trechoDaFonte(mensagens: Array<{ content?: unknown }> | undefined): string {
    const prompt = String(mensagens?.[mensagens.length - 1]?.content ?? '');
    const a = prompt.indexOf('FONTES DE VERDADE');
    if (a < 0) return '';
    const bloco = prompt.slice(a);
    const abre = bloco.indexOf('"""\n');
    if (abre < 0) return '';
    const linha = bloco.slice(abre + 4).split('\n').find(l => l.trim().length > 8) ?? '';
    return linha.trim().slice(0, 40);
}

export type TipoDePergunta = 'grounding' | 'qualidade' | 'passo' | 'conclusao' | 'risco' | 'molde';

/**
 * Qual juiz do motor está perguntando (pela PERGUNTA do prompt), ou null se a chamada não é de um juiz (planejador, revisor,
 * agente). Os mocks que respondem a TODAS as chamadas usam isto para responder no formato do motor SÓ ao juiz que o teste
 * simula — e aos demais exatamente como antes (inclusive um juiz de outro tipo, que recebia um JSON que não reconhecia).
 */
export function tipoDaPerguntaDoMotor(mensagens: Array<{ content?: unknown }> | undefined): TipoDePergunta | null {
    const ultimo = mensagens?.[mensagens.length - 1]?.content;
    if (typeof ultimo !== 'string' || !/^Você é um validador\. PERGUNTA: /.test(ultimo)) return null;
    const pergunta = ultimo.slice(0, ultimo.indexOf('\n'));
    if (/Cada afirmação que a RESPOSTA/.test(pergunta)) return 'grounding';
    if (/atende plenamente ao pedido do usuário/.test(pergunta)) return 'qualidade';
    if (/ENDEREÇA a intenção do passo/.test(pergunta)) return 'passo';
    if (/COMPLETAMENTE concluído/.test(pergunta)) return 'conclusao';
    if (/plano está completo e correto/.test(pergunta)) return 'risco';
    if (/CONTEÚDO REAL, pronto para entrega/.test(pergunta)) return 'molde';
    return null;
}

/** `conclusao_do_objetivo`: aprovado → resumo; reprovado → motivo (+ sugestões). */
export function vereditoConclusao(achieved: boolean, extras: { summary?: string; reason?: string; suggestions?: string[] } = {}): string {
    return j({
        estado: achieved ? 'aprovado' : 'reprovado', itens: [], confianca: 0.9,
        motivo: achieved ? (extras.summary ?? '') : (extras.reason ?? ''),
        resumo: achieved ? (extras.summary ?? '') : '', sugestoes: (extras.suggestions ?? []).join(' | '),
    });
}
