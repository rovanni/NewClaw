import { Router, Request, Response } from 'express';
import { exec, execSync } from 'child_process';
import { errorMessage } from '../../shared/errors';
import { createLogger } from '../../shared/AppLogger';
import fs from 'fs';
import path from 'path';

const log = createLogger('Maintenance');
const DIR = process.cwd();
const BACKUP_DIR = path.join(DIR, 'data', 'backups');
const DB_FILE = path.join(DIR, 'data', 'newclaw.db');
const BACKUP_CONFIG_FILE = path.join(DIR, 'data', 'backup-config.json');
const ENV_CANDIDATES = [path.join(DIR, 'newclaw.env'), path.join(DIR, '.env')];

interface BackupConfig {
    retentionCount: number;
}

function ensureBackupDir() {
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

function timestamp(): string {
    return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

function formatBytes(bytes: number): string {
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    let size = bytes;
    while (size >= 1024 && i < units.length - 1) { size /= 1024; i++; }
    return `${size.toFixed(1)} ${units[i]}`;
}

function gitExec(cmd: string): string {
    return execSync(cmd, { cwd: DIR, encoding: 'utf8', timeout: 10000 }).trim();
}

function loadBackupConfig(): BackupConfig {
    try {
        if (fs.existsSync(BACKUP_CONFIG_FILE)) {
            const parsed = JSON.parse(fs.readFileSync(BACKUP_CONFIG_FILE, 'utf8'));
            return { retentionCount: 10, ...parsed };
        }
    } catch {}
    return { retentionCount: 10 };
}

function saveBackupConfig(cfg: BackupConfig) {
    fs.mkdirSync(path.dirname(BACKUP_CONFIG_FILE), { recursive: true });
    fs.writeFileSync(BACKUP_CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
}

function enforceRetention(prefix: string, retentionCount: number) {
    try {
        const files = fs.readdirSync(BACKUP_DIR)
            .filter(f => f.startsWith(prefix))
            .map(f => ({ name: f, mtime: fs.statSync(path.join(BACKUP_DIR, f)).mtime.getTime() }))
            .sort((a, b) => b.mtime - a.mtime);
        files.slice(retentionCount).forEach(({ name }) => {
            try {
                fs.unlinkSync(path.join(BACKUP_DIR, name));
                log.info(`Retenção: removido ${name}`);
            } catch {}
        });
    } catch {}
}

export function createMaintenanceRouter(): Router {
    const router = Router();

    // GET /api/maintenance/update/check
    router.get('/update/check', (_req: Request, res: Response) => {
        exec('git fetch origin main', { cwd: DIR, timeout: 20000 }, (fetchErr) => {
            try {
                if (fetchErr) throw new Error(`git fetch falhou: ${errorMessage(fetchErr)}`);
                const local = gitExec('git rev-parse HEAD');
                const remote = gitExec('git rev-parse origin/main');
                const hasUpdate = local !== remote;
                let commits: { sha: string; msg: string; when: string }[] = [];
                let commitCount = 0;
                if (hasUpdate) {
                    commitCount = parseInt(gitExec('git rev-list HEAD..origin/main --count'), 10) || 0;
                    const raw = gitExec('git log HEAD..origin/main --pretty=format:"%h|||%s|||%ar" -30');
                    commits = raw.split('\n').filter(Boolean).map(line => {
                        const [sha, msg, when] = line.split('|||');
                        return { sha: sha ?? '', msg: msg ?? '', when: when ?? '' };
                    });
                }
                res.json({ success: true, hasUpdate, localSha: local.slice(0, 7), remoteSha: remote.slice(0, 7), commitCount, commits });
            } catch (err) {
                res.status(500).json({ success: false, error: errorMessage(err) });
            }
        });
    });

    // POST /api/maintenance/update/apply
    router.post('/update/apply', (_req: Request, res: Response) => {
        res.json({ success: true, message: 'Atualização iniciada. O sistema será reiniciado automaticamente.' });
        const node = process.execPath;
        const cli = path.join(DIR, 'bin', 'newclaw');
        exec(`"${node}" "${cli}" update restart`, { cwd: DIR }, (err) => {
            if (err) log.error('Falha na atualização:', errorMessage(err));
        });
    });

    // GET /api/maintenance/backup/config
    router.get('/backup/config', (_req: Request, res: Response) => {
        res.json({ success: true, config: loadBackupConfig() });
    });

    // POST /api/maintenance/backup/config
    router.post('/backup/config', (req: Request, res: Response) => {
        try {
            const { retentionCount } = req.body || {};
            const cfg = loadBackupConfig();
            if (typeof retentionCount === 'number' && retentionCount >= 1) {
                cfg.retentionCount = Math.min(retentionCount, 100);
            }
            saveBackupConfig(cfg);
            res.json({ success: true, config: cfg });
        } catch (err) {
            res.status(500).json({ success: false, error: errorMessage(err) });
        }
    });

    // GET /api/maintenance/backup/list
    router.get('/backup/list', (_req: Request, res: Response) => {
        try {
            ensureBackupDir();
            const files = fs.readdirSync(BACKUP_DIR)
                .filter(f => f.endsWith('.bak') || f.endsWith('.db'))
                .map(f => {
                    const stat = fs.statSync(path.join(BACKUP_DIR, f));
                    return { name: f, size: stat.size, sizeHuman: formatBytes(stat.size), createdAt: stat.mtime.toISOString() };
                })
                .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
                .slice(0, 50);
            res.json({ success: true, backups: files });
        } catch (err) {
            res.status(500).json({ success: false, error: errorMessage(err) });
        }
    });

    // POST /api/maintenance/backup/system
    router.post('/backup/system', (_req: Request, res: Response) => {
        try {
            ensureBackupDir();
            const envSrc = ENV_CANDIDATES.find(f => fs.existsSync(f));
            if (!envSrc) return res.status(404).json({ success: false, error: '.env não encontrado' });
            const ts = timestamp();
            const dest = path.join(BACKUP_DIR, `system-${ts}.bak`);
            fs.copyFileSync(envSrc, dest);
            const { retentionCount } = loadBackupConfig();
            enforceRetention('system-', retentionCount);
            const stat = fs.statSync(dest);
            log.info(`Backup do sistema criado: ${dest}`);
            res.json({ success: true, backup: { name: `system-${ts}.bak`, size: stat.size, sizeHuman: formatBytes(stat.size), createdAt: stat.mtime.toISOString() } });
        } catch (err) {
            res.status(500).json({ success: false, error: errorMessage(err) });
        }
    });

    // POST /api/maintenance/backup/database
    router.post('/backup/database', (_req: Request, res: Response) => {
        try {
            ensureBackupDir();
            if (!fs.existsSync(DB_FILE)) return res.status(404).json({ success: false, error: 'Banco de dados não encontrado' });
            const ts = timestamp();
            const dest = path.join(BACKUP_DIR, `database-${ts}.db`);
            fs.copyFileSync(DB_FILE, dest);
            const { retentionCount } = loadBackupConfig();
            enforceRetention('database-', retentionCount);
            const stat = fs.statSync(dest);
            log.info(`Backup do banco criado: ${dest}`);
            res.json({ success: true, backup: { name: `database-${ts}.db`, size: stat.size, sizeHuman: formatBytes(stat.size), createdAt: stat.mtime.toISOString() } });
        } catch (err) {
            res.status(500).json({ success: false, error: errorMessage(err) });
        }
    });

    // GET /api/maintenance/backup/:filename  (download)
    router.get('/backup/:filename', (req: Request, res: Response) => {
        try {
            const filename = path.basename(String(req.params.filename));
            const filePath = path.join(BACKUP_DIR, filename);
            if (!fs.existsSync(filePath)) return res.status(404).json({ success: false, error: 'Arquivo não encontrado' });
            res.download(filePath, filename);
        } catch (err) {
            res.status(500).json({ success: false, error: errorMessage(err) });
        }
    });

    return router;
}
