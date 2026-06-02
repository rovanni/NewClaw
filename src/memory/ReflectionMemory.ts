/**
 * ReflectionMemory — Memória de Reflexão pós-execução
 *
 * Persiste ValidationResult do ObserverValidator e agrega padrões de erro.
 * Fecha o loop de aprendizado: falhas do passado informam execuções futuras
 * via buildContextHint(), que é injetado no system prompt.
 *
 * Fluxo:
 *   ObserverValidator.validate() → ReflectionMemory.record() → reflection_annotations
 *   ReflectionMemory.buildContextHint(input) → injetado em skillContext
 */

import { createLogger } from '../shared/AppLogger';
import { errorMessage } from '../shared/errors';
import type { MemoryManager } from './MemoryManager';

const log = createLogger('ReflectionMemory');

// ── Types ──────────────────────────────────────────────────────────────

export interface ReflectionAnnotation {
    id: string;
    traceId?: string;
    conversationId?: string;
    userInput: string;
    intent: string;
    toolUsed: string;
    toolOutput?: string;
    finalResponse?: string;
    approved: boolean;
    reason: string;
    confidence: number;
    suggestedFix?: string;
    pattern?: string;
    createdAt: string;
}

interface AnnotationRow {
    id: string;
    trace_id: string | null;
    conversation_id: string | null;
    user_input: string;
    intent: string;
    tool_used: string;
    tool_output: string | null;
    final_response: string | null;
    approved: number;
    reason: string;
    confidence: number;
    suggested_fix: string | null;
    pattern: string | null;
    created_at: string;
}

interface PatternAggRow {
    pattern: string;
    tool_used: string;
    total: number;
    failures: number;
    failure_rate: number;
    top_fix: string | null;
}

// ── ReflectionMemory ───────────────────────────────────────────────────

export class ReflectionMemory {
    private db: ReturnType<MemoryManager['getDatabase']>;

    constructor(memory: MemoryManager) {
        this.db = memory.getDatabase();
        this.initSchema();
    }

