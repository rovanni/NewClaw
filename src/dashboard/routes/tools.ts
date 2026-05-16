import { Router, Request, Response } from 'express';
import { ToolRegistry } from '../../core/ToolRegistry';

export function createToolsRouter(): Router {
    const router = Router();

    router.get('/', (_req: Request, res: Response) => {
        res.json({
            success: true,
            tools: [
                { name: 'exec_command', description: 'Execute shell commands' },
                { name: 'web_search', description: 'Search the web' },
                { name: 'write', description: 'Create or overwrite files' },
                { name: 'edit', description: 'Edit existing files (replace/patch/append)' },
                { name: 'read', description: 'Read files or list directories' },
                { name: 'crypto_report', description: 'Cryptocurrency price reports (quick lookup)' },
                { name: 'crypto_analysis', description: 'Deep crypto analysis: bleeding coins, gainers, losers, opportunities' },
                { name: 'send_audio', description: 'Generate and send TTS audio via Telegram' },
            ]
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
