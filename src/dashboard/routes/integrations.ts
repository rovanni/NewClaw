import { Router, Request, Response } from 'express';
import { spawn } from 'child_process';
import path from 'path';
import crypto from 'crypto';
import { errorMessage } from '../../shared/errors';
import { DashboardContext } from './types';
import { createLogger } from '../../shared/AppLogger';
import { dashboardAuth } from './auth';
import { powerpointBroker } from './powerpointBroker';

const log = createLogger('Integrations');

interface InstallJob {
    id: string;
    ownerId: string;
    status: 'running' | 'succeeded' | 'failed';
    createdAt: number;
    finishedAt?: number;
}

const activeJobs = new Map<string, InstallJob>();

// TTL Garbage Collector
const gcInterval = setInterval(() => {
    const now = Date.now();
    for (const [id, job] of activeJobs.entries()) {
        if (job.status !== 'running' && job.finishedAt && (now - job.finishedAt > 1000 * 60 * 60)) {
            activeJobs.delete(id);
        }
    }
}, 15 * 60 * 1000);
if (gcInterval.unref) gcInterval.unref();

function getRequestToken(req: Request): string | null {
    const headerToken = Array.isArray(req.headers.authorization) ? req.headers.authorization[0] : req.headers.authorization;
    const queryToken = Array.isArray(req.query.token) ? req.query.token[0] : req.query.token;
    const headerStr = headerToken?.replace('Bearer ', '') || queryToken;
    const cookieToken = req.cookies?.newclaw_session;
    let token = (headerStr || cookieToken) as string;
    if (!dashboardAuth.enabled) token = 'no-auth-required';
    return token || null;
}

function getOwnerId(token: string): string {
    if (token === 'no-auth-required') return 'system';
    const secret = dashboardAuth.passwordHash || 'newclaw-no-auth';
    return crypto.createHmac('sha256', secret).update(token).digest('hex');
}

