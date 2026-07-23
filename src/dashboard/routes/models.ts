import { Router, Request, Response } from 'express';
import { errorMessage } from '../../shared/errors';
import { DashboardContext } from './types';

/**
 * Catálogo de modelos (Model Registry) — GET /api/models/catalog.
 * Camada HTTP fina: toda a lógica de discovery/cache vive em ModelRegistryService;
 * esta rota só traduz query params e devolve JSON.
 */
export function createModelsRouter(ctx: DashboardContext): Router {
    const router = Router();

    router.get('/catalog', async (req: Request, res: Response) => {
        if (!ctx.modelRegistryService) {
            return res.json({ success: true, models: [], health: [] });
        }
        try {
            const forceRefresh = req.query.refresh === 'true';
            const models = await ctx.modelRegistryService.getCatalog(forceRefresh);
            res.json({ success: true, models, health: ctx.modelRegistryService.getLastHealth() });
        } catch (err) {
            res.status(500).json({ success: false, error: errorMessage(err) });
        }
    });

    router.get('/cloud-catalog', async (req: Request, res: Response) => {
        if (!ctx.modelRegistryService) {
            return res.json({ success: true, models: [] });
        }
        // getCloudCatalog() já é best-effort internamente (nunca rejeita) — sem try/catch aqui
        // pra não esconder um bug real caso o contrato mude.
        const forceRefresh = req.query.refresh === 'true';
        const models = await ctx.modelRegistryService.getCloudCatalog(forceRefresh);
        res.json({ success: true, models });
    });

    return router;
}
