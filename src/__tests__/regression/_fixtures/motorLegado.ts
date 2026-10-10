/**
 * Compatibilidade DOS TESTES com o motor único (ADR-014) — importar este módulo basta.
 *
 * Os seis validadores antigos liam, cada um, um JSON próprio: {"claims":[…]}, {"approved":…}, {"result":…}, {"achieved":…},
 * {"risks":…,"plan":…} e {"isStub":…}. Muitos testes de regressão simulam o modelo respondendo nesse formato — o que
 * importa neles é o COMPORTAMENTO que o veredito provoca (goal concluído, passo rebaixado, resposta bloqueada), não o formato.
 * Hoje todos decidem pelo `ValidationEngine`, que lê um formato só. Este módulo traduz, no limite entre o modelo simulado e o
 * motor, o JSON antigo para o do motor — escolhendo o tipo pela PERGUNTA do prompt (`Você é um validador. PERGUNTA: …`) — e
 * deixa passar tudo o que não é do formato antigo (já no formato do motor, ou outra chamada: planejador, revisor, agente).
 *
 * O conhecimento do formato do motor fica AQUI, num lugar só: mudar o contrato do motor é mexer neste arquivo, não em 40 testes.
 * Os testes do próprio motor (S363, S368, S372–S374) NÃO usam isto — falam o formato do motor direto.
 */
import { ValidationEngine } from '../../../validation/ValidationEngine';

type Obj = Record<string, any>;

function primeiroObjeto(texto: string): Obj | null {
    const limpo = texto.replace(/```json\n?/gi, '').replace(/```\n?/g, '').trim();
    try { const o = JSON.parse(limpo); return o && typeof o === 'object' && !Array.isArray(o) ? o : null; } catch { /* segue */ }
    const i = limpo.indexOf('{'), j = limpo.lastIndexOf('}');
    if (i < 0 || j <= i) return null;
    try { const o = JSON.parse(limpo.slice(i, j + 1)); return o && typeof o === 'object' && !Array.isArray(o) ? o : null; } catch { return null; }
}

/** Um trecho LITERAL das fontes de verdade do prompt — para a citação conferida pelo motor existir. */
function trechoDaFonte(prompt: string): string {
    const a = prompt.indexOf('FONTES DE VERDADE');
    if (a < 0) return '';
    const bloco = prompt.slice(a);
    const abre = bloco.indexOf('"""\n');
    if (abre < 0) return '';
    const corpo = bloco.slice(abre + 4);
    const linha = corpo.split('\n').find(l => l.trim().length > 8) ?? '';
    return linha.trim().slice(0, 40);
}

const j = (o: object): string => JSON.stringify(o);

export function legadoParaMotor(prompt: string, conteudo: string): string {
    if (!/^Você é um validador\. PERGUNTA: /.test(prompt)) return conteudo;
    const o = primeiroObjeto(conteudo);
    if (!o) return conteudo;
    if ('estado' in o || 'itens' in o) return conteudo;   // já é do motor

    const pergunta = prompt.slice(0, prompt.indexOf('\n'));
    const faltou = typeof o.faltou === 'string' ? { faltou: o.faltou } : {};

    // grounding
    if (/Cada afirmação que a RESPOSTA/.test(pergunta) && Array.isArray(o.claims)) {
        const trecho = trechoDaFonte(prompt);
        const itens = o.claims.map((c: Obj) => ({
            item: String(c.claim ?? ''),
            confere: c.verdict === 'SUPPORTED' ? 'sim' : c.verdict === 'NOT_SUPPORTED' ? 'nao' : c.verdict === 'NOT_EVALUABLE' ? 'sem_evidencia' : 'valor-invalido',
            evidencia: Array.isArray(c.evidence) ? c.evidence.join(',') : (c.evidence_id ?? ''),
            trecho,
        }));
        return j({ estado: 'aprovado', itens, confianca: 0.9, motivo: '', ...faltou });
    }
    // qualidade
    if (/atende plenamente ao pedido do usuário/.test(pergunta) && 'approved' in o) {
        return j({
            estado: o.approved ? 'aprovado' : 'reprovado', itens: [], confianca: o.confidence ?? 0.5, motivo: o.reason ?? '',
            tipo_de_falha: o.failure_type ?? (o.approved ? 'none' : 'other'), correcao_sugerida: o.suggested_fix ?? '', ...faltou,
        });
    }
    // passo
    if (/ENDEREÇA a intenção do passo/.test(pergunta) && 'result' in o) {
        const confere = o.result === 'relevant' ? 'sim' : o.result === 'mismatch' ? 'nao' : 'sem_evidencia';
        return j({ estado: o.result === 'mismatch' ? 'reprovado' : 'aprovado', itens: [{ item: 'o resultado trata do que o passo pediu', confere }], confianca: o.confidence ?? 0.6, motivo: o.reason ?? '', ...faltou });
    }
    // conclusão
    if (/COMPLETAMENTE concluído/.test(pergunta) && 'achieved' in o) {
        return j({
            estado: o.achieved ? 'aprovado' : 'reprovado', itens: [], confianca: 0.9,
            motivo: o.achieved ? (o.summary ?? '') : (o.reason ?? ''), resumo: o.achieved ? (o.summary ?? '') : '',
            sugestoes: Array.isArray(o.suggestions) ? o.suggestions.join(' | ') : '', ...faltou,
        });
    }
    // risco (o MESMO conteúdo antigo serve ao revisor, que lê {"risks","plan"} — ele passa sem conversão)
    if (/plano está completo e correto/.test(pergunta) && ('risks' in o || 'plan' in o)) {
        const riscos: string[] = Array.isArray(o.risks) ? o.risks.map(String) : [];
        const mudou = riscos.length > 0 || (Array.isArray(o.plan) && o.plan.length > 0);
        return j({ estado: mudou ? 'reprovado' : 'aprovado', itens: [], confianca: 0.9, motivo: riscos.join('; '), riscos: riscos.join(' | '), ...faltou });
    }
    // conteúdo-molde
    if (/CONTEÚDO REAL, pronto para entrega/.test(pergunta) && 'isStub' in o) {
        return j({ estado: o.isStub ? 'reprovado' : 'aprovado', itens: [], confianca: 0.9, motivo: o.reason ?? '', ...faltou });
    }
    return conteudo;
}

// ── instalação: toda chamada que o motor fizer ao provedor (simulado) passa pela tradução ───────────────────
const original = ValidationEngine.prototype.validar;
ValidationEngine.prototype.validar = async function (this: any, tipo: string, entradas: Record<string, string | undefined>, opcoes?: any) {
    const pf = this.providerFactory;
    // Os validadores antigos tinham prazo fixo e as fábricas simuladas não declaram o orçamento que o motor pede.
    if (pf && typeof pf.getBudgetAuxiliar !== 'function') pf.getBudgetAuxiliar = () => ({ timeoutMs: 45_000, origem: 'padrao', latenciaTipicaMs: null });
    if (pf && typeof pf.chatWithFallback === 'function' && !pf.__motorLegado) {
        const cwf = pf.chatWithFallback;
        pf.chatWithFallback = async (...args: any[]) => {
            const r = await cwf.apply(pf, args);
            const msgs: Array<{ content: string }> = args[0] ?? [];
            const prompt = msgs[msgs.length - 1]?.content ?? '';
            return r && r.status === 'success' && typeof r.content === 'string' ? { ...r, content: legadoParaMotor(prompt, r.content) } : r;
        };
        pf.__motorLegado = true;
    }
    return original.call(this, tipo, entradas, opcoes);
} as typeof original;
