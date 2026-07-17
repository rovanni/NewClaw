/**
 * CMIInspectTool — Ferramentas de inspeção do Conversational Memory Index.
 *
 * Fase 2: observabilidade ANTES de integrar retrieval no AgentLoop.
 *
 * Ações:
 *   recent  — últimos chunks (validar summaries, qualidade, topics)
 *   search  — busca textual manual (debug, sem retrieval automático)
 *   stats   — estatísticas globais do CMI
 *   inspect — inspecionar um chunk específico por ID
 *
 * Uso: "cmi_inspect recent", "cmi_inspect search query=pdf", "cmi_inspect stats"
 */

import type { ToolExecutor, ToolResult } from '../loop/agentLoopTypes';
import type { CMIEngine } from '../memory/conversational/CMIEngine';
import type { ConversationChunk } from '../memory/conversational/cmiTypes';
import { errorMessage } from '../shared/errors';

export class CMIInspectTool implements ToolExecutor {
    name = 'cmi_inspect';
    description = 'Inspecionar o Conversational Memory Index (CMI). Ações: recent=últimos chunks, search=busca textual, stats=estatísticas, inspect=chunk por ID. Ferramenta de observabilidade e debug da memória episódica.';
    parameters = {
        type: 'object',
        properties: {
            action: {
                type: 'string',
                enum: ['recent', 'search', 'stats', 'inspect'],
                description: 'recent=últimos chunks | search=busca textual | stats=estatísticas globais | inspect=chunk por ID'
            },
            query: {
                type: 'string',
                description: 'Texto para busca (apenas para action=search)'
            },
            id: {
                type: 'string',
                description: 'ID do chunk para action=inspect'
            },
            session: {
                type: 'string',
                description: 'Filtrar por session_key (ex: telegram:12345). Opcional para recent.'
            },
            limit: {
                type: 'number',
                description: 'Número de resultados (padrão: 5)'
            }
        },
        required: ['action']
    };

    private engine: CMIEngine;

    constructor(engine: CMIEngine) {
        this.engine = engine;
    }

    async execute(args: Record<string, unknown>): Promise<ToolResult> {
        const action = args.action as string;
        const query   = (args.query   as string) || '';
        const id      = (args.id      as string) || '';
        const session = (args.session as string) || '';
        const limit   = Math.min((args.limit as number) || 5, 20);

        try {
            switch (action) {
                case 'recent':  return this.recent(session, limit);
                case 'search':  return this.search(query, limit);
                case 'stats':   return this.stats();
                case 'inspect': return this.inspect(id);
                default:
                    return { success: false, output: '', error: `Ação "${action}" inválida.` };
            }
        } catch (err) {
            return { success: false, output: '', error: `CMI erro: ${errorMessage(err)}` };
        }
    }

    // ── RECENT ─────────────────────────────────────────────────────────────────

    private recent(session: string, limit: number): ToolResult {
        const repo = this.engine.getRepository();
        const chunks = session
            ? repo.findBySession(session, limit)
            : repo.findRecent(limit);

        if (chunks.length === 0) {
            return { success: true, output: 'Nenhum chunk encontrado. O CMI ainda não acumulou episódios.' };
        }

        let out = `📚 ${chunks.length} chunk(s) recente(s)${session ? ` [${session}]` : ''}:\n\n`;
        for (const c of chunks) {
            out += this.formatChunkBrief(c);
            out += '\n';
        }
        out += `\nUse cmi_inspect inspect id=<id> para detalhes completos.`;
        return { success: true, output: out };
    }

    // ── SEARCH ─────────────────────────────────────────────────────────────────

    private search(query: string, limit: number): ToolResult {
        if (!query.trim()) {
            return { success: false, output: '', error: 'Informe query para busca.' };
        }

        const repo = this.engine.getRepository();
        const chunks = repo.searchByText(query, limit);

        if (chunks.length === 0) {
            return { success: true, output: `Nenhum chunk encontrado para: "${query}"` };
        }

        let out = `🔍 ${chunks.length} chunk(s) para "${query}":\n\n`;
        for (const c of chunks) {
            out += this.formatChunkBrief(c);
            out += '\n';
        }
        return { success: true, output: out };
    }

    // ── STATS ──────────────────────────────────────────────────────────────────

