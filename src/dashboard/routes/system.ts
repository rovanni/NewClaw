import { Router, Request, Response } from 'express';
import { errorMessage } from '../../shared/errors';
import { DashboardContext } from './types';
import { OperationalMode, MODE_LABELS, MODE_DESCRIPTIONS, isValidMode } from '../../core/CapabilityMode';
import { permissionRegistry } from '../../core/PermissionRegistry';

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

    // ── Capability Mode ───────────────────────────────────────────────────────

    router.get('/capability-mode', (_req: Request, res: Response) => {
        try {
            const state = permissionRegistry.toJSON();
            const modes = Object.values(OperationalMode).map(m => ({
                value: m,
                label: MODE_LABELS[m],
                description: MODE_DESCRIPTIONS[m],
                active: m === state.mode,
            }));
            res.json({ success: true, current: state, modes });
        } catch (err) {
            res.status(500).json({ error: errorMessage(err) });
        }
    });

    router.put('/capability-mode', (req: Request, res: Response) => {
        try {
            if (!ctx.ownerProfileService) {
                return res.status(503).json({ error: 'OwnerProfileService não disponível.' });
            }
            const { mode, godModeConfirmed } = req.body || {};
            if (!mode || !isValidMode(mode)) {
                return res.status(400).json({
                    error: `Modo inválido. Valores aceitos: ${Object.values(OperationalMode).join(', ')}`,
                });
            }
            const result = ctx.ownerProfileService.setCapabilityMode(
                mode as OperationalMode,
                'dashboard',
                godModeConfirmed === true,
            );
            if (!result.success) {
                return res.status(403).json({ error: result.error });
            }
            res.json({ success: true, current: permissionRegistry.toJSON() });
        } catch (err) {
            res.status(500).json({ error: errorMessage(err) });
        }
    });

    return router;
}
