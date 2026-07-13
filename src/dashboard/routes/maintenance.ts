import express, { Router, Request, Response } from 'express';
import { exec, spawn } from 'child_process';
import { errorMessage } from '../../shared/errors';
import { createLogger } from '../../shared/AppLogger';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

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

// Abre o arquivo em modo readonly e executa PRAGMA integrity_check.
// Lança erro se o arquivo não for um SQLite válido ou estiver corrompido.
// Usado tanto no upload quanto no restore para evitar que arquivos ruins entrem no sistema.
function validateSqliteFile(filePath: string): void {
    const db = new Database(filePath, { readonly: true });
    try {
        const row = db.prepare('PRAGMA integrity_check').get() as { integrity_check: string } | undefined;
        if (row?.integrity_check !== 'ok') {
            throw new Error(`Arquivo SQLite corrompido: integrity_check retornou "${row?.integrity_check}"`);
        }
    } finally {
        db.close();
    }
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

function parseCronHuman(expr: string): string {
    const [min, hour, day, month, weekday] = expr.split(' ');
    if (!min || !hour) return expr;

    if (min === '0' && hour.startsWith('*/') && day === '*' && month === '*' && weekday === '*') {
        const n = hour.slice(2);
        return `a cada ${n} hora${n === '1' ? '' : 's'}`;
    }
    if (min.startsWith('*/') && hour === '*' && day === '*' && month === '*' && weekday === '*') {
        const n = min.slice(2);
        return `a cada ${n} minuto${n === '1' ? '' : 's'}`;
    }
    if (/^\d+$/.test(min) && /^\d+$/.test(hour) && day === '*' && month === '*' && weekday === '*') {
        return `todo dia às ${hour}h${min !== '0' ? min : ''}`;
    }
    if (min === '0' && hour === '0' && day === '*' && month === '*' && weekday !== '*') {
        const days = ['domingo','segunda-feira','terça-feira','quarta-feira','quinta-feira','sexta-feira','sábado'];
        const d = parseInt(weekday, 10);
        return `toda ${days[d] ?? weekday} à meia-noite`;
    }
    if (min === '0' && hour === '0' && day === '1' && month === '*' && weekday === '*') {
        return 'todo dia 1 do mês';
    }
    return expr; // fallback: mostra a expressão raw
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

// Safety backups (pre-restore) are never subject to retention — they protect against
// a bad restore and are already limited naturally (one per restore attempt).
function enforceRetention(prefix: string, retentionCount: number) {
    try {
        const files = fs.readdirSync(BACKUP_DIR)
            .filter(f => f.startsWith(prefix) && !f.includes('pre-restore'))
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

// ── Build log streaming ────────────────────────────────────────────────────
interface LogSub { res: Response; alive: boolean; }

class BuildLogBuffer {
    private lines: string[] = [];
    private subs: LogSub[] = [];
    private _running = false;

    get running() { return this._running; }

    start() {
        this.lines = [];
        this.subs = [];
        this._running = true;
    }

    push(raw: string) {
        raw.split('\n').filter(l => l.trim()).forEach(line => {
            this.lines.push(line);
            this.subs = this.subs.filter(s => s.alive);
            for (const s of this.subs) {
                try { s.res.write(`data: ${JSON.stringify({ line })}\n\n`); }
                catch { s.alive = false; }
            }
        });
    }

    finish(ok: boolean) {
        this._running = false;
        const evt = ok ? 'done' : 'error';
        this.subs.forEach(s => {
            try { s.res.write(`event: ${evt}\ndata: {}\n\n`); s.res.end(); } catch {}
        });
        this.subs = [];
    }

    subscribe(res: Response): () => void {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();
        for (const line of this.lines) {
            res.write(`data: ${JSON.stringify({ line })}\n\n`);
        }
        if (!this._running) {
            res.write(`event: done\ndata: {}\n\n`);
            res.end();
            return () => {};
        }
        const sub: LogSub = { res, alive: true };
        this.subs.push(sub);
        return () => { sub.alive = false; };
    }
}

const buildLog = new BuildLogBuffer();

// ── Canais de atualização ────────────────────────────────────────────────
// bin/newclaw (resolveUpdateChannel) é a fonte única de verdade sobre qual branch
// usar. Este router nunca reimplementa git — ele só invoca `bin/newclaw update`
// com os modos --check / --list-branches (somente leitura, imprimem um JSON em
// stdout) e repassa channel/branch para o `update restart` real via spawn, do
// mesmo jeito que /update/apply já fazia antes desta mudança.
const VALID_UPDATE_CHANNELS = ['stable', 'preview', 'dev'] as const;
type UpdateChannel = typeof VALID_UPDATE_CHANNELS[number];

// Nomes de branch git válidos (cobre o padrão real do projeto, ex.:
// experimental/artifact-pipeline-refactor). Validado aqui porque channel/branch
// chegam do body/query HTTP — fronteira de confiança antes de virar argv do
// processo filho.
const BRANCH_NAME_RE = /^[A-Za-z0-9._/-]+$/;

function parseChannelParams(input: Record<string, unknown>): { args: string[]; error?: string } {
    const { channel, branch } = input;
    if (channel === undefined || channel === null || channel === '') return { args: [] };
    if (typeof channel !== 'string' || !VALID_UPDATE_CHANNELS.includes(channel as UpdateChannel)) {
        return { args: [], error: `channel inválido: ${String(channel)}` };
    }
    const args = [`--channel=${channel}`];
    if (channel === 'dev') {
        if (typeof branch !== 'string' || !branch || !BRANCH_NAME_RE.test(branch)) {
            return { args: [], error: 'branch é obrigatório e deve ser um nome de branch git válido quando channel=dev' };
        }
        args.push(`--branch=${branch}`);
    }
    return { args };
}

function runNewclawCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
        const node = process.execPath;
        const cli = path.join(DIR, 'bin', 'newclaw');
        const child = spawn(node, [cli, ...args], { cwd: DIR, windowsHide: true });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
        child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
        child.on('close', (code) => resolve({ code, stdout, stderr }));
        child.on('error', (err) => resolve({ code: -1, stdout, stderr: errorMessage(err) }));
    });
}

function parseLastJsonLine(stdout: string): unknown {
    const lastLine = stdout.trim().split('\n').filter(Boolean).pop() || '';
    return JSON.parse(lastLine);
}

export function createMaintenanceRouter(): Router {
    const router = Router();

    // GET /api/maintenance/update/check?channel=&branch=
    router.get('/update/check', async (req: Request, res: Response) => {
        const { args, error } = parseChannelParams(req.query as Record<string, unknown>);
        if (error) return res.status(400).json({ success: false, error });

        const { stdout, stderr } = await runNewclawCli(['update', '--check', ...args]);
        try {
            const parsed = parseLastJsonLine(stdout) as { success: boolean; error?: string };
            if (!parsed.success) {
                return res.status(500).json({ success: false, error: parsed.error || 'Falha ao verificar atualização.' });
            }
            res.json(parsed);
        } catch {
            res.status(500).json({ success: false, error: stderr || 'Resposta inesperada do CLI ao verificar atualização.' });
        }
    });

    // GET /api/maintenance/update/branches
    router.get('/update/branches', async (_req: Request, res: Response) => {
        const { stdout, stderr } = await runNewclawCli(['update', '--list-branches']);
        try {
            const parsed = parseLastJsonLine(stdout) as { success: boolean; branches?: string[] };
            res.json(parsed);
        } catch {
            res.status(500).json({ success: false, error: stderr || 'Resposta inesperada do CLI ao listar branches.' });
        }
    });

    // POST /api/maintenance/update/apply  { channel?, branch? }
    router.post('/update/apply', (req: Request, res: Response) => {
        if (buildLog.running) {
            return res.status(409).json({ success: false, error: 'Atualização já em andamento.' });
        }
        const { args, error } = parseChannelParams(req.body || {});
        if (error) return res.status(400).json({ success: false, error });

        res.json({ success: true, message: 'Atualização iniciada.' });

        buildLog.start();
        const node = process.execPath;
        const cli = path.join(DIR, 'bin', 'newclaw');
        const child = spawn(node, [cli, 'update', 'restart', ...args], { cwd: DIR, windowsHide: true });

        child.stdout.on('data', (d: Buffer) => buildLog.push(d.toString()));
        child.stderr.on('data', (d: Buffer) => buildLog.push(d.toString()));
        child.on('close', (code) => {
            log.info(`Update process exited with code ${code}`);
            buildLog.finish(code === 0);
        });
        child.on('error', (err) => {
            buildLog.push(`❌ ${errorMessage(err)}`);
            buildLog.finish(false);
        });
    });

    // GET /api/maintenance/update/stream  (SSE)
    router.get('/update/stream', (req: Request, res: Response) => {
        const unsub = buildLog.subscribe(res);
        req.on('close', unsub);
    });

    // GET /api/maintenance/backup/schedule
    router.get('/backup/schedule', (_req: Request, res: Response) => {
        if (process.platform === 'win32') {
            return res.json({ success: true, found: false, humanReadable: null, cronExpr: null, raw: null, note: 'Agendamento via cron não disponível no Windows. Use o Agendador de Tarefas do Windows (taskschd.msc).' });
        }
        exec('crontab -l 2>/dev/null', { windowsHide: true }, (_err, stdout) => {
            const lines = (stdout || '').split('\n')
                .filter(l => l.includes('backup_db.sh') && !l.trim().startsWith('#'));

            if (!lines.length) {
                return res.json({ success: true, found: false, humanReadable: null, cronExpr: null, raw: null });
            }

            const raw = lines[0].trim();
            const parts = raw.split(/\s+/);
            const cronExpr = parts.slice(0, 5).join(' ');
            const humanReadable = parseCronHuman(cronExpr);

            res.json({ success: true, found: true, raw, cronExpr, humanReadable });
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
    router.post('/backup/database', async (_req: Request, res: Response) => {
        try {
            ensureBackupDir();
            if (!fs.existsSync(DB_FILE)) return res.status(404).json({ success: false, error: 'Banco de dados não encontrado' });
            const ts = timestamp();
            const dest = path.join(BACKUP_DIR, `database-${ts}.db`);
            // Use better-sqlite3's Online Backup API: safely snapshots the DB even in WAL
            // mode with concurrent writers. fs.copyFileSync would miss the WAL journal.
            const db = new Database(DB_FILE, { readonly: true });
            try {
                await db.backup(dest);
            } finally {
                db.close();
            }
            const { retentionCount } = loadBackupConfig();
            enforceRetention('database-', retentionCount);
            const stat = fs.statSync(dest);
            log.info(`Backup do banco criado: ${dest}`);
            res.json({ success: true, backup: { name: `database-${ts}.db`, size: stat.size, sizeHuman: formatBytes(stat.size), createdAt: stat.mtime.toISOString() } });
        } catch (err) {
            res.status(500).json({ success: false, error: errorMessage(err) });
        }
    });

    // POST /api/maintenance/backup/restore
    router.post('/backup/restore', async (req: Request, res: Response) => {
        try {
            const { filename } = req.body || {};
            if (!filename) return res.status(400).json({ success: false, error: 'filename obrigatório' });
            const safe = path.basename(String(filename));
            const filePath = path.join(BACKUP_DIR, safe);
            if (!fs.existsSync(filePath)) return res.status(404).json({ success: false, error: 'Arquivo não encontrado' });
            const isSystem   = safe.startsWith('system-')   && safe.endsWith('.bak');
            const isDatabase = safe.startsWith('database-') && safe.endsWith('.db');
            if (!isSystem && !isDatabase) return res.status(400).json({ success: false, error: 'Tipo de backup inválido' });
            const ts = timestamp();
            ensureBackupDir();

            if (isSystem) {
                const envDest = ENV_CANDIDATES.find(f => fs.existsSync(f)) || ENV_CANDIDATES[ENV_CANDIDATES.length - 1];
                if (fs.existsSync(envDest)) {
                    fs.copyFileSync(envDest, path.join(BACKUP_DIR, `system-pre-restore-${ts}.bak`));
                }
                fs.copyFileSync(filePath, envDest);
                log.info(`Sistema restaurado de ${safe} — reiniciando`);
                setTimeout(() => process.exit(0), 500);
                return res.json({ success: true, message: 'Restauração do sistema concluída. O processo será reiniciado.' });
            }

            // Valida o arquivo antes de tocar no banco atual
            try {
                validateSqliteFile(filePath);
            } catch (validationErr) {
                return res.status(422).json({ success: false, error: `Backup inválido ou corrompido — restauração cancelada. ${errorMessage(validationErr)}` });
            }

            // Database: cria backup de segurança via Online Backup API, depois aplica restore
            if (fs.existsSync(DB_FILE)) {
                const safetyDest = path.join(BACKUP_DIR, `database-pre-restore-${ts}.db`);
                const dbSrc = new Database(DB_FILE, { readonly: true });
                try { await dbSrc.backup(safetyDest); } finally { dbSrc.close(); }
            }

            // Estágio 1: copia o backup para newclaw.db.restore + flag (fallback para index.ts startup check)
            const dataDir = path.join(DIR, 'data');
            const pendingSource = path.join(dataDir, 'newclaw.db.restore');
            fs.copyFileSync(filePath, pendingSource);
            fs.writeFileSync(
                path.join(dataDir, '.restore-pending'),
                JSON.stringify({ source: 'newclaw.db.restore', timestamp: ts })
            );

            // Estágio 2: helper process detached que aplica o restore diretamente após o exit.
            // PM2 tem restart_delay de 40 s — o helper conclui bem antes disso.
            // Não depende do index.ts startup check (compatível com dist/index.js desatualizado).
            const helperCode = [
                'const fs=require("fs"),p=require("path");',
                `const d=${JSON.stringify(dataDir)};`,
                'setTimeout(()=>{',
                '  const src=p.join(d,"newclaw.db.restore");',
                '  const dst=p.join(d,"newclaw.db");',
                '  const flag=p.join(d,".restore-pending");',
                '  if(!fs.existsSync(src))return;',
                '  try{fs.unlinkSync(dst+"-wal");}catch{}',
                '  try{fs.unlinkSync(dst+"-shm");}catch{}',
                '  try{fs.copyFileSync(src,dst);fs.unlinkSync(src);fs.unlinkSync(flag);}catch(e){console.error("restore-helper:",e.message);}',
                '},2000);',
            ].join('');
            const helper = spawn(process.execPath, ['-e', helperCode], { detached: true, stdio: 'ignore', windowsHide: true });
            helper.unref();

            log.info(`Banco de dados agendado para restauração de ${safe} — reiniciando`);
            setTimeout(() => process.exit(0), 500);
            return res.json({ success: true, message: 'Restauração do banco agendada. O processo será reiniciado.' });
        } catch (err) {
            res.status(500).json({ success: false, error: errorMessage(err) });
        }
    });

    // POST /api/maintenance/backup/upload
    router.post('/backup/upload',
        (req: Request, res: Response, next) => {
            // Accept raw binary body (Content-Type: application/octet-stream)
            // express.raw is applied only for this route to avoid interfering with json body parser
            express.raw({ type: 'application/octet-stream', limit: '100mb' })(req, res, next);
        },
        (req: Request, res: Response) => {
            try {
                const rawName = String(req.headers['x-filename'] || '');
                const safe = path.basename(rawName).replace(/[^a-zA-Z0-9._-]/g, '_');
                if (!safe || (!safe.endsWith('.bak') && !safe.endsWith('.db'))) {
                    return res.status(400).json({ success: false, error: 'Arquivo deve ter extensão .bak ou .db' });
                }
                if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
                    return res.status(400).json({ success: false, error: 'Corpo da requisição vazio' });
                }
                ensureBackupDir();
                const dest = path.join(BACKUP_DIR, safe);
                const tmp  = dest + '.tmp';
                fs.writeFileSync(tmp, req.body);

                // Para arquivos .db, valida integridade antes de aceitar
                if (safe.endsWith('.db')) {
                    try {
                        validateSqliteFile(tmp);
                    } catch (validationErr) {
                        fs.unlinkSync(tmp);
                        return res.status(422).json({ success: false, error: `Arquivo SQLite inválido ou corrompido — upload rejeitado. ${errorMessage(validationErr)}` });
                    }
                }

                fs.renameSync(tmp, dest);
                const stat = fs.statSync(dest);
                log.info(`Backup enviado: ${safe} (${formatBytes(stat.size)})`);
                res.json({ success: true, backup: { name: safe, size: stat.size, sizeHuman: formatBytes(stat.size), createdAt: stat.mtime.toISOString() } });
            } catch (err) {
                res.status(500).json({ success: false, error: errorMessage(err) });
            }
        }
    );

    // GET /api/maintenance/backup/:filename  (download)
    router.get('/backup/:filename', (req: Request, res: Response) => {
        try {
            const filename = path.basename(String(req.params.filename));
            const filePath = path.join(BACKUP_DIR, filename);
            if (!fs.existsSync(filePath)) {
                return res.status(404).json({ success: false, error: `Arquivo não encontrado: ${filename}` });
            }
            // Pass error callback: without it, a streaming failure silently closes
            // the connection, causing "O arquivo não estava disponível no site" in the browser.
            res.download(filePath, filename, (err) => {
                if (err && !res.headersSent) {
                    log.error(`Erro ao enviar backup ${filename}: ${errorMessage(err)}`);
                    res.status(500).json({ success: false, error: errorMessage(err) });
                } else if (err) {
                    log.error(`Erro durante streaming de ${filename}: ${errorMessage(err)}`);
                }
            });
        } catch (err) {
            res.status(500).json({ success: false, error: errorMessage(err) });
        }
    });

    return router;
}
