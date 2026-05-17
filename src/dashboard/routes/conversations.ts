import { Router, Request, Response } from 'express';
import { errorMessage } from '../../shared/errors';
import { DashboardContext } from './types';

export function createConversationsRouter(ctx: DashboardContext): Router {
    const router = Router();

    router.get('/', (req: Request, res: Response) => {
        if (!ctx.memoryManager) return res.status(500).json({ error: 'Memory not available' });
        try {
            const repo = ctx.memoryManager.getDashboardRepository();
            const userId = String(req.query.userId || 'web-dashboard');
            const convs = repo.listConversationsByUser(userId);
            res.json({ success: true, conversations: convs });
        } catch (err) {
            res.status(500).json({ error: errorMessage(err) });
        }
    });

    router.get('/export', (_req: Request, res: Response) => {
        if (!ctx.memoryManager) return res.status(500).json({ error: 'Memory not available' });
        try {
            const repo = ctx.memoryManager.getDashboardRepository();
            const { conversations, messages } = repo.exportAllConversations();
            res.json({ success: true, export: { conversations, messages, exportedAt: new Date().toISOString() } });
        } catch (err) {
            res.status(500).json({ error: errorMessage(err) });
        }
    });

    router.get('/:id/messages', (req: Request, res: Response) => {
        if (!ctx.memoryManager) return res.status(500).json({ error: 'Memory not available' });
        try {
            const repo = ctx.memoryManager.getDashboardRepository();
            const convId = String(req.params.id);
            const limit = parseInt(String(req.query.limit)) || 50;
            const msgs = repo.getMessagesByConversation(convId, limit);
            res.json({ success: true, messages: msgs });
        } catch (err) {
            res.status(500).json({ error: errorMessage(err) });
        }
    });

    return router;
}
