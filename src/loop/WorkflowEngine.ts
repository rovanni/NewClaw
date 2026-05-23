/**
 * WorkflowEngine — Motor de execução de workflows com autorização estruturada.
 *
 * Responsabilidade: receber callbacks de botões (via ID de transação),
 * executar a ferramenta aprovada e retornar um WorkflowStepResult compacto
 * para síntese pelo LLM.
 *
 * NÃO passa pelo pipeline conversacional — zero regex, zero replay episódico.
 *
 * Storage: SQLite quando disponível (sobrevive a restart), Map in-memory como fallback.
 */

import { createLogger } from '../shared/AppLogger';
import type { ToolExecutor } from './AgentLoop';
import {
    AuthDecision,
    AuthTransaction,
    ContinuationContext,
    WorkflowStepResult,
} from './WorkflowTypes';

const log = createLogger('WorkflowEngine');

const TTL_MS = 5 * 60 * 1000; // 5 minutos

type SqliteDb = {
    prepare(sql: string): {
        run(...params: unknown[]): unknown;
        get(...params: unknown[]): unknown;
        all(...params: unknown[]): unknown[];
    };
    exec(sql: string): void;
};

export class WorkflowEngine {
    private readonly db?: SqliteDb;
    /** Fallback in-memory quando db não está disponível */
    private readonly mem = new Map<string, AuthTransaction>();

    constructor(db?: SqliteDb) {
        this.db = db;
        if (db) {
            this.initSchema(db);
            log.info('[WF] storage=sqlite');
        } else {
            log.info('[WF] storage=memory');
        }
    }

    private initSchema(db: SqliteDb): void {
        db.exec(`
            CREATE TABLE IF NOT EXISTS workflow_transactions (
                id              TEXT PRIMARY KEY,
                conversation_id TEXT NOT NULL,
                tool            TEXT NOT NULL,
                params_json     TEXT NOT NULL,
                context_json    TEXT NOT NULL,
                status          TEXT NOT NULL DEFAULT 'pending_auth',
                created_at      INTEGER NOT NULL,
                expires_at      INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_wtxn_conv ON workflow_transactions(conversation_id, status);
            CREATE INDEX IF NOT EXISTS idx_wtxn_exp  ON workflow_transactions(expires_at);
        `);
        log.info('[WF] schema ready');
    }

    // ── Criação ──────────────────────────────────────────────────────────────

