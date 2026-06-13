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

// P0.4 — timeout dedicado ao classificador: uma resposta binária não justifica 45s.
// 15s acomoda modelos que emitem thinking tokens antes do JSON (ex: minimax-m3).
// Abaixo de 8s, modelos com reasoning pipeline ultrapassam o limite e o conteúdo
// recuperado é o thinking em texto natural, que não é JSON → fail-open indesejado.
const GOAL_EXTRACTOR_TIMEOUT_MS = 15_000;

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

/**
 * Frases que são sempre goals NÃO-AMBÍGUOS porque existe uma tool específica
 * que as resolve sem precisar de critérios adicionais do usuário.
 * Curto-circuita o LLM — nenhuma clarificação deve ser pedida.
 */
const UNAMBIGUOUS_TOOL_PATTERNS: RegExp[] = [
    // organize_workspace / analyze_workspace_groups
    /\b(organiz|reorganiz|arruma)\w*\s+(meu\s+)?(workspace|arquivos|pasta|diret[oó]rio)\b/i,
    /\banalise?\s+(os\s+)?grupos?\s+(do\s+)?(meu\s+)?workspace\b/i,
    /\b(organize?|reorganize?)\s+(my\s+)?workspace\b/i,
];

/** Padrões que indicam CLARAMENTE conversa simples (não goal) */
const NOT_GOAL_SIGNALS: RegExp[] = [
    /^(oi|ol[aá]|hey|e a[ií]|tudo\s+bem|bom\s+dia|boa\s+tarde|boa\s+noite)\b/i,
    /^(o\s+que\s+[eé]|me\s+explica|como\s+funciona|qual\s+[eé]\s+a\s+diferen[cç]a)\b/i,
    /^(voc[eê]\s+[eé]|quem\s+[eé]\s+voc[eê]|o\s+que\s+voc[eê]\s+pode)\b/i,
    /^(obrigad[ao]|valeu|vlw|entendi|ok|perfeito|show|[oó]timo)\b/i,
    /\?$/, // perguntas simples terminando em ?
    // Dados suplementares sendo fornecidos pelo usuário — não são comandos
    /\bconteúdo\s+programático\b/i,
    /^(turma:|quantidade\s+de\s+alunos:|período:|hor[aá]rio:)/im,
    /^(Excel|Word|PowerPoint|Calc)\s+(Básico|Intermediário|Avançado)\b/im,
    // Mensagens de esclarecimento contextual — o usuário está DESCREVENDO algo, não comandando.
    // Padrão: "X [é/e] um [curso/sistema/projeto] de A, B e C" — definição nominal sem verbo imperativo.
    // Ex: "Assistente de TI e um curso de montagem e manutenção de computadores, instalação de SO..."
    // Mesmo que contenham substantivos de ação (instalação, configuração), são listas descritivas.
    /^[\w\s]+\s+[eé]\s+um[a]?\s+(curso|disciplina|módulo|treinamento|programa|sistema|projeto|aplicativo)\s+(de|sobre|para)\b/i,
    // Correção/ajuste da mensagem anterior sem novo pedido explícito: "Estava me referindo a..."
    /^(estava\s+me\s+referindo|me\s+referia|quis\s+dizer|na\s+verdade\s+(é|eu)|só\s+queria|era\s+(sobre|para))\b/i,
    // Confirmação ou reconhecimento sem novo objetivo
    /^(isso|exato|exatamente|correto|é\s+isso|isso\s+mesmo|sim\s*,?\s*(é|foi))\b/i,
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
        }

        if (matches >= 1) {
            // Guardrail anti-nominal (Sugestão 1): padrões como instala[r]? e configur[ae]
            // disparam para substantivos deverbais ("instalação", "configuração") porque \b em
            // JavaScript é ASCII-only e trata 'ç'/'ã' como não-palavras. Resultado: "instalação"
            // coincide com `instala[r]?` via short-match antes do sufixo nominal.
            // Heurística: se há ≥2 formas nominais (sufixos ção/ões/mento/agem) e nenhum
            // verbo de ação explícito no infinitivo, a mensagem descreve conteúdo — não comanda.
            const nominalCount = (msg.match(/\b\w+(?:ção|ções|mento|mentos|agem|agens)\b/gi) ?? []).length;
            if (nominalCount >= 2 && matches < 3) {
                const actionVerbCount = (msg.match(
                    /\b(criar?|fazer?|gerar?|produzir?|executar?|instalar?|baixar?|converter?|processar?|editar?|modificar?|atualizar?|pesquisar?|verificar?|implementar?|configurar?|adicionar?|remover?|copiar?|mover?|analisar?|resumir?)\b/gi
                ) ?? []).length;
                if (actionVerbCount === 0) {
                    log.debug(`[GoalExtractor] nominal_guardrail: nominals=${nominalCount} action_verbs=0 matches=${matches} → null (LLM)`);
                    return null;
                }
            }
            if (matches >= 2) return true;
            // Mensagem longa com pelo menos 1 sinal positivo → provavelmente goal
            if (msg.length > 50) return true;
        }

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

        const prompt = `Classifique a mensagem abaixo em cinco dimensões:
1. É um goal (requer execução de tarefas com ferramentas)?
2. Se for goal, a intenção é AMBÍGUA (não está claro qual arquivo, formato ou ação específica)?
3. É um projeto de construção de software ou desenvolvimento de funcionalidade complexa (ex: criar um jogo, desenvolver um site, implementar um sistema, criar um módulo ou script complexo)?
4. Existe evidência textual EXPLÍCITA do objetivo no texto do usuário, ou o objetivo foi inferido a partir dos dados fornecidos?
5. É uma REFINAMENTO/CLARIFICAÇÃO de um goal recente do contexto (o usuário está complementando ou corrigindo o pedido anterior, sem criar um objetivo completamente novo)?
${conversationSnippet}Mensagem atual do usuário: "${message.slice(0, 300)}"

Responda APENAS com JSON válido, sem markdown:
{"is_goal": boolean, "confidence": 0.0-1.0, "objective": "descrição se for goal", "required_tools": ["tool1"], "reason": "motivo", "is_ambiguous": boolean, "clarification_question": "pergunta ao usuário se is_ambiguous=true", "is_construction": boolean, "has_explicit_evidence": boolean, "is_refinement": boolean}

Regras:
- is_ambiguous=true SOMENTE quando is_goal=true E a intenção é genuinamente vaga (sem arquivo, sem erro específico)
- is_refinement=true quando: (a) o contexto recente mostra um goal concluído, (b) a mensagem atual é contextual/descritiva sem verbo imperativo novo, e (c) a mensagem complementa o goal anterior em vez de iniciar um objetivo diferente. Neste caso is_goal deve ser false.
- Exemplo is_refinement=true: contexto="gere discurso de encerramento do curso de TI", mensagem="Assistente de TI é um curso de montagem, instalação de SO e redes" — o usuário está descrevendo o curso para contextualizar o pedido anterior, não pedindo algo novo.
- Relatórios de erro técnico com código ou path específico são NUNCA ambíguos: o erro já identifica o problema
- Se o contexto recente mostra que o usuário está respondendo a uma lista de opções ou confirmando uma escolha, is_goal=false
- Exemplos is_ambiguous=true: "essa versão não consigo editar" (qual arquivo?), "pode corrigir?" (o quê exatamente?)
- Exemplos is_ambiguous=false: "criar apresentação sobre Python com 10 slides", "resumir o PDF que enviei"
- Exemplos is_ambiguous=false (workspace): "organize meu workspace", "reorganize os arquivos", "analise os grupos do workspace", "arrume meu workspace" — existe uma ferramenta específica que resolve sem precisar de critérios adicionais
- Exemplos is_ambiguous=false (erros técnicos): "style.css:1 Failed to load resource: net::ERR_FILE_NOT_FOUND", "TypeError: cannot read property of undefined at line 42", "está com vários erros: SyntaxError no map.js"
- Exemplos is_goal=false: "o que é machine learning?", "oi tudo bem?", "obrigado", seleção de opção de menu, confirmação de escolha, mensagens descritivas/contextuais sem pedido de ação
- has_explicit_evidence=true: "criar cronograma", "gerar relatório", "montar planilha" — objetivo dito explicitamente
- has_explicit_evidence=false: usuário envia turma/datas/conteúdo sem pedir ação — objetivo inferido dos dados`;

        try {
            const messages: LLMMessage[] = [{ role: 'user', content: prompt }];
            // P0.4: timeout de 8s — classificação binária não justifica 45s de espera.
            // P0.1: se o stream expirar e o provider recuperar o campo "thinking" como content,
            //       parseClassificationResponse não encontrará JSON válido e devolverá reason:'parse_error'.
            //       Ambos os casos (status!=success e parse_error) caem no fail-open para AgentLoop.
            const result = await this.providerFactory.chatWithFallback(
                messages,
                undefined,
                undefined,
                GOAL_EXTRACTOR_TIMEOUT_MS
            );

            if (result.status !== 'success') {
                log.warn(`[GoalExtractor] LLM classification failed status=${result.status} — fail-open to AgentLoop`);
                return { isGoal: false, confidence: 0.5, reason: 'goal_extractor_timeout', timedOut: true };
            }

            // P0.1 — verifica se o conteúdo é JSON válido ANTES de usá-lo.
            // Quando o provider recupera o campo "thinking" como fallback de conteúdo,
            // o texto começa com linguagem natural ("Vou analisar…"), não com '{'.
            // Nesse caso descartamos e fazemos fail-open — thinking jamais vira classificação.
            const trimmed = result.content.trim();
            const looksLikeJson = trimmed.startsWith('{') || trimmed.startsWith('```');
            if (!looksLikeJson) {
                log.warn(`[GoalExtractor] content does not look like JSON (likely recovered thinking) — discarding, fail-open to AgentLoop`);
                return { isGoal: false, confidence: 0.5, reason: 'goal_extractor_timeout', timedOut: true };
            }

            const parsed = this.parseClassificationResponse(result.content);
            // Se parse falhou (conteúdo era thinking disfarçado de JSON) → fail-open
            if (parsed.reason === 'parse_error') {
                log.warn('[GoalExtractor] parse_error — content was not valid classification JSON, fail-open to AgentLoop');
                return { isGoal: false, confidence: 0.5, reason: 'goal_extractor_timeout', timedOut: true };
            }

            log.info(`[GoalExtractor] LLM classified: isGoal=${parsed.isGoal} isAmbiguous=${parsed.isAmbiguous} confidence=${parsed.confidence}`);
            return parsed;
        } catch (err) {
            log.warn('[GoalExtractor] LLM classify error:', String(err));
            return { isGoal: false, confidence: 0.5, reason: 'goal_extractor_timeout', timedOut: true };
        }
    }

    private parseClassificationResponse(content: string): GoalClassification {
        try {
            const cleaned = content.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
            const parsed = JSON.parse(cleaned);
            const isRefinement = Boolean(parsed.is_refinement);
            return {
                isGoal: isRefinement ? false : Boolean(parsed.is_goal),
                confidence: Number(parsed.confidence) || 0.5,
                objective: parsed.objective || undefined,
                requiredTools: Array.isArray(parsed.required_tools) ? parsed.required_tools : [],
                reason: isRefinement ? 'refinement_of_recent_goal' : (parsed.reason || undefined),
                isAmbiguous: Boolean(parsed.is_ambiguous),
                clarificationQuestion: parsed.clarification_question || undefined,
                isConstruction: Boolean(parsed.is_construction),
                hasExplicitEvidence: parsed.has_explicit_evidence !== false,
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
        const startMs = Date.now();
        let usedLLM = false;
        let result: GoalClassification;

        const quick = this.quickClassify(message);

        if (quick === true) {
            log.debug(`[GoalExtractor] quick=goal message="${message.slice(0, 60)}"`);
            result = {
                isGoal: true,
                confidence: GOAL_LIMITS.QUICK_CLASSIFY_THRESHOLD,
                objective: message.slice(0, 300),
                requiredTools: [],
                reason: 'heuristic_positive',
                isConstruction: this.isConstructionHeuristic(message),
            };
        } else if (quick === false) {
            log.debug(`[GoalExtractor] quick=not-goal message="${message.slice(0, 60)}"`);
            result = { isGoal: false, confidence: GOAL_LIMITS.QUICK_CLASSIFY_THRESHOLD, reason: 'heuristic_negative' };
        } else {
            // Tool-specific shortcut: frases com tool dedicada nunca precisam de clarificação
            const isUnambiguousTool = UNAMBIGUOUS_TOOL_PATTERNS.some(p => p.test(message.trim()));
            if (isUnambiguousTool) {
                log.info(`[GoalExtractor] unambiguous_tool_match — skipping LLM classify for "${message.slice(0, 60)}"`);
                result = {
                    isGoal: true,
                    confidence: 0.90,
                    objective: message.slice(0, 300),
                    requiredTools: [],
                    reason: 'unambiguous_tool_available',
                    isAmbiguous: false,
                    isConstruction: false,
                    hasExplicitEvidence: true,
                };
            } else {
                // Inconclusivo — classificação via LLM com contexto recente da conversa
                usedLLM = true;
                log.debug(`[GoalExtractor] inconclusive, calling LLM for "${message.slice(0, 60)}"`);
                result = await this.llmClassify(message, context, recentMessages);
            }
        }

        // Fase 1 — telemetria estruturada do GoalExtractor.
        // Emite latência, modelo, rota e resultado para coleta de métricas de produção.
        const latencyMs = Date.now() - startMs;
        const modelName = this.getDefaultModelName();
        const route = result.isGoal ? 'goal_orchestrator' : 'agentloop';
        log.info(
            `[GOAL-EXTRACTOR]` +
            ` model=${modelName}` +
            ` latencyMs=${latencyMs}` +
            ` timeout=${result.timedOut ?? false}` +
            ` parseError=${result.reason === 'parse_error'}` +
            ` usedLLM=${usedLLM}` +
            ` route=${route}` +
            ` confidence=${result.confidence}` +
            ` reason=${result.reason ?? 'none'}`
        );

        return result;
    }

    /** Retorna o nome do modelo atualmente configurado no provider padrão. */
    private getDefaultModelName(): string {
        try {
            const provider = this.providerFactory.getProvider() as { getModel?: () => string };
            return provider.getModel?.() ?? 'default';
        } catch {
            return 'default';
        }
    }
}