    private initSchema(): void {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS reflection_annotations (
                id TEXT PRIMARY KEY,
                trace_id TEXT,
                conversation_id TEXT,
                user_input TEXT NOT NULL,
                intent TEXT NOT NULL,
                tool_used TEXT NOT NULL,
                tool_output TEXT,
                final_response TEXT,
                approved INTEGER NOT NULL DEFAULT 1,
                reason TEXT NOT NULL,
                confidence REAL NOT NULL DEFAULT 0.5,
                suggested_fix TEXT,
                pattern TEXT,
                created_at TEXT DEFAULT (datetime('now'))
            );

            CREATE INDEX IF NOT EXISTS idx_reflection_pattern ON reflection_annotations(pattern);
            CREATE INDEX IF NOT EXISTS idx_reflection_tool ON reflection_annotations(tool_used);
            CREATE INDEX IF NOT EXISTS idx_reflection_approved ON reflection_annotations(approved);
            CREATE INDEX IF NOT EXISTS idx_reflection_created ON reflection_annotations(created_at);
        `);
    }

    // ── Write ──────────────────────────────────────────────────────────

    record(params: {
        traceId?: string;
        conversationId?: string;
        userInput: string;
        intent: string;
        toolUsed: string;
        toolOutput?: string;
        finalResponse?: string;
        approved: boolean;
        reason: string;
        confidence: number;
        suggestedFix?: string;
        pattern?: string;
    }): void {
        try {
            const pattern = params.pattern ?? (params.toolUsed ? `tool_${params.toolUsed}` : 'general');
            const id = `ref_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

            this.db.prepare(`
                INSERT INTO reflection_annotations
                    (id, trace_id, conversation_id, user_input, intent, tool_used,
                     tool_output, final_response, approved, reason, confidence, suggested_fix, pattern)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
                id,
                params.traceId ?? null,
                params.conversationId ?? null,
                params.userInput.slice(0, 500),
                params.intent,
                params.toolUsed,
                (params.toolOutput ?? '').slice(0, 1000) || null,
                (params.finalResponse ?? '').slice(0, 500) || null,
                params.approved ? 1 : 0,
                params.reason,
                params.confidence,
                params.suggestedFix ?? null,
                pattern
            );

            if (!params.approved) {
                log.info(`[REFLECT] Falha registrada: tool=${params.toolUsed} pattern=${pattern} reason="${params.reason}"`);
            }
        } catch (e) {
            log.warn('record_failed', errorMessage(e));
        }
    }

    // ── Read / Query ───────────────────────────────────────────────────

    /**
     * Retorna um hint de contexto baseado em padrões de falha similares.
     * Retorna string vazia se não há nada relevante.
     */
    buildContextHint(category: string): string {
        try {
            const patterns = this.getFailurePatterns(category);
            if (patterns.length === 0) return '';

            const lines: string[] = ['Padrões de erro similares detectados no histórico:'];
            for (const p of patterns) {
                const pct = Math.round(p.failure_rate * 100);
                lines.push(`- Ferramenta: ${p.tool_used} | Padrão: ${p.pattern} | Falha: ${pct}% (${p.failures}/${p.total})`);
                if (p.top_fix) {
                    lines.push(`  Sugestão baseada em histórico: "${p.top_fix}"`);
                }
            }
            lines.push('Use essas informações como guia; priorize abordagens que tiveram mais sucesso.');
            return lines.join('\n');
        } catch {
            return '';
        }
    }

    /**
     * Padrões de falha agrupados por (pattern, tool_used), com taxa de falha >= 30%
     * e ao menos 2 registros — relevantes para o input atual.
     *
     * Quando category é 'tool_xxx', também pesquisa registros goal_blocker_* cuja
     * tool_used seja 'xxx' — corrige o mismatch entre a chave de escrita
     * (GoalExecutionLoop usa `goal_blocker_${kind}`) e a chave de leitura
     * (GoalPlanner usa `tool_${toolName}`).
     */
    private getFailurePatterns(category: string): PatternAggRow[] {
        const toolName = category.startsWith('tool_') ? category.slice(5) : null;
        return this.db.prepare(`
            SELECT
                pattern,
                tool_used,
                COUNT(*) AS total,
                SUM(CASE WHEN approved = 0 THEN 1 ELSE 0 END) AS failures,
                CAST(SUM(CASE WHEN approved = 0 THEN 1 ELSE 0 END) AS REAL) / COUNT(*) AS failure_rate,
                (SELECT suggested_fix FROM reflection_annotations r2
                 WHERE r2.pattern = r1.pattern AND r2.tool_used = r1.tool_used
                   AND r2.approved = 0 AND r2.suggested_fix IS NOT NULL
                 ORDER BY r2.created_at DESC LIMIT 1) AS top_fix
            FROM reflection_annotations r1
            WHERE (pattern = ? OR (? IS NOT NULL AND pattern LIKE 'goal_blocker_%' AND tool_used = ?))
              AND created_at > datetime('now', '-7 days')
            GROUP BY pattern, tool_used
            HAVING total >= 2 AND failure_rate >= 0.30
            ORDER BY failure_rate DESC, total DESC
            LIMIT 3
        `).all(category, toolName, toolName) as PatternAggRow[];
    }

    /** Retorna as últimas N anotações (para observabilidade/dashboard). */
    getRecent(limit = 20): ReflectionAnnotation[] {
        return (this.db.prepare(`
            SELECT * FROM reflection_annotations
            ORDER BY created_at DESC LIMIT ?
        `).all(limit) as AnnotationRow[]).map(this.rowToAnnotation);
    }

    /** Todos os padrões com failure_rate >= threshold (para relatório). */
    getTopFailurePatterns(minCount = 3, minFailureRate = 0.3): PatternAggRow[] {
        return this.db.prepare(`
            SELECT
                pattern,
                tool_used,
                COUNT(*) AS total,
                SUM(CASE WHEN approved = 0 THEN 1 ELSE 0 END) AS failures,
                CAST(SUM(CASE WHEN approved = 0 THEN 1 ELSE 0 END) AS REAL) / COUNT(*) AS failure_rate,
                (SELECT suggested_fix FROM reflection_annotations r2
                 WHERE r2.pattern = r1.pattern AND r2.tool_used = r1.tool_used
                   AND r2.approved = 0 AND r2.suggested_fix IS NOT NULL
                 ORDER BY r2.created_at DESC LIMIT 1) AS top_fix
            FROM reflection_annotations r1
            WHERE created_at > datetime('now', '-30 days')
            GROUP BY pattern, tool_used
            HAVING total >= ? AND failure_rate >= ?
            ORDER BY failure_rate DESC, total DESC
            LIMIT 20
        `).all(minCount, minFailureRate) as PatternAggRow[];
    }

    // ── Constraint Injection ───────────────────────────────────────────

    /**
     * Retorna constraints duras baseadas em padrões com 100% de falha.
     *
     * Diferente de buildContextHint() (que sugere), constraints são proibições
     * absolutas injetadas no prompt do GoalPlanner como regras a seguir.
     *
     * @param planTools Lista de toolNames presentes no plano atual. Quando fornecida,
     *   constraints de tools que NÃO estão no plano são descartadas — evita noise
     *   de constraints irrelevantes (ex: web_search bloqueada num plano que não a usa).
     *
     * Exemplos de output:
     *   ["NÃO use pip install direto — PEP 668 bloqueado neste ambiente",
     *    "NÃO use python3 -m venv — ensurepip ausente neste ambiente"]
     */
    buildConstraints(goalContext: string, planTools?: string[]): string[] {
        try {
            const patterns = this.getHardFailurePatterns(goalContext);
            const planToolSet = planTools && planTools.length > 0 ? new Set(planTools) : null;
            const constraints: string[] = [];

            for (const p of patterns) {
                // Se temos a lista de tools do plano, descarta constraints cujas tools
                // não aparecem no plano — evita que falhas históricas de web_search
                // poluam plans de edição de arquivo, por exemplo.
                if (planToolSet && p.tool_used && p.tool_used !== 'unknown' && p.tool_used !== 'agentloop') {
                    if (!planToolSet.has(p.tool_used)) continue;
                }
                const constraint = this.patternToConstraint(p.pattern, p.tool_used, p.top_fix);
                if (constraint) constraints.push(constraint);
            }

            return constraints;
        } catch {
            return [];
        }
    }

    /**
     * Padrões com taxa de falha = 100% e ao menos 2 registros nos últimos 7 dias.
     * Esses se tornam constraints duras no planner.
     */
    private getHardFailurePatterns(category: string): PatternAggRow[] {
        return this.db.prepare(`
            SELECT
                pattern,
                tool_used,
                COUNT(*) AS total,
                SUM(CASE WHEN approved = 0 THEN 1 ELSE 0 END) AS failures,
                CAST(SUM(CASE WHEN approved = 0 THEN 1 ELSE 0 END) AS REAL) / COUNT(*) AS failure_rate,
                (SELECT suggested_fix FROM reflection_annotations r2
                 WHERE r2.pattern = r1.pattern AND r2.tool_used = r1.tool_used
                   AND r2.approved = 0 AND r2.suggested_fix IS NOT NULL
                 ORDER BY r2.created_at DESC LIMIT 1) AS top_fix
            FROM reflection_annotations r1
            WHERE (pattern = ? OR pattern LIKE 'goal_blocker_%')
              AND created_at > datetime('now', '-7 days')
            GROUP BY pattern, tool_used
            HAVING total >= 2 AND failure_rate >= 0.90
            ORDER BY failure_rate DESC, total DESC
            LIMIT 5
        `).all(category) as PatternAggRow[];
    }

    /**
     * Converte um padrão de falha em texto de constraint para o planner.
     * Retorna null se o padrão não mapear para uma constraint conhecida.
     */
    private patternToConstraint(pattern: string, toolUsed: string, topFix: string | null): string | null {
        // PEP 668 / pip bloqueado
        if (/environment_limit|pep.?668|externally.managed/i.test(pattern)) {
            return `NÃO use 'pip install' direto — bloqueado pelo sistema operacional (PEP 668). Use venv isolado ou alternativa sem pip.`;
        }
        // venv / ensurepip ausente
        if (/ensurepip|python3.?venv/i.test(pattern)) {
            return `NÃO use 'python3 -m venv' — ensurepip indisponível neste ambiente. Use pandoc, marp ou outra abordagem.`;
        }
        // Ferramentas core nunca devem ser bloqueadas por constraints duras.
        // Falhas pontuais (ex: leitura de arquivo binário, path incorreto) não
        // representam falha permanente da ferramenta — apenas uso inadequado no contexto.
        const CORE_TOOLS = new Set(['read', 'write', 'edit', 'exec_command', 'memory_search', 'memory_write', 'list_workspace', 'send_document', 'send_audio']);
        if (CORE_TOOLS.has(toolUsed)) return null;
        // Tool que falhou 100% das vezes
        if (toolUsed && toolUsed !== 'unknown' && toolUsed !== 'agentloop') {
            const hint = topFix ? ` Alternativa: ${topFix}` : '';
            return `A ferramenta '${toolUsed}' falhou em 100% das tentativas recentes.${hint}`;
        }
        return null;
    }

    // ── Maintenance ────────────────────────────────────────────────────

    /** Remove anotações com mais de N dias. */
    prune(olderThanDays = 30): number {
        const result = this.db.prepare(
            `DELETE FROM reflection_annotations WHERE created_at < datetime('now', '-${olderThanDays} days')`
        ).run();
        return result.changes;
    }

    // ── Internals ──────────────────────────────────────────────────────

    private rowToAnnotation(row: AnnotationRow): ReflectionAnnotation {
        return {
            id: row.id,
            traceId: row.trace_id ?? undefined,
            conversationId: row.conversation_id ?? undefined,
            userInput: row.user_input,
            intent: row.intent,
            toolUsed: row.tool_used,
            toolOutput: row.tool_output ?? undefined,
            finalResponse: row.final_response ?? undefined,
            approved: !!row.approved,
            reason: row.reason,
            confidence: row.confidence,
            suggestedFix: row.suggested_fix ?? undefined,
            pattern: row.pattern ?? undefined,
            createdAt: row.created_at,
        };
    }
}
