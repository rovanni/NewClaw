/**
 * EventRanker — Ranks session events by importance for context prioritization
 * 
 * Scoring factors:
 * - Role: user (3x) > assistant (2x) > tool (1x) > system (0.5x)
 * - Length: longer = more information density (capped)
 * - Recency: newer = more relevant (exponential decay)
 * - Contains question: higher priority
 * - Contains decision/preference: higher priority
 * - Tool success/failure: failure = more important for learning
 */

import { TranscriptEntry } from './SessionTranscript';

export interface RankedEvent {
    event: TranscriptEntry;
    score: number;
    reason: string;
}

export class EventRanker {
    // Decay factor: half-life of 10 messages
    private readonly RECENCY_DECAY = 0.93;
    // Maximum length bonus (chars)
    private readonly MAX_LENGTH_BONUS = 2000;

    /**
     * Rank events by importance. Returns sorted descending by score.
     */
    rank(events: TranscriptEntry[]): RankedEvent[] {
        const totalEvents = events.length;
        
        const ranked = events.map((event, index) => {
            const score = this.calculateScore(event, index, totalEvents);
            const reason = this.explainScore(event, score);
            return { event, score, reason };
        });

        return ranked.sort((a, b) => b.score - a.score);
    }

    /**
     * Get top-N most important events for context building.
     */
    getTopEvents(events: TranscriptEntry[], n: number): RankedEvent[] {
        return this.rank(events).slice(0, n);
    }

    /**
     * Calculate importance score for a single event.
     */
    private calculateScore(event: TranscriptEntry, index: number, totalEvents: number): number {
        let score = 0;

        // 1. Role weight
        const roleWeights: Record<string, number> = {
            'user': 3.0,
            'assistant': 2.0,
            'tool_call': 1.5,
            'tool_result': 1.0,
            'system': 0.5,
            'checkpoint': 0.3
        };
        score += roleWeights[event.role] || 1.0;

        // 2. Content length (information density)
        const contentLen = (event.content || '').length;
        const lengthBonus = Math.min(contentLen, this.MAX_LENGTH_BONUS) / this.MAX_LENGTH_BONUS;
        score += lengthBonus * 2.0;

        // 3. Recency (exponential decay)
        const recency = Math.pow(this.RECENCY_DECAY, totalEvents - index - 1);
        score += recency * 3.0;

        // 4. Question detection (user asking something)
        const content = (event.content || '').toLowerCase();
        if (event.role === 'user') {
            if (content.includes('?') || content.match(/^(como|qual|quando|onde|por que|o que|quantos|pode|consegue)/i)) {
                score += 2.0; // Questions are important
            }
        }

        // 5. Decision/preference detection
        if (content.match(/(?:prefiro|quero|gosto|não gosto|escolho|decidi|vamos|bora|implementa|cria|faz)/i)) {
            score += 2.5; // Decisions and preferences are very important
        }

        // 6. Tool failure (learning opportunity)
        if (event.role === 'tool_result' && event.meta?.tool_success === false) {
            score += 1.5; // Failed tools reveal problems
        }

        // 7. Tool call with high duration (significant operation)
        if (event.meta?.tool_duration_ms && event.meta.tool_duration_ms > 5000) {
            score += 0.5; // Long operations are worth remembering
        }

        // 8. Token count (richer responses)
        if (event.meta?.tokens && event.meta.tokens > 500) {
            score += 1.0;
        }

        return Math.round(score * 100) / 100;
    }

    /**
     * Explain why an event got its score.
     */
    private explainScore(event: TranscriptEntry, score: number): string {
        const reasons: string[] = [];
        const content = (event.content || '').toLowerCase();

        if (event.role === 'user') reasons.push('user_msg');
        if (event.role === 'user' && content.includes('?')) reasons.push('question');
        if (content.match(/(?:prefiro|quero|gosto|implementa|cria)/i)) reasons.push('decision');
        if (event.meta?.tool_success === false) reasons.push('tool_fail');
        if (event.meta?.tokens && event.meta.tokens > 500) reasons.push('rich_response');

        return `score=${score} [${reasons.join(',')}]`;
    }
}