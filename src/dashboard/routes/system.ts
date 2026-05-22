import { Router, Request, Response } from 'express';
import { errorMessage } from '../../shared/errors';
import { DashboardContext } from './types';

export function createSystemRouter(ctx: DashboardContext): Router {
    const router = Router();

    router.get('/owner-profile', (_req: Request, res: Response) => {
        try {
            if (!ctx.ownerProfileService) {
                return res.json({ success: true, profile: null });
            }
            const profile = ctx.ownerProfileService.getProfile();
            res.json({ success: true, profile });
        } catch (err) {
            res.status(500).json({ error: errorMessage(err) });
        }
    });

    router.put('/owner-profile', (req: Request, res: Response) => {
        try {
            if (!ctx.ownerProfileService) {
                return res.status(503).json({ error: 'OwnerProfileService não disponível.' });
            }
            const { ownerName, locked } = req.body || {};
            if (!ownerName || typeof ownerName !== 'string' || ownerName.trim().length === 0) {
                return res.status(400).json({ error: 'ownerName é obrigatório e não pode ser vazio.' });
            }
            ctx.ownerProfileService.updateFromDashboard(ownerName.trim(), locked === true);
            res.json({ success: true, profile: ctx.ownerProfileService.getProfile() });
        } catch (err) {
            res.status(500).json({ error: errorMessage(err) });
        }
    });

    router.get('/owner-audit', (_req: Request, res: Response) => {
        try {
            const events = ctx.ownerProfileService?.getAuditLog(100) ?? [];
            res.json({ success: true, events });
        } catch (err) {
            res.status(500).json({ error: errorMessage(err) });
        }
    });

    return router;
}