export function createIntegrationsRouter(_ctx: DashboardContext, spawnFn: any = spawn): Router {
    const router = Router();

    router.get('/powerpoint/commands', (req: Request, res: Response) => {
        const sessionId = req.query.sessionId as string;
        if (!sessionId) {
            return res.status(400).json({ error: 'sessionId is required' });
        }
        const cmd = powerpointBroker.poll(sessionId);
        if (cmd) {
            return res.json({ commands: [cmd] });
        }
        return res.json({ commands: [] });
    });

    router.post('/powerpoint/commands/:commandId/result', (req: Request, res: Response) => {
        const commandId = req.params.commandId;
        const { sessionId, status, error, data } = req.body;
        if (!sessionId || !status) {
            return res.status(400).json({ error: 'sessionId and status are required' });
        }

        const result = powerpointBroker.ack(String(commandId), String(sessionId), status as any, error as string, data);
        if (result.error) {
            return res.status(400).json(result);
        }
        return res.json({ success: true });
    });

    router.get('/install/powerpoint/status/:jobId', (req: Request, res: Response) => {
        const token = getRequestToken(req);
        if (!token) return res.status(401).json({ error: 'Não autorizado.' });

        const job = activeJobs.get(req.params.jobId as string);
        if (!job) {
            return res.status(404).json({ error: 'Job inexistente.' });
        }

        const ownerId = getOwnerId(token);
        if (job.ownerId !== ownerId) {
            return res.status(404).json({ error: 'Job inexistente.' });
        }

        res.json({ status: job.status });
    });

    router.post('/install/powerpoint', (req: Request, res: Response) => {
        try {
            const token = getRequestToken(req);
            if (!token) {
                return res.status(401).json({ error: 'Nenhum token de autenticação disponível.' });
            }

            if (process.platform !== 'win32') {
                return res.status(400).json({
                    error: `A instalação remota neste servidor não é suportada. O suplemento precisa ser instalado no computador Windows onde o PowerPoint está disponível.`
                });
            }

            // Lock global (apenas 1 instalação simultânea de PPTX permitida neste host)
            for (const job of activeJobs.values()) {
                if (job.status === 'running') {
                    return res.status(409).json({ error: 'Uma instalação já está em andamento neste servidor.' });
                }
            }

            const jobId = crypto.randomUUID();
            const job: InstallJob = {
                id: jobId,
                ownerId: getOwnerId(token),
                status: 'running',
                createdAt: Date.now(),
            };
            activeJobs.set(jobId, job);

            const addinDir = path.join(process.cwd(), 'addins', 'powerpoint-addin');
            const installScript = path.join(addinDir, 'install.ps1');

            const args = [
                '-WindowStyle', 'Hidden',
                '-ExecutionPolicy', 'Bypass',
                '-NonInteractive',
                '-File', installScript,
                '-NonInteractive',
                '-ServerUrl', `http://127.0.0.1:3090`
            ];

            log.info(`Instalando suplemento PowerPoint (Job ${jobId}): powershell ${args.join(' ')}`);

            let child;
            try {
                child = spawnFn('powershell.exe', args, {
                    cwd: addinDir,
                    windowsHide: true,
                    env: { ...process.env, NODE_ENV: 'development', NEWCLAW_TOKEN: token }
                });
            } catch (err) {
                job.status = 'failed';
                job.finishedAt = Date.now();
                return res.status(500).json({ error: `Falha síncrona ao iniciar processo: ${errorMessage(err)}` });
            }

            let isTerminal = false;
            const finalizeJob = (status: 'succeeded' | 'failed') => {
                if (isTerminal) return;
                isTerminal = true;
                job.status = status;
                job.finishedAt = Date.now();
            };

            child.on('error', (err: Error) => {
                log.error(`[PPTX Install Error] Falha no processo: ${errorMessage(err)}`);
                finalizeJob('failed');
            });

            child.stdout.on('data', (data: Buffer) => {
                log.info(`[PPTX Install] ${data.toString().trim()}`);
            });

            child.stderr.on('data', (data: Buffer) => {
                log.warn(`[PPTX Install Warn] ${data.toString().trim()}`);
            });

            child.on('close', (code: number | null) => {
                log.info(`Instalação do suplemento PowerPoint concluída com código ${code}`);
                finalizeJob(code === 0 ? 'succeeded' : 'failed');
            });

            res.status(202).json({
                success: true,
                jobId,
                status: 'running',
                message: 'Instalação iniciada em segundo plano.'
            });

        } catch (err) {
            res.status(500).json({ error: errorMessage(err) });
        }
    });
    router.delete('/install/powerpoint', (req: Request, res: Response) => {
        try {
            const token = getRequestToken(req);
            if (!token) {
                return res.status(401).json({ error: 'Nenhum token de autenticação disponível.' });
            }

            if (process.platform !== 'win32') {
                return res.status(400).json({ error: 'Desinstalação apenas suportada em Windows.' });
            }

            const addinDir = path.join(process.cwd(), 'addins', 'powerpoint-addin');
            const uninstallScript = path.join(addinDir, 'uninstall.ps1');

            const child = spawnFn('powershell.exe', [
                '-WindowStyle', 'Hidden',
                '-ExecutionPolicy', 'Bypass',
                '-File', uninstallScript
            ], {
                cwd: addinDir,
                windowsHide: true,
                env: { ...process.env, NODE_ENV: 'development', NEWCLAW_TOKEN: token },
                detached: false
            });

            let out = '';
            child.stdout.on('data', (data: Buffer) => out += data.toString());
            child.stderr.on('data', (data: Buffer) => out += data.toString());

            child.on('close', (code: number) => {
                if (code === 0) {
                    res.json({ success: true, message: 'Suplemento desinstalado.' });
                } else {
                    res.status(500).json({ error: `Erro na desinstalação: ${out}` });
                }
            });

        } catch (err) {
            res.status(500).json({ error: errorMessage(err) });
        }
    });

    router.get('/powerpoint/status', (_req: Request, res: Response) => {
        try {
            if (process.platform !== 'win32') {
                return res.json({ installed: false });
            }

            // Verifica se o pm2 newclaw-pptx-addin existe
            const child = spawnFn('pm2', ['show', 'newclaw-pptx-addin'], { windowsHide: true });

            let responded = false;
            child.on('close', (code: number) => {
                if (responded) return;
                responded = true;
                res.json({ installed: code === 0 });
            });
            child.on('error', () => {
                if (responded) return;
                responded = true;
                res.json({ installed: false });
            });

        } catch (err) {
            res.status(500).json({ error: errorMessage(err) });
        }
    });

    return router;
}
