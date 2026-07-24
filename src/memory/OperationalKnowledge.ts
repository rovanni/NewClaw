/**
 * OperationalKnowledge — Milestone M2 (docs/RFC-001_APRENDIZADO_OPERACIONAL.md)
 *
 * Metade APRENDIDA do papel que KNOWN_DEPS (GoalEvaluator.ts) já ocupa de forma estática:
 * aprende, em runtime, comandos que resolveram dependências ausentes fora do catálogo
 * distribuído com o código-fonte. Chaveado por (ferramenta, plataforma) — nunca por objetivo
 * do usuário, o eixo que a própria investigação já provou ser incompatível com este tipo de
 * conhecimento (CaseMemory recupera por similaridade de OBJETIVO; dois goals sem relação
 * semântica podem esbarrar na mesma dependência ausente e nunca seriam conectados por lá).
 *
 * Segue o Evidence Provider Pattern (docs/ARCHITECTURE/EVIDENCE_PROVIDER_PATTERN.md): aplica
 * seu próprio critério de relevância e devolve texto para o GoalPlanner ponderar — nunca decide
 * sozinho o que fazer. Esta fatia cobre só o caminho informativo (buildEvidenceHint). A
 * extensão tática (RFC-001 seção 7 — exceção nomeada, mesmo padrão de KNOWN_DEPS/
 * needs_dependency, condicionada a permissionRegistry) fica deliberadamente fora desta fatia:
 * exigiria threading de plataforma/conhecimento aprendido através de GoalEvaluator, hoje sem
 * nenhuma dependência injetada — mudança maior, adiada até o caminho informativo se provar
 * útil em uso real (Validação Progressiva, etapa 4).
 *
 * Separação Distribuído × Aprendido: esta classe persiste em SQLite local (mesma camada física
 * de ReflectionMemory/CaseMemory), nunca no código-fonte — conhecimento aqui é específico da
 * instância, nunca promovido automaticamente a KNOWN_DEPS.
 */

import { createLogger } from '../shared/AppLogger';
import { errorMessage } from '../shared/errors';
import { isWindows, isMac } from '../utils/crossPlatform';
import type { MemoryManager } from './MemoryManager';
import type { Goal } from '../shared/domainTypes';

const log = createLogger('OperationalKnowledge');

export type Platform = 'windows' | 'linux' | 'macos';

export function currentPlatform(): Platform {
    if (isWindows) return 'windows';
    if (isMac) return 'macos';
    return 'linux';
}

interface KnowledgeRow {
    id: string;
    tool: string;
    platform: string;
    command: string;
    success_count: number;
    failure_count: number;
    created_at: string;
    last_confirmed_at: string;
}

export class OperationalKnowledge {
    private readonly db: ReturnType<MemoryManager['getDatabase']>;

    constructor(memory: MemoryManager) {
        this.db = memory.getDatabase();
        this.initSchema();
    }

