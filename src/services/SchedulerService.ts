/**
 * SchedulerService — Sistema de mensagens agendadas
 * 
 * Permite ao NewClaw agendar envios recorrentes (weather, crypto, etc.)
 * usando expressões cron. Persiste no SQLite para sobreviver a restarts.
 * 
 * Uso: "Me mande previsão do tempo às 8h, 12h e 18h todo dia"
 *      "Todo dia às 9h me mande cotação de BTC e ETH"
 */

import Database from 'better-sqlite3';
import path from 'path';
import { createLogger } from '../shared/AppLogger';
const log = createLogger('Schedulerservice');

export interface ScheduledTask {
    id: number;
    chat_id: string;
    label: string;
    cron_expr: string;        // e.g. "0 8,12,18 * * *"
    action_type: string;      // weather | crypto | custom
    action_params: string;    // JSON params
    active: boolean;
    last_run: string | null;
    created_at: string;
}

export class SchedulerService {
    private db: Database.Database;
    private timers: Map<number, ReturnType<typeof setTimeout>> = new Map();
    private onTrigger: ((task: ScheduledTask) => Promise<void>) | null = null;

    constructor(dbPath: string, db?: Database.Database) {
        if (db) {
            this.db = db;
        } else {
            const dir = path.dirname(dbPath);
            if (!path.isAbsolute(dbPath)) dbPath = path.resolve(process.cwd(), dbPath);
            this.db = new Database(dbPath);
        }
        this.initTable();
    }

