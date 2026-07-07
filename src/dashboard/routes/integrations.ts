import { Router, Request, Response } from 'express';
import { spawn } from 'child_process';
import path from 'path';
import { errorMessage } from '../../shared/errors';
import { DashboardContext } from './types';
import { createLogger } from '../../shared/AppLogger';
import { dashboardAuth } from './auth';

const log = createLogger('Integrations');

export function createIntegrationsRouter(_ctx: DashboardContext): Router {
    const router = Router();

    router.post('/install/powerpoint', (req: Request, res: Response) => {
        try {
            // Get token from cookie or header
            const headerToken = req.headers.authorization?.replace('Bearer ', '') || req.query.token;
            const cookieToken = req.cookies?.newclaw_session;
            let token = (headerToken || cookieToken) as string;

            if (!dashboardAuth.enabled) {
                token = 'no-auth-required';
            }

            if (!token) {
                return res.status(401).json({ error: 'Nenhum token de autenticação disponível.' });
            }

            const addinDir = path.join(process.cwd(), 'addins', 'powerpoint-addin');
            const installScript = path.join(addinDir, 'install.ps1');

            // Pass the token safely
            const args = [
                '-ExecutionPolicy', 'Bypass',
                '-NonInteractive',
                '-File', installScript,
                '-NonInteractive', // For the script parameter
                '-Token', token,
                '-ServerUrl', `http://127.0.0.1:3090`
            ];

            log.info(`Instalando suplemento PowerPoint: powershell ${args.join(' ')}`);

            const child = spawn('powershell.exe', args, {
                cwd: addinDir,
                windowsHide: true,
            });

            let output = '';

            child.stdout.on('data', (data) => {
                const text = data.toString();
                output += text;
                log.info(`[PPTX Install] ${text.trim()}`);
            });

            child.stderr.on('data', (data) => {
                const text = data.toString();
                output += text;
                log.warn(`[PPTX Install Error] ${text.trim()}`);
            });

            child.on('close', (code) => {
                log.info(`Instalação do suplemento PowerPoint concluída com código ${code}`);
            });

            // Return early to avoid timeout and let the client assume it's running in background
            res.json({ 
                success: true, 
                message: 'Instalação iniciada em segundo plano. Verifique os logs no terminal (ou na view) para acompanhar o progresso.' 
            });

        } catch (err) {
            res.status(500).json({ error: errorMessage(err) });
        }
    });

    return router;
}
