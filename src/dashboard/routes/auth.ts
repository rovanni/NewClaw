import { Router, Request, Response } from 'express';
import express from 'express';
import crypto from 'crypto';

// ── Session tokens (in-memory, cleared on restart) ──
const API_TOKENS: Set<string> = new Set();

// ── Persistent signed tokens (survive restarts) ──
// A signed token = hmac(DASHBOARD_PASSWORD, random-bytes). Verifiable without storing.

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

// ── Signed token: survives restarts because it's verifiable from DASHBOARD_PASSWORD ──
function createSignedToken(): string {
    const raw = crypto.randomBytes(32).toString('hex');
    const secret = process.env.DASHBOARD_PASSWORD || '';
    const signature = crypto.createHmac('sha256', secret).update(raw).digest('hex');
    const token = `${raw}.${signature}`;
    API_TOKENS.add(token);
    return token;
}

function verifySignedToken(token: string): boolean {
    // Fast path: in-memory set
    if (API_TOKENS.has(token)) return true;

    // Slow path: verify signature (survives restart)
    const parts = token.split('.');
    if (parts.length !== 2) return false;
    const [raw, signature] = parts;
    const secret = process.env.DASHBOARD_PASSWORD || '';
    const expected = crypto.createHmac('sha256', secret).update(raw).digest('hex');
    try {
        if (crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'))) {
            // Add to in-memory set for fast subsequent lookups
            API_TOKENS.add(token);
            return true;
        }
    } catch { /* invalid format */ }
    return false;
}

if (process.env.DASHBOARD_PASSWORD) {
    dashboardAuth.enabled = true;
    dashboardAuth.passwordHash = hashPassword(process.env.DASHBOARD_PASSWORD);
}

export function authMiddleware(req: Request, res: Response, next: express.NextFunction): void {
    if (!dashboardAuth.enabled) { next(); return; }
    const headerToken = req.headers.authorization?.replace('Bearer ', '') || req.query.token;
    const cookieToken = req.cookies?.newclaw_session;
    const token = headerToken || cookieToken;
    if (token && verifySignedToken(String(token))) { next(); return; }
    const allowedPaths = ['/', '/config', '/help', '/traces', '/memory', '/memory-graph', '/memory-review', '/shared.js', '/shared.css', '/favicon.ico', '/api/auth/login', '/health'];
    if (allowedPaths.includes(req.path) || req.path.endsWith('.html') || req.path.endsWith('.js') || req.path.endsWith('.css')) {
        next();
        return;
    }
    res.status(401).json({ error: 'Unauthorized' });
}

// Keep API_TOKENS export for backward compat
export { API_TOKENS };

export function createAuthRouter(): Router {
    const router = Router();

    router.post('/login', (req: Request, res: Response) => {
        const { password } = req.body;
        if (!dashboardAuth.enabled) {
            return res.json({ success: true, token: 'no-auth-required' });
        }
        if (password && verifyPassword(password, dashboardAuth.passwordHash)) {
            const token = createSignedToken();
            // Set httpOnly cookie for session persistence across page loads
            res.cookie('newclaw_session', token, {
                httpOnly: true,
                sameSite: 'strict',
                maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
                path: '/',
            });
            res.json({ success: true, token });
        } else {
            res.status(401).json({ success: false, error: 'Invalid password' });
        }
    });

    router.post('/logout', (_req: Request, res: Response) => {
        res.clearCookie('newclaw_session', { path: '/' });
        res.json({ success: true });
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