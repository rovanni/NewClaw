import { Router, Request, Response } from 'express';
import path from 'path';
import { errorMessage } from '../../shared/errors';
import { DashboardContext } from './types';

export function createSkillsRouter(ctx: DashboardContext): Router {
    const router = Router();

    // ── Filesystem skills (SkillLoader) ───────────────────────────────────────

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

    // ── Auto-skills (SkillLearner) — read ─────────────────────────────────────

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

    // ── Auto-skills — lifecycle (SkillLearner owns file export/remove) ─────────
    //
    // SkillLearner is the single authority for auto-skill lifecycle so that
    // approve/reject/activate/deactivate always stay in sync with the filesystem.
    // If ctx.skillLearner is not wired up yet (e.g. standalone dashboard), we fall
    // back to DashboardMemoryRepository (DB-only, no file ops) for backward compat.

    router.post('/auto/:id/approve', (req: Request, res: Response) => {
        const id = String(req.params.id);

        if (ctx.skillLearner) {
            try {
                const ok = ctx.skillLearner.approveSkill(id);
                if (!ok) return res.status(404).json({ success: false, error: 'Skill not found or not in proposed state' });
                return res.json({ success: true });
            } catch (err) {
                return res.status(500).json({ error: errorMessage(err) });
            }
        }

        if (!ctx.memoryManager) return res.status(500).json({ error: 'Memory not available' });
        try {
            const ok = ctx.memoryManager.getDashboardRepository().approveAutoSkill(id);
            if (!ok) return res.status(404).json({ success: false, error: 'Skill not found' });
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: errorMessage(err) });
        }
    });

    router.post('/auto/:id/reject', (req: Request, res: Response) => {
        const id = String(req.params.id);

        if (ctx.skillLearner) {
            try {
                const ok = ctx.skillLearner.rejectSkill(id);
                if (!ok) return res.status(404).json({ success: false, error: 'Skill not found' });
                return res.json({ success: true });
            } catch (err) {
                return res.status(500).json({ error: errorMessage(err) });
            }
        }

        if (!ctx.memoryManager) return res.status(500).json({ error: 'Memory not available' });
        try {
            const ok = ctx.memoryManager.getDashboardRepository().rejectAutoSkill(id);
            if (!ok) return res.status(404).json({ success: false, error: 'Skill not found' });
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: errorMessage(err) });
        }
    });

    router.post('/auto/:id/activate', (req: Request, res: Response) => {
        const id = String(req.params.id);

        if (ctx.skillLearner) {
            try {
                const ok = ctx.skillLearner.activateSkill(id);
                if (!ok) return res.status(404).json({ success: false, error: 'Skill not found or not rejected/inactive' });
                return res.json({ success: true });
            } catch (err) {
                return res.status(500).json({ error: errorMessage(err) });
            }
        }

        if (!ctx.memoryManager) return res.status(500).json({ error: 'Memory not available' });
        try {
            const ok = ctx.memoryManager.getDashboardRepository().activateAutoSkill(id);
            if (!ok) return res.status(404).json({ success: false, error: 'Skill not found or not rejected' });
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: errorMessage(err) });
        }
    });

    router.post('/auto/:id/deactivate', (req: Request, res: Response) => {
        const id = String(req.params.id);

        if (ctx.skillLearner) {
            try {
                const ok = ctx.skillLearner.deactivateSkill(id);
                if (!ok) return res.status(404).json({ success: false, error: 'Skill not found or not active' });
                return res.json({ success: true });
            } catch (err) {
                return res.status(500).json({ error: errorMessage(err) });
            }
        }

        if (!ctx.memoryManager) return res.status(500).json({ error: 'Memory not available' });
        try {
            const ok = ctx.memoryManager.getDashboardRepository().deactivateAutoSkill(id);
            if (!ok) return res.status(404).json({ success: false, error: 'Skill not found or not active' });
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: errorMessage(err) });
        }
    });

    router.delete('/auto/:id', (req: Request, res: Response) => {
        const id = String(req.params.id);

        if (ctx.skillLearner) {
            try {
                const ok = ctx.skillLearner.deleteSkill(id);
                if (!ok) return res.status(404).json({ success: false, error: 'Skill not found' });
                return res.json({ success: true });
            } catch (err) {
                return res.status(500).json({ error: errorMessage(err) });
            }
        }

        if (!ctx.memoryManager) return res.status(500).json({ error: 'Memory not available' });
        try {
            const ok = ctx.memoryManager.getDashboardRepository().deleteAutoSkill(id);
            if (!ok) return res.status(404).json({ success: false, error: 'Skill not found' });
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: errorMessage(err) });
        }
    });

    // ── SkillInstaller (git / npm / npx) ──────────────────────────────────────

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
