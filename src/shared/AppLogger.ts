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

function getConfiguredLevel(): LogLevel {
    const env = process.env.LOG_LEVEL;
    const normalized = (env || 'info').toLowerCase().trim();
    if (normalized in LEVELS) return normalized as LogLevel;
    return 'info';
}

function shouldLog(level: LogLevel): boolean {
    return LEVELS[level] >= LEVELS[getConfiguredLevel()];
}

// ── File audit logging ────────────────────────────────────────────
// Writes clean (no ANSI) lines to a log file for forensic auditing.
// Controlled by LOG_FILE env var (default: ./logs/newclaw-audit.log)

let _auditStream: fs.WriteStream | null = null;
let _currentLogFile = '';

function getAuditStream(): fs.WriteStream | null {
    const envFile = process.env.LOG_FILE || '';
    
    // Se o arquivo mudou ou ainda não abrimos, tenta abrir
    if (envFile !== _currentLogFile) {
        if (_auditStream) {
            _auditStream.end();
            _auditStream = null;
        }
        
        if (envFile) {
            try {
                const dir = path.dirname(envFile);
                if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                _auditStream = fs.createWriteStream(envFile, { flags: 'a', encoding: 'utf8' });
                _currentLogFile = envFile;
            } catch (e) {
                console.error('Failed to create audit stream:', e);
                _currentLogFile = '';
            }
        }
    }
    
    return _auditStream;
}

function writeAuditLine(level: LogLevel, component: string, event: string, message?: string, meta?: Record<string, any>) {
    const stream = getAuditStream();
    if (stream) {
        const timestamp = formatTimestamp();
        const levelStr = level.toUpperCase().padEnd(5);
        const metaStr = meta && Object.keys(meta).length > 0
            ? ` ${JSON.stringify(meta)}`
            : '';
        const msgStr = message ? ` ${message}` : '';
        stream.write(`[${timestamp}] ${levelStr} [${component}] ${event}${msgStr}${metaStr}\n`);
    }
}

function formatTimestamp(): string {
    const d = new Date();
    const offset = d.getTimezoneOffset();
    const local = new Date(d.getTime() - offset * 60000);
    return local.toISOString().replace('T', ' ').substring(0, 19);
}

/** Generate a consistent color for a component name */
function getComponentColor(name: string): string {
    const colors = [
        '\x1b[32m', // Green
        '\x1b[33m', // Yellow
        '\x1b[34m', // Blue
        '\x1b[35m', // Magenta
        '\x1b[36m', // Cyan
        '\x1b[92m', // Bright Green
        '\x1b[93m', // Bright Yellow
        '\x1b[94m', // Bright Blue
        '\x1b[95m', // Bright Magenta
        '\x1b[96m', // Bright Cyan
    ];
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
        hash = name.charCodeAt(i) + ((hash << 5) - hash);
    }
    return colors[Math.abs(hash) % colors.length];
}

function writeLog(level: LogLevel, component: string, event: string, message?: string, meta?: Record<string, any>) {
    if (!shouldLog(level)) return;

    const timestamp = formatTimestamp();
    const levelColor = COLORS[level];
    const compColor = getComponentColor(component);
    const icon = ICONS[level];
    const DIM = '\x1b[2m';
    const BOLD = '\x1b[1m';
    
    const metaStr = meta && Object.keys(meta).length > 0 
        ? ` ${DIM}` + Object.entries(meta).map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' ') + RESET
        : '';
    const msgStr = message ? ` ${message}` : '';

    // Advanced coloring: Gray timestamp, dynamic component color, level-based icon
    const line = `${DIM}[${timestamp}]${RESET} ${levelColor}${icon}${RESET} ${compColor}${BOLD}[${component}]${RESET} ${levelColor}${event}${RESET}${msgStr}${metaStr}`;
    
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

    error(event: string, error?: unknown, message?: string, meta?: Record<string, unknown>) {
        let errMsg: string;
        let errMeta: Record<string, any> = { ...this.baseMeta, ...(meta || {}) };

        if (error instanceof Error) {
            errMsg = error.message;
            errMeta.stack = error.stack;
        } else if (typeof error === 'string') {
            errMsg = error;
        } else if (error && typeof error === 'object') {
            errMsg = (error as { message?: string }).message || message || 'Unknown error object';
            try {
                errMeta.rawError = JSON.stringify(error).slice(0, 500);
            } catch {
                errMeta.rawError = '[Circular or Non-Serializable]';
            }
        } else {
            // Called with a single string (like info/warn): the full message is in event, nothing to append
            errMsg = message || '';
        }

        writeLog('error', this.component, event, errMsg || undefined, errMeta);
    }
}

export function createLogger(component: string, baseMeta: Record<string, any> = {}): AppLogger {
    return new AppLogger(component, baseMeta);
}