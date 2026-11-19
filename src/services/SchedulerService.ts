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
    channel: string;          // telegram | discord | signal | whatsapp | web
    label: string;
    cron_expr: string;        // e.g. "0 8,12,18 * * *"
    action_type: string;      // weather | crypto | custom
    action_params: string;    // JSON params
    active: boolean;
    last_run: string | null;
    created_at: string;
}

// ── Expressão cron de cinco campos (minuto hora dia-do-mês mês dia-da-semana) ──────────────────────────────────────────
// S489 (18/11/2026): antes, a expressão pronta nunca era aceita e só minuto e hora eram lidos — "0 9 * * 1" disparava
// todo dia. Aceita `*`, número, intervalo `a-b`, passo `/n` e listas com vírgula; nomes (MON, JAN) não. Dia da semana
// vai de 0 a 7 (0 e 7 = domingo). Quando dia do mês E dia da semana estão restritos, basta um casar (regra do cron).

const CAMPOS_DO_CRON: ReadonlyArray<{ min: number; max: number }> = [
    { min: 0, max: 59 }, { min: 0, max: 23 }, { min: 1, max: 31 }, { min: 1, max: 12 }, { min: 0, max: 7 },
];

/** Valores que um campo aceita, ou `null` se o campo não é válido. */
function valoresDoCampo(campo: string, { min, max }: { min: number; max: number }): Set<number> | null {
    const valores = new Set<number>();
    for (const item of campo.split(',')) {
        const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(item);
        if (!m) return null;
        let inicio = min;
        let fim = max;
        if (m[1] !== '*') {
            const [a, b] = m[1].split('-').map(Number);
            inicio = a;
            fim = b ?? (m[2] ? max : a);
        }
        const passo = m[2] ? Number(m[2]) : 1;
        if (inicio < min || fim > max || inicio > fim || passo < 1) return null;
        for (let v = inicio; v <= fim; v += passo) valores.add(v);
    }
    return valores;
}

interface CronLido { minutos: Set<number>; horas: Set<number>; dias: Set<number>; meses: Set<number>; semana: Set<number>; diaRestrito: boolean; semanaRestrita: boolean }

function lerCron(cronExpr: string): CronLido | null {
    const partes = cronExpr.trim().split(/\s+/);
    if (partes.length !== 5) return null;
    const lidos = partes.map((p, i) => valoresDoCampo(p, CAMPOS_DO_CRON[i]));
    if (lidos.some(v => v === null)) return null;
    const [minutos, horas, dias, meses, semana] = lidos as Set<number>[];
    if (semana.has(7)) semana.add(0);
    return { minutos, horas, dias, meses, semana, diaRestrito: !partes[2].startsWith('*'), semanaRestrita: !partes[4].startsWith('*') };
}

/**
 * Próximo instante (hora local da máquina, segundos zerados) estritamente depois de `depoisDe` em que a expressão casa.
 * `null` se a expressão é inválida ou não casa nos próximos 5 anos (ex.: 31 de fevereiro).
 */
export function proximoDisparo(cronExpr: string, depoisDe: Date): Date | null {
    const c = lerCron(cronExpr);
    if (!c) return null;
    const d = new Date(depoisDe.getTime());
    d.setSeconds(0, 0);
    d.setMinutes(d.getMinutes() + 1);
    const limite = new Date(depoisDe.getTime());
    limite.setFullYear(limite.getFullYear() + 5);
    while (d <= limite) {
        if (!c.meses.has(d.getMonth() + 1)) { d.setMonth(d.getMonth() + 1, 1); d.setHours(0, 0, 0, 0); continue; }
        const casaDia = c.dias.has(d.getDate());
        const casaSemana = c.semana.has(d.getDay());
        const diaCasa = c.diaRestrito && c.semanaRestrita ? (casaDia || casaSemana) : (casaDia && casaSemana);
        if (!diaCasa) { d.setDate(d.getDate() + 1); d.setHours(0, 0, 0, 0); continue; }
        if (!c.horas.has(d.getHours())) { d.setHours(d.getHours() + 1, 0, 0, 0); continue; }
        if (!c.minutos.has(d.getMinutes())) { d.setMinutes(d.getMinutes() + 1, 0, 0); continue; }
        return d;
    }
    return null;
}

