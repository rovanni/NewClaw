/**
 * SessionAutoCleaner — Compactação e limpeza automática de sessões
 * 
 * Problema: JSONL cresce indefinidamente. Compactação existe mas não é automática.
 * Solução: Scheduler que roda periodicamente e:
 *   1. Compacta sessões inativas que ultrapassaram o tamanho limite
 *   2. Remove arquivos de backup antigos
 *   3. Emite métricas via EventBus
 * 
 * Configuração:
 *   - COMPACT_SIZE_THRESHOLD: tamanho mínimo para compactar (default: 500KB)
 *   - COMPACT_INTERVAL: intervalo entre verificações (default: 1h)
 *   - BACKUP_MAX_AGE_MS: idade máxima de backups (default: 7 dias)
 *   - INACTIVE_THRESHOLD_MS: tempo para considerar sessão inativa (default: 30 min)
 */

import { SessionManager, type SessionKey } from '../session/SessionManager';
import { fromFileSafeId, parseSessionKey } from '../session/SessionKeyFactory';
import { eventBus } from '../core/EventBus';
import { createLogger } from '../shared/AppLogger';
import fs from 'fs';
import path from 'path';

const log = createLogger('SessionAutoCleaner');

export interface AutoCleanerConfig {
    /** Tamanho mínimo do JSONL para compactar (bytes, default: 500KB) */
    compactSizeThreshold: number;
    /** Intervalo entre verificações (ms, default: 3600000 = 1h) */
    compactIntervalMs: number;
    /** Idade máxima de backups .bak (ms, default: 604800000 = 7 dias) */
    backupMaxAgeMs: number;
    /** Tempo para considerar sessão inativa (ms, default: 1800000 = 30 min) */
    inactiveThresholdMs: number;
    /** Diretório de transcrições */
    transcriptDir: string;
    /** Número máximo de sessões inativas a limpar por ciclo */
    maxCleanupPerCycle: number;
}

const DEFAULT_CONFIG: AutoCleanerConfig = {
    compactSizeThreshold: 500 * 1024,    // 500KB
    compactIntervalMs: 3600_000,          // 1h
    backupMaxAgeMs: 7 * 24 * 3600_000,    // 7 dias
    inactiveThresholdMs: 600_000,          // 10 min
    transcriptDir: './data/sessions',
    maxCleanupPerCycle: 10,
};

export class SessionAutoCleaner {
    private config: AutoCleanerConfig;
    private sessionManager: SessionManager;
    private timer: NodeJS.Timeout | null = null;
    private running: boolean = false;
    private stats: {
        compactionsRun: number;
        bytesSaved: number;
        backupsRemoved: number;
        sessionsCleaned: number;
        lastRunAt: number;
    };

    constructor(sessionManager: SessionManager, config?: Partial<AutoCleanerConfig>) {
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.sessionManager = sessionManager;
        this.stats = {
            compactionsRun: 0,
            bytesSaved: 0,
            backupsRemoved: 0,
            sessionsCleaned: 0,
            lastRunAt: 0,
        };
    }

    /**
     * Start the automatic cleanup scheduler.
     */
    start(): void {
        if (this.timer) {
            log.warn('SessionAutoCleaner already running');
            return;
        }

        log.info(`SessionAutoCleaner started — interval: ${Math.round(this.config.compactIntervalMs / 60_000)}min, threshold: ${Math.round(this.config.compactSizeThreshold / 1024)}KB`);

        // Run first cleanup after 5 minutes (let system stabilize)
        this.timer = setTimeout(() => {
            if (!this.timer) return; // Stopped in the meantime
            this.runCleanupCycle();
            // Then schedule periodic
            this.timer = setInterval(() => this.runCleanupCycle(), this.config.compactIntervalMs);
        }, 5 * 60_000);
    }

    /**
     * Stop the automatic cleanup scheduler.
     */
    stop(): void {
        if (this.timer) {
            // In Node.js clearTimeout and clearInterval use the same ID pool
            clearTimeout(this.timer);
            clearInterval(this.timer);
            this.timer = null;
        }
        log.info('SessionAutoCleaner stopped');
    }