    private initTable(): void {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS scheduled_tasks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                chat_id TEXT NOT NULL,
                label TEXT NOT NULL,
                cron_expr TEXT NOT NULL,
                action_type TEXT NOT NULL DEFAULT 'custom',
                action_params TEXT DEFAULT '{}',
                active INTEGER DEFAULT 1,
                last_run TEXT,
                created_at TEXT DEFAULT (datetime('now'))
            )
        `);
    }

    setTriggerHandler(handler: (task: ScheduledTask) => Promise<void>): void {
        this.onTrigger = handler;
    }

    /** Parse simple time expressions like "8h, 12h, 18h" or "8:30" into cron */
    parseTimeInput(input: string): string {
        // Already a cron expression (5 parts)
        if (input.trim().split(/\s+/).length === 5 && /^[\d*/,-]+$/.test(input.trim())) {
            return input.trim();
        }

        // Parse patterns like "8h, 12h, 18h" or "8:00 12:00 18:00" or "8 12 18"
        const times: number[] = [];
        const hourMinPattern = /(\d{1,2})(?::(\d{2}))?\s*h?/gi;
        let match;
        while ((match = hourMinPattern.exec(input)) !== null) {
            const hour = parseInt(match[1]);
            const minute = match[2] ? parseInt(match[2]) : 0;
            // Store as minutes since midnight for sorting
            times.push(hour * 60 + minute);
        }

        if (times.length === 0) return '';

        times.sort((a, b) => a - b);

        // Group by minute, collect hours
        const byMinute: Map<number, number[]> = new Map();
        for (const t of times) {
            const h = Math.floor(t / 60);
            const m = t % 60;
            if (!byMinute.has(m)) byMinute.set(m, []);
            byMinute.get(m)!.push(h);
        }

        // Build cron expression: minute hour * * *
        if (byMinute.size === 1) {
            const [minute, hours] = [...byMinute.entries()][0];
            return `${minute} ${hours.join(',')} * * *`;
        }

        // Multiple different minutes — build multiple cron parts joined
        const parts = [...byMinute.entries()].map(([minute, hours]) => 
            `${minute} ${hours.join(',')} * * *`
        );
        // Return first one for simplicity (most common case is same minute)
        const [minute, hours] = [...byMinute.entries()][0];
        return `${minute} ${hours.join(',')} * * *`;
    }

    /** Map action keywords to action_type + params */
    parseActionType(text: string): { action_type: string; action_params: string } {
        const lower = text.toLowerCase();

        if (/(tempo|clima|weather|previsão|chuva|sol)/i.test(lower)) {
            // Extract city if mentioned
            const cityMatch = lower.match(/(?:tempo|clima|previsão)\s+(?:de|em|para)?\s*([a-zà-ú\s]+?)(?:\s*$|\s*[,.;])/i);
            const city = cityMatch ? cityMatch[1].trim() : '';
            return { action_type: 'weather', action_params: JSON.stringify({ city: city || 'Cornélio Procópio' }) };
        }

        if (/(cripto|crypto|bitcoin|btc|eth|ethereum|moeda|cotação|cotaçao)/i.test(lower)) {
            const coins: string[] = [];
            if (/btc|bitcoin/i.test(lower)) coins.push('bitcoin');
            if (/eth|ethereum/i.test(lower)) coins.push('ethereum');
            if (coins.length === 0) coins.push('bitcoin', 'ethereum');
            return { action_type: 'crypto', action_params: JSON.stringify({ coins }) };
        }

        return { action_type: 'custom', action_params: JSON.stringify({ message: text }) };
    }

    /** Create a new scheduled task */
    createTask(chatId: string, label: string, cronExpr: string, actionType: string, actionParams: string): ScheduledTask {
        const info = this.db.prepare(
            'INSERT INTO scheduled_tasks (chat_id, label, cron_expr, action_type, action_params) VALUES (?, ?, ?, ?, ?)'
        ).run(chatId, label, cronExpr, actionType, actionParams);

        const task = this.getTask(info.lastInsertRowid as number);
        if (task && task.active) this.startTaskTimer(task);
        return task!;
    }

    getTask(id: number): ScheduledTask | undefined {
        return this.db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as ScheduledTask | undefined;
    }

    listTasks(chatId?: string): ScheduledTask[] {
        if (chatId) {
            return this.db.prepare('SELECT * FROM scheduled_tasks WHERE chat_id = ? ORDER BY id').all(chatId) as ScheduledTask[];
        }
        return this.db.prepare('SELECT * FROM scheduled_tasks ORDER BY id').all() as ScheduledTask[];
    }

    deleteTask(id: number): boolean {
        this.stopTaskTimer(id);
        const result = this.db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
        return result.changes > 0;
    }

    toggleTask(id: number, active: boolean): ScheduledTask | undefined {
        this.db.prepare('UPDATE scheduled_tasks SET active = ? WHERE id = ?').run(active ? 1 : 0, id);
        if (active) {
            const task = this.getTask(id);
            if (task) this.startTaskTimer(task);
        } else {
            this.stopTaskTimer(id);
        }
        return this.getTask(id);
    }

    /** Start all active tasks (call on boot) */
    startAll(): void {
        const tasks = this.listTasks().filter(t => t.active);
        for (const task of tasks) {
            this.startTaskTimer(task);
        }
        log.info(`[Scheduler] Started ${tasks.length} scheduled tasks`);
    }

    /** Stop all timers (call on shutdown) */
    stopAll(): void {
        for (const [id, timer] of this.timers) {
            clearTimeout(timer);
        }
        this.timers.clear();
        log.info('[Scheduler] All timers stopped');
    }

    /** Calculate milliseconds until next cron tick (simplified) */
    private msUntilNext(cronExpr: string): number {
        const parts = cronExpr.trim().split(/\s+/);
        if (parts.length !== 5) return 60000; // default 1 min

        const [, hourPart, , ,] = parts;
        const minute = parseInt(parts[0]) || 0;
        const hours = hourPart.split(',').map(h => parseInt(h.trim())).filter(h => !isNaN(h));

        if (hours.length === 0) return 60000;

        const now = new Date();
        const currentMinutes = now.getHours() * 60 + now.getMinutes();

        // Find next occurrence today or tomorrow
        let nextMinutes: number | null = null;
        for (const h of hours.sort((a, b) => a - b)) {
            const targetMin = h * 60 + minute;
            if (targetMin > currentMinutes) {
                nextMinutes = targetMin;
                break;
            }
        }

        if (nextMinutes === null) {
            // Next is first hour tomorrow
            nextMinutes = hours.sort((a, b) => a - b)[0] * 60 + minute + 24 * 60;
        }

        const diffMinutes = nextMinutes - currentMinutes;
        return diffMinutes * 60 * 1000;
    }

    private startTaskTimer(task: ScheduledTask): void {
        this.stopTaskTimer(task.id);

        const scheduleNext = () => {
            const ms = this.msUntilNext(task.cron_expr);
            // Cap at 24h to re-evaluate
            const timerMs = Math.min(ms, 24 * 60 * 60 * 1000);

            const timer = setTimeout(async () => {
                if (!this.onTrigger) return;

                try {
                    await this.onTrigger(task);
                    this.db.prepare('UPDATE scheduled_tasks SET last_run = datetime("now") WHERE id = ?').run(task.id);
                } catch (e) {
                    log.error(`[Scheduler] Error running task ${task.id}:`, e);
                }

                // Schedule next occurrence
                const updated = this.getTask(task.id);
                if (updated && updated.active) {
                    this.startTaskTimer(updated);
                }
            }, timerMs);

            this.timers.set(task.id, timer);
        };

        scheduleNext();
    }

    private stopTaskTimer(id: number): void {
        const timer = this.timers.get(id);
        if (timer) {
            clearTimeout(timer);
            this.timers.delete(id);
        }
    }

    /** Get human-readable description of cron expression */
    describeCron(cronExpr: string): string {
        const parts = cronExpr.trim().split(/\s+/);
        if (parts.length !== 5) return cronExpr;

        const minute = parts[0];
        const hours = parts[1].split(',').map(h => h.trim()).join('h, ') + 'h';

        let dayDesc = 'todo dia';
        if (parts[4] !== '*') dayDesc = 'dia ' + parts[4];

        return `${hours} ${dayDesc}` + (minute !== '0' && minute !== '*' ? ` às ${minute}min` : '');
    }
}