const NOMES_DA_SEMANA = ['domingos', 'segundas', 'terças', 'quartas', 'quintas', 'sextas', 'sábados'];

/** Teto de um único `setTimeout`: ao chegar nele, o timer recalcula o próximo disparo (não dispara). */
const TETO_DO_TIMER_MS = 24 * 60 * 60 * 1000;

/** Fato que acompanha um disparo: `atrasadoDe` = horário previsto que passou com o NewClaw fora do ar (S489, 19/11/2026). */
export interface InfoDoDisparo {
    atrasadoDe?: Date;
}

/** `datetime('now')` do SQLite é UTC sem fuso ("AAAA-MM-DD HH:MM:SS"); `null` se ausente ou ilegível. */
function lerDataDoSqlite(valor: string | null | undefined): Date | null {
    if (!valor) return null;
    const d = new Date(`${valor.replace(' ', 'T')}Z`);
    return Number.isNaN(d.getTime()) ? null : d;
}

export class SchedulerService {
    private db: Database.Database;
    private timers: Map<number, ReturnType<typeof setTimeout>> = new Map();
    private onTrigger: ((task: ScheduledTask, info?: InfoDoDisparo) => Promise<void>) | null = null;

    constructor(dbPath: string, db?: Database.Database) {
        if (db) {
            this.db = db;
        } else {
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
                channel TEXT NOT NULL DEFAULT 'telegram',
                label TEXT NOT NULL,
                cron_expr TEXT NOT NULL,
                action_type TEXT NOT NULL DEFAULT 'custom',
                action_params TEXT DEFAULT '{}',
                active INTEGER DEFAULT 1,
                last_run TEXT,
                created_at TEXT DEFAULT (datetime('now'))
            )
        `);
        // Migration: add channel column to existing tables
        try {
            this.db.exec(`ALTER TABLE scheduled_tasks ADD COLUMN channel TEXT NOT NULL DEFAULT 'telegram'`);
        } catch {
            // Column already exists — ignore
        }
    }

    setTriggerHandler(handler: (task: ScheduledTask, info?: InfoDoDisparo) => Promise<void>): void {
        this.onTrigger = handler;
    }

    /**
     * Converte o horário pedido em expressão cron, ou devolve `''` quando não é um formato aceito.
     * Aceita: (1) expressão cron válida de cinco campos, gravada como veio; (2) lista só de horários, todo dia
     * ("8h, 12h, 18h", "8:30", "8h30", "7:30 e 19:30"), com o mesmo minuto em todos. Qualquer outra palavra recusa a
     * entrada inteira: antes ela era ignorada ("toda segunda 9h" virava todo dia às 9h, S489). Minutos diferentes
     * também recusam, porque uma expressão só não os representa sem criar horários que ninguém pediu.
     */
    parseTimeInput(entrada: string | number): string {
        // Revisão (18/11/2026): o modelo pode mandar `time: 9` (número); vira texto em vez de lançar TypeError.
        const input = String(entrada ?? '');
        const campos = input.trim().split(/\s+/);
        // Revisão (19/11/2026): cinco números soltos ("6 8 10 12 3") podem ser cron ou lista de horas, e os dois sentidos
        // disparam em horários diferentes. Sem como saber, recusa (o erro da ferramenta mostra os dois formatos).
        if (campos.length === 5 && campos.every(c => /^\d+$/.test(c))) return '';
        if (campos.length === 5 && lerCron(campos.join(' '))) return campos.join(' ');

        const itens = input.replace(/\b(e|and)\b/gi, ',').split(/[\s,;]+/).filter(Boolean);
        if (itens.length === 0) return '';
        const horas: number[] = [];
        const minutos = new Set<number>();
        for (const item of itens) {
            const m = /^(\d{1,2})(?:[:h](\d{2}))?h?$/i.exec(item);
            if (!m) return '';
            const hora = Number(m[1]);
            const minuto = m[2] ? Number(m[2]) : 0;
            if (hora > 23 || minuto > 59) return '';
            horas.push(hora);
            minutos.add(minuto);
        }
        if (minutos.size !== 1) return '';
        const unicas = [...new Set(horas)].sort((a, b) => a - b);
        return `${[...minutos][0]} ${unicas.join(',')} * * *`;
    }

    /** Map action keywords to action_type + params */
    parseActionType(text: string): { action_type: string; action_params: string } {
        const lower = text.toLowerCase();

        if (/(tempo|clima|weather|previsão|chuva|sol)/i.test(lower)) {
            // Extract city if mentioned
            const cityMatch = lower.match(/(?:tempo|clima|previsão)\s+(?:de|em|para)?\s*([a-zà-ú\s]+?)(?:\s*$|\s*[,.;])/i);
            const city = cityMatch ? cityMatch[1].trim() : '';
            // Sem default de cidade hardcoded: city vazio é resolvido depois, na hora do
            // disparo (AgentController.setTriggerHandler), consultando a memória do usuário —
            // um valor fixo aqui só funcionaria pra quem configurou este deploy específico.
            return { action_type: 'weather', action_params: JSON.stringify({ city }) };
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
    createTask(chatId: string, label: string, cronExpr: string, actionType: string, actionParams: string, channel: string = 'telegram'): ScheduledTask {
        if (!proximoDisparo(cronExpr, new Date())) {
            throw new Error(`expressão cron "${cronExpr}" inválida ou sem data futura nos próximos 5 anos`);
        }
        const info = this.db.prepare(
            'INSERT INTO scheduled_tasks (chat_id, channel, label, cron_expr, action_type, action_params) VALUES (?, ?, ?, ?, ?, ?)'
        ).run(chatId, channel, label, cronExpr, actionType, actionParams);

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
        // Revisão (18/11/2026): ativar uma tarefa que nunca vai disparar (cron inválido gravado pelo código antigo) não
        // pode responder "ativado" — recusa, dizendo qual expressão.
        const atual = this.getTask(id);
        if (active && atual && !proximoDisparo(atual.cron_expr, new Date())) {
            throw new Error(`a tarefa #${id} tem a expressão cron "${atual.cron_expr}", inválida ou sem data futura nos próximos 5 anos; recrie-a com um horário válido`);
        }
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
            const perdido = this.disparoPerdido(task, new Date());
            if (perdido) {
                // Decisão da operadora (19/11/2026): o horário que passou com o NewClaw fora do ar (deploy, PC desligado)
                // dispara uma vez ao voltar, avisando que é atrasado. Vários perdidos viram um disparo só.
                log.warn(`[Scheduler] Tarefa #${task.id} perdeu o disparo de ${perdido.toISOString()} (NewClaw fora do ar): disparando agora, uma vez`);
                void this.disparar(task, { atrasadoDe: perdido });
            }
            this.startTaskTimer(task);
        }
        log.info(`[Scheduler] Started ${tasks.length} scheduled tasks`);
    }

    /**
     * Primeiro horário previsto que passou sem disparo, contado do último disparo gravado (`last_run`) ou, sem ele, da
     * criação. `null` quando nada passou, quando a expressão é inválida ou quando não há data de referência.
     */
    disparoPerdido(task: ScheduledTask, agora: Date): Date | null {
        const referencia = lerDataDoSqlite(task.last_run) ?? lerDataDoSqlite(task.created_at);
        if (!referencia) return null;
        const previsto = proximoDisparo(task.cron_expr, referencia);
        return previsto && previsto.getTime() <= agora.getTime() ? previsto : null;
    }

    /** Roda o handler e grava `last_run`; a falha fica no log (o próximo horário continua agendado). */
    private async disparar(task: ScheduledTask, info?: InfoDoDisparo): Promise<void> {
        if (!this.onTrigger) return;
        try {
            await this.onTrigger(task, info);
            this.db.prepare("UPDATE scheduled_tasks SET last_run = datetime('now') WHERE id = ?").run(task.id);
        } catch (e) {
            log.error(`[Scheduler] Error running task ${task.id}:`, e);
        }
    }

    /** Stop all timers (call on shutdown) */
    stopAll(): void {
        for (const [_id, timer] of this.timers) {
            clearTimeout(timer);
        }
        this.timers.clear();
        log.info('[Scheduler] All timers stopped');
    }

    /**
     * Milissegundos até o próximo disparo depois de `depoisDe` (padrão: agora), ou `null` se a expressão é inválida ou não
     * tem data futura. Nunca negativo: base é o maior entre agora e `depoisDe`.
     */
    private msUntilNext(cronExpr: string, depoisDe?: Date): number | null {
        const agora = new Date();
        const base = depoisDe && depoisDe.getTime() > agora.getTime() ? depoisDe : agora;
        const proximo = proximoDisparo(cronExpr, base);
        return proximo ? proximo.getTime() - agora.getTime() : null;
    }

    /**
     * `jaDisparouEm`: o minuto em que a tarefa acabou de disparar. O próximo é calculado depois DELE, não de agora:
     * revisão de 18/11/2026 — o setTimeout conta pelo relógio monotônico e o Date pelo de parede; se ele acordasse alguns
     * ms antes do minuto pelo Date, o recálculo acharia o mesmo minuto e a tarefa dispararia duas vezes.
     */
    private startTaskTimer(task: ScheduledTask, jaDisparouEm?: Date): void {
        this.stopTaskTimer(task.id);

        const scheduleNext = () => {
            const ms = this.msUntilNext(task.cron_expr, jaDisparouEm);
            if (ms === null) {
                log.error(`[Scheduler] Tarefa #${task.id} não agendada: expressão cron "${task.cron_expr}" inválida ou sem data futura nos próximos 5 anos`);
                return;
            }
            if (ms > TETO_DO_TIMER_MS) {
                // Teto de um setTimeout: ao chegar nele, só recalcula. Antes disparava a tarefa (S489).
                const espera = setTimeout(() => {
                    const atual = this.getTask(task.id);
                    if (atual && atual.active) this.startTaskTimer(atual, jaDisparouEm);
                }, TETO_DO_TIMER_MS);
                this.timers.set(task.id, espera);
                return;
            }

            const alvo = new Date(Date.now() + ms);
            const timer = setTimeout(async () => {
                if (!this.onTrigger) return;
                await this.disparar(task);

                // Schedule next occurrence
                const updated = this.getTask(task.id);
                if (updated && updated.active) {
                    this.startTaskTimer(updated, alvo);
                }
            }, ms);

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

    /**
     * Descrição em texto: "8h, 12h todo dia", "9h às segundas". Quando a expressão não cabe nessa forma (passos,
     * intervalos de hora, dia do mês, mês), devolve a própria expressão e o próximo disparo, sem traduzir pela metade.
     */
    describeCron(cronExpr: string): string {
        const c = lerCron(cronExpr);
        if (!c) return `cron "${cronExpr}" (inválida)`;
        const [min, hora, dia, mes, semana] = cronExpr.trim().split(/\s+/);
        const simples = /^\d+$/.test(min) && /^\d+(,\d+)*$/.test(hora) && dia === '*' && mes === '*' && /^(\*|[0-7](,[0-7])*)$/.test(semana);
        if (!simples) {
            const proximo = proximoDisparo(cronExpr, new Date());
            const quando = proximo ? proximo.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : 'nenhum nos próximos 5 anos';
            return `cron "${cronExpr}" (próximo: ${quando})`;
        }
        const m = Number(min);
        const horas = [...c.horas].sort((a, b) => a - b).map(h => m === 0 ? `${h}h` : `${h}h${String(m).padStart(2, '0')}`).join(', ');
        if (semana === '*') return `${horas} todo dia`;
        const dias = [...c.semana].filter(d => d !== 7).sort((a, b) => a - b).map(d => NOMES_DA_SEMANA[d]);
        return `${horas} às ${dias.join(', ')}`;
    }
}
