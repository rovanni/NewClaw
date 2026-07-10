/**
 * GoalStore — Persistência de goals em SQLite.
 *
 * Goals sobrevivem a restarts. Um usuário tem no máximo 1 goal ativo por sessão
 * (bounded autonomy). Goals expirados são limpos automaticamente via expireStale().
 *
 * Segue o mesmo padrão do WorkflowEngine: recebe SqliteDb no construtor
 * e cria a tabela na inicialização.
 */

import { createLogger } from '../shared/AppLogger';
import { Goal, GoalStatus, GoalBlocker, GoalAttempt, PlanStep, SuccessCriterion } from './GoalTypes';

const log = createLogger('GoalStore');

type SqliteDb = {
    prepare(sql: string): {
        run(...params: unknown[]): { changes: number };
        get(...params: unknown[]): unknown;
        all(...params: unknown[]): unknown[];
    };
    exec(sql: string): void;
};

interface GoalRow {
    id: string;
    session_key: string;
    conversation_id: string;
    user_intent: string;
    objective: string;
    status: string;
    current_plan: string | null;
    attempts: string | null;
    blockers: string | null;
    tools_tried: string | null;
    strategies_tried: string | null;
    next_action: string | null;
    cycle_focus: string | null;
    retry_budget: number;
    replan_budget: number;
    confidence: number;
    requires_auth: number;
    authorization_scope: string | null;
    pending_txn_id: string | null;
    created_at: number;
    updated_at: number;
    expires_at: number;
    completed_at: number | null;
    is_construction: number;
    roadmap: string | null;
    current_milestone_index: number;
    allow_roadmap_adjustment: number;
    success_criteria: string | null;
    sent_artifacts: string | null;
}

export class GoalStore {
    private readonly db: SqliteDb;

    constructor(db: SqliteDb) {
        this.db = db;
        this.initSchema();
    }

