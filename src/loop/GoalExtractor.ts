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
    // Relatório de erro técnico com código ou caminho específico — sempre é um goal claro,
    // nunca ambíguo: o erro já identifica o problema e não precisa de clarificação.
    /\b(ERR_[A-Z_]+|ENOENT|EACCES|failed to load|net::|SyntaxError|ReferenceError|TypeError)\b/i,
    /\b(está com (vários |muitos )?erros?|deu erro|erro na linha|exception:|traceback)\b/i,
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

        // Relatório de erro técnico com código específico → goal imediato, sem ambiguidade
        const ERROR_REPORT = /\b(ERR_[A-Z_]+|ENOENT|EACCES|failed to load|net::|SyntaxError|ReferenceError|TypeError)\b/i;
        if (ERROR_REPORT.test(msg)) return true;

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

    private isConstructionHeuristic(message: string): boolean {
        const msg = message.toLowerCase();
        const keywords = [
            'criar jogo', 'desenvolver jogo', 'construir jogo', 'criar app', 'desenvolver app',
            'criar sistema', 'desenvolver sistema', 'implementar sistema', 'criar site',
            'desenvolver site', 'criar tower defense', 'desenvolver tower defense',
            'construir software', 'desenvolver software', 'escrever código para um',
            'criar um bot', 'desenvolver um bot'
        ];
        return keywords.some(k => msg.includes(k));
    }

    /**
     * Estágio 2: classificação via LLM (apenas quando heurística falhou).
     * Detecta também ambiguidade de intenção para pedir clarificação antes de criar o goal.
     */
    private async llmClassify(
        message: string,
        _context: ChannelContext,
        recentMessages?: Array<{ role: string; content: string }>
    ): Promise<GoalClassification> {
        const conversationSnippet = recentMessages && recentMessages.length > 0
            ? '\n\nContexto recente da conversa (últimas mensagens antes desta):\n' +
              recentMessages
                  .map(m => `${m.role === 'assistant' ? 'Assistente' : 'Usuário'}: ${m.content.slice(0, 300)}`)
                  .join('\n') +
              '\n\n'
            : '\n\n';

        const prompt = `Classifique a mensagem abaixo em três dimensões:
1. É um goal (requer execução de tarefas com ferramentas)?
2. Se for goal, a intenção é AMBÍGUA (não está claro qual arquivo, formato ou ação específica)?
3. É um projeto de construção de software ou desenvolvimento de funcionalidade complexa (ex: criar um jogo, desenvolver um site, implementar um sistema, criar um módulo ou script complexo)?
${conversationSnippet}Mensagem atual do usuário: "${message.slice(0, 300)}"

Responda APENAS com JSON válido, sem markdown:
{"is_goal": boolean, "confidence": 0.0-1.0, "objective": "descrição se for goal", "required_tools": ["tool1"], "reason": "motivo", "is_ambiguous": boolean, "clarification_question": "pergunta ao usuário se is_ambiguous=true", "is_construction": boolean}

Regras:
- is_ambiguous=true SOMENTE quando is_goal=true E a intenção é genuinamente vaga (sem arquivo, sem erro específico)
- Relatórios de erro técnico com código ou path específico são NUNCA ambíguos: o erro já identifica o problema
- Se o contexto recente mostra que o usuário está respondendo a uma lista de opções ou confirmando uma escolha, is_goal=false
- Exemplos is_ambiguous=true: "essa versão não consigo editar" (qual arquivo?), "pode corrigir?" (o quê exatamente?)
- Exemplos is_ambiguous=false: "criar apresentação sobre Python com 10 slides", "resumir o PDF que enviei"
- Exemplos is_ambiguous=false (erros técnicos): "style.css:1 Failed to load resource: net::ERR_FILE_NOT_FOUND", "TypeError: cannot read property of undefined at line 42", "está com vários erros: SyntaxError no map.js"
- Exemplos is_goal=false: "o que é machine learning?", "oi tudo bem?", "obrigado", seleção de opção de menu, confirmação de escolha`;

        try {
            const messages: LLMMessage[] = [{ role: 'user', content: prompt }];
            // 45s: kimi-k2.6 pode gastar 30s+ só em thinking antes de gerar output.
            // Com 30s o stream era abortado e o sistema recuperava o thinking como conteúdo
            // (fallback funcional mas com latência extra e classificação subótima).
            const result = await this.providerFactory.chatWithFallback(
                messages,
                undefined,
                undefined,
                45_000
            );

            if (result.status !== 'success') {
                log.warn('[GoalExtractor] LLM classification failed, defaulting to not-goal');
                return { isGoal: false, confidence: 0.5, reason: 'llm_unavailable' };
            }

            const parsed = this.parseClassificationResponse(result.content);
            log.info(`[GoalExtractor] LLM classified: isGoal=${parsed.isGoal} isAmbiguous=${parsed.isAmbiguous} confidence=${parsed.confidence}`);
            return parsed;
        } catch (err) {
            log.warn('[GoalExtractor] LLM classify error:', String(err));
            return { isGoal: false, confidence: 0.5, reason: 'classify_error' };
        }
    }

    private parseClassificationResponse(content: string): GoalClassification {
        try {
            const cleaned = content.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
            const parsed = JSON.parse(cleaned);
            return {
                isGoal: Boolean(parsed.is_goal),
                confidence: Number(parsed.confidence) || 0.5,
                objective: parsed.objective || undefined,
                requiredTools: Array.isArray(parsed.required_tools) ? parsed.required_tools : [],
                reason: parsed.reason || undefined,
                isAmbiguous: Boolean(parsed.is_ambiguous),
                clarificationQuestion: parsed.clarification_question || undefined,
                isConstruction: Boolean(parsed.is_construction),
            };
        } catch {
            return { isGoal: false, confidence: 0.5, reason: 'parse_error' };
        }
    }

    /** Ponto de entrada principal */
    async classify(
        message: string,
        context: ChannelContext,
        recentMessages?: Array<{ role: string; content: string }>
    ): Promise<GoalClassification> {
        const quick = this.quickClassify(message);

        if (quick === true) {
            log.debug(`[GoalExtractor] quick=goal message="${message.slice(0, 60)}"`);
            return {
                isGoal: true,
                confidence: GOAL_LIMITS.QUICK_CLASSIFY_THRESHOLD,
                objective: message.slice(0, 300),
                requiredTools: [],
                reason: 'heuristic_positive',
                isConstruction: this.isConstructionHeuristic(message),
            };
        }

        if (quick === false) {
            log.debug(`[GoalExtractor] quick=not-goal message="${message.slice(0, 60)}"`);
            return { isGoal: false, confidence: GOAL_LIMITS.QUICK_CLASSIFY_THRESHOLD, reason: 'heuristic_negative' };
        }

        // Inconclusivo — classificação via LLM com contexto recente da conversa
        log.debug(`[GoalExtractor] inconclusive, calling LLM for "${message.slice(0, 60)}"`);
        return this.llmClassify(message, context, recentMessages);
    }
}