    createTransaction(
        conversationId: string,
        tool: string,
        params: Record<string, unknown>,
        ctx: ContinuationContext
    ): AuthTransaction {
        const now = Date.now();
        const rand = Math.random().toString(36).slice(2, 7);
        const txn: AuthTransaction = {
            id: `txn_${now}_${rand}`,
            conversationId,
            tool,
            params,
            continuationCtx: ctx,
            status: 'pending_auth',
            createdAt: now,
            expiresAt: now + TTL_MS,
        };

        if (this.db) {
            this.db.prepare(`
                INSERT INTO workflow_transactions
                    (id, conversation_id, tool, params_json, context_json, status, created_at, expires_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
                txn.id, txn.conversationId, txn.tool,
                JSON.stringify(txn.params),
                JSON.stringify(txn.continuationCtx),
                txn.status, txn.createdAt, txn.expiresAt
            );
        } else {
            this.mem.set(txn.id, txn);
        }

        log.info(`[WF] created ${txn.id} tool=${tool} workflow=${ctx.workflow} conv=${conversationId}`);
        return txn;
    }

    // ── Recuperação ──────────────────────────────────────────────────────────

    getTransaction(txnId: string): AuthTransaction | undefined {
        let txn: AuthTransaction | undefined;

        if (this.db) {
            const row = this.db.prepare(
                'SELECT * FROM workflow_transactions WHERE id = ?'
            ).get(txnId) as Record<string, unknown> | undefined;

            if (!row) {
                log.warn(`[WF] not_found ${txnId}`);
                return undefined;
            }
            txn = this.rowToTxn(row);
        } else {
            txn = this.mem.get(txnId);
        }

        if (!txn) {
            log.warn(`[WF] not_found ${txnId}`);
            return undefined;
        }

        if (Date.now() > txn.expiresAt) {
            this.deleteTxn(txnId);
            log.warn(`[WF] expired ${txnId}`);
            return undefined;
        }

        return txn;
    }

    // ── Execução ─────────────────────────────────────────────────────────────

    async resume(
        txnId: string,
        decision: AuthDecision,
        toolResolver: (name: string) => ToolExecutor | undefined
    ): Promise<WorkflowStepResult | null> {
        const txn = this.getTransaction(txnId);
        if (!txn) return null;

        if (decision === 'rejected') {
            this.updateStatus(txnId, 'rejected');
            this.deleteTxn(txnId);
            log.info(`[WF] rejected ${txnId} tool=${txn.tool}`);
            return {
                success: false,
                output: '',
                decision: 'rejected',
                continuationCtx: txn.continuationCtx,
            };
        }

        log.info(`[WF] approved ${txnId} tool=${txn.tool}`);
        this.updateStatus(txnId, 'executing');

        const tool = toolResolver(txn.tool);
        if (!tool) {
            this.deleteTxn(txnId);
            log.error(`[WF] tool_not_found ${txn.tool} txn=${txnId}`);
            return null;
        }

        try {
            const result = await tool.execute(txn.params as Record<string, any>);
            const finalStatus = result.success ? 'completed' : 'failed';
            this.updateStatus(txnId, finalStatus);
            this.deleteTxn(txnId);

            log.info(`[WF] executed ${txn.tool} success=${result.success} outputLen=${result.output?.length ?? 0} txn=${txnId}`);
            log.info(`[WF] ${finalStatus} ${txnId}`);

            return {
                success: result.success,
                output: result.output ?? '',
                decision: 'approved',
                error: result.error,
                continuationCtx: {
                    ...txn.continuationCtx,
                    metadata: {
                        ...(txn.continuationCtx.metadata ?? {}),
                        executedTool: txn.tool,
                        outputSize: String(result.output?.length ?? 0),
                    },
                },
            };
        } catch (err) {
            this.updateStatus(txnId, 'failed');
            this.deleteTxn(txnId);
            const msg = err instanceof Error ? err.message : String(err);
            log.error(`[WF] exception ${txn.tool} txn=${txnId}: ${msg}`);
            return {
                success: false,
                output: '',
                decision: 'approved',
                error: msg,
                continuationCtx: txn.continuationCtx,
            };
        }
    }

    // ── Manutenção ───────────────────────────────────────────────────────────

    purgeExpired(): number {
        if (this.db) {
            const stmt = this.db.prepare(
                'DELETE FROM workflow_transactions WHERE expires_at < ?'
            );
            const info = stmt.run(Date.now()) as { changes: number };
            const removed = info.changes ?? 0;
            if (removed > 0) log.info(`[WF] purge storage=sqlite removed=${removed}`);
            return removed;
        }

        let removed = 0;
        const now = Date.now();
        for (const [id, txn] of this.mem) {
            if (now > txn.expiresAt) {
                this.mem.delete(id);
                removed++;
                log.warn(`[WF] purged_expired ${id} tool=${txn.tool}`);
            }
        }
        if (removed > 0) log.info(`[WF] purge storage=memory removed=${removed} remaining=${this.mem.size}`);
        return removed;
    }

    get size(): number {
        if (this.db) {
            const row = this.db.prepare(
                'SELECT COUNT(*) as n FROM workflow_transactions WHERE expires_at >= ?'
            ).get(Date.now()) as { n: number } | undefined;
            return row?.n ?? 0;
        }
        return this.mem.size;
    }

    // ── Internos ─────────────────────────────────────────────────────────────

    private rowToTxn(row: Record<string, unknown>): AuthTransaction {
        return {
            id:              String(row.id),
            conversationId:  String(row.conversation_id),
            tool:            String(row.tool),
            params:          JSON.parse(String(row.params_json)),
            continuationCtx: JSON.parse(String(row.context_json)),
            status:          row.status as AuthTransaction['status'],
            createdAt:       Number(row.created_at),
            expiresAt:       Number(row.expires_at),
        };
    }

    private updateStatus(txnId: string, status: AuthTransaction['status']): void {
        if (this.db) {
            this.db.prepare(
                'UPDATE workflow_transactions SET status = ? WHERE id = ?'
            ).run(status, txnId);
        } else {
            const txn = this.mem.get(txnId);
            if (txn) txn.status = status;
        }
    }

    private deleteTxn(txnId: string): void {
        if (this.db) {
            this.db.prepare('DELETE FROM workflow_transactions WHERE id = ?').run(txnId);
        } else {
            this.mem.delete(txnId);
        }
    }
}
