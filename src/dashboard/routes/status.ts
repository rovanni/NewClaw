import { Router, Request, Response } from 'express';
import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { errorMessage } from '../../shared/errors';
import { createLogger } from '../../shared/AppLogger';
import { getEventLoopMonitor } from '../../shared/EventLoopMonitor';
import { DashboardContext } from './types';
import { assertNotSsrfTarget } from '../../core/ssrfGuard';

const log = createLogger('Dashboardserver');
const DIR = process.cwd();

/** Resolvida uma vez: o arquivo não muda enquanto o processo vive. */
let cachedAppVersion: string | null | undefined;

/**
 * Versão do NewClaw, lida do próprio `package.json` — fonte única, nunca digitada em outro lugar.
 *
 * Sobe a partir deste arquivo procurando o package.json do projeto, em vez de usar um caminho
 * relativo fixo: em desenvolvimento o código roda de `src/`, em produção de `dist/`, e as duas
 * profundidades são diferentes. Confere `name` para não pegar por engano o package.json de uma
 * dependência.
 *
 * Devolve `null` quando não encontra — a interface mostra "—" em vez de um número inventado.
 */
export function getAppVersion(): string | null {
    if (cachedAppVersion !== undefined) return cachedAppVersion;
    let dir = __dirname;
    for (let i = 0; i < 8; i++) {
        try {
            const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8'));
            if (pkg.name === 'newclaw' && typeof pkg.version === 'string') {
                cachedAppVersion = pkg.version as string;
                return cachedAppVersion;
            }
        } catch { /* não é aqui: continua subindo */ }
        const parent = path.dirname(dir);
        if (parent === dir) break;   // chegou na raiz do sistema de arquivos
        dir = parent;
    }
    log.warn('package.json do NewClaw não encontrado — versão não será exibida');
    cachedAppVersion = null;
    return null;
}

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
            const ollamaUrl = ctx.config.ollamaUrl || 'http://localhost:11434';
            // /health não exige autenticação (allowedPaths de authMiddleware, checagem de load
            // balancer/watchdog) — o catch abaixo é bare de propósito, para nunca vazar a
            // mensagem de bloqueio (nem qualquer outro detalhe do erro) a um chamador anônimo.
            assertNotSsrfTarget(ollamaUrl);
            const ollamaRes = await fetch(`${ollamaUrl}/api/tags`, {
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
                version: getAppVersion(),
                nodeVersion: process.version,
                platform: process.platform,
                arch: process.arch,
                hostname: os.hostname(),
                pid: process.pid,
                telegramChannel,
            }
        });
    });

    router.post('/restart', (_req: Request, res: Response) => {
        res.json({ success: true, message: 'Restarting...' });
        // Delega pro bin/newclaw restart (Node puro, PM2-first com fallback pra spawn cru)
        // em vez de chamar bash ./start.sh restart direto: bash não existe no Windows por
        // padrão, e bin/newclaw já é a implementação única e testada de restart usada
        // pelo CLI e pelo fluxo de update — evita duas lógicas de restart divergindo.
        execFile(process.execPath, [path.join(DIR, 'bin', 'newclaw'), 'restart'], { windowsHide: true, cwd: DIR }, (err) => {
            if (err) log.error('Restart error:', errorMessage(err));
        });
    });

    return router;
}
