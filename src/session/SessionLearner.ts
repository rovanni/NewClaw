/**
 * SessionLearner — Extracts facts from session transcripts into the cognitive graph
 * 
 * Pipeline:
 * 1. Read recent session events
 * 2. Extract entities, facts, preferences
 * 3. Rank by importance (user messages > tool results > system messages)
 * 4. Upsert into MemoryManager graph nodes + edges
 * 
 * This closes the loop: Session → Facts → Graph → Context → LLM → Session
 */

import { SessionManager, SessionKey } from './SessionManager';
import { MemoryManager } from '../memory/MemoryManager';
import { TranscriptEntry } from './SessionTranscript';

export interface ExtractedFact {
    type: 'identity' | 'preference' | 'project' | 'fact' | 'skill' | 'infrastructure';
    name: string;
    content: string;
    confidence: number;
    source: string;    // session key where it was extracted
    sourceSeq: number; // sequence number in transcript
}

export interface SessionLearningResult {
    factsExtracted: number;
    nodesCreated: number;
    edgesCreated: number;
    facts: ExtractedFact[];
}

export class SessionLearner {
    private sessionManager: SessionManager;
    private memory: MemoryManager;
    private processedSeqs: Map<string, number> = new Map(); // last processed seq per session

    constructor(sessionManager: SessionManager, memory: MemoryManager) {
        this.sessionManager = sessionManager;
        this.memory = memory;
    }

    /**
     * Learn from recent session events.
     * Call this periodically (e.g., after each assistant response or on checkpoint).
     */
    async learnFromSession(key: SessionKey): Promise<SessionLearningResult> {
        const sid = `${key.channel}:${key.userId}`;
        const result: SessionLearningResult = {
            factsExtracted: 0,
            nodesCreated: 0,
            edgesCreated: 0,
            facts: []
        };

        const transcript = await this.sessionManager.getOrCreateSession(key);
        const lastProcessed = this.processedSeqs.get(sid) || 0;

        // Get events since last processing
        const events = transcript.replay(lastProcessed + 1);
        if (events.length === 0) return result;

        // Filter to learnable events
        const learnableEvents = events.filter(e =>
            e.role === 'user' || e.role === 'assistant'
        );

        for (const event of learnableEvents) {
            const facts = this.extractFacts(event, sid);
            for (const fact of facts) {
                result.factsExtracted++;
                const created = this.upsertFact(fact);
                if (created === 'node') result.nodesCreated++;
                if (created === 'edge') result.edgesCreated++;
                result.facts.push(fact);
            }
        }

        // Mark last processed sequence
        const lastEvent = events[events.length - 1];
        if (lastEvent) {
            this.processedSeqs.set(sid, lastEvent.seq);
        }

        if (result.factsExtracted > 0) {
            console.log(`[SESSION-LEARNER] ${sid}: extracted ${result.factsExtracted} facts, created ${result.nodesCreated} nodes, ${result.edgesCreated} edges`);
        }

        return result;
    }

