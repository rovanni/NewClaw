/**
 * SessionTranscript — JSONL Append-Only Transcript Log (v2)
 * 
 * Production-grade event-sourced transcript with:
 * - Mutex per session (concurrency safety)
 * - Lightweight index file (.idx.json) for fast seeks
 * - Rich event metadata (status, duration, tokens)
 * - Checkpoint index for fast replay since last checkpoint
 * 
 * Each session gets:
 *   telegram:8071707790.jsonl  → append-only event log
 *   telegram:8071707790.idx.json → seek index + stats
 */

import fs from 'fs';
import path from 'path';
import { mkdirSync, existsSync } from 'fs';

export type SessionEventType = 'user' | 'assistant' | 'system' | 'tool_call' | 'tool_result' | 'checkpoint';

export interface TranscriptMeta {
    model?: string;
    tokens?: number;
    tools_used?: string[];
    duration_ms?: number;
    checkpoint?: boolean;
    compressed_up_to?: number;
    // Rich metadata for tool events
    tool_name?: string;
    tool_input?: string;
    tool_success?: boolean;
    tool_duration_ms?: number;
    // Status tracking
    status?: 'success' | 'error' | 'partial';
}

export interface TranscriptEntry {
    ts: string;
    seq: number;
    role: SessionEventType;
    content: string;
    meta?: TranscriptMeta;
}

export interface SessionIndex {
    lastOffset: number;       // byte offset of last entry
    lastSeq: number;           // last sequence number
    totalEntries: number;     // total entries written
    checkpoints: Array<{
        offset: number;        // byte offset in JSONL
        seq: number;           // sequence number
        ts: string;            // timestamp
    }>;
    updatedAt: string;
}

export class SessionTranscript {
    private transcriptDir: string;
    private sessionId: string;
    private filePath: string;
    private indexPath: string;
    private writeStream: fs.WriteStream | null = null;
    private seqCounter: number = 0;
    private initialized: boolean = false;
    private index: SessionIndex;
    private writeMutex: Promise<void> = Promise.resolve();

    constructor(transcriptDir: string, sessionId: string) {
        this.transcriptDir = transcriptDir;
        this.sessionId = sessionId;
        this.filePath = path.join(transcriptDir, `${sessionId}.jsonl`);
        this.indexPath = path.join(transcriptDir, `${sessionId}.idx.json`);
        this.index = {
            lastOffset: 0,
            lastSeq: 0,
            totalEntries: 0,
            checkpoints: [],
            updatedAt: new Date().toISOString()
        };
    }

    /**
     * Initialize or resume a transcript.
     * Loads index file if exists, otherwise scans JSONL.
     */
    async init(): Promise<void> {
        if (this.initialized) return;

        mkdirSync(this.transcriptDir, { recursive: true });

        // Try loading index first
        if (existsSync(this.indexPath)) {
            try {
                const idxData = JSON.parse(fs.readFileSync(this.indexPath, 'utf-8'));
                this.index = { ...this.index, ...idxData };
                this.seqCounter = this.index.lastSeq;
            } catch {
                // Corrupt index, rebuild from JSONL
                this.rebuildIndex();
            }
        } else if (existsSync(this.filePath)) {
            // No index, rebuild from JSONL
            this.rebuildIndex();
        }

        // Open append stream
        this.writeStream = fs.createWriteStream(this.filePath, { flags: 'a', encoding: 'utf-8' });
        this.initialized = true;

        console.log(`[TRANSCRIPT] Initialized: ${this.sessionId} (seq: ${this.seqCounter}, entries: ${this.index.totalEntries}, checkpoints: ${this.index.checkpoints.length})`);
    }

    /**
     * Mutex-protected append. Prevents concurrent writes to the same JSONL.
     */
    async appendAsync(role: SessionEventType, content: string, meta?: TranscriptMeta): Promise<number> {
        // Chain on mutex: each write waits for the previous one
        return new Promise((resolve) => {
            this.writeMutex = this.writeMutex.then(() => {
                const seq = this.appendSync(role, content, meta);
                resolve(seq);
            });
        });
    }

    /**
     * Synchronous append (for backward compat). Use appendAsync for production.
     */
    append(role: SessionEventType, content: string, meta?: TranscriptMeta): number {
        return this.appendSync(role, content, meta);
    }

    private appendSync(role: SessionEventType, content: string, meta?: TranscriptMeta): number {
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
        const offset = this.index.lastOffset;
        this.writeStream.write(line);

        // Update index
        this.index.lastOffset = offset + Buffer.byteLength(line, 'utf-8');
        this.index.lastSeq = this.seqCounter;
        this.index.totalEntries++;

        // Track checkpoints in index
        if (meta?.checkpoint) {
            this.index.checkpoints.push({
                offset,
                seq: this.seqCounter,
                ts: entry.ts
            });
        }

        // Persist index periodically (every 10 entries)
        if (this.seqCounter % 10 === 0) {
            this.saveIndex();
        }

        return this.seqCounter;
    }

