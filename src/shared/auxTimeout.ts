/**
 * auxTimeout — orçamento de tempo para chamadas LLM AUXILIARES, derivado da latência
 * observada do provedor em vez de um número fixo em milissegundos.
 *
 * ── O problema ─────────────────────────────────────────────────────────────────────────────
 *
 * Chamadas auxiliares (classificar intenção, decidir domínio, validar um passo) tinham cada
 * uma seu teto fixo: 6s, 8s, 12s, 15s, 30s, 45s. Todos calibrados observando modelos de
 * nuvem. Um número em milissegundos, porém, não descreve a chamada — descreve uma suposição
 * sobre a velocidade do hardware de quem roda.
 *
 * Evidência real (03/08/2026, logs/newclaw-audit.log): o MESMO classificador respondeu em
 * 1.329 ms num modelo de nuvem e em 18.030 ms num .gguf local, na mesma máquina. Com o local,
 * dois abortos por turno, em todos os turnos:
 *
 *     05:03:06  FAILED This operation was aborted duration=6010ms   ← DOMAIN_CLASSIFIER (6s)
 *     05:03:23  FAILED This operation was aborted duration=17722ms  ← GOAL_EXTRACTOR (15s)
 *
 * Nada quebrava de forma visível — esses caminhos falham abertos e caem em heurística. O custo
 * era silencioso: ~21s por turno gastos em chamadas destinadas a falhar, classificação
 * degradada, e um log cheio de abortos.
 *
 * ── Por que não as saídas óbvias ───────────────────────────────────────────────────────────
 *
 * Aumentar as constantes: é o que já se fez antes. `shared/dynamicTimeout.ts` documenta
 * exatamente essa lição — os valores fixos do GoalPlanner (90s/45s) foram substituídos por uma
 * função de escala justamente porque "a mesma classe de bug reapareceria assim que o contexto
 * crescesse de novo". Aqui vale o mesmo: com um modelo mais lento, quebra de novo.
 *
 * Reusar `computeDynamicTimeout`: escala pelo TAMANHO DO PROMPT, e o eixo do problema é a
 * VELOCIDADE DO PROVEDOR — o prompt do classificador tem ~1.161 tokens e ainda assim estoura.
 * Além disso seu piso é 45s, alto demais para uma resposta binária que precisa desistir rápido
 * quando o provedor está morto.
 *
 * Multiplicador para "modelo local": "local" não é a variável. Um modelo local numa GPU
 * potente é mais rápido que um endpoint de nuvem congestionado — correlacionaria com o proxy
 * errado.
 *
 * ── O que este módulo faz ──────────────────────────────────────────────────────────────────
 *
 * Quem chama declara a INTENÇÃO da chamada (uma classificação barata? uma validação cara?) e
 * recebe um orçamento derivado da latência que aquele provedor de fato apresenta. Sem
 * histórico, devolve o padrão do perfil — nunca um número inventado a partir de nada.
 */

/**
 * Perfis de chamada auxiliar. O nome descreve o que a chamada É, não quanto tempo ela leva —
 * o tempo é medido, não declarado.
 */
export type PerfilAuxiliar = 'classificacao' | 'validacao';

interface DefinicaoPerfil {
    /** Quantas vezes a latência típica do provedor cabe no orçamento. */
    fator: number;
    /** Piso: abaixo disto a chamada não teria chance nem num provedor rápido. */
    minMs: number;
    /** Teto: acima disto é melhor desistir e seguir pela heurística de fallback. */
    maxMs: number;
    /** Usado enquanto não há nenhuma medição para o provedor (partida a frio). */
    padraoMs: number;
}

const PERFIS: Record<PerfilAuxiliar, DefinicaoPerfil> = {
    // Resposta curta e estruturada (JSON de uma linha, rótulo de categoria). Precisa de folga
    // sobre a latência típica porque modelos com etapa de raciocínio emitem tokens de thinking
    // antes do JSON — mas também precisa desistir cedo quando o provedor não responde.
    classificacao: { fator: 2.5, minMs: 6_000, maxMs: 60_000, padraoMs: 15_000 },

    // Julgamento sobre um texto maior (validar conclusão de goal, avaliar um passo). Tolera
    // mais porque o custo de desistir é refazer trabalho, não só perder uma dica.
    validacao: { fator: 4, minMs: 15_000, maxMs: 120_000, padraoMs: 45_000 },
};

/** Fonte da latência típica — injetada para manter este módulo sem dependência de runtime. */
export interface FonteDeLatencia {
    getLatenciaTipicaMs(provedor: string): number | null;
}

export interface OrcamentoAuxiliar {
    timeoutMs: number;
    /** De onde veio o número — `medido` ou `padrao`. Para o log dizer a verdade. */
    origem: 'medido' | 'padrao';
    latenciaTipicaMs: number | null;
}

/**
 * Orçamento para uma chamada auxiliar a `provedor`.
 *
 * Sem medição disponível, devolve o padrão do perfil e diz que é padrão — quem loga isso
 * consegue distinguir "calculei 40s porque este provedor leva 16s" de "chutei 15s porque nunca
 * vi este provedor responder".
 */
export function getBudgetAuxiliar(
    perfil: PerfilAuxiliar,
    provedor: string | null | undefined,
    fonte: FonteDeLatencia | null | undefined,
): OrcamentoAuxiliar {
    const def = PERFIS[perfil];
    const latencia = provedor && fonte ? fonte.getLatenciaTipicaMs(provedor) : null;

    if (latencia === null || !Number.isFinite(latencia) || latencia <= 0) {
        return { timeoutMs: def.padraoMs, origem: 'padrao', latenciaTipicaMs: null };
    }

    const bruto = latencia * def.fator;
    const timeoutMs = Math.round(Math.min(Math.max(bruto, def.minMs), def.maxMs));
    return { timeoutMs, origem: 'medido', latenciaTipicaMs: latencia };
}