    /**
     * Run a single cleanup cycle.
     */
    async runCleanupCycle(): Promise<void> {
        if (this.running) {
            log.warn('Cleanup cycle already running — skipping');
            return;
        }

        this.running = true;
        log.info('Starting cleanup cycle...');

        try {
            // 1. Compact large session files
            const compactResults = await this.compactLargeSessions();
            
            // 2. Remove old backups
            const backupsRemoved = this.removeOldBackups();
            
            // 3. Cleanup inactive sessions from memory
            const sessionsCleaned = await this.sessionManager.cleanupInactiveSessions(this.config.inactiveThresholdMs);

            this.stats.compactionsRun += compactResults.length;
            this.stats.bytesSaved += compactResults.reduce((sum, r) => sum + r.saved, 0);
            this.stats.backupsRemoved += backupsRemoved;
            this.stats.sessionsCleaned += sessionsCleaned;
            this.stats.lastRunAt = Date.now();

            log.info(`Cleanup cycle complete: ${compactResults.length} compacted, ${backupsRemoved} backups removed, ${sessionsCleaned} sessions cleaned`);

            // Emit event
            eventBus.emit('session:compressed', {
                sessionId: 'auto-cleaner',
                messagesCompressed: compactResults.length,
                tokensSaved: Math.round(this.stats.bytesSaved / 4),
            });

        } catch (err) {
            log.error('Cleanup cycle failed:', (err as Error).message);
        } finally {
            this.running = false;
        }
    }

    /**
     * Find and compact session files that exceed the size threshold.
     */
    private async compactLargeSessions(): Promise<Array<{ sessionId: string; before: number; after: number; saved: number }>> {
        const results: Array<{ sessionId: string; before: number; after: number; saved: number }> = [];

        try {
            const files = fs.readdirSync(this.config.transcriptDir)
                .filter(f => f.endsWith('.jsonl'));

            for (const file of files) {
                const filePath = path.join(this.config.transcriptDir, file);
                const stat = fs.statSync(filePath);

                if (stat.size < this.config.compactSizeThreshold) continue;

                // Arquivo no disco está no formato file-safe (toFileSafeId — ':' virou '~',
                // ver SessionKeyFactory). fromFileSafeId desfaz isso antes de parsear de volta
                // em {channel, userId}; parseSessionKey delimita no PRIMEIRO ':' (não trunca
                // um userId que contenha ':').
                const sessionId = fromFileSafeId(file.replace('.jsonl', ''));
                const sessionKey: SessionKey = parseSessionKey(sessionId);

                try {
                    const result = await this.sessionManager.compactSession(sessionKey);
                    if (result.saved > 0) {
                        results.push({ sessionId, ...result });
                        log.info(`Compacted ${sessionId}: ${result.before} → ${result.after} bytes (saved ${result.saved})`);
                    }
                } catch (err) {
                    log.warn(`Failed to compact ${sessionId}: ${(err as Error).message}`);
                }

                if (results.length >= this.config.maxCleanupPerCycle) break;
            }
        } catch (err) {
            log.error('Error scanning session files:', (err as Error).message);
        }

        return results;
    }

    /**
     * Remove backup files older than backupMaxAgeMs.
     */
    private removeOldBackups(): number {
        let removed = 0;
        const now = Date.now();

        try {
            const files = fs.readdirSync(this.config.transcriptDir)
                .filter(f => f.endsWith('.jsonl.bak'));

            for (const file of files) {
                const filePath = path.join(this.config.transcriptDir, file);
                const stat = fs.statSync(filePath);

                if (now - stat.mtimeMs > this.config.backupMaxAgeMs) {
                    fs.unlinkSync(filePath);
                    removed++;
                    log.info(`Removed old backup: ${file}`);
                }
            }
        } catch (err) {
            log.warn('Error removing backups:', (err as Error).message);
        }

        return removed;
    }

    /**
     * Get stats for observability.
     */
    getStats(): typeof this.stats & { config: AutoCleanerConfig } {
        return { ...this.stats, config: this.config };
    }
}

export default SessionAutoCleaner;