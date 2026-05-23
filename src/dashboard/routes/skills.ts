import { Router, Request, Response } from 'express';
import path from 'path';
import { errorMessage } from '../../shared/errors';
import { DashboardContext } from './types';

export function createSkillsRouter(ctx: DashboardContext): Router {
    const router = Router();

    router.get('/', async (_req: Request, res: Response) => {
        try {
            const fs = await import('fs');
            const skillsPath = path.resolve(ctx.config.skillsDir);

            if (!fs.existsSync(skillsPath)) {
                return res.json({ success: true, skills: [] });
            }

            const entries = fs.readdirSync(skillsPath, { withFileTypes: true })
                .filter(d => d.isDirectory())
                .map(d => {
                    const skillFile = path.join(skillsPath, d.name, 'SKILL.md');
                    const hasSkillFile = fs.existsSync(skillFile);
                    return { name: d.name, hasSkillFile };
                });

            res.json({ success: true, skills: entries });
        } catch (err) {
            res.status(500).json({ error: errorMessage(err) });
        }
    });

    router.get('/auto', (_req: Request, res: Response) => {
        if (!ctx.memoryManager) return res.status(500).json({ error: 'Memory not available' });
        try {
            const skills = ctx.memoryManager.getDashboardRepository().listAutoSkills();
            res.json({ success: true, skills });
        } catch (err) {
            res.status(500).json({ error: errorMessage(err) });
        }
    });

    router.get('/patterns', (_req: Request, res: Response) => {
        if (!ctx.memoryManager) return res.status(500).json({ error: 'Memory not available' });
        try {
            const patterns = ctx.memoryManager.getDashboardRepository().listSkillPatterns();
            res.json({ success: true, patterns });
        } catch (err) {
            res.status(500).json({ error: errorMessage(err) });
        }
    });

    router.post('/auto/:id/approve', (req: Request, res: Response) => {
        if (!ctx.memoryManager) return res.status(500).json({ error: 'Memory not available' });
        try {
            const ok = ctx.memoryManager.getDashboardRepository().approveAutoSkill(String(req.params.id));
            if (!ok) return res.status(404).json({ success: false, error: 'Skill not found' });
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: errorMessage(err) });
        }
    });

    router.post('/auto/:id/reject', (req: Request, res: Response) => {
        if (!ctx.memoryManager) return res.status(500).json({ error: 'Memory not available' });
        try {
            const ok = ctx.memoryManager.getDashboardRepository().rejectAutoSkill(String(req.params.id));
            if (!ok) return res.status(404).json({ success: false, error: 'Skill not found' });
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: errorMessage(err) });
        }
    });

    router.post('/auto/:id/activate', (req: Request, res: Response) => {
        if (!ctx.memoryManager) return res.status(500).json({ error: 'Memory not available' });
        try {
            const ok = ctx.memoryManager.getDashboardRepository().activateAutoSkill(String(req.params.id));
            if (!ok) return res.status(404).json({ success: false, error: 'Skill not found or not rejected' });
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: errorMessage(err) });
        }
    });

    router.post('/auto/:id/deactivate', (req: Request, res: Response) => {
        if (!ctx.memoryManager) return res.status(500).json({ error: 'Memory not available' });
        try {
            const ok = ctx.memoryManager.getDashboardRepository().deactivateAutoSkill(String(req.params.id));
            if (!ok) return res.status(404).json({ success: false, error: 'Skill not found or not active' });
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: errorMessage(err) });
        }
    });

    router.delete('/auto/:id', (req: Request, res: Response) => {
        if (!ctx.memoryManager) return res.status(500).json({ error: 'Memory not available' });
        try {
            const ok = ctx.memoryManager.getDashboardRepository().deleteAutoSkill(String(req.params.id));
            if (!ok) return res.status(404).json({ success: false, error: 'Skill not found' });
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: errorMessage(err) });
        }
    });

    router.post('/install', async (req: Request, res: Response) => {
        if (!ctx.skillInstaller) return res.status(500).json({ error: 'SkillInstaller not available' });
        try {
            const result = await ctx.skillInstaller.install(req.body);
            res.json(result);
        } catch (err) {
            res.status(500).json({ error: errorMessage(err) });
        }
    });

    router.get('/installed', (_req: Request, res: Response) => {
        if (!ctx.skillInstaller) return res.status(500).json({ error: 'SkillInstaller not available' });
        try {
            const skills = ctx.skillInstaller.listInstalled();
            res.json({ success: true, skills });
        } catch (err) {
            res.status(500).json({ error: errorMessage(err) });
        }
    });

    router.delete('/:name', async (req: Request, res: Response) => {
        if (!ctx.skillInstaller) return res.status(500).json({ error: 'SkillInstaller not available' });
        try {
            const result = await ctx.skillInstaller.remove(String(req.params.name));
            res.json(result);
        } catch (err) {
            res.status(500).json({ error: errorMessage(err) });
        }
    });

    return router;
}
