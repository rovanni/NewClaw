import { Router, Request, Response } from 'express';
import { errorMessage } from '../../shared/errors';
import { DashboardContext } from './types';

const chatRateLimit = new Map<string, number[]>();
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 10;

export function createChatRouter(ctx: DashboardContext): Router {
    const router = Router();

    router.post('/', async (req: Request, res: Response) => {
        const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
        const now = Date.now();
        const timestamps = chatRateLimit.get(clientIp) || [];
        const recent = timestamps.filter(t => now - t < RATE_LIMIT_WINDOW_MS);

        if (recent.length >= RATE_LIMIT_MAX) {
            const retryAfter = Math.ceil((recent[0] + RATE_LIMIT_WINDOW_MS - now) / 1000);
            res.set('Retry-After', String(retryAfter));
            return res.status(429).json({ error: `Rate limit exceeded. Try again in ${retryAfter}s.` });
        }

        recent.push(now);
        chatRateLimit.set(clientIp, recent);

        if (chatRateLimit.size > 100) {
            for (const [ip, ts] of chatRateLimit) {
                if (ts.every(t => now - t > RATE_LIMIT_WINDOW_MS)) chatRateLimit.delete(ip);
            }
        }

        if (!ctx.controller) {
            return res.status(500).json({ error: 'AgentController not initialized' });
        }

        try {
            const { message, sessionId = 'web-session' } = req.body;
            if (!message) return res.status(400).json({ error: 'Message required' });

            const response = await ctx.controller.handleWebMessage(sessionId, message);
            res.json({ success: true, response, sessionId });
        } catch (err) {
            res.status(500).json({ error: errorMessage(err) });
        }
    });

    return router;
}
