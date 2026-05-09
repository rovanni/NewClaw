/**
 * EventLoopMonitor — Non-blocking event loop lag detector
 * 
 * Measures the delay between when a setTimeout(cb, 0) was scheduled
 * and when it actually fires. This reveals event loop congestion.
 * 
 * Usage:
 *   const monitor = new EventLoopMonitor({ warnMs: 500, criticalMs: 2000 });
 *   monitor.start();
 * 
 * Integration with /health:
 *   monitor.getStats() → { lagMs, ... }
 */

import { createLogger } from './AppLogger';
const log = createLogger('EventLoopMonitor');

export interface EventLoopMonitorConfig {
    /** Check interval in ms (default: 1000) */
    intervalMs?: number;
    /** Log warning when lag exceeds this (default: 500ms) */
    warnMs?: number;
    /** Log critical when lag exceeds this (default: 2000ms) */
    criticalMs?: number;
    /** Enable periodic logging even when healthy (default: false) */
    logHealthy?: boolean;
    /** Healthy log interval — only log every N checks (default: 60 = every ~1min) */
    healthyLogEvery?: number;
}

export interface EventLoopStats {
    /** Current lag in ms */
    lagMs: number;
    /** Average lag over last window */
    avgLagMs: number;
    /** Peak lag recorded */
    peakLagMs: number;
    /** Number of warning events (lag > warnMs) */
    warnCount: number;
    /** Number of critical events (lag > criticalMs) */
    criticalCount: number;
    /** Total checks performed */
    totalChecks: number;
    /** Process uptime in seconds */
    uptimeSeconds: number;
    /** Heap usage in MB */
    heapUsedMb: number;
    /** RSS in MB */
    rssMb: number;
    /** Active handles */
    activeHandles: number;
    /** Active requests */
    activeRequests: number;
    /** Timestamp ISO */
    timestamp: string;
}

export class EventLoopMonitor {
    private config: Required<EventLoopMonitorConfig>;
    private timer: ReturnType<typeof setInterval> | null = null;
    private lagMs: number = 0;
    private peakLagMs: number = 0;
    private warnCount: number = 0;
    private criticalCount: number = 0;
    private totalChecks: number = 0;
    private recentLags: number[] = [];
    private readonly LAG_WINDOW = 30; // Keep last 30 samples for avg
    private healthyCounter: number = 0;
    private startTime: number = Date.now();

    constructor(config: EventLoopMonitorConfig = {}) {
        this.config = {
            intervalMs: config.intervalMs ?? 1000,
            warnMs: config.warnMs ?? 500,
            criticalMs: config.criticalMs ?? 2000,
            logHealthy: config.logHealthy ?? false,
            healthyLogEvery: config.healthyLogEvery ?? 60,
        };
    }

    start(): void {
        if (this.timer) return;
        this.startTime = Date.now();
        log.info('monitor_started', `interval=${this.config.intervalMs}ms warn=${this.config.warnMs}ms critical=${this.config.criticalMs}ms`);
        this.timer = setInterval(() => this.check(), this.config.intervalMs);
        this.timer.unref(); // Don't prevent process exit
    }

    stop(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
            log.info('monitor_stopped');
        }
    }

    private check(): void {
        const start = Date.now();
        setImmediate(() => {
            const lag = Date.now() - start;
            this.lagMs = lag;
            this.totalChecks++;

            // Track peak
            if (lag > this.peakLagMs) {
                this.peakLagMs = lag;
            }

            // Rolling window for average
            this.recentLags.push(lag);
            if (this.recentLags.length > this.LAG_WINDOW) {
                this.recentLags.shift();
            }

            // Emit warnings
            if (lag > this.config.criticalMs) {
                this.criticalCount++;
                log.error('event_loop_critical', undefined, `Lag: ${lag}ms (threshold: ${this.config.criticalMs}ms) handles=${this.getActiveHandles()} requests=${this.getActiveRequests()} heap=${this.getHeapUsedMb()}MB rss=${this.getRssMb()}MB`);
            } else if (lag > this.config.warnMs) {
                this.warnCount++;
                log.warn('event_loop_warning', `Lag: ${lag}ms (threshold: ${this.config.warnMs}ms)`);
            } else if (this.config.logHealthy) {
                this.healthyCounter++;
                if (this.healthyCounter >= this.config.healthyLogEvery) {
                    this.healthyCounter = 0;
                    log.info('event_loop_healthy', `Lag: ${lag}ms`);
                }
            }
        });
    }

    getStats(): EventLoopStats {
        const mem = process.memoryUsage();
        return {
            lagMs: this.lagMs,
            avgLagMs: this.recentLags.length > 0
                ? Math.round(this.recentLags.reduce((a, b) => a + b, 0) / this.recentLags.length)
                : 0,
            peakLagMs: this.peakLagMs,
            warnCount: this.warnCount,
            criticalCount: this.criticalCount,
            totalChecks: this.totalChecks,
            uptimeSeconds: Math.round((Date.now() - this.startTime) / 1000),
            heapUsedMb: Math.round(mem.heapUsed / 1048576),
            rssMb: Math.round(mem.rss / 1048576),
            activeHandles: this.getActiveHandles(),
            activeRequests: this.getActiveRequests(),
            timestamp: new Date().toISOString(),
        };
    }

    private getActiveHandles(): number {
        try {
            return (process as any)._getActiveHandles?.()?.length ?? -1;
        } catch {
            return -1;
        }
    }

    private getActiveRequests(): number {
        try {
            return (process as any)._getActiveRequests?.()?.length ?? -1;
        } catch {
            return -1;
        }
    }

    private getHeapUsedMb(): number {
        return Math.round(process.memoryUsage().heapUsed / 1048576);
    }

    private getRssMb(): number {
        return Math.round(process.memoryUsage().rss / 1048576);
    }
}

// Singleton for global use
let globalMonitor: EventLoopMonitor | null = null;

export function getEventLoopMonitor(config?: EventLoopMonitorConfig): EventLoopMonitor {
    if (!globalMonitor) {
        globalMonitor = new EventLoopMonitor(config);
    }
    return globalMonitor;
}