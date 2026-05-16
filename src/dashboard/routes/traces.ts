import { Router, Request, Response } from 'express';
import { traceManager } from '../../core/ExecutionTrace';

export function sseStreamHandler(req: Request, res: Response): void {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const sendEvent = (event: string, data: unknown) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const onStep = (data: unknown) => sendEvent('trace_step', data);
    const onStart = (data: unknown) => sendEvent('trace_start', data);
    const onComplete = (data: unknown) => sendEvent('trace_complete', data);

    traceManager.on('trace_step', onStep);
    traceManager.on('trace_start', onStart);
    traceManager.on('trace_complete', onComplete);

    const heartbeat = setInterval(() => {
        res.write(': ping\n\n');
    }, 15000);

    req.on('close', () => {
        clearInterval(heartbeat);
        traceManager.off('trace_step', onStep);
        traceManager.off('trace_start', onStart);
        traceManager.off('trace_complete', onComplete);
        res.end();
    });
}

export function createTracesRouter(): Router {
    const router = Router();

    router.get('/', (_req: Request, res: Response) => {
        const traces = traceManager.getRecentTraces(20);
        res.json({ success: true, traces });
    });

    router.get('/stats', (_req: Request, res: Response) => {
        const stats = traceManager.getStats();
        res.json({ success: true, stats });
    });

    return router;
}