    private stats(): ToolResult {
        const repo = this.engine.getRepository();
        const s = repo.getStats();
        const eng = this.engine.getStats();

        let out = `📊 CMI — Conversational Memory Index\n`;
        out += `${'─'.repeat(40)}\n\n`;

        out += `Chunks:\n`;
        out += `  Total:        ${s.totalChunks}\n`;
        out += `  Sessões:      ${s.totalSessions}\n`;
        out += `  Últimos 7d:   ${s.recentChunks}\n`;
        out += `  Com embedding: ${s.chunksWithEmbedding} / ${s.totalChunks}\n`;
        out += `  Storage est.: ~${s.storageEstimateKb} KB\n\n`;

        out += `Qualidade:\n`;
        out += `  Média:        ${s.avgQuality.toFixed(2)}\n`;
        out += `  Alta (≥0.7):  ${s.qualityDistribution.high}\n`;
        out += `  Média (0.4-0.7): ${s.qualityDistribution.medium}\n`;
        out += `  Baixa (<0.4): ${s.qualityDistribution.low}\n\n`;

        if (s.topTopics.length > 0) {
            out += `Top tópicos:\n`;
            for (const t of s.topTopics.slice(0, 5)) {
                out += `  ${t.name}: ${t.count}\n`;
            }
            out += '\n';
        }

        if (s.topEntities.length > 0) {
            out += `Top entidades:\n`;
            for (const e of s.topEntities.slice(0, 5)) {
                out += `  ${e.name}: ${e.count}\n`;
            }
            out += '\n';
        }

        out += `Engine:\n`;
        out += `  Entradas processadas: ${eng.entriesFed}\n`;
        out += `  Chunks criados:       ${eng.chunksCreated}\n`;
        out += `  Chunks descartados:   ${eng.chunksDiscarded}\n`;
        out += `  Embeddings gerados:   ${eng.embeddings}\n`;
        out += `  Ciclos GC:            ${eng.gcRuns}\n`;

        return { success: true, output: out };
    }

    // ── INSPECT ────────────────────────────────────────────────────────────────

    private inspect(id: string): ToolResult {
        if (!id) {
            return { success: false, output: '', error: 'Informe id do chunk.' };
        }

        const repo = this.engine.getRepository();
        const chunk = repo.findById(id);
        if (!chunk) {
            return { success: false, output: '', error: `Chunk "${id}" não encontrado.` };
        }

        const age = this.formatAge(chunk.createdAt);
        const ttl = chunk.expiresAt
            ? this.formatAge(chunk.expiresAt) + ' (expira)'
            : 'sem expiração';

        let out = `🔍 Chunk: ${chunk.id}\n`;
        out += `${'─'.repeat(50)}\n`;
        out += `Session:    ${chunk.sessionKey}\n`;
        out += `Trigger:    ${chunk.cutTrigger}\n`;
        out += `Qualidade:  ${chunk.chunkQuality.toFixed(2)}\n`;
        out += `Criado:     ${age} atrás\n`;
        out += `TTL:        ${ttl}\n`;
        out += `Acessos:    ${chunk.accessCount}\n`;
        out += `Embedding:  ${chunk.embedding ? `✅ (${chunk.embedding.length / 8} dims)` : '❌ ausente'}\n\n`;

        out += `Seqs:       ${chunk.startSeq} → ${chunk.endSeq}\n`;
        out += `Período:    ${new Date(chunk.startTimestamp).toLocaleString('pt-BR')} → ${new Date(chunk.endTimestamp).toLocaleString('pt-BR')}\n\n`;

        if (chunk.topics.length > 0) out += `Tópicos:    ${chunk.topics.join(', ')}\n`;
        if (chunk.entities.length > 0) out += `Entidades:  ${chunk.entities.join(', ')}\n`;
        if (chunk.toolsUsed.length > 0) out += `Tools:      ${chunk.toolsUsed.join(', ')}\n`;
        if (chunk.intent) out += `Intent:     ${chunk.intent}\n`;

        out += `\n📝 Summary:\n${chunk.summary}\n`;

        if (chunk.messages.length > 0) {
            out += `\n💬 Mensagens (${chunk.messages.length}):\n`;
            for (const m of chunk.messages) {
                const prefix = m.role === 'user' ? '👤' : '🤖';
                out += `${prefix} ${m.content.slice(0, 200)}${m.content.length > 200 ? '...' : ''}\n`;
            }
        }

        return { success: true, output: out };
    }

    // ── FORMATAÇÃO ─────────────────────────────────────────────────────────────

    private formatChunkBrief(c: ConversationChunk): string {
        const age = this.formatAge(c.createdAt);
        const qualBar = this.qualityBar(c.chunkQuality);
        const emb = c.embedding ? '🔵' : '⚪';
        const topics = c.topics.slice(0, 2).join(', ') || '—';
        const entities = c.entities.slice(0, 2).join(', ') || '—';
        const tools = c.toolsUsed.slice(0, 2).join(', ') || '—';

        let s = `[${c.id}]\n`;
        s += `  ${qualBar} quality=${c.chunkQuality.toFixed(2)} ${emb} trigger=${c.cutTrigger} ${age} atrás\n`;
        s += `  session: ${c.sessionKey}\n`;
        s += `  topics: ${topics} | entities: ${entities} | tools: ${tools}\n`;
        s += `  summary: ${c.summary.slice(0, 150)}${c.summary.length > 150 ? '...' : ''}\n`;
        return s;
    }

    private qualityBar(q: number): string {
        if (q >= 0.7) return '🟢';
        if (q >= 0.4) return '🟡';
        return '🔴';
    }

    private formatAge(timestampMs: number): string {
        const diff = Date.now() - timestampMs;
        const sec  = Math.floor(diff / 1000);
        const min  = Math.floor(sec / 60);
        const hr   = Math.floor(min / 60);
        const day  = Math.floor(hr  / 24);
        if (day  > 0) return `${day}d`;
        if (hr   > 0) return `${hr}h`;
        if (min  > 0) return `${min}min`;
        return `${sec}s`;
    }
}
