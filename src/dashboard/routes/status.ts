import { Router, Request, Response } from 'express';
import { exec } from 'child_process';
import { errorMessage } from '../../shared/errors';
import { createLogger } from '../../shared/AppLogger';
import { getEventLoopMonitor } from '../../shared/EventLoopMonitor';
import { DashboardContext } from './types';

const log = createLogger('Dashboardserver');

export function formatUptime(seconds: number): string {
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);

    const parts: string[] = [];
    if (d > 0) parts.push(`${d}d`);
    if (h > 0) parts.push(`${h}h`);
    if (m > 0) parts.push(`${m}m`);
    parts.push(`${s}s`);
    return parts.join(' ');
}

export function formatBytes(bytes: number): string {
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    let size = bytes;
    while (size >= 1024 && i < units.length - 1) {
        size /= 1024;
        i++;
    }
    return `${size.toFixed(1)} ${units[i]}`;
}

export function healthHandler(ctx: DashboardContext) {
    return async (_req: Request, res: Response) => {
        const startMs = Date.now();
        const mem = process.memoryUsage();
        const monitor = getEventLoopMonitor();
        const stats = monitor.getStats();

        let ollamaStatus = 'unknown';
        try {
            const ollamaRes = await fetch('http://localhost:11434/api/tags', {
                signal: AbortSignal.timeout(3000),
            });
            ollamaStatus = ollamaRes.ok ? 'healthy' : 'degraded';
        } catch {
            ollamaStatus = 'unreachable';
        }

        const telegramStatus = ctx.controller?.getTelegramAdapter()?.isConnected
            ? 'connected' : 'disconnected';

        const isHealthy = ollamaStatus !== 'unreachable' && stats.lagMs < 5000;
        const responseMs = Date.now() - startMs;

        res.status(isHealthy ? 200 : 503).json({
            status: isHealthy ? 'ok' : 'degraded',
            uptime: stats.uptimeSeconds,
            memory: {
                rssMb: Math.round(mem.rss / 1048576),
                heapUsedMb: Math.round(mem.heapUsed / 1048576),
                heapTotalMb: Math.round(mem.heapTotal / 1048576),
            },
            eventLoop: {
                lagMs: stats.lagMs,
                avgLagMs: stats.avgLagMs,
                peakLagMs: stats.peakLagMs,
                warnCount: stats.warnCount,
                criticalCount: stats.criticalCount,
            },
            telegram: telegramStatus,
            ollama: ollamaStatus,
            activeHandles: stats.activeHandles,
            activeRequests: stats.activeRequests,
            responseTimeMs: responseMs,
            timestamp: stats.timestamp,
        });
    };
}

export function createStatusRouter(ctx: DashboardContext): Router {
    const router = Router();

    router.get('/status', (_req: Request, res: Response) => {
        const uptime = process.uptime();
        const mem = process.memoryUsage();

        const telegramAdapter = ctx.controller?.getTelegramAdapter();
        const telegramChannel = telegramAdapter
            ? telegramAdapter.getPollingStatus()
            : null;

        res.json({
            success: true,
            status: {
                uptime: Math.floor(uptime),
                uptimeHuman: formatUptime(uptime),
                memory: {
                    rss: formatBytes(mem.rss),
                    heapUsed: formatBytes(mem.heapUsed),
                    heapTotal: formatBytes(mem.heapTotal),
                },
                nodeVersion: process.version,
                platform: process.platform,
                pid: process.pid,
                telegramChannel,
            }
        });
    });

    router.post('/restart', (_req: Request, res: Response) => {
        res.json({ success: true, message: 'Restarting...' });
        exec('bash ./start.sh restart', (err) => {
            if (err) log.error('Restart error:', errorMessage(err));
        });
    });

    return router;
}
