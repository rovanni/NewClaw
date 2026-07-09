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

import { ProviderFactory, LLMMessage } from '../core/ProviderFactory';
import { createLogger } from './AppLogger';

const log = createLogger('ContentStubClassifier');

const CLASSIFIER_MODEL = process.env['CONTENT_STUB_CLASSIFIER_MODEL'] ?? 'gemma4:31b-cloud';
const TIMEOUT_MS = 6_000;

export interface ContentStubVerdict {
    isStub: boolean;
    reason: string;
}

/** Assinatura injetável em sanitizePlanSteps() — mesmo estilo de detectMissingRequiredArgs. */
export type ContentStubClassifier = (content: string, toolName: string) => Promise<ContentStubVerdict>;

/** Constrói o classificador real a partir de um ProviderFactory já existente (GoalPlanner/RiskAnalyzer). */
export function makeContentStubClassifier(providerFactory: ProviderFactory): ContentStubClassifier {
    return async (content: string, toolName: string): Promise<ContentStubVerdict> => {
        if (!content || content.trim().length < 3) {
            return { isStub: true, reason: 'conteúdo vazio ou quase vazio' };
        }

        const lines = [
            'Você é um detector de conteúdo-molde ("stub") gerado por um LLM em vez de conteúdo real.',
            '',
            `Ferramenta: ${toolName} (o texto abaixo será entregue DIRETAMENTE ao usuário — como arquivo ou narração de áudio, sem revisão humana).`,
            '',
            'Texto a avaliar:',
            '"""',
            content.slice(0, 800),
            '"""',
            '',
            'O texto acima é CONTEÚDO REAL, pronto para entrega (mesmo que curto ou simples)?',
            'Ou é uma DESCRIÇÃO/PLACEHOLDER do que deveria ser gerado — ex: menciona "step"/"passo N", ' +
            '"dados obtidos anteriormente", identificadores entre colchetes/sublinhados ' +
            '(ex: [resultado_do_passo_1]), frases tipo "conteúdo será gerado", ou texto genérico ' +
            'que descreve o processo em vez de responder ao pedido real?',
            'Responda APENAS com JSON: {"isStub": true|false, "reason": "curta em português"}',
        ];

        const messages: LLMMessage[] = [{ role: 'user', content: lines.join('\n') }];
        const provider = providerFactory.getProviderWithModel(CLASSIFIER_MODEL);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

        try {
            const response = await provider.chat(messages, undefined, { signal: controller.signal, timeoutMs: TIMEOUT_MS });
            clearTimeout(timer);

            const cleaned = response.content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
            const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
            if (!jsonMatch) {
                log.warn(`[ContentStubClassifier] tool=${toolName} resposta sem JSON válido — fail-closed (isStub=true)`);
                return { isStub: true, reason: 'resposta do LLM sem JSON válido' };
            }

            const parsed = JSON.parse(jsonMatch[0]) as { isStub?: boolean; reason?: string };
            if (typeof parsed.isStub !== 'boolean') {
                log.warn(`[ContentStubClassifier] tool=${toolName} JSON sem campo isStub válido — fail-closed (isStub=true)`);
                return { isStub: true, reason: 'resposta do LLM sem campo isStub' };
            }

            const reason = String(parsed.reason ?? (parsed.isStub ? 'classificado como stub' : 'classificado como conteúdo real'));
            log.info(`[ContentStubClassifier] tool=${toolName} isStub=${parsed.isStub} reason="${reason.slice(0, 100)}"`);
            return { isStub: parsed.isStub, reason };
        } catch (err) {
            clearTimeout(timer);
            log.warn(`[ContentStubClassifier] tool=${toolName} erro na classificação: ${String(err).slice(0, 100)} — fail-closed (isStub=true)`);
            return { isStub: true, reason: 'erro na classificação LLM (fail-closed)' };
        }
    };
}
