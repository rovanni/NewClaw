/**
 * GoalExtractor — Classifica se uma mensagem representa um Goal ou conversa simples.
 *
 * Dois estágios para minimizar overhead:
 *   1. Heurística determinística (zero latência) — detecta sinais claros de goal
 *   2. Classificação LLM (apenas quando heurística é inconclusiva)
 *
 * Um Goal é uma solicitação que requer execução de múltiplos passos com tools.
 * Conversas simples, perguntas factuais e saudações nunca viram goals.
 */

import { createLogger } from '../shared/AppLogger';
import { ProviderFactory, LLMMessage } from '../core/ProviderFactory';
import { GoalClassification } from './GoalTypes';
import { GOAL_LIMITS } from './GoalLimits';
import { ChannelContext } from './agentLoopTypes';

const log = createLogger('GoalExtractor');

// ── Heurísticas determinísticas ───────────────────────────────────────────────

/** Padrões que indicam claramente um goal (sem LLM) */
const GOAL_SIGNALS: RegExp[] = [
    // Verbos de ação + objeto
    /\b(resumir?|analis[ae]|cri[ae]|faz?er?|execut[ae]|instala[r]?|baixa[r]?|convert[ae]|processa[r]?)\b/i,
    /\b(edita[r]?|modific[ae]|atualiz[ae]|renomeia[r]?|mover?|copi[ae]|deleta[r]?|remov[ae])\b/i,
    /\b(busca[r]?|pesquisa[r]?|encontra[r]?|verifica[r]?|checa[r]?|testa[r]?|valida[r]?)\b/i,
    /\b(gera[r]?|produ[zs]|extraia?|compila[r]?|constri?u|deploiar?|publicar?)\b/i,
    // Referência a arquivo/documento
    /\b(esse|este|aquele?|o)\s+(pdf|arquivo|documento|c[oó]digo|script|log|relat[oó]rio)\b/i,
    // Estruturas "faça X para mim" / "preciso que você X"
    /\b(para\s+mim|preciso\s+que\s+voc[eê]|quero\s+que\s+voc[eê]|pode\s+(fazer|criar|executar))\b/i,
    // Tarefas de desenvolvimento
    /\b(implementa[r]?|refatora[r]?|depur[ae]|corrig[ei]|fix[ae]|adiciona[r]?)\b/i,
    // Operações de sistema
    /\b(inicia[r]?|para[r]?|reinicia[r]?|configur[ae]|instala[r]?|desinsta[l])\b/i,
];

/** Padrões que indicam CLARAMENTE conversa simples (não goal) */
const NOT_GOAL_SIGNALS: RegExp[] = [
    /^(oi|ol[aá]|hey|e a[ií]|tudo\s+bem|bom\s+dia|boa\s+tarde|boa\s+noite)\b/i,
    /^(o\s+que\s+[eé]|me\s+explica|como\s+funciona|qual\s+[eé]\s+a\s+diferen[cç]a)\b/i,
    /^(voc[eê]\s+[eé]|quem\s+[eé]\s+voc[eê]|o\s+que\s+voc[eê]\s+pode)\b/i,
    /^(obrigad[ao]|valeu|vlw|entendi|ok|perfeito|show|[oó]timo)\b/i,
    /\?$/, // perguntas simples terminando em ?
];

export class GoalExtractor {
    constructor(private readonly providerFactory: ProviderFactory) {}

    /**
     * Estágio 1: heurística rápida.
     * Retorna null quando inconclusivo (precisa de LLM).
     */
    private quickClassify(message: string): boolean | null {
        const msg = message.trim();

        if (msg.length < GOAL_LIMITS.MIN_GOAL_MESSAGE_LENGTH) return false;

        // Fragmento de lista sem contexto — Telegram cortou uma mensagem grande.
        // Começa com bullet/asterisco e não tem verbo de ação → não é goal autônomo.
        const isListFragment = /^[\*\-•]\s+\w/.test(msg) && msg.split('\n').length <= 15
            && !GOAL_SIGNALS.some(p => p.test(msg));
        if (isListFragment) return false;

        // Sinais negativos claros → não é goal
        for (const pattern of NOT_GOAL_SIGNALS) {
            if (pattern.test(msg)) return false;
        }

        // Sinais positivos claros → é goal
        let matches = 0;
        for (const pattern of GOAL_SIGNALS) {
            if (pattern.test(msg)) matches++;
            if (matches >= 2) return true;
        }

        // Mensagem longa com pelo menos 1 sinal positivo → provavelmente goal
        if (matches >= 1 && msg.length > 50) return true;

        return null; // inconclusivo
    }

