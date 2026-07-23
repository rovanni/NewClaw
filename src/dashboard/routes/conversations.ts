import { Router, Request, Response } from 'express';
import { errorMessage } from '../../shared/errors';
import { DashboardContext } from './types';

export function createConversationsRouter(ctx: DashboardContext): Router {
    const router = Router();

    router.get('/', (_req: Request, res: Response) => {
        if (!ctx.memoryManager) return res.status(500).json({ error: 'Memory not available' });
        try {
            const repo = ctx.memoryManager.getDashboardRepository();
            // provider='web' — não userId: cada conversa web é salva com user_id=sessionId (id
            // local gerado no browser), nunca um "usuário" fixo. Ver DashboardMemoryRepository.
            const convs = repo.listWebConversations();
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

    router.delete('/', (_req: Request, res: Response) => {
        if (!ctx.memoryManager) return res.status(500).json({ error: 'Memory not available' });
        try {
            const repo = ctx.memoryManager.getDashboardRepository();
            const deleted = repo.deleteAllWebConversations();
            res.json({ success: true, deleted });
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
