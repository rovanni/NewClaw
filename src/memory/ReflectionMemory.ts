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
import { permissionRegistry } from '../core/PermissionRegistry';
import type { MemoryManager } from './MemoryManager';
import type { AttemptOutcome, BlockerKind, IntentCategory } from '../shared/domainTypes';

const log = createLogger('ReflectionMemory');

// ── S1 (roadmap de aprendizado orientado a objetivos) ───────────────────────
//
// Contrato mínimo, ainda NÃO conectado — nenhuma mudança de schema, de SQL, nem
// de comportamento nesta Sprint. record()/buildContextHint()/buildConstraints()
// continuam exatamente como estão; nada aqui é lido ou escrito ainda.
//
// Por que estes 3 campos e não outros: `pattern: string` hoje faz papel de 3
// coisas ao mesmo tempo dependendo de quem grava — categoria de intenção,
// tipo de falha, ou ferramenta+sucesso concatenados (auditoria anterior). Os
// 3 campos abaixo dão nome a cada um separadamente, reaproveitando vocabulário
// que já existe no projeto em vez de inventar um novo:
//   - outcome:      AttemptOutcome (GoalTypes.ts) — os mesmos 3 valores que
//                   GoalAttempt.result já usa. Sucesso e parcial continuam
//                   sendo resultados de primeira classe, não só falha.
//   - category:     IntentCategory (UnifiedIntentRouter.ts) — eixo SECUNDÁRIO
//                   e opcional (é sobre o pedido do usuário, não sobre o que
//                   aconteceu); nunca deve ser a única chave de busca.
//   - failureType:  BlockerKind (GoalTypes.ts) — só faz sentido quando
//                   outcome !== 'success'; reaproveita a mesma taxonomia que
//                   GoalExecutionLoop já usa para blockers de goal, em vez de
//                   criar uma segunda taxonomia de "tipo de falha" paralela.
//
// Deliberadamente NÃO incluído:
//   - `tool`      — já existe como coluna `tool_used`, sempre populada
//                   corretamente (confirmado na auditoria); nada a acrescentar.
//   - `severity`  — derivável de failure_rate/recência/confirmações; persistir
//                   por linha seria guardar estado sem necessidade comprovada.
//   - uma interface única (`KnowledgeUnit`/`IMemory`) fundindo isto com
//                   DecisionMemory/Skills/memória episódica — ver justificativa
//                   completa no relatório de fechamento da S1.
export interface ReflectionKnowledgeFields {
    outcome?: AttemptOutcome;
    category?: IntentCategory;
    failureType?: BlockerKind;
}

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

        // S2 (roadmap de aprendizado) — 3 colunas novas, anuláveis, para o contrato
        // estruturado da S1 (outcome/category/failure_type). SQLite não tem
        // "ADD COLUMN IF NOT EXISTS"; o try/catch cobre tanto o banco fresco (colunas
        // já vieram no CREATE TABLE acima seria redundante, então nem estão lá — só
        // aqui) quanto o banco de produção existente (~1400 linhas). Nenhuma query de
        // leitura referencia essas colunas ainda — são escritas por produtores
        // migrados (S2a-c) e permanecem invisíveis para os consumidores até a S3.
        const tryAddColumn = (name: string) => {
            try { this.db.exec(`ALTER TABLE reflection_annotations ADD COLUMN ${name} TEXT`); }
            catch { /* coluna já existe */ }
        };
        tryAddColumn('outcome');
        tryAddColumn('category');
        tryAddColumn('failure_type');
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
    } & ReflectionKnowledgeFields): void {
        try {
            const pattern = params.pattern ?? (params.toolUsed ? `tool_${params.toolUsed}` : 'general');
            const id = `ref_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

            this.db.prepare(`
                INSERT INTO reflection_annotations
                    (id, trace_id, conversation_id, user_input, intent, tool_used,
                     tool_output, final_response, approved, reason, confidence, suggested_fix, pattern,
                     outcome, category, failure_type)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                pattern,
                params.outcome ?? null,
                params.category ?? null,
                params.failureType ?? null
            );

            if (!params.approved) {
                log.info(`[REFLECT] Falha registrada: tool=${params.toolUsed} pattern=${pattern} reason="${params.reason}"`);
            }
        } catch (e) {
            log.warn('record_failed', errorMessage(e));
        }
    }

    // ── Read / Query ───────────────────────────────────────────────────

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
    // ARCH-006: buildConstraints()/getHardFailurePatterns() (geração de API anterior à S3,
    // chave por `pattern` livre) removidos — zero chamadores em produção confirmados antes da
    // remoção. O caminho vivo equivalente é findHardConstraints() (abaixo), que já cobre os
    // mesmos consumidores (RiskAnalyzer, GoalPlanner) por `tool_used` real.

    /**
     * ARCH-005 — fatos de ambiente conhecidos a priori, não aprendidos por repetição.
     * Retorna null quando o padrão não corresponde a nenhum workaround conhecido — nesse
     * caso o chamador segue para a lógica estatística padrão de patternToConstraint().
     */
    private environmentWorkaroundForPattern(pattern: string): string | null {
        // PEP 668 / pip bloqueado
        if (/environment_limit|pep.?668|externally.managed/i.test(pattern)) {
            return `NÃO use 'pip install' direto — bloqueado pelo sistema operacional (PEP 668). Use venv isolado ou alternativa sem pip.`;
        }
        // venv / ensurepip ausente
        if (/ensurepip|python3.?venv/i.test(pattern)) {
            return `NÃO use 'python3 -m venv' — ensurepip indisponível neste ambiente. Use pandoc, marp ou outra abordagem.`;
        }
        return null;
    }

    /**
     * Converte um padrão de falha em texto de constraint para o planner.
     * Retorna null se o padrão não mapear para uma constraint conhecida.
     */
    private patternToConstraint(pattern: string, toolUsed: string, topFix: string | null): string | null {
        // ARCH-005: fatos de ambiente conhecidos a priori (não estatística de falha) —
        // separados explicitamente do restante do método, que é sobre INFERÊNCIA a partir de
        // taxa de falha observada. O gatilho (chamado só quando getHardFailurePatterns já
        // confirmou >=90% de falha recente) continua estatístico; o CONTEÚDO da regra abaixo,
        // não — é sempre o mesmo texto fixo, verdadeiro independente de quantas vezes ocorreu.
        // Localização ainda em aberto (ver docs/RFC-001_APRENDIZADO_OPERACIONAL.md) — mantido
        // aqui por ora, isolado nesta função para não ficar implícito dentro da lógica
        // estatística que segue.
        const environmentWorkaround = this.environmentWorkaroundForPattern(pattern);
        if (environmentWorkaround) return environmentWorkaround;

        // Ferramentas core nunca devem ser bloqueadas por constraints duras em SAFE/DEVELOPER.
        // Em GOD mode (bypass_reflection_constraints=true), exec_command pode receber constraints
        // reais — mas o RiskAnalyzer as marcará como [CONSTRAINT-BYPASSED] sem enforceá-las.
        // SAFE/DEVELOPER: exec_command permanece protegido de hard-block por CORE_TOOLS.
        const bypassMode = permissionRegistry.can('bypass_reflection_constraints');
        const CORE_TOOLS = new Set(
            bypassMode
                ? ['read', 'write', 'edit', 'memory_search', 'memory_write', 'list_workspace', 'send_document', 'send_audio']
                : ['read', 'write', 'edit', 'exec_command', 'memory_search', 'memory_write', 'list_workspace', 'send_document', 'send_audio']
        );
        if (CORE_TOOLS.has(toolUsed)) return null;
        // Tool que falhou 100% das vezes
        if (toolUsed && toolUsed !== 'unknown' && toolUsed !== 'agentloop') {
            const hint = topFix ? ` Alternativa: ${topFix}` : '';
            return `A ferramenta '${toolUsed}' falhou em 100% das tentativas recentes.${hint}`;
        }
        return null;
    }

    // ── S3 (roadmap de aprendizado orientado a objetivos) — consultas estruturadas ──
    //
    // Cada método abaixo responde a UMA pergunta cognitiva de um consumidor real —
    // não um retrieve() genérico com opcionais ambíguos (ver S3.1 no relatório).
    // Todos agrupam por COLUNA REAL (tool_used/category/failure_type), nunca mais
    // por `pattern` livre. tool_used sempre foi populado corretamente mesmo em
    // registros gravados antes da S2 — por isso as consultas por ferramenta já
    // cobrem o histórico inteiro sem precisar adivinhar convenção de prefixo.
    // category/failure_type só existem em registros novos (pós-S2); cada método
    // documenta o que isso significa para dados legados.
    //
    // Mantém o MESMO formato de texto de buildContextHint() (linha "- Ferramenta:
    // X | Padrão: Y | Falha: NN% (a/b)") porque PromptComposer.compressReflection()
    // faz parsing por regex sobre esse formato — mudar o texto quebraria isso
    // silenciosamente em vez de dar erro.

    private formatHintRow(toolLabel: string, patternLabel: string, total: number, failures: number, failureRate: number, topFix: string | null): string {
        const pct = Math.round(failureRate * 100);
        const lines = [
            'Padrões de erro similares detectados no histórico:',
            `- Ferramenta: ${toolLabel} | Padrão: ${patternLabel} | Falha: ${pct}% (${failures}/${total})`,
        ];
        if (topFix) lines.push(`  Sugestão baseada em histórico: "${topFix}"`);
        lines.push('Use essas informações como guia; priorize abordagens que tiveram mais sucesso.');
        return lines.join('\n');
    }

    /**
     * "Para esta ferramenta, existe um padrão de falha recorrente?"
     * Usada por RiskAnalyzer (por step do plano) e por findBlockerLessons() quando
     * o blocker tem toolName. GROUP BY tool_used sozinho — não mais (pattern,
     * tool_used) — então falhas do MESMO tool gravadas sob patterns diferentes
     * (ex: tool_exec_command / goal_blocker_tool_error / tool_tool_error, todas
     * tool_used=exec_command) somam num único sinal em vez de se fragmentarem.
     */
    findToolFailures(tool: string): string {
        try {
            const row = this.db.prepare(`
                SELECT tool_used, COUNT(*) AS total,
                       SUM(CASE WHEN approved = 0 THEN 1 ELSE 0 END) AS failures,
                       CAST(SUM(CASE WHEN approved = 0 THEN 1 ELSE 0 END) AS REAL) / COUNT(*) AS failure_rate,
                       (SELECT suggested_fix FROM reflection_annotations r2
                        WHERE r2.tool_used = r1.tool_used AND r2.approved = 0 AND r2.suggested_fix IS NOT NULL
                        ORDER BY r2.created_at DESC LIMIT 1) AS top_fix
                FROM reflection_annotations r1
                WHERE tool_used = ?
                  AND created_at > datetime('now', '-7 days')
                GROUP BY tool_used
                HAVING total >= 2 AND failure_rate >= 0.30
                  AND (
                    SELECT COUNT(*) FROM reflection_annotations r3
                    WHERE r3.tool_used = r1.tool_used
                      AND r3.approved = 1 AND r3.outcome IS NOT 'partial' AND r3.created_at > datetime('now', '-3 hours')
                  ) = 0
            `).get(tool) as { tool_used: string; total: number; failures: number; failure_rate: number; top_fix: string | null } | undefined;
            if (!row) return '';
            return this.formatHintRow(row.tool_used, tool, row.total, row.failures, row.failure_rate, row.top_fix);
        } catch { return ''; }
    }

    /**
     * "Existem restrições duras (falha quase garantida) relevantes para as
     * ferramentas deste plano?" Usada por RiskAnalyzer.analyze() ANTES de
     * executar — substitui a chamada que passava texto livre do objetivo do
     * usuário como se fosse uma chave técnica (achado crítico da auditoria).
     * Mesmo threshold (90%) e mesma supressão por sucesso recente de sempre —
     * só a chave de busca mudou de `pattern` livre para `tool_used` real.
     */
    findHardConstraints(tools: string[]): string[] {
        try {
            const constraints: string[] = [];
            for (const tool of tools) {
                const row = this.db.prepare(`
                    SELECT tool_used, COUNT(*) AS total,
                           CAST(SUM(CASE WHEN approved = 0 THEN 1 ELSE 0 END) AS REAL) / COUNT(*) AS failure_rate,
                           (SELECT suggested_fix FROM reflection_annotations r2
                            WHERE r2.tool_used = r1.tool_used AND r2.approved = 0 AND r2.suggested_fix IS NOT NULL
                            ORDER BY r2.created_at DESC LIMIT 1) AS top_fix,
                           (SELECT failure_type FROM reflection_annotations r4
                            WHERE r4.tool_used = r1.tool_used AND r4.failure_type IS NOT NULL
                            ORDER BY r4.created_at DESC LIMIT 1) AS recent_failure_type,
                           (SELECT pattern FROM reflection_annotations r5
                            WHERE r5.tool_used = r1.tool_used
                            ORDER BY r5.created_at DESC LIMIT 1) AS recent_pattern
                    FROM reflection_annotations r1
                    WHERE tool_used = ?
                      AND created_at > datetime('now', '-7 days')
                    GROUP BY tool_used
                    HAVING total >= 2 AND failure_rate >= 0.90
                      AND (
                        SELECT COUNT(*) FROM reflection_annotations r3
                        WHERE r3.tool_used = r1.tool_used
                          AND r3.approved = 1 AND r3.outcome IS NOT 'partial' AND r3.created_at > datetime('now', '-3 hours')
                      ) = 0
                `).get(tool) as { tool_used: string; total: number; failure_rate: number; top_fix: string | null; recent_failure_type: string | null; recent_pattern: string | null } | undefined;
                if (!row) continue;
                // patternToConstraint() já casa a string literal 'environment_limit' (e
                // variações) via regex — passar failure_type real (quando disponível) ou o
                // pattern legado mais recente como fallback reaproveita a função inalterada.
                const constraint = this.patternToConstraint(row.recent_failure_type ?? row.recent_pattern ?? '', row.tool_used, row.top_fix);
                if (constraint) constraints.push(constraint);
            }
            return constraints;
        } catch { return []; }
    }

    /**
     * "Dado o que acabou de bloquear/falhar, o que já aprendemos que evita
     * repetir a mesma estratégia?" Usada por GoalPlanner.replan(). Quando o
     * blocker tem toolName, delega para findToolFailures() (mesma pergunta).
     * Quando NÃO tem (blockers não amarrados a uma ferramenta específica, ex.
     * goal_ambiguous/context_insufficient), busca por failure_type real — uma
     * capacidade nova; dados gravados antes da S2 não têm failure_type e não
     * aparecem aqui (não é regressão: o fallback antigo por prefixo também não
     * os alcançava de forma confiável, é só um caminho honesto novo).
     */
    findBlockerLessons(blocker: { kind: string; toolName?: string }): string {
        if (blocker.toolName) return this.findToolFailures(blocker.toolName);
        try {
            const row = this.db.prepare(`
                SELECT COUNT(*) AS total,
                       SUM(CASE WHEN approved = 0 THEN 1 ELSE 0 END) AS failures,
                       CAST(SUM(CASE WHEN approved = 0 THEN 1 ELSE 0 END) AS REAL) / COUNT(*) AS failure_rate,
                       (SELECT suggested_fix FROM reflection_annotations r2
                        WHERE r2.failure_type = r1.failure_type AND r2.approved = 0 AND r2.suggested_fix IS NOT NULL
                        ORDER BY r2.created_at DESC LIMIT 1) AS top_fix
                FROM reflection_annotations r1
                WHERE failure_type = ?
                  AND created_at > datetime('now', '-7 days')
                HAVING total >= 2 AND failure_rate >= 0.30
            `).get(blocker.kind) as { total: number; failures: number; failure_rate: number; top_fix: string | null } | undefined;
            if (!row) return '';
            return this.formatHintRow('(vários)', blocker.kind, row.total, row.failures, row.failure_rate, row.top_fix);
        } catch { return ''; }
    }

    /**
     * "Que tipo de problema geral tende a acontecer neste tipo de pedido?"
     * Usada por AgentLoop (categoria da intenção do usuário). GROUP BY é a
     * categoria inteira, SEM sub-agrupar por tool_used — é exatamente essa
     * fragmentação (categoria ampla dividida por ferramenta) que fazia
     * getFailurePatterns('conversation') retornar vazio mesmo com 30% de falha
     * agregada (S16.5). Inclui fallback para registros legados que têm a
     * categoria smuggled em `pattern` (sem coluna `category` própria).
     */
    findCategoryHints(category: string): string {
        try {
            const row = this.db.prepare(`
                SELECT COUNT(*) AS total,
                       SUM(CASE WHEN approved = 0 THEN 1 ELSE 0 END) AS failures,
                       CAST(SUM(CASE WHEN approved = 0 THEN 1 ELSE 0 END) AS REAL) / COUNT(*) AS failure_rate,
                       (SELECT suggested_fix FROM reflection_annotations r2
                        WHERE (r2.category = ? OR (r2.category IS NULL AND r2.pattern = ?))
                          AND r2.approved = 0 AND r2.suggested_fix IS NOT NULL
                        ORDER BY r2.created_at DESC LIMIT 1) AS top_fix
                FROM reflection_annotations r1
                WHERE (r1.category = ? OR (r1.category IS NULL AND r1.pattern = ?))
                  AND r1.created_at > datetime('now', '-7 days')
                HAVING total >= 2 AND failure_rate >= 0.30
                  AND (
                    SELECT COUNT(*) FROM reflection_annotations r3
                    WHERE (r3.category = ? OR (r3.category IS NULL AND r3.pattern = ?))
                      AND r3.approved = 1 AND r3.outcome IS NOT 'partial' AND r3.created_at > datetime('now', '-3 hours')
                  ) = 0
            `).get(category, category, category, category, category, category) as { total: number; failures: number; failure_rate: number; top_fix: string | null } | undefined;
            if (!row) return '';
            return this.formatHintRow('(várias)', category, row.total, row.failures, row.failure_rate, row.top_fix);
        } catch { return ''; }
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
