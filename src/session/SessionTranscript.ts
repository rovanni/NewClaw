/**
 * SessionTranscript — JSONL Append-Only Transcript Log
 * 
 * Each session gets a .jsonl file with every message appended atomically.
 * Enables full linear replay, debugging, and audit trail.
 * 
 * Format per line:
 * {"ts":"ISO8601","seq":N,"role":"user|assistant|system|tool","content":"...","meta":{...}}
 */

import fs from 'fs';
import path from 'path';
import { mkdirSync, existsSync } from 'fs';

export type SessionEventType = 'user' | 'assistant' | 'system' | 'tool_call' | 'tool_result' | 'checkpoint';

export interface TranscriptEntry {
    ts: string;         // ISO8601 timestamp
    seq: number;        // monotonically increasing sequence number
    role: SessionEventType;
    content: string;
    meta?: {
        model?: string;
        tokens?: number;
        tools_used?: string[];
        duration_ms?: number;
        checkpoint?: boolean;  // marks a compression checkpoint
        compressed_up_to?: number; // seq number this summary covers
        tool_name?: string;    // for tool_call/tool_result events
        tool_input?: string;   // for tool_call events
        tool_success?: boolean; // for tool_result events
    };
}

export class SessionTranscript {
    private transcriptDir: string;
    private sessionId: string;
    private filePath: string;
    private writeStream: fs.WriteStream | null = null;
    private seqCounter: number = 0;
    private initialized: boolean = false;

    constructor(transcriptDir: string, sessionId: string) {
        this.transcriptDir = transcriptDir;
        this.sessionId = sessionId;
        this.filePath = path.join(transcriptDir, `${sessionId}.jsonl`);
    }

    /**
     * Initialize or resume a transcript.
     * If file exists, resume from the last sequence number.
     */
    async init(): Promise<void> {
        if (this.initialized) return;

        mkdirSync(this.transcriptDir, { recursive: true });

        if (existsSync(this.filePath)) {
            // Resume: find the last sequence number
            const lines = fs.readFileSync(this.filePath, 'utf-8').trim().split('\n');
            if (lines.length > 0 && lines[lines.length - 1]) {
                try {
                    const lastEntry = JSON.parse(lines[lines.length - 1]);
                    this.seqCounter = lastEntry.seq || 0;
                } catch {
                    this.seqCounter = 0;
                }
            }
        }

        // Open append stream (atomic writes via flags: 'a')
        this.writeStream = fs.createWriteStream(this.filePath, { flags: 'a', encoding: 'utf-8' });
        this.initialized = true;

        console.log(`[TRANSCRIPT] Initialized: ${this.sessionId} (seq: ${this.seqCounter})`);
    }

    /**
     * Append an entry to the transcript.
     * Atomic write: each entry is a single JSON line.
     */
    append(role: TranscriptEntry['role'], content: string, meta?: TranscriptEntry['meta']): number {
        if (!this.initialized || !this.writeStream) {
            console.warn('[TRANSCRIPT] Not initialized, skipping append');
            return -1;
        }

        this.seqCounter++;
        const entry: TranscriptEntry = {
            ts: new Date().toISOString(),
            seq: this.seqCounter,
            role,
            content,
            meta
        };

        const line = JSON.stringify(entry) + '\n';
        this.writeStream.write(line);

        return this.seqCounter;
    }

    /**
     * Get the current sequence number.
     */
    getSeq(): number {
        return this.seqCounter;
    }

    /**
     * Replay the full transcript from the beginning.
     * Returns entries in order.
     */
    replay(from?: number, to?: number): TranscriptEntry[] {
        if (!existsSync(this.filePath)) return [];

        const lines = fs.readFileSync(this.filePath, 'utf-8').trim().split('\n');
        const entries: TranscriptEntry[] = [];

        for (const line of lines) {
            try {
                const entry = JSON.parse(line) as TranscriptEntry;
                if (from !== undefined && entry.seq < from) continue;
                if (to !== undefined && entry.seq > to) continue;
                entries.push(entry);
            } catch {
                // Skip malformed lines
            }
        }

        return entries.sort((a, b) => a.seq - b.seq);
    }

    /**
     * Replay conversation messages (user + assistant + tool_call + tool_result),
     * excluding system noise but preserving tool context.
     */    replayMessages(from?: number, to?: number): TranscriptEntry[] {
        return this.replay(from, to).filter(e =>
            e.role === 'user' || e.role === 'assistant' || e.role === 'tool_call' || e.role === 'tool_result'
        );
    }

    /**
     * Get the last N entries.
     */
    getTail(n: number): TranscriptEntry[] {
        const all = this.replay();
        return all.slice(-n);
    }

    /**
     * Get entries since a checkpoint (for context reconstruction).
     */
    getSinceCheckpoint(): { entries: TranscriptEntry[]; lastCheckpointSeq: number | null } {
        const all = this.replay();
        let lastCheckpointSeq: number | null = null;

        for (const entry of all) {
            if (entry.meta?.checkpoint) {
                lastCheckpointSeq = entry.seq;
            }
        }

        if (lastCheckpointSeq === null) {
            return { entries: all, lastCheckpointSeq: null };
        }

        return {
            entries: all.filter(e => e.seq > lastCheckpointSeq),
            lastCheckpointSeq
        };
    }

    /**
     * Flush pending writes.
     */
    async flush(): Promise<void> {
        return new Promise((resolve) => {
            if (this.writeStream) {
                this.writeStream.write('', () => resolve());
            } else {
                resolve();
            }
        });
    }

    /**
     * Close the transcript file.
     */
    async close(): Promise<void> {
        if (this.writeStream) {
            await this.flush();
            this.writeStream.end();
            this.writeStream = null;
        }
    }

    /**
     * Get transcript stats.
     */
    getStats(): { totalEntries: number; totalBytes: number; firstTs: string | null; lastTs: string | null } {
        if (!existsSync(this.filePath)) {
            return { totalEntries: 0, totalBytes: 0, firstTs: null, lastTs: null };
        }

        const stat = fs.statSync(this.filePath);
        const lines = fs.readFileSync(this.filePath, 'utf-8').trim().split('\n');
        const entries = lines.filter(l => l.trim()).map(l => {
            try { return JSON.parse(l) as TranscriptEntry; }
            catch { return null; }
        }).filter(Boolean) as TranscriptEntry[];

        return {
            totalEntries: entries.length,
            totalBytes: stat.size,
            firstTs: entries[0]?.ts || null,
            lastTs: entries[entries.length - 1]?.ts || null
        };
    }

    /**
     * Get the session ID.
     */
    getSessionId(): string {
        return this.sessionId;
    }

    /**
     * Get the file path.
     */
    getFilePath(): string {
        return this.filePath;
    }
}