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
            const db = ctx.memoryManager.getDatabase();
            if (!db) return res.status(500).json({ error: 'DB not available' });

            const skills = db.prepare(
                `SELECT id, name, trigger, description, tool_sequence, priority, hits, status, source_pattern, source_tool, reviewed_at, created_at, updated_at
                 FROM auto_skills
                 ORDER BY
                    CASE status WHEN 'active' THEN 0 WHEN 'proposed' THEN 1 ELSE 2 END,
                    priority DESC,
                    hits DESC,
                    updated_at DESC`
            ).all();

            res.json({ success: true, skills });
        } catch (err) {
            res.status(500).json({ error: errorMessage(err) });
        }
    });

    router.get('/patterns', (_req: Request, res: Response) => {
        if (!ctx.memoryManager) return res.status(500).json({ error: 'Memory not available' });
        try {
            const db = ctx.memoryManager.getDatabase();
            if (!db) return res.status(500).json({ error: 'DB not available' });

            const patterns = db.prepare(
                `SELECT pattern, tool_name, success_count, fail_count, avg_latency_ms, last_seen, created_at
                 FROM skill_patterns
                 ORDER BY success_count DESC, fail_count ASC, avg_latency_ms ASC, last_seen DESC`
            ).all();

            res.json({ success: true, patterns });
        } catch (err) {
            res.status(500).json({ error: errorMessage(err) });
        }
    });

    router.post('/auto/:id/approve', (req: Request, res: Response) => {
        if (!ctx.memoryManager) return res.status(500).json({ error: 'Memory not available' });
        try {
            const db = ctx.memoryManager.getDatabase();
            if (!db) return res.status(500).json({ error: 'DB not available' });

            const result = db.prepare(
                `UPDATE auto_skills
                 SET status = 'active', reviewed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?`
            ).run(String(req.params.id));

            if (result.changes === 0) return res.status(404).json({ success: false, error: 'Skill not found' });
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: errorMessage(err) });
        }
    });

    router.post('/auto/:id/reject', (req: Request, res: Response) => {
        if (!ctx.memoryManager) return res.status(500).json({ error: 'Memory not available' });
        try {
            const db = ctx.memoryManager.getDatabase();
            if (!db) return res.status(500).json({ error: 'DB not available' });

            const result = db.prepare(
                `UPDATE auto_skills
                 SET status = 'rejected', reviewed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?`
            ).run(String(req.params.id));

            if (result.changes === 0) return res.status(404).json({ success: false, error: 'Skill not found' });
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
