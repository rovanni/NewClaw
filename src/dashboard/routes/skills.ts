import { Router, Request, Response } from 'express';
import path from 'path';
import { errorMessage } from '../../shared/errors';
import { DashboardContext } from './types';
import { SkillLoader, pastasDaInstalacao, acrescentarValidacao, lerTabelaDePastas, gravarTabelaDePastas, NOME_DE_PASTA } from '../../skills/SkillLoader';
import { rateLimit } from 'express-rate-limit';

/**
 * Limite das rotas de portabilidade (ADR-035), em cima do geral: elas leem todas as skills do disco e gravam SKILL.md.
 * `express-rate-limit` pelo mesmo motivo do limitador de backup em maintenance.ts: o CodeQL (js/missing-rate-limiting)
 * só reconhece limitadores de bibliotecas conhecidas. Mesmo limite de lá: 20/min por IP.
 */
const skillsFsRateLimit = rateLimit({
    windowMs: 60 * 1000,
    limit: 20,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Muitas requisições a rotas de skills — aguarde um instante.' },
});

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

    // ── ADR-035: portabilidade das skills em arquivo ──────────────────────────

    /** As skills em arquivo com os fatos de portabilidade e os avisos deste sistema. */
    router.get('/portabilidade', skillsFsRateLimit, (_req: Request, res: Response) => {
        try {
            const skillsPath = path.resolve(ctx.config.skillsDir);
            const loader = new SkillLoader(skillsPath, () => ({ ...pastasDaInstalacao(), skills: skillsPath }));
            const fs = require('fs') as typeof import('fs');
            const pastaDe = new Map<string, string>();
            if (fs.existsSync(skillsPath)) {
                for (const d of fs.readdirSync(skillsPath, { withFileTypes: true })) {
                    const arq = path.join(skillsPath, d.name, 'SKILL.md');
                    if (!d.isDirectory() || !fs.existsSync(arq)) continue;
                    const nome = fs.readFileSync(arq, 'utf8').match(/^name:\s*(.+)$/m)?.[1]?.trim();
                    if (nome) pastaDe.set(nome, d.name);
                }
            }
            const skills = loader.loadAll().map(s => ({
                nome: s.name, pasta: pastaDe.get(s.name), descricao: s.description,
                sistemaOrigem: s.sistemaOrigem ?? null, plataformas: s.plataformas ?? null, requer: s.requer ?? null,
                validadaEm: s.validadaEm ?? [], resumo: s.resumo, avisos: s.avisos?.curtos ?? [],
                validadaAqui: (s.validadaEm ?? []).some(v => v.sistema === process.platform && v.resumo === s.resumo),
            }));
            res.json({ success: true, sistema: process.platform, skills, pastas: lerTabelaDePastas() });
        } catch (err) {
            res.status(500).json({ success: false, error: errorMessage(err) });
        }
    });

    /** "Funcionou aqui": acrescenta este sistema e o resumo atual do corpo a validada_em (arquivo e, se houver, auto_skills). */
    router.post('/portabilidade/:pasta/funcionou', skillsFsRateLimit, (req: Request, res: Response) => {
        try {
            const fs = require('fs') as typeof import('fs');
            const skillsPath = path.resolve(ctx.config.skillsDir);
            const pasta = path.basename(String(req.params.pasta));
            const arq = path.join(skillsPath, pasta, 'SKILL.md');
            if (!fs.existsSync(arq)) return res.status(404).json({ success: false, error: 'skill não encontrada' });
            const loader = new SkillLoader(skillsPath, () => ({ ...pastasDaInstalacao(), skills: skillsPath }));
            const texto = fs.readFileSync(arq, 'utf8');
            const nome = texto.match(/^name:\s*(.+)$/m)?.[1]?.trim();
            const skill = nome ? loader.loadAll().find(s => s.name === nome) : undefined;
            if (!skill?.resumo) return res.status(422).json({ success: false, error: 'a skill não tem cabeçalho legível' });
            const novo = acrescentarValidacao(texto, process.platform, skill.resumo);
            if (!novo) return res.status(422).json({ success: false, error: 'a skill não tem cabeçalho' });
            fs.writeFileSync(arq, novo);
            const validada = novo.match(/^validada_em:\s*(.+)$/m)?.[1]?.trim() ?? null;
            // O banco também guarda (o SKILL.md regerado a partir dele mantém a validação). Falha não é silenciosa.
            let noBanco = false;
            try {
                noBanco = (ctx.memoryManager?.getDatabase().prepare(`UPDATE auto_skills SET validada_em = ? WHERE name = ?`).run(validada, nome).changes ?? 0) > 0;
            } catch (e) {
                return res.status(500).json({ success: false, error: `arquivo atualizado, mas o banco não: ${errorMessage(e)}` });
            }
            res.json({ success: true, validadaEm: validada, noBanco });
        } catch (err) {
            res.status(500).json({ success: false, error: errorMessage(err) });
        }
    });

    /** Tabela local `nome → pasta` dos marcadores {PASTA:nome} (D2). Fica nesta instalação; não vai no pacote da ADR-034. */
    router.put('/pastas', skillsFsRateLimit, (req: Request, res: Response) => {
        try {
            const fs = require('fs') as typeof import('fs');
            const tabela = (req.body?.pastas ?? {}) as Record<string, unknown>;
            const erros: string[] = [];
            const limpa: Record<string, string> = {};
            for (const [nome, caminho] of Object.entries(tabela)) {
                if (!NOME_DE_PASTA.test(nome)) { erros.push(`nome inválido: "${nome}" (só minúsculas, números e hífen)`); continue; }
                if (typeof caminho !== 'string' || !caminho.trim()) continue;
                if (!fs.existsSync(caminho.trim())) { erros.push(`"${nome}": a pasta não existe nesta máquina (${caminho})`); continue; }
                limpa[nome] = caminho.trim();
            }
            if (erros.length) return res.status(400).json({ success: false, error: erros.join('; ') });
            gravarTabelaDePastas(limpa);
            res.json({ success: true, pastas: lerTabelaDePastas() });
        } catch (err) {
            res.status(500).json({ success: false, error: errorMessage(err) });
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
