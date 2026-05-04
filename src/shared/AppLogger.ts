/**
 * AppLogger — Structured logging with LOG_LEVEL support + file audit logging
 * 
 * LOG_LEVEL: debug | info | warn | error (default: info)
 * 
 * Features:
 *   - Console output with colors and icons
 *   - File audit logging (plain text, no ANSI codes) for forensics
 *   - Configurable via LOG_LEVEL and LOG_FILE env vars
 * 
 * Usage:
 *   const logger = createLogger('MyComponent');
 *   logger.debug('event_name', 'optional message', { key: 'value' });
 *   logger.info('event_name', 'message');
 *   logger.warn('event_name', 'warning');
 *   logger.error('event_name', error, 'context');
 */

import * as fs from 'fs';
import * as path from 'path';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40
};

const COLORS: Record<LogLevel, string> = {
    debug: '\x1b[2m',    // DIM
    info: '\x1b[36m',   // CYAN
    warn: '\x1b[33m',   // YELLOW
    error: '\x1b[31m'  // RED
};

const ICONS: Record<LogLevel, string> = {
    debug: '🔍',
    info: 'ℹ️',
    warn: '⚠️',
    error: '❌'
};

const RESET = '\x1b[0m';

function parseLevel(env?: string): LogLevel {
    const normalized = (env || 'info').toLowerCase().trim();
    if (normalized in LEVELS) return normalized as LogLevel;
    return 'info';
}

const configuredLevel = parseLevel(process.env.LOG_LEVEL);

function shouldLog(level: LogLevel): boolean {
    return LEVELS[level] >= LEVELS[configuredLevel];
}

// ── File audit logging ────────────────────────────────────────────
// Writes clean (no ANSI) lines to a log file for forensic auditing.
// Controlled by LOG_FILE env var (default: ./logs/newclaw-audit.log)

const LOG_FILE = process.env.LOG_FILE || '';
const auditStream: fs.WriteStream | null = (() => {
    if (!LOG_FILE) return null;
    try {
        const dir = path.dirname(LOG_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        return fs.createWriteStream(LOG_FILE, { flags: 'a', encoding: 'utf8' });
    } catch {
        return null;
    }
})();

function writeAuditLine(level: LogLevel, component: string, event: string, message?: string, meta?: Record<string, any>) {
    if (!auditStream) return;
    const timestamp = formatTimestamp();
    const levelStr = level.toUpperCase().padEnd(5);
    const metaStr = meta && Object.keys(meta).length > 0
        ? ' ' + Object.entries(meta).map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' ')
        : '';
    const msgStr = message ? ` ${message}` : '';
    auditStream.write(`[${timestamp}] ${levelStr} [${component}] ${event}${msgStr}${metaStr}\n`);
}

function formatTimestamp(): string {
    return new Date().toISOString().replace('T', ' ').substring(0, 19);
}

function writeLog(level: LogLevel, component: string, event: string, message?: string, meta?: Record<string, any>) {
    if (!shouldLog(level)) return;

    const timestamp = formatTimestamp();
    const color = COLORS[level];
    const icon = ICONS[level];
    const metaStr = meta && Object.keys(meta).length > 0 
        ? ' ' + Object.entries(meta).map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' ')
        : '';
    const msgStr = message ? ` ${message}` : '';

    const line = `${color}[${timestamp}] ${icon} [${component}] ${event}${msgStr}${metaStr}${RESET}`;
    
    if (level === 'error') {
        process.stderr.write(line + '\n');
    } else {
        process.stdout.write(line + '\n');
    }

    // Always write to audit file (no ANSI codes)
    writeAuditLine(level, component, event, message, meta);
}

export class AppLogger {
    private component: string;
    private baseMeta: Record<string, any>;

    constructor(component: string, baseMeta: Record<string, any> = {}) {
        this.component = component;
        this.baseMeta = baseMeta;
    }

    child(meta: Record<string, any>): AppLogger {
        return new AppLogger(this.component, { ...this.baseMeta, ...meta });
    }

    debug(event: string, message?: string, meta?: Record<string, any>) {
        writeLog('debug', this.component, event, message, { ...this.baseMeta, ...(meta || {}) });
    }

    info(event: string, message?: string, meta?: Record<string, any>) {
        writeLog('info', this.component, event, message, { ...this.baseMeta, ...(meta || {}) });
    }

    warn(event: string, message?: string, meta?: Record<string, any>) {
        writeLog('warn', this.component, event, message, { ...this.baseMeta, ...(meta || {}) });
    }

    error(event: string, error?: any, message?: string, meta?: Record<string, any>) {
        const errMsg = error instanceof Error ? error.message : typeof error === 'string' ? error : message || 'Unknown error';
        const errMeta = error instanceof Error ? { stack: error.stack, ...meta } : meta;
        writeLog('error', this.component, event, errMsg, errMeta);
    }
}

export function createLogger(component: string, baseMeta: Record<string, any> = {}): AppLogger {
    return new AppLogger(component, baseMeta);
}