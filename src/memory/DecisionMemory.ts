/**
 * DecisionMemory — Registra decisões operacionais e desempenho de ferramentas
 * 
 * Adaptado do IalClaw para o NewClaw.
 * Permite que o agente aprenda com experiências passadas.
 */
import { Database } from 'better-sqlite3';

export interface ToolDecision {
    id?: number;
    toolName: string;
    context: string;
    taskType: string;
    success: boolean;
    latencyMs: number;
    feedback?: string;
    createdAt?: string;
}

export class DecisionMemory {
    private db: Database;

    constructor(db: Database) {
        this.db = db;
        this.initializeSchema();
    }

    private initializeSchema(): void {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS tool_decisions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                tool_name TEXT NOT NULL,
                context TEXT NOT NULL,
                task_type TEXT NOT NULL,
                success INTEGER NOT NULL,
                latency_ms REAL DEFAULT 0,
                feedback TEXT,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            )
        `);
        const tryAdd = (stmt: string) => { try { this.db.exec(stmt); } catch { /* exists */ } };
        tryAdd('CREATE INDEX IF NOT EXISTS idx_decisions_tool ON tool_decisions(tool_name)');
        tryAdd('CREATE INDEX IF NOT EXISTS idx_decisions_context ON tool_decisions(context)');
        tryAdd('CREATE INDEX IF NOT EXISTS idx_decisions_task ON tool_decisions(task_type)');
    }

    /**
     * Record a tool decision
     */
    record(decision: Omit<ToolDecision, 'id' | 'createdAt'>): number {
        const result = this.db.prepare(`
            INSERT INTO tool_decisions (tool_name, context, task_type, success, latency_ms, feedback)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(
            decision.toolName,
            decision.context,
            decision.taskType,
            decision.success ? 1 : 0,
            decision.latencyMs,
            decision.feedback || null
        );
        return Number(result.lastInsertRowid);
    }

    /**
     * Get best tool for a given context and task type
     */
    getBestTool(context: string, taskType: string): { toolName: string; successRate: number; avgLatency: number } | null {
        const row = this.db.prepare(`
            SELECT 
                tool_name,
                SUM(success) * 1.0 / COUNT(*) as success_rate,
                AVG(latency_ms) as avg_latency,
                COUNT(*) as uses
            FROM tool_decisions
            WHERE (context = ? OR context = 'any')
              AND (task_type = ? OR task_type = 'any')
            GROUP BY tool_name
            HAVING uses >= 2
            ORDER BY success_rate DESC, avg_latency ASC
            LIMIT 1
        `).get(context, taskType) as any;

        if (!row || row.success_rate < 0.3) return null;

        return {
            toolName: row.tool_name,
            successRate: row.success_rate,
            avgLatency: row.avg_latency
        };
    }

    /**
     * Get tool performance stats
     */
    getToolStats(toolName?: string): Array<{
        toolName: string; uses: number; successRate: number; avgLatency: number;
    }> {
        const query = toolName
            ? `SELECT tool_name, COUNT(*) as uses, SUM(success)*1.0/COUNT(*) as success_rate, AVG(latency_ms) as avg_latency FROM tool_decisions WHERE tool_name = ? GROUP BY tool_name`
            : `SELECT tool_name, COUNT(*) as uses, SUM(success)*1.0/COUNT(*) as success_rate, AVG(latency_ms) as avg_latency FROM tool_decisions GROUP BY tool_name ORDER BY uses DESC`;

        const rows = toolName
            ? this.db.prepare(query).all(toolName)
            : this.db.prepare(query).all();

        return (rows as any[]).map(r => ({
            toolName: r.tool_name,
            uses: r.uses,
            successRate: Math.round(r.success_rate * 100) / 100,
            avgLatency: Math.round(r.avg_latency)
        }));
    }

    /**
     * Prune old decisions (keep last 90 days)
     */
    prune(): number {
        const result = this.db.prepare(
            "DELETE FROM tool_decisions WHERE created_at < datetime('now', '-90 days')"
        ).run();
        return result.changes;
    }

    /**
     * Record from agent loop (convenience method)
     */
    recordFromLoop(toolName: string, success: boolean, latencyMs: number, input?: string): void {
        const context = this.detectContext(input || '');
        const taskType = this.detectTaskType(input || '', toolName);
        this.record({ toolName, context, taskType, success, latencyMs, feedback: undefined });
    }

    private detectContext(input: string): string {
        const n = input.toLowerCase();
        if (/\b(npm|npx|pip|apt|git|docker|ssh|bash)\b/.test(n)) return 'terminal';
        if (/\b(btc|eth|crypto|trading|preço|cotação)\b/.test(n)) return 'trading';
        if (/\b(function|class|const|def|async)\b/.test(n)) return 'coding';
        if (/\?\s*$/.test(n)) return 'chat';
        return 'analysis';
    }

    private detectTaskType(input: string, tool: string): string {
        const n = input.toLowerCase();
        if (tool.includes('crypto') || tool.includes('search')) return 'information_retrieval';
        if (tool.includes('exec')) return 'system_operation';
        if (tool.includes('file')) return 'file_operation';
        if (tool.includes('audio') || tool.includes('tts')) return 'communication';
        if (/\b(busque|busca|search|find|procure)\b/.test(n)) return 'information_retrieval';
        if (/\b(cria|create|gera|install|monte)\b/.test(n)) return 'creation';
        return 'conversation';
    }
}