    /**
     * Extract facts from a single transcript event.
     * Uses pattern matching (no LLM needed for common patterns).
     */
    private extractFacts(event: TranscriptEntry, source: string): ExtractedFact[] {
        const facts: ExtractedFact[] = [];
        const content = event.content.toLowerCase();

        // Pattern: User mentions a name
        const nameMatch = content.match(/(?:meu nome é|eu sou o|eu sou a|chamo-me|me cham[ao])\s+(\w+)/i);
        if (nameMatch) {
            facts.push({
                type: 'identity',
                name: `user_name_${nameMatch[1].toLowerCase()}`,
                content: `Nome do usuário: ${nameMatch[1]}`,
                confidence: 0.9,
                source,
                sourceSeq: event.seq
            });
        }

        // Pattern: User mentions a preference
        const prefMatch = content.match(/(?:eu prefiro|gosto mais de|prefiro|adoro|amo|não gosto de|odeio|detesto)\s+(.+?)(?:\.|!|,|$)/i);
        if (prefMatch) {
            facts.push({
                type: 'preference',
                name: `pref_${prefMatch[1].slice(0, 30).replace(/\s+/g, '_')}`,
                content: `Preferência: ${prefMatch[1].trim()}`,
                confidence: 0.7,
                source,
                sourceSeq: event.seq
            });
        }

        // Pattern: User mentions a project/tool
        const projectMatch = content.match(/(?:estou trabalhando|estou fazendo|tô fazendo|projeto|projeto de| desenvolvendo|criando)\s+(.+?)(?:\.|!|,|$)/i);
        if (projectMatch) {
            facts.push({
                type: 'project',
                name: `proj_${projectMatch[1].slice(0, 30).replace(/\s+/g, '_')}`,
                content: `Projeto: ${projectMatch[1].trim()}`,
                confidence: 0.8,
                source,
                sourceSeq: event.seq
            });
        }

        // Pattern: Technical details (IPs, servers, paths)
        const serverMatch = content.match(/(?:servidor|server|vps|máquina)\s+(\S+)\s+(?:no|em|na)\s+(\S+)/i);
        if (serverMatch) {
            facts.push({
                type: 'infrastructure',
                name: `infra_${serverMatch[1].toLowerCase()}`,
                content: `Servidor: ${serverMatch[1]} em ${serverMatch[2]}`,
                confidence: 0.85,
                source,
                sourceSeq: event.seq
            });
        }

        // Pattern: User mentions learning/studying
        const studyMatch = content.match(/(?:estudando|aprendendo|curso de|aula de|estudar)\s+(.+?)(?:\.|!|,|$)/i);
        if (studyMatch) {
            facts.push({
                type: 'fact',
                name: `study_${studyMatch[1].slice(0, 30).replace(/\s+/g, '_')}`,
                content: `Estudando: ${studyMatch[1].trim()}`,
                confidence: 0.75,
                source,
                sourceSeq: event.seq
            });
        }

        // Pattern: User mentions skill/tool
        const skillMatch = content.match(/(?:sei usar|uso|trabalho com|programo em|domínio de|experiência em)\s+(.+?)(?:\.|!|,|$)/i);
        if (skillMatch) {
            facts.push({
                type: 'skill',
                name: `skill_${skillMatch[1].slice(0, 30).replace(/\s+/g, '_')}`,
                content: `Habilidade: ${skillMatch[1].trim()}`,
                confidence: 0.8,
                source,
                sourceSeq: event.seq
            });
        }

        // Important: user messages with high information density (longer messages)
        if (event.role === 'user' && content.length > 100 && facts.length === 0) {
            // No pattern matched but significant content — extract as general fact
            const summary = event.content.slice(0, 150).replace(/\n/g, ' ').trim();
            facts.push({
                type: 'fact',
                name: `fact_${event.seq}`,
                content: summary,
                confidence: 0.5,
                source,
                sourceSeq: event.seq
            });
        }

        return facts;
    }

    /**
     * Upsert a fact into the MemoryManager graph.
     * Returns 'node' if a new node was created, 'edge' if only an edge, or 'none'.
     */
    private upsertFact(fact: ExtractedFact): 'node' | 'edge' | 'none' {
        try {
            const existingNode = this.memory.getNode(fact.name);

            if (existingNode) {
                // Update confidence if new fact is more confident or more recent
                if (fact.confidence > (existingNode.confidence || 0)) {
                    this.memory.addNode({
                        id: fact.name,
                        type: fact.type,
                        name: fact.name,
                        content: fact.content,
                        confidence: fact.confidence,
                        weight: (existingNode.weight || 1) + 0.1, // Boost weight on reaffirmation
                        last_updated: new Date().toISOString()
                    });
                    return 'node';
                }
                // Update weight (reaffirmation)
                this.memory.addNode({
                    ...existingNode,
                    weight: (existingNode.weight || 1) + 0.05,
                    last_updated: new Date().toISOString()
                } as any);
                return 'edge';
            }

            // Create new node
            this.memory.addNode({
                id: fact.name,
                type: fact.type,
                name: fact.name,
                content: fact.content,
                confidence: fact.confidence,
                weight: 1.0,
                last_updated: new Date().toISOString()
            });

            // Create edge from user identity to this fact
            const userId = fact.source.replace(':', '_');
            try {
                this.memory.addEdge(userId, fact.name, 'has_preference', 0.5, fact.confidence);
            } catch {
                // Edge might already exist or source node might not exist
            }

            return 'node';
        } catch (err) {
            console.warn(`[SESSION-LEARNER] Failed to upsert fact ${fact.name}:`, (err as Error).message);
            return 'none';
        }
    }

    /**
     * Get learning stats for a session.
     */
    getLearningStats(key: SessionKey): { lastProcessedSeq: number } {
        const sid = `${key.channel}:${key.userId}`;
        return { lastProcessedSeq: this.processedSeqs.get(sid) || 0 };
    }
}