    /**
     * Rebuild index from JSONL file (used on init if index is missing/corrupt).
     */
    private rebuildIndex(): void {
        if (!existsSync(this.filePath)) return;

        const content = fs.readFileSync(this.filePath, 'utf-8');
        const lines = content.trim().split('\n');
        let offset = 0;
        let lastSeq = 0;
        let totalEntries = 0;
        const checkpoints: SessionIndex['checkpoints'] = [];

        for (const line of lines) {
            if (!line.trim()) { offset += Buffer.byteLength(line + '\n', 'utf-8'); continue; }
            try {
                const entry = JSON.parse(line) as TranscriptEntry;
                if (entry.seq > lastSeq) lastSeq = entry.seq;
                totalEntries++;
                if (entry.meta?.checkpoint) {
                    checkpoints.push({ offset, seq: entry.seq, ts: entry.ts });
                }
            } catch { /* skip malformed */ }
            offset += Buffer.byteLength(line + '\n', 'utf-8');
        }

        this.index = {
            lastOffset: offset,
            lastSeq: lastSeq,
            totalEntries,
            checkpoints,
            updatedAt: new Date().toISOString()
        };
        this.seqCounter = lastSeq;
        this.saveIndex();
    }

    /**
     * Save index file to disk.
     */
    private saveIndex(): void {
        try {
            this.index.updatedAt = new Date().toISOString();
            fs.writeFileSync(this.indexPath, JSON.stringify(this.index, null, 2), 'utf-8');
        } catch (err) {
            console.warn('[TRANSCRIPT] Failed to save index:', err);
        }
    }

    getSeq(): number { return this.seqCounter; }

    /**
     * Replay the full transcript. Uses index for fast seek if available.
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
            } catch { /* skip malformed */ }
        }

        return entries.sort((a, b) => a.seq - b.seq);
    }

    /**
     * Fast replay since last checkpoint using index.
     * Avoids parsing the entire file — seeks directly from checkpoint offset.
     */
    replaySinceCheckpoint(): { entries: TranscriptEntry[]; lastCheckpointSeq: number | null } {
        const lastCheckpoint = this.index.checkpoints.length > 0
            ? this.index.checkpoints[this.index.checkpoints.length - 1]
            : null;

        if (!lastCheckpoint) {
            return { entries: this.replay(), lastCheckpointSeq: null };
        }

        // Read from checkpoint offset onward (fast seek)
        const entries = this.replay(lastCheckpoint.seq + 1);
        return { entries, lastCheckpointSeq: lastCheckpoint.seq };
    }

    /**
     * Replay conversation messages (user + assistant + tool_call + tool_result).
     */
    replayMessages(from?: number, to?: number): TranscriptEntry[] {
        return this.replay(from, to).filter(e =>
            e.role === 'user' || e.role === 'assistant' || e.role === 'tool_call' || e.role === 'tool_result'
        );
    }

    getTail(n: number): TranscriptEntry[] {
        const all = this.replay();
        return all.slice(-n);
    }

    /**
     * Get entries since last checkpoint (uses index for fast seek).
     */
    getSinceCheckpoint(): { entries: TranscriptEntry[]; lastCheckpointSeq: number | null } {
        const lastCheckpoint = this.index.checkpoints.length > 0
            ? this.index.checkpoints[this.index.checkpoints.length - 1]
            : null;

        if (lastCheckpoint === null) {
            return { entries: this.replay(), lastCheckpointSeq: null };
        }

        return {
            entries: this.replay(lastCheckpoint.seq + 1),
            lastCheckpointSeq: lastCheckpoint.seq
        };
    }

    async flush(): Promise<void> {
        return new Promise((resolve) => {
            if (this.writeStream) {
                this.writeStream.write('', () => {
                    this.saveIndex();
                    resolve();
                });
            } else {
                resolve();
            }
        });
    }

    async close(): Promise<void> {
        if (this.writeStream) {
            await this.flush();
            this.writeStream.end();
            this.writeStream = null;
        }
        this.saveIndex();
    }

    getStats(): { totalEntries: number; totalBytes: number; firstTs: string | null; lastTs: string | null; checkpointCount: number } {
        const fileExists = existsSync(this.filePath);
        const stat = fileExists ? fs.statSync(this.filePath) : null;
        return {
            totalEntries: this.index.totalEntries,
            totalBytes: stat?.size || 0,
            firstTs: null,
            lastTs: null,
            checkpointCount: this.index.checkpoints.length
        };
    }

    getSessionId(): string { return this.sessionId; }
    getFilePath(): string { return this.filePath; }
}