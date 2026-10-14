import { Router, Request, Response } from 'express';
import { ToolRegistry } from '../../core/ToolRegistry';

export function createToolsRouter(): Router {
    const router = Router();

    router.get('/', (_req: Request, res: Response) => {
        // Do registro real — antes, uma lista fixa de 8 ferramentas que envelheceu (citava crypto_report, que nunca foi
        // registrada) enquanto o registro tinha dezenas. Uma fonte só (Sprint 4, código morto, 14/10/2026).
        res.json({
            success: true,
            tools: ToolRegistry.getEnabled().map(t => ({ name: t.name, description: t.description })),
        });
    });

    router.get('/status', (_req: Request, res: Response) => {
        res.json({ success: true, tools: ToolRegistry.getStatus() });
    });

    router.post('/:name/enable', (req: Request, res: Response) => {
        const name = String(req.params.name);
        if (ToolRegistry.enable(name)) {
            res.json({ success: true, message: `Tool "${name}" enabled` });
        } else {
            res.status(404).json({ success: false, error: `Tool "${name}" not found` });
        }
    });

    router.post('/:name/disable', (req: Request, res: Response) => {
        const name = String(req.params.name);
        if (ToolRegistry.disable(name)) {
            res.json({ success: true, message: `Tool "${name}" disabled` });
        } else {
            res.status(404).json({ success: false, error: `Tool "${name}" not found` });
        }
    });

    return router;
}
