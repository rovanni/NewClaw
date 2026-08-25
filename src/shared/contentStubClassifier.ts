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

// Sem padrão embutido (issue 019): quando o operador não configura, quem decide o modelo é o
// provedor ativo — via getProviderWithModel() sem modelo. Um nome de modelo de NUVEM como padrão
// aqui era enviado ao provedor em uso, e numa instalação só-local ele não existe.
const CLASSIFIER_MODEL = process.env['CONTENT_STUB_CLASSIFIER_MODEL'] ?? '';

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
        // Orçamento derivado da latência observada do provedor (shared/auxTimeout.ts), como
        // DomainRegistry e GoalExtractor já fazem. O teto fixo de 6s que existia aqui era o
        // sétimo dos que a Sprint 7 mediu e deixou de fora por não ter evidência de abort —
        // a evidência apareceu em 08/08/2026: `AbortError: This operation was aborted` em 2 de
        // 3 classificações do turno, contra um provedor cujo primeiro chunk levou 14,2s. Como o
        // classificador é fail-closed, cada aborto rebaixava para AgentLoop um step 'write' com
        // conteúdo legítimo.
        //
        // Aumentar a constante seria repetir o erro que auxTimeout.ts foi criado para encerrar:
        // um número em milissegundos não descreve a chamada, descreve uma suposição sobre a
        // velocidade do hardware de quem roda. O perfil 'classificacao' é o mesmo dos outros dois
        // pontos — a chamada é da mesma natureza (JSON de uma linha, veredito binário).
        //
        // O fail-closed NÃO muda (ver doc no topo): erro continua valendo isStub=true. O que muda
        // é parar de tratar "este provedor é mais lento" como "o LLM não conseguiu classificar".
        const orcamento = providerFactory.getBudgetAuxiliar('classificacao');
        const TIMEOUT_MS = orcamento.timeoutMs;

        // Reusa chatWithFallback em vez de getProviderWithModel() direto (D-08,
        // docs/ARCHITECTURE/INVENTARIO_DUPLICACAO_2026-08-24.md) — mesmo mecanismo que
        // ObserverValidator (S258) já usa. getProviderWithModel() sem providerName cai sempre em
        // this.defaultProvider, sem nenhum fallback se essa única chamada falhar; chatWithFallback
        // tenta os demais providers antes de desistir, com o mesmo TIMEOUT_MS de hoje delimitando
        // cada tentativa. A política fail-closed continua decidida aqui, não no ProviderFactory —
        // qualquer status diferente de 'success' (erro, timeout, cancelado) cai no mesmo ramo.
        const result = await providerFactory.chatWithFallback(messages, undefined, undefined, TIMEOUT_MS, undefined, CLASSIFIER_MODEL);
        if (result.status !== 'success') {
            log.warn(`[ContentStubClassifier] tool=${toolName} chamada ao LLM falhou (status=${result.status}) — fail-closed (isStub=true)`);
            return { isStub: true, reason: 'erro na classificação LLM (fail-closed)' };
        }

        try {
            const cleaned = result.content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
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
            log.warn(`[ContentStubClassifier] tool=${toolName} erro ao interpretar resposta: ${String(err).slice(0, 100)} — fail-closed (isStub=true)`);
            return { isStub: true, reason: 'erro na classificação LLM (fail-closed)' };
        }
    };
}
