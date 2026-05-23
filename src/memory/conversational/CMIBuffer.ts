/**
 * CMIBuffer — Buffer in-memory por sessão com lógica de corte semântico.
 *
 * Responsabilidade: decidir QUANDO cortar um chunk.
 * Cinco triggers em ordem de prioridade semântica:
 *   1. workflow_completed  — unidade natural de trabalho
 *   2. checkpoint_written  — compressão linear disparou
 *   3. domain_shift        — mudança de assunto detectada
 *   4. window_size         — limite de mensagens
 *   5. time_window         — inatividade prolongada
 */

import { TranscriptEntry } from '../../session/SessionTranscript';
import { BufferState, ChunkCutTrigger } from './cmiTypes';
import { classifyDomain } from '../DomainRegistry';
import { createLogger } from '../../shared/AppLogger';

const log = createLogger('CMIBuffer');

const MAX_CHUNK_MESSAGES = 15;          // máximo de entradas por chunk
const MAX_TIME_WINDOW_MS = 15 * 60_000; // 15 minutos de inatividade

/** Nomes de tools que sinalizam conclusão de workflow */
const TERMINAL_TOOLS = new Set([
    'send_document', 'send_audio', 'send_image',
    'write_tool', 'write', 'edit', 'edit_tool'
]);

export class CMIBuffer {
    private buffers: Map<string, BufferState> = new Map();

    /**
     * Adiciona uma entrada ao buffer da sessão.
     * Retorna o trigger de corte se o buffer deve ser drenado agora, ou null.
     */
    push(
        sessionKey: string,
        entry: TranscriptEntry
    ): ChunkCutTrigger | null {
        const state = this.getOrCreate(sessionKey, entry);

        // Checkpoint escrito → corte imediato (a fronteira já ocorreu)
        if (entry.meta?.checkpoint === true) {
            return 'checkpoint_written';
        }

        // Registrar tool usage
        if (entry.role === 'tool_call' && entry.meta?.tool_name) {
            const toolName = entry.meta.tool_name;
            if (!state.toolsDetected.includes(toolName)) {
                state.toolsDetected.push(toolName);
            }
            // Workflow terminal detectado
            if (TERMINAL_TOOLS.has(toolName) && entry.meta?.tool_success !== false) {
                state.workflowCompleted = true;
            }
        }

        if (entry.role === 'tool_result' && entry.meta?.tool_success === true) {
            const toolName = entry.meta.tool_name || '';
            if (TERMINAL_TOOLS.has(toolName)) {
                state.workflowCompleted = true;
            }
        }

        // Acumular mensagens user/assistant e checkpoints no buffer
        if (
            entry.role === 'user' ||
            entry.role === 'assistant' ||
            entry.role === 'tool_call' ||
            entry.role === 'tool_result'
        ) {
            state.entries.push(entry);
            state.lastEntryTimestamp = Date.now();
        }

        // Agora avaliar triggers na ordem de prioridade
        return this.evaluateCutTrigger(state, entry);
    }

    /**
     * Drena e remove o buffer de uma sessão.
     * Retorna as entradas acumuladas.
     */
    flush(sessionKey: string): BufferState | null {
        const state = this.buffers.get(sessionKey);
        if (!state || state.entries.length === 0) return null;
        this.buffers.delete(sessionKey);
        return state;
    }

    /**
     * Força flush imediato (usado quando SessionManager cria um checkpoint).
     */
    forceFlush(sessionKey: string, trigger: ChunkCutTrigger): BufferState | null {
        const state = this.buffers.get(sessionKey);
        if (!state || state.entries.length === 0) {
            this.buffers.delete(sessionKey);
            return null;
        }
        this.buffers.delete(sessionKey);
        log.info('forceFlush', `${sessionKey} trigger=${trigger} entries=${state.entries.length}`);
        return state;
    }

    /** Retorna o tamanho atual do buffer sem drenar */
    size(sessionKey: string): number {
        return this.buffers.get(sessionKey)?.entries.length ?? 0;
    }

    /** Verifica sessões com inatividade > MAX_TIME_WINDOW para flush por tempo */
    getTimedOutSessions(): string[] {
        const now = Date.now();
        const timedOut: string[] = [];
        for (const [key, state] of this.buffers) {
            if (state.entries.length > 0 && now - state.lastEntryTimestamp > MAX_TIME_WINDOW_MS) {
                timedOut.push(key);
            }
        }
        return timedOut;
    }

    // ── PRIVADO ────────────────────────────────────────────────────────────────

    private getOrCreate(sessionKey: string, firstEntry: TranscriptEntry): BufferState {
        if (!this.buffers.has(sessionKey)) {
            const now = Date.now();
            // Detectar domínio inicial a partir do conteúdo da primeira mensagem
            const domain = firstEntry.role === 'user'
                ? (classifyDomain(firstEntry.content)?.domainId ?? null)
                : null;

            this.buffers.set(sessionKey, {
                entries: [],
                currentDomain: domain,
                startTimestamp: now,
                toolsDetected: [],
                workflowCompleted: false,
                lastEntryTimestamp: now
            });
        }
        return this.buffers.get(sessionKey)!;
    }

    private evaluateCutTrigger(
        state: BufferState,
        _latestEntry: TranscriptEntry
    ): ChunkCutTrigger | null {
        // Prioridade 1: workflow concluído (unidade semântica mais rica)
        if (state.workflowCompleted) {
            return 'workflow_completed';
        }

        // Prioridade 2: janela de mensagens cheia
        const userAssistantCount = state.entries.filter(
            e => e.role === 'user' || e.role === 'assistant'
        ).length;
        if (userAssistantCount >= MAX_CHUNK_MESSAGES) {
            return 'window_size';
        }

        // Prioridade 3: domain shift (usando DomainRegistry, só em mensagens de usuário)
        if (state.currentDomain && _latestEntry.role === 'user') {
            const newDomain = classifyDomain(_latestEntry.content)?.domainId;
            if (newDomain && newDomain !== state.currentDomain && userAssistantCount >= 4) {
                // Só corta por domain shift se já tem pelo menos 4 msgs (evita micro-chunks)
                log.info('domainShift', `${state.currentDomain} → ${newDomain}`);
                return 'domain_shift';
            }
        }

        // Prioridade 4: time window (verificada via getTimedOutSessions no Engine)
        // Não avaliada aqui — é pull-based pelo Engine periodicamente

        return null;
    }
}
