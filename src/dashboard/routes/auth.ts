import { Router, Request, Response } from 'express';
import express from 'express';
import crypto from 'crypto';

export const API_TOKENS: Set<string> = new Set();
export let dashboardAuth: { enabled: boolean; passwordHash: string } = { enabled: false, passwordHash: '' };

function hashPassword(password: string): string {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.createHash('sha256').update(salt + password).digest('hex');
    return `${salt}:${hash}`;
}

function verifyPassword(password: string, stored: string): boolean {
    if (!stored || !stored.includes(':')) return false;
    const [salt, expectedHash] = stored.split(':');
    const actualHash = crypto.createHash('sha256').update(salt + password).digest('hex');
    try {
        return crypto.timingSafeEqual(
            Buffer.from(actualHash, 'hex'),
            Buffer.from(expectedHash, 'hex')
        );
    } catch {
        return false;
    }
}

if (process.env.DASHBOARD_PASSWORD) {
    dashboardAuth.enabled = true;
    dashboardAuth.passwordHash = hashPassword(process.env.DASHBOARD_PASSWORD);
}

export function authMiddleware(req: Request, res: Response, next: express.NextFunction): void {
    if (!dashboardAuth.enabled) { next(); return; }
    const token = req.headers.authorization?.replace('Bearer ', '') || req.query.token;
    if (token && API_TOKENS.has(String(token))) { next(); return; }
    const allowedPaths = ['/', '/config', '/help', '/traces', '/memory', '/memory-graph', '/memory-review', '/shared.js', '/shared.css', '/favicon.ico', '/api/auth/login', '/health'];
    if (allowedPaths.includes(req.path) || req.path.endsWith('.html') || req.path.endsWith('.js') || req.path.endsWith('.css')) {
        next();
        return;
    }
    res.status(401).json({ error: 'Unauthorized' });
}

export function createAuthRouter(): Router {
    const router = Router();

    router.post('/login', (req: Request, res: Response) => {
        const { password } = req.body;
        if (!dashboardAuth.enabled) {
            return res.json({ success: true, token: 'no-auth-required' });
        }
        if (password && verifyPassword(password, dashboardAuth.passwordHash)) {
            const token = crypto.randomBytes(32).toString('hex');
            API_TOKENS.add(token);
            res.json({ success: true, token });
        } else {
            res.status(401).json({ success: false, error: 'Invalid password' });
        }
    });

    router.post('/config', (req: Request, res: Response) => {
        const { enabled, password } = req.body;
        if (typeof enabled === 'boolean') {
            dashboardAuth.enabled = enabled;
        }
        if (password) {
            dashboardAuth.passwordHash = hashPassword(password);
        }
        res.json({ success: true, auth: { enabled: dashboardAuth.enabled, hasPassword: !!dashboardAuth.passwordHash } });
    });

    return router;
}
