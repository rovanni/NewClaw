/**
 * classifyContentStub — substitui CONTENT_STUB_PATTERNS (regex) como detector de "conteúdo-
 * molde" no gate de PLANEJAMENTO (sanitizePlanSteps.ts, chamado por GoalPlanner e RiskAnalyzer).
 *
 * Por que trocar por LLM: a lista de regex precisou de um padrão novo 6 vezes em incidentes
 * reais (09/06 a 09/07/2026), cada vez para uma frase que o LLM autor do plano ainda não tinha
 * usado ("step_1" → "step 1" → "etapas anteriores" → "gerado pelo assistente" → "passo 1" →
 * "[resultado_do_passo_1]") — perseguir vocabulário indefinidamente não escala. Um LLM julgando
 * "isso parece conteúdo real ou uma descrição/placeholder do que deveria ser gerado?" generaliza
 * a CLASSE do problema em vez de memorizar frases específicas.
 *
 * A lista de regex (shared/contentStubPatterns.ts) continua existindo e sendo usada por
 * write_tool.ts como última linha de defesa EM RUNTIME (checagem síncrona, sem custo de rede,
 * logo antes de gravar em disco) — só o gate de PLANEJAMENTO trocou para LLM.
 *
 * Fail-closed: erro de rede, timeout ou resposta sem JSON válido são tratados como isStub=true
 * (mesma postura do skill-auditor.md: "falso positivo é aceitável; falso negativo não é"). Um
 * step incorretamente convertido para AgentLoop ainda completa o objetivo por um caminho mais
 * lento; um stub que chega ao usuário via TTS/arquivo é irreversível depois do fato.
 */

import type { ProviderFactory } from '../core/ProviderFactory';
import { createLogger } from './AppLogger';
import { obterMotor } from '../validation/motorPadrao';
import type { DecisaoDeMolde } from '../validation/tipos/demaisTipos';

const log = createLogger('ContentStubClassifier');

export interface ContentStubVerdict {
    isStub: boolean;
    reason: string;
}

/** Assinatura injetável em sanitizePlanSteps() — mesmo estilo de detectMissingRequiredArgs. */
/** `pedido` (Sprint V4, Informação Completa para Decidir): a pergunta é se o texto responde ao pedido real — sem o pedido, o LLM adivinhava. */
export type ContentStubClassifier = (content: string, toolName: string, pedido?: string) => Promise<ContentStubVerdict>;

/**
 * Constrói o classificador real a partir de um ProviderFactory já existente (GoalPlanner/RiskAnalyzer).
 *
 * Campanha 09/10/2026 (troca M4, ADR-014): quem julga é o motor único, tipo `conteudo_molde` — a pergunta, as entradas
 * (pedido e texto INTEIROS), o prazo, o modelo (CLASSIFIER_MODEL) e o registro no gravador de voo são do descritor e do
 * motor, não mais deste arquivo. Aqui ficam só a política e o formato do consumidor: aprovado = conteúdo real.
 */
export function makeContentStubClassifier(providerFactory: ProviderFactory): ContentStubClassifier {
    return async (content: string, toolName: string, pedido?: string): Promise<ContentStubVerdict> => {
        if (!content || content.trim().length < 3) {
            return { isStub: true, reason: 'conteúdo vazio ou quase vazio' };
        }
        try {
            const { adaptado, semVeredito, deveBloquear, veredito } = await obterMotor(providerFactory).validar<DecisaoDeMolde>('conteudo_molde', { pedido, texto: content, ferramenta: toolName }, { phase: 'planejamento' });
            // Fail-closed (política declarada no tipo, `semVeredito: bloquear`): sem veredito (modelo fora, prazo, saída inválida)
            // vale isStub=true — falso positivo é aceitável, falso negativo não (um stub que chega ao usuário por arquivo/áudio é
            // irreversível). Um step convertido à toa para o AgentLoop ainda completa o objetivo, por um caminho mais lento.
            if (semVeredito && deveBloquear) {
                log.warn(`[ContentStubClassifier] tool=${toolName} sem veredito (${veredito.naoAvaliavelPorque ?? 'não declarado'}) — fail-closed (isStub=true)`);
                return { isStub: true, reason: 'erro na classificação LLM (fail-closed)' };
            }
            log.info(`[ContentStubClassifier] tool=${toolName} isStub=${adaptado.isStub} reason="${adaptado.reason.slice(0, 100)}"`);
            return adaptado;
        } catch (err) {
            log.warn(`[ContentStubClassifier] tool=${toolName} erro no motor: ${String(err).slice(0, 100)} — fail-closed (isStub=true)`);
            return { isStub: true, reason: 'erro na classificação LLM (fail-closed)' };
        }
    };
}
