import { Router, Request, Response } from 'express';
import { errorMessage } from '../../shared/errors';
import { DashboardContext } from './types';

export function createConversationsRouter(ctx: DashboardContext): Router {
    const router = Router();

    router.get('/', (req: Request, res: Response) => {
        if (!ctx.memoryManager) return res.status(500).json({ error: 'Memory not available' });
        try {
            const db = ctx.memoryManager.getDatabase();
            if (!db) return res.status(500).json({ error: 'DB not available' });
            const userId = (req.query.userId as string) || 'web-dashboard';
            const convs = db.prepare('SELECT id, user_id, provider, created_at, updated_at FROM conversations WHERE user_id = ? ORDER BY updated_at DESC').all(userId);
            res.json({ success: true, conversations: convs });
        } catch (err) {
            res.status(500).json({ error: errorMessage(err) });
        }
    });

    router.get('/export', (_req: Request, res: Response) => {
        if (!ctx.memoryManager) return res.status(500).json({ error: 'Memory not available' });
        try {
            const db = ctx.memoryManager.getDatabase();
            if (!db) return res.status(500).json({ error: 'DB not available' });
            const convs = db.prepare('SELECT * FROM conversations').all();
            const msgs = db.prepare('SELECT * FROM messages').all();
            res.json({ success: true, export: { conversations: convs, messages: msgs, exportedAt: new Date().toISOString() } });
        } catch (err) {
            res.status(500).json({ error: errorMessage(err) });
        }
    });

    router.get('/:id/messages', (req: Request, res: Response) => {
        if (!ctx.memoryManager) return res.status(500).json({ error: 'Memory not available' });
        try {
            const db = ctx.memoryManager.getDatabase();
            if (!db) return res.status(500).json({ error: 'DB not available' });
            const convId = req.params.id;
            const limit = parseInt(req.query.limit as string) || 50;
            const msgs = db.prepare('SELECT role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?').all(convId, limit);
            res.json({ success: true, messages: msgs.reverse() });
        } catch (err) {
            res.status(500).json({ error: errorMessage(err) });
        }
    });

    return router;
}