    /**
     * Estágio 2: classificação via LLM (apenas quando heurística falhou).
     * Prompt minimalista para minimizar tokens e latência.
     */
    private async llmClassify(message: string, _context: ChannelContext): Promise<GoalClassification> {
        const prompt = `Classifique se a mensagem abaixo requer execução de tarefas com ferramentas (is_goal=true) ou é conversa simples/pergunta (is_goal=false).

Mensagem: "${message.slice(0, 300)}"

Responda APENAS com JSON válido, sem markdown:
{"is_goal": boolean, "confidence": 0.0-1.0, "objective": "descrição concisa se for goal", "required_tools": ["tool1"], "reason": "motivo"}

Exemplos de is_goal=true: "resumir esse PDF", "criar script Python", "instalar dependência", "editar arquivo config"
Exemplos de is_goal=false: "o que é machine learning?", "oi tudo bem?", "obrigado", "como você funciona?"`;

        try {
            const messages: LLMMessage[] = [{ role: 'user', content: prompt }];
            const result = await this.providerFactory.chatWithFallback(
                messages,
                undefined,
                undefined,
                15_000 // 15s timeout para classificação
            );

            if (result.status !== 'success') {
                log.warn('[GoalExtractor] LLM classification failed, defaulting to not-goal');
                return { isGoal: false, confidence: 0.5, reason: 'llm_unavailable' };
            }

            const parsed = this.parseClassificationResponse(result.content);
            log.info(`[GoalExtractor] LLM classified: isGoal=${parsed.isGoal} confidence=${parsed.confidence}`);
            return parsed;
        } catch (err) {
            log.warn('[GoalExtractor] LLM classify error:', String(err));
            return { isGoal: false, confidence: 0.5, reason: 'classify_error' };
        }
    }

    private parseClassificationResponse(content: string): GoalClassification {
        try {
            // Remove markdown code blocks se presentes
            const cleaned = content.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
            const parsed = JSON.parse(cleaned);
            return {
                isGoal: Boolean(parsed.is_goal),
                confidence: Number(parsed.confidence) || 0.5,
                objective: parsed.objective || undefined,
                requiredTools: Array.isArray(parsed.required_tools) ? parsed.required_tools : [],
                reason: parsed.reason || undefined,
            };
        } catch {
            return { isGoal: false, confidence: 0.5, reason: 'parse_error' };
        }
    }

    /** Ponto de entrada principal */
    async classify(message: string, context: ChannelContext): Promise<GoalClassification> {
        const quick = this.quickClassify(message);

        if (quick === true) {
            log.debug(`[GoalExtractor] quick=goal message="${message.slice(0, 60)}"`);
            return {
                isGoal: true,
                confidence: GOAL_LIMITS.QUICK_CLASSIFY_THRESHOLD,
                objective: message.slice(0, 300),
                requiredTools: [],
                reason: 'heuristic_positive',
            };
        }

        if (quick === false) {
            log.debug(`[GoalExtractor] quick=not-goal message="${message.slice(0, 60)}"`);
            return { isGoal: false, confidence: GOAL_LIMITS.QUICK_CLASSIFY_THRESHOLD, reason: 'heuristic_negative' };
        }

        // Inconclusivo — classificação via LLM
        log.debug(`[GoalExtractor] inconclusive, calling LLM for "${message.slice(0, 60)}"`);
        return this.llmClassify(message, context);
    }
}