    private initSchema(): void {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS operational_knowledge (
                id TEXT PRIMARY KEY,
                tool TEXT NOT NULL,
                platform TEXT NOT NULL,
                command TEXT NOT NULL,
                success_count INTEGER NOT NULL DEFAULT 0,
                failure_count INTEGER NOT NULL DEFAULT 0,
                created_at TEXT DEFAULT (datetime('now')),
                last_confirmed_at TEXT DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_opknow_tool_platform ON operational_knowledge(tool, platform);
        `);
    }

    /**
     * Grava (ou reforça) que `command` resolveu `tool` na plataforma atual. Upsert por
     * (tool, platform, command) — comandos diferentes para a mesma ferramenta são fatos
     * distintos, não se sobrescrevem (RFC-001 pergunta 1: a unidade é ferramenta×plataforma,
     * não "o último comando tentado").
     */
    recordAttempt(tool: string, command: string, succeeded: boolean): void {
        try {
            const platform = currentPlatform();
            const existing = this.db.prepare(
                'SELECT id FROM operational_knowledge WHERE tool = ? AND platform = ? AND command = ?'
            ).get(tool, platform, command) as { id: string } | undefined;

            if (existing) {
                this.db.prepare(`
                    UPDATE operational_knowledge
                    SET success_count = success_count + ?, failure_count = failure_count + ?,
                        last_confirmed_at = datetime('now')
                    WHERE id = ?
                `).run(succeeded ? 1 : 0, succeeded ? 0 : 1, existing.id);
            } else {
                const id = `opknow_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
                this.db.prepare(`
                    INSERT INTO operational_knowledge (id, tool, platform, command, success_count, failure_count)
                    VALUES (?, ?, ?, ?, ?, ?)
                `).run(id, tool, platform, command, succeeded ? 1 : 0, succeeded ? 0 : 1);
            }
            log.info(`[OPKNOW-RECORD] tool=${tool} platform=${platform} succeeded=${succeeded} command="${command.slice(0, 80)}"`);
        } catch (e) {
            log.warn('record_attempt_failed', errorMessage(e));
        }
    }

    /**
     * Ponto único de captura, mesmo padrão de CaseMemory.captureIfEligible(): chamar SOMENTE
     * depois que o goal já foi validado como genuinamente concluído (mesmo gate de evidência
     * de nível de goal, não de tool call isolada) — nunca lança, nunca bloqueia o fluxo.
     *
     * Heurística de captura: para cada blocker 'missing_tool' com missingDependency (nome real da
     * dependência ausente, ex: 'yq' — NUNCA blocker.toolName, que é a tool que falhou, ex:
     * 'exec_command'), procura o primeiro attempt de exec_command bem-sucedido ocorrido DEPOIS da
     * detecção do blocker — candidato razoável a "comando que resolveu". Não é prova formal de
     * causalidade (poderia ser um exec_command não relacionado que coincidentemente sucedeu
     * depois) — por isso o resultado nunca vira atalho determinístico sozinho: uma captura isolada
     * é evidência fraca (ver buildEvidenceHint), só ganha peso com confirmações repetidas.
     */
    captureFromGoal(goal: Goal): { captured: number } {
        let captured = 0;
        try {
            const missingToolBlockers = goal.blockers.filter(b => b.kind === 'missing_tool' && b.missingDependency);
            for (const blocker of missingToolBlockers) {
                const fixAttempt = goal.attempts.find(a =>
                    a.toolName === 'exec_command' &&
                    a.result === 'success' &&
                    a.executedAt > blocker.detectedAt &&
                    typeof a.args?.command === 'string' &&
                    (a.args.command as string).trim().length > 0
                );
                if (!fixAttempt) continue;
                log.info(`[OPKNOW-CAPTURE] goal=${goal.id} dependency=${blocker.missingDependency} command="${String(fixAttempt.args.command).trim().slice(0, 80)}" blocker_detected_at=${blocker.detectedAt} fix_executed_at=${fixAttempt.executedAt}`);
                this.recordAttempt(blocker.missingDependency!, String(fixAttempt.args.command).trim(), true);
                captured++;
            }
        } catch (e) {
            log.warn('capture_from_goal_failed', errorMessage(e));
        }
        return { captured };
    }

    /**
     * Evidence Provider: texto para o GoalPlanner ponderar, nunca uma ordem. Vazio quando não
     * há nada aprendido para (tool, plataforma atual) — silêncio é saída válida e esperada.
     */
    buildEvidenceHint(tool: string): string {
        try {
            const platform = currentPlatform();
            const rows = this.db.prepare(`
                SELECT * FROM operational_knowledge
                WHERE tool = ? AND platform = ? AND success_count >= 1
                ORDER BY success_count DESC, last_confirmed_at DESC
                LIMIT 2
            `).all(tool, platform) as KnowledgeRow[];
            if (rows.length === 0) {
                log.debug(`[OPKNOW-RECOVER] tool=${tool} platform=${platform} result=nothing_learned`);
                return '';
            }
            log.info(`[OPKNOW-RECOVER] tool=${tool} platform=${platform} candidates=${rows.length} top_success_count=${rows[0].success_count}`);

            const lines: string[] = [`Conhecimento operacional aprendido para '${tool}' (${platform}):`];
            for (const r of rows) {
                lines.push(`- "${r.command}" já funcionou ${r.success_count}x, ${r.failure_count} falha(s) registrada(s).`);
            }
            lines.push('Evidência de execuções anteriores nesta instância — não é garantia, pondere como qualquer outro sinal.');
            return lines.join('\n');
        } catch {
            return '';
        }
    }

    /** Observabilidade — mesma convenção de getStats() do CaseMemory. */
    getStats(): { total: number; byPlatform: Record<string, number> } {
        const total = (this.db.prepare('SELECT COUNT(*) as c FROM operational_knowledge').get() as { c: number }).c;
        const byPlatformRows = this.db.prepare(
            'SELECT platform, COUNT(*) as c FROM operational_knowledge GROUP BY platform'
        ).all() as Array<{ platform: string; c: number }>;
        const byPlatform: Record<string, number> = {};
        for (const r of byPlatformRows) byPlatform[r.platform] = r.c;
        return { total, byPlatform };
    }
}