    private initSchema(): void {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS goals (
                id                 TEXT PRIMARY KEY,
                session_key        TEXT NOT NULL,
                conversation_id    TEXT NOT NULL,
                user_intent        TEXT NOT NULL,
                objective          TEXT NOT NULL,
                status             TEXT NOT NULL DEFAULT 'active',
                current_plan       TEXT,
                attempts           TEXT,
                blockers           TEXT,
                tools_tried        TEXT,
                strategies_tried   TEXT,
                next_action        TEXT,
                cycle_focus        TEXT,
                retry_budget       INTEGER NOT NULL DEFAULT 5,
                replan_budget      INTEGER NOT NULL DEFAULT 3,
                confidence         REAL NOT NULL DEFAULT 0.85,
                requires_auth      INTEGER NOT NULL DEFAULT 0,
                authorization_scope TEXT,
                pending_txn_id     TEXT,
                created_at         INTEGER NOT NULL,
                updated_at         INTEGER NOT NULL,
                expires_at         INTEGER NOT NULL,
                completed_at       INTEGER,
                is_construction    INTEGER NOT NULL DEFAULT 0,
                roadmap            TEXT,
                current_milestone_index INTEGER NOT NULL DEFAULT 0,
                allow_roadmap_adjustment INTEGER NOT NULL DEFAULT 1,
                success_criteria       TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_goals_session ON goals(session_key, status);
            CREATE INDEX IF NOT EXISTS idx_goals_conversation ON goals(conversation_id, status);
            CREATE INDEX IF NOT EXISTS idx_goals_expires ON goals(expires_at, status);
        `);
        // Migração retrocompatível: adiciona colunas em bancos existentes
        try { this.db.exec('ALTER TABLE goals ADD COLUMN cycle_focus TEXT'); } catch { /* já existe */ }
        try { this.db.exec('ALTER TABLE goals ADD COLUMN is_construction INTEGER NOT NULL DEFAULT 0'); } catch { /* já existe */ }
        try { this.db.exec('ALTER TABLE goals ADD COLUMN roadmap TEXT'); } catch { /* já existe */ }
        try { this.db.exec('ALTER TABLE goals ADD COLUMN current_milestone_index INTEGER NOT NULL DEFAULT 0'); } catch { /* já existe */ }
        try { this.db.exec('ALTER TABLE goals ADD COLUMN allow_roadmap_adjustment INTEGER NOT NULL DEFAULT 1'); } catch { /* já existe */ }
        try { this.db.exec('ALTER TABLE goals ADD COLUMN success_criteria TEXT'); } catch { /* já existe */ }
        try { this.db.exec('ALTER TABLE goals ADD COLUMN sent_artifacts TEXT'); } catch { /* já existe */ }
        log.info('[GoalStore] schema ready');
    }

    // ── Criação ───────────────────────────────────────────────────────────────

    create(params: Omit<Goal, 'id' | 'createdAt' | 'updatedAt'>): Goal {
        const now = Date.now();
        const rand = Math.random().toString(36).slice(2, 7);
        const goal: Goal = {
            ...params,
            id: `goal_${now}_${rand}`,
            createdAt: now,
            updatedAt: now,
        };

        this.db.prepare(`
            INSERT INTO goals (
                id, session_key, conversation_id, user_intent, objective,
                status, current_plan, attempts, blockers, tools_tried, strategies_tried,
                next_action, cycle_focus, retry_budget, replan_budget, confidence,
                requires_auth, authorization_scope, pending_txn_id,
                created_at, updated_at, expires_at, completed_at,
                is_construction, roadmap, current_milestone_index, allow_roadmap_adjustment,
                success_criteria
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        `).run(
            goal.id,
            goal.sessionKey,
            goal.conversationId,
            goal.userIntent.slice(0, 300),
            goal.objective.slice(0, 500),
            goal.status,
            JSON.stringify(goal.currentPlan ?? []),
            JSON.stringify(goal.attempts ?? []),
            JSON.stringify(goal.blockers ?? []),
            JSON.stringify(goal.toolsTried ?? []),
            JSON.stringify(goal.strategiesTried ?? []),
            goal.nextAction ?? null,
            goal.cycleFocus ?? null,
            goal.retryBudget,
            goal.replanBudget,
            goal.confidence,
            goal.requiresAuth ? 1 : 0,
            JSON.stringify(goal.authorizationScope ?? []),
            goal.pendingTxnId ?? null,
            goal.createdAt,
            goal.updatedAt,
            goal.expiresAt,
            goal.completedAt ?? null,
            goal.isConstruction ? 1 : 0,
            JSON.stringify(goal.roadmap ?? []),
            goal.currentMilestoneIndex ?? 0,
            goal.allowRoadmapAdjustment !== false ? 1 : 0,
            JSON.stringify(goal.successCriteria ?? []),
        );

        log.info(`[GoalStore] created goal=${goal.id} session=${goal.sessionKey}`);
        return goal;
    }

    // ── Leitura ───────────────────────────────────────────────────────────────

    getById(id: string): Goal | null {
        const row = this.db.prepare('SELECT * FROM goals WHERE id = ?').get(id) as GoalRow | undefined;
        return row ? this.rowToGoal(row) : null;
    }

    /** Retorna o goal ativo mais recente da sessão. Máximo 1 ativo por sessão. */
    getActiveBySession(sessionKey: string): Goal | null {
        const row = this.db.prepare(`
            SELECT * FROM goals
            WHERE session_key = ? AND status IN ('active', 'executing', 'blocked', 'replanning')
            ORDER BY created_at DESC LIMIT 1
        `).get(sessionKey) as GoalRow | undefined;
        return row ? this.rowToGoal(row) : null;
    }

    getByTxnId(txnId: string): Goal | null {
        const row = this.db.prepare(`
            SELECT * FROM goals
            WHERE pending_txn_id = ?
            AND status IN ('active', 'executing', 'blocked', 'replanning')
        `).get(txnId) as GoalRow | undefined;
        return row ? this.rowToGoal(row) : null;
    }

    /** Retorna todos os goals não-terminais (para log de shutdown e recovery). */
    getAllActive(): Goal[] {
        const rows = this.db.prepare(`
            SELECT * FROM goals
            WHERE status IN ('active', 'executing', 'blocked', 'replanning')
            ORDER BY created_at DESC
        `).all() as GoalRow[];
        return rows.map(r => this.rowToGoal(r));
    }

    /**
     * Retorna os goals mais recentes de uma sessão (qualquer status), mais recente primeiro.
     * Usado para recuperar `sentArtifacts` de goals passados da mesma sessão — esse campo é
     * persistido em SQLite por goal, então sobrevive tanto à limpeza de sessões inativas em
     * memória (SessionManager.deliveredArtifacts, apagado após 10-15min sem atividade) quanto
     * a reinícios do processo.
     */
    getRecentBySession(sessionKey: string, limit = 5): Goal[] {
        const rows = this.db.prepare(`
            SELECT * FROM goals
            WHERE session_key = ?
            ORDER BY created_at DESC
            LIMIT ?
        `).all(sessionKey, limit) as GoalRow[];
        return rows.map(r => this.rowToGoal(r));
    }

    // ── Atualização ───────────────────────────────────────────────────────────

    update(id: string, patch: Partial<Goal>): void {
        const now = Date.now();
        const sets: string[] = ['updated_at = ?'];
        const values: unknown[] = [now];

        if (patch.status !== undefined)            { sets.push('status = ?');             values.push(patch.status); }
        if (patch.currentPlan !== undefined)       { sets.push('current_plan = ?');       values.push(JSON.stringify(patch.currentPlan)); }
        if (patch.attempts !== undefined)          { sets.push('attempts = ?');           values.push(JSON.stringify(patch.attempts)); }
        if (patch.blockers !== undefined)          { sets.push('blockers = ?');           values.push(JSON.stringify(patch.blockers)); }
        if (patch.toolsTried !== undefined)        { sets.push('tools_tried = ?');        values.push(JSON.stringify(patch.toolsTried)); }
        if (patch.strategiesTried !== undefined)   { sets.push('strategies_tried = ?');   values.push(JSON.stringify(patch.strategiesTried)); }
        if (patch.nextAction !== undefined)        { sets.push('next_action = ?');        values.push(patch.nextAction); }
        if (patch.cycleFocus !== undefined)         { sets.push('cycle_focus = ?');         values.push(patch.cycleFocus ?? null); }
        if (patch.isConstruction !== undefined)    { sets.push('is_construction = ?');    values.push(patch.isConstruction ? 1 : 0); }
        if (patch.roadmap !== undefined)           { sets.push('roadmap = ?');           values.push(JSON.stringify(patch.roadmap)); }
        if (patch.currentMilestoneIndex !== undefined) { sets.push('current_milestone_index = ?'); values.push(patch.currentMilestoneIndex); }
        if (patch.allowRoadmapAdjustment !== undefined) { sets.push('allow_roadmap_adjustment = ?'); values.push(patch.allowRoadmapAdjustment ? 1 : 0); }
        if (patch.successCriteria !== undefined)       { sets.push('success_criteria = ?');       values.push(JSON.stringify(patch.successCriteria)); }
        if (patch.sentArtifacts !== undefined)         { sets.push('sent_artifacts = ?');         values.push(JSON.stringify(patch.sentArtifacts)); }
        if (patch.retryBudget !== undefined)       { sets.push('retry_budget = ?');       values.push(patch.retryBudget); }
        if (patch.replanBudget !== undefined)      { sets.push('replan_budget = ?');      values.push(patch.replanBudget); }
        if (patch.confidence !== undefined)        { sets.push('confidence = ?');         values.push(patch.confidence); }
        if (patch.requiresAuth !== undefined)      { sets.push('requires_auth = ?');      values.push(patch.requiresAuth ? 1 : 0); }
        if (patch.authorizationScope !== undefined){ sets.push('authorization_scope = ?'); values.push(JSON.stringify(patch.authorizationScope)); }
        if (patch.pendingTxnId !== undefined)      { sets.push('pending_txn_id = ?');     values.push(patch.pendingTxnId ?? null); }
        if (patch.completedAt !== undefined)       { sets.push('completed_at = ?');       values.push(patch.completedAt); }

        values.push(id);
        this.db.prepare(`UPDATE goals SET ${sets.join(', ')} WHERE id = ?`).run(...values);

        // Loga mudança de status inline (update() é usado tanto quanto setStatus)
        if (patch.status !== undefined) {
            log.info(`[GoalStore] goal=${id} → ${patch.status}`);
        }
        if (patch.replanBudget !== undefined) {
            log.debug(`[GoalStore] goal=${id} replanBudget=${patch.replanBudget}`);
        }
        if (patch.retryBudget !== undefined) {
            log.debug(`[GoalStore] goal=${id} retryBudget=${patch.retryBudget}`);
        }
    }

    // ── Máquina de estados explícita ─────────────────────────────────────────
    // Cada estado lista exatamente quais transições são permitidas.
    // Estados terminais (completed, failed, abandoned) não permitem saída.
    private static readonly ALLOWED_TRANSITIONS: Record<string, GoalStatus[]> = {
        active:      ['executing', 'abandoned'],
        executing:   ['blocked', 'replanning', 'completed', 'failed', 'abandoned'],
        blocked:     ['executing', 'replanning', 'failed', 'abandoned'],
        replanning:  ['executing', 'failed', 'abandoned'],
        completed:   [],  // terminal — sem saída
        failed:      [],  // terminal — sem saída
        abandoned:   [],  // terminal — sem saída
    };

    setStatus(id: string, status: GoalStatus): void {
        const now = Date.now();
        const prev = (this.db.prepare('SELECT status FROM goals WHERE id = ?').get(id) as { status: string } | undefined)?.status ?? '?';

        // Validação da máquina de estados
        const allowed = GoalStore.ALLOWED_TRANSITIONS[prev] ?? [];
        if (prev !== '?' && !allowed.includes(status)) {
            log.warn(`[GoalStore] blocked invalid transition: ${prev} → ${status} for goal=${id}`);
            return;
        }

        const completedAt = (status === 'completed' || status === 'failed' || status === 'abandoned') ? now : null;
        this.db.prepare('UPDATE goals SET status = ?, updated_at = ?, completed_at = COALESCE(completed_at, ?) WHERE id = ?')
            .run(status, now, completedAt, id);
        log.info(`[GoalStore] goal=${id} ${prev} → ${status}`);
    }

    addAttempt(goalId: string, attempt: GoalAttempt): void {
        const goal = this.getById(goalId);
        if (!goal) return;
        const attempts = [...goal.attempts, attempt];
        this.update(goalId, { attempts, retryBudget: Math.max(0, goal.retryBudget - 1) });
        log.debug(`[GoalStore] goal=${goalId} attempt: tool=${attempt.toolName} result=${attempt.result} durationMs=${attempt.durationMs}${attempt.error ? ` error="${attempt.error.slice(0, 80)}"` : ''}`);
    }

    addBlocker(goalId: string, blocker: GoalBlocker): void {
        const goal = this.getById(goalId);
        if (!goal) return;
        const blockers = [...goal.blockers, blocker];
        this.update(goalId, { blockers, status: 'blocked' });
        log.info(`[GoalStore] goal=${goalId} blocker: kind=${blocker.kind} tool=${blocker.toolName ?? 'none'} desc="${blocker.description.slice(0, 100)}"`);
    }

    /**
     * Registra um blocker SEM forçar `status='blocked'` — ao contrário de `addBlocker()`
     * (que sempre muda o status, correto no branch 'blocked', onde o goal de fato pausa para
     * replan). Usada nos branches onde o blocker já foi classificado por
     * `GoalEvaluator.evaluate()` mas o outcome real é outro: 'partial' (retryável — o goal
     * continua 'executing', virar 'blocked' seria transformar uma falha recuperável em bloqueio
     * permanente falso) ou 'failed'/entrega diferida (o goal já está terminando com seu status
     * final correto — `addBlocker` sobrescreveria para 'blocked' incorretamente, já que
     * `update()` não valida transição de estado). Sprint 0.6, Front B — causa raiz do
     * `blockers=[]` observado em goals `failed` reais (ex: goal_...ykpko, Sprint 0.5).
     */
    recordBlocker(goalId: string, blocker: GoalBlocker): void {
        const goal = this.getById(goalId);
        if (!goal) return;
        const blockers = [...goal.blockers, blocker];
        this.update(goalId, { blockers });
        log.info(`[GoalStore] goal=${goalId} blocker recorded (status inalterado): kind=${blocker.kind} tool=${blocker.toolName ?? 'none'} desc="${blocker.description.slice(0, 100)}"`);
    }

    addToolTried(goalId: string, toolName: string): void {
        const goal = this.getById(goalId);
        if (!goal) return;
        if (!goal.toolsTried.includes(toolName)) {
            this.update(goalId, { toolsTried: [...goal.toolsTried, toolName] });
        }
    }

    addStrategyTried(goalId: string, strategy: string): void {
        const goal = this.getById(goalId);
        if (!goal) return;
        this.update(goalId, { strategiesTried: [...goal.strategiesTried, strategy.slice(0, 200)] });
    }

    // ── TTL cleanup ───────────────────────────────────────────────────────────

    /** Marca como abandoned todos os goals expirados. Retorna count. */
    expireStale(): number {
        const now = Date.now();
        const result = this.db.prepare(`
            UPDATE goals SET status = 'abandoned', updated_at = ?
            WHERE expires_at < ? AND status IN ('active', 'executing', 'blocked', 'replanning')
        `).run(now, now);
        if (result.changes > 0) {
            log.info(`[GoalStore] expired ${result.changes} stale goals`);
        }
        return result.changes;
    }

    // ── Conversão ─────────────────────────────────────────────────────────────

    private rowToGoal(row: GoalRow): Goal {
        return {
            id: row.id,
            sessionKey: row.session_key,
            conversationId: row.conversation_id,
            userIntent: row.user_intent,
            objective: row.objective,
            status: row.status as GoalStatus,
            currentPlan: this.parseJson<PlanStep[]>(row.current_plan, []),
            attempts: this.parseJson<GoalAttempt[]>(row.attempts, []),
            blockers: this.parseJson<GoalBlocker[]>(row.blockers, []),
            toolsTried: this.parseJson<string[]>(row.tools_tried, []),
            strategiesTried: this.parseJson<string[]>(row.strategies_tried, []),
            nextAction: row.next_action ?? undefined,
            cycleFocus: row.cycle_focus ?? undefined,
            isConstruction: row.is_construction === 1,
            roadmap: this.parseJson<string[]>(row.roadmap, []),
            currentMilestoneIndex: row.current_milestone_index ?? 0,
            allowRoadmapAdjustment: row.allow_roadmap_adjustment === 1,
            successCriteria: this.parseJson<SuccessCriterion[]>(row.success_criteria, []),
            retryBudget: row.retry_budget,
            replanBudget: row.replan_budget,
            confidence: row.confidence,
            requiresAuth: row.requires_auth === 1,
            authorizationScope: this.parseJson<string[]>(row.authorization_scope, []),
            pendingTxnId: row.pending_txn_id ?? undefined,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            expiresAt: row.expires_at,
            completedAt: row.completed_at ?? undefined,
            sentArtifacts: this.parseJson<string[]>(row.sent_artifacts, []),
        };
    }

    private parseJson<T>(raw: string | null, fallback: T): T {
        if (!raw) return fallback;
        try { return JSON.parse(raw) as T; } catch { return fallback; }
    }

    // ── Stats para dashboard ──────────────────────────────────────────────────

    getStats(): { active: number; completed: number; failed: number; abandoned: number } {
        const rows = this.db.prepare(`
            SELECT status, COUNT(*) as count FROM goals GROUP BY status
        `).all() as Array<{ status: string; count: number }>;

        const result = { active: 0, completed: 0, failed: 0, abandoned: 0 };
        for (const row of rows) {
            if (['active', 'executing', 'blocked', 'replanning'].includes(row.status)) result.active += row.count;
            else if (row.status === 'completed') result.completed = row.count;
            else if (row.status === 'failed') result.failed = row.count;
            else if (row.status === 'abandoned') result.abandoned = row.count;
        }
        return result;
    }
}
