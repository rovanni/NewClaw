/**
 * ConfidenceClassifier — Classificação de confiança de conteúdo
 * 
 * Toda memória é classificada por origem:
 * - FACT: fato verificado (0.95)
 * - TOOL_RESULT: resultado de ferramenta (0.9)
 * - USER_INPUT: input direto do usuário (0.85)
 * - REASONING: raciocínio do CognitiveWorkspace (0.7) — NÃO persistir
 * - INFERENCE: inferência do LLM (0.6)
 * - HYPOTHESIS: hipótese (0.3, TTL curto)
 * - SPECULATION: especulação (0.1, TTL mínimo)
 * 
 * Uso:
 *   const classifier = new ConfidenceClassifier();
 *   const classified = classifier.classify('BTC está a $70k', 'tool_result', 'crypto_analysis');
 *   // → { confidence: 'TOOL_RESULT', score: 0.9, ttl: 720h }
 */

import { Confidence, CONFIDENCE_SCORES, CONFIDENCE_TTL, ClassifiedContent } from './EventBus';
import { createLogger } from '../shared/AppLogger';

const log = createLogger('ConfidenceClassifier');

export interface ClassificationInput {
    content: string;
    source: string;  // 'tool_result', 'user_input', 'llm_inference', 'llm_hypothesis', 'memory_recall', 'web_search'
    metadata?: Record<string, any>;
}

export interface ClassificationResult {
    confidence: Confidence;
    score: number;
    ttl: number;      // horas
    source: string;
    reason: string;
}

// ── Source → Confidence mapping ─────────────────────────────────

const SOURCE_CONFIDENCE_MAP: Record<string, { confidence: Confidence; reason: string }> = {
    // Tool results — verified data
    'tool_result': { confidence: 'TOOL_RESULT', reason: 'Resultado direto de ferramenta' },
    'web_search': { confidence: 'TOOL_RESULT', reason: 'Resultado de busca web verificado' },
    'crypto_analysis': { confidence: 'TOOL_RESULT', reason: 'Análise de mercado via ferramenta' },
    'weather_api': { confidence: 'TOOL_RESULT', reason: 'Dados meteorológicos via API' },
    'exec_command': { confidence: 'TOOL_RESULT', reason: 'Saída de comando verificado' },
    'ssh_exec': { confidence: 'TOOL_RESULT', reason: 'Resultado SSH verificado' },
    'read_file': { confidence: 'TOOL_RESULT', reason: 'Conteúdo de arquivo lido' },

    // User input — trusted but may contain opinions
    'user_input': { confidence: 'USER_INPUT', reason: 'Input direto do usuário' },
    'user_statement': { confidence: 'USER_INPUT', reason: 'Afirmação do usuário' },
    'user_preference': { confidence: 'USER_INPUT', reason: 'Preferência declarada pelo usuário' },

    // LLM outputs — varying confidence
    'llm_inference': { confidence: 'INFERENCE', reason: 'Inferência do modelo de linguagem' },
    'llm_reasoning': { confidence: 'REASONING', reason: 'Raciocínio interno do modelo' },
    'llm_hypothesis': { confidence: 'HYPOTHESIS', reason: 'Hipótese gerada pelo modelo' },
    'llm_speculation': { confidence: 'SPECULATION', reason: 'Especulação do modelo' },

    // Memory — depends on original source
    'memory_recall': { confidence: 'INFERENCE', reason: 'Recall de memória (verificar original)' },
    'memory_graph': { confidence: 'INFERENCE', reason: 'Nó do grafo de memória' },

    // External — lower confidence by default
    'web_scrape': { confidence: 'INFERENCE', reason: 'Conteúdo extraído da web (não verificado)' },
    'unknown': { confidence: 'INFERENCE', reason: 'Fonte desconhecida' },
};

export class ConfidenceClassifier {
    /**
     * Classify content based on source.
     */
    classify(content: string, source: string, metadata?: Record<string, any>): ClassificationResult {
        const mapping = SOURCE_CONFIDENCE_MAP[source] || SOURCE_CONFIDENCE_MAP['unknown'];
        const confidence = mapping.confidence;
        const score = CONFIDENCE_SCORES[confidence];
        const ttl = CONFIDENCE_TTL[confidence];

        // Adjust score based on content heuristics
        const adjustedScore = this.adjustScore(content, score, metadata);

        log.info(`Classified "${content.slice(0, 50)}..." as ${confidence} (${adjustedScore.toFixed(2)}) from ${source}`);

        return {
            confidence,
            score: adjustedScore,
            ttl,
            source,
            reason: mapping.reason,
        };
    }

    /**
     * Classify from LLM response metadata.
     * Determines confidence based on how the LLM categorized its own output.
     */
    classifyFromLLM(content: string, evaluation?: { confidence?: string; is_complete?: boolean }): ClassificationResult {
        if (!evaluation) {
            return this.classify(content, 'llm_inference');
        }

        // Map LLM's self-assessment to our confidence levels
        const llmConfidence = evaluation.confidence?.toLowerCase() || 'medium';

        let source: string;
        switch (llmConfidence) {
            case 'high':
                source = 'llm_inference';
                break;
            case 'medium':
                source = 'llm_inference';
                break;
            case 'low':
                source = 'llm_hypothesis';
                break;
            default:
                source = 'llm_inference';
        }

        return this.classify(content, source);
    }

    /**
     * Create a ClassifiedContent object with expiry time.
     */
    createClassifiedContent(id: string, content: string, source: string, metadata?: Record<string, any>): ClassifiedContent {
        const classification = this.classify(content, source, metadata);

        const now = new Date();
        const expiresAt = classification.ttl === Infinity 
            ? undefined 
            : new Date(now.getTime() + classification.ttl * 60 * 60 * 1000);

        return {
            id,
            content,
            confidence: classification.confidence,
            score: classification.score,
            source: classification.source,
            ttl: classification.ttl,
            createdAt: now,
            expiresAt,
        };
    }

    /**
     * Check if a classified content is expired.
     */
    isExpired(content: ClassifiedContent): boolean {
        if (!content.expiresAt) return false;
        return Date.now() > content.expiresAt.getTime();
    }

    /**
     * Check if a content should be persisted based on confidence.
     * REASONING is never persisted (internal cognition only).
     */
    shouldPersist(confidence: Confidence): boolean {
        return confidence !== 'REASONING';
    }

    /**
     * Adjust score based on content heuristics.
     */
    private adjustScore(content: string, baseScore: number, metadata?: Record<string, any>): number {
        let score = baseScore;

        // Boost for numerical data (likely factual)
        if (/\$\d+[\d,.]*/.test(content) || /\d+(\.\d+)?%/.test(content)) {
            score = Math.min(1.0, score + 0.05);
        }

        // Reduce for hedging language
        const hedging = /\b(talvez|possivelmente|quizá|maybe|probably|might|could be|parece|acho)\b/i;
        if (hedging.test(content)) {
            score = Math.max(0.1, score - 0.1);
        }

        // Reduce for very short content (less informative)
        if (content.length < 20) {
            score = Math.max(0.1, score - 0.05);
        }

        // Apply metadata adjustments
        if (metadata?.verified) {
            score = Math.min(1.0, score + 0.05);
        }
        if (metadata?.uncertain) {
            score = Math.max(0.1, score - 0.1);
        }

        return Math.round(score * 100) / 100;
    }
}

export default ConfidenceClassifier;