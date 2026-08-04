/**
 * OperationalKnowledge — Milestone M2 (docs/decisoes/RFC-001_APRENDIZADO_OPERACIONAL.md)
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

type LastEvent = 'success' | 'failure';

interface KnowledgeRow {
    id: string;
    tool: string;
    platform: string;
    command: string;
    success_count: number;
    failure_count: number;
    created_at: string;
    last_confirmed_at: string;
    last_event: LastEvent | null;
}

/**
 * Nível de confiança explícito (RFC-003 Sprint E,
 * `docs/decisoes/RFC-003_AQUISICAO_CONHECIMENTO_OPERACIONAL.md`) — substitui os limiares crus
 * espalhados que já existiam (`success_count>=2 && failure_count===0` em `getTacticalCommand()`,
 * `success_count>=1` em `buildEvidenceHint()`) por um único cálculo nomeado, simples de explicar:
 * nenhum modelo estatístico, nenhum aprendizado de máquina — só contadores e um campo (`last_event`)
 * já persistidos. Deliberadamente NÃO usa comparação de timestamps: `datetime('now')` do SQLite
 * só tem resolução de 1 segundo — duas chamadas rápidas em sequência (ex.: um teste) podiam
 * gravar o mesmo timestamp pra sucesso e falha, quebrando a comparação. `last_event`, setado
 * diretamente a cada `recordAttempt()`, não depende de precisão de relógio nenhuma.
 *
 *   'none'      — nunca teve sucesso registrado (nunca aparece nas consultas, que já filtram por
 *                 success_count>=1 — mantido aqui só pra o tipo ser exaustivo).
 *   'degraded'  — já teve sucesso, mas o evento mais RECENTE foi uma falha (RFC-001 §2, "sem
 *                 falha recente" — a lacuna que o comentário de getTacticalCommand() já nomeava
 *                 como pendente pra esta Sprint). Nunca elegível a atalho tático.
 *   'weak'      — recém-aprendido: teve sucesso(s), sem falha mais recente, mas ainda abaixo do
 *                 limiar de confirmações repetidas.
 *   'validated' — repetidamente validado: mesmo limiar que já existia (>=2 sucessos), agora
 *                 também exige que o evento mais recente não tenha sido falha — permite
 *                 RECUPERAÇÃO: uma falha antiga não bloqueia mais permanentemente um comando que
 *                 voltou a funcionar depois (failure_count>0 no schema antigo bloqueava pra sempre).
 */
export type ConfidenceLevel = 'none' | 'weak' | 'degraded' | 'validated';

/**
 * Limiar mínimo de sucessos confirmados para o nível 'validated' (elegível ao atalho tático,
 * RFC-003 §7 item 2 / RFC-001 §2) — módulo-level em vez de membro de classe pra
 * `computeConfidenceLevel()` poder ser uma função pura, testável isoladamente, sem precisar de
 * uma instância de `OperationalKnowledge`.
 */
const MIN_SUCCESS_COUNT_FOR_TACTICAL = 2;

export function computeConfidenceLevel(
    row: Pick<KnowledgeRow, 'success_count' | 'last_event'>,
): ConfidenceLevel {
    if (row.success_count === 0) return 'none';
    if (row.last_event === 'failure') return 'degraded';
    if (row.success_count >= MIN_SUCCESS_COUNT_FOR_TACTICAL) return 'validated';
    return 'weak';
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
        // RFC-003 Sprint E — modelo de confiança: coluna nova, nulável, guardando diretamente
        // qual foi o evento mais recente ('success'|'failure') — mesmo padrão de migração já
        // usado em CaseMemory.ts/GoalStore.ts/OwnerProfileService.ts (ALTER TABLE + catch
        // silencioso pra tabelas já existentes de antes desta Sprint).
        try { this.db.exec('ALTER TABLE operational_knowledge ADD COLUMN last_event TEXT'); } catch { /* já existe */ }
    }

    /**
     * Grava (ou reforça) que `command` resolveu `tool` na plataforma atual. Upsert por
     * (tool, platform, command) — comandos diferentes para a mesma ferramenta são fatos
     * distintos, não se sobrescrevem (RFC-001 pergunta 1: a unidade é ferramenta×plataforma,
     * não "o último comando tentado").
     *
     * RFC-003 Sprint E: além dos contadores agregados (success_count/failure_count, já
     * existentes), grava também `last_event` ('success'|'failure') — é essa informação, usada em
     * `computeConfidenceLevel()`, que permite distinguir conhecimento degradado (última coisa que
     * aconteceu foi falhar) de conhecimento que se recuperou (falhou antes, mas voltou a
     * funcionar depois).
     */
    recordAttempt(tool: string, command: string, succeeded: boolean): void {
        try {
            const platform = currentPlatform();
            const lastEvent: LastEvent = succeeded ? 'success' : 'failure';
            const existing = this.db.prepare(
                'SELECT id FROM operational_knowledge WHERE tool = ? AND platform = ? AND command = ?'
            ).get(tool, platform, command) as { id: string } | undefined;

            if (existing) {
                this.db.prepare(`
                    UPDATE operational_knowledge
                    SET success_count = success_count + ?, failure_count = failure_count + ?,
                        last_confirmed_at = datetime('now'), last_event = ?
                    WHERE id = ?
                `).run(succeeded ? 1 : 0, succeeded ? 0 : 1, lastEvent, existing.id);
            } else {
                const id = `opknow_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
                this.db.prepare(`
                    INSERT INTO operational_knowledge (id, tool, platform, command, success_count, failure_count, last_event)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                `).run(id, tool, platform, command, succeeded ? 1 : 0, succeeded ? 0 : 1, lastEvent);
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
     * detecção do blocker — candidato razoável a "comando que resolveu".
     *
     * VALIDAÇÃO OBJETIVA (RFC-003 Sprint D, revista por
     * `docs/decisoes/ADR-003_APRENDIZADO_POR_EVIDENCIA_DE_AMBIENTE.md`): a captura só é creditada
     * mediante fato observável, nunca julgamento. Duas evidências valem, nesta ordem:
     *
     * 1. um attempt bem-sucedido DEPOIS do fixAttempt cujo `planStepId` começa com `'verify_'` —
     *    o step de verificação que `GoalExecutionLoop.handleNeedsDependencyOutcome()` injeta
     *    quando `DependencyInfo.verifyCmd` está declarado. Checado primeiro por ser evidência já
     *    registrada no goal (custo zero, sem tocar o sistema);
     * 2. `isDependencyAvailable(dep)` — veredito do ESTADO DO AMBIENTE ("a dependência existe
     *    agora?"), injetado pelo chamador. Este componente nunca executa comando: quem tem a
     *    capacidade de observar o sistema é o `GoalExecutionLoop`, aqui só entra o resultado
     *    (fronteira do Evidence Provider Pattern preservada).
     *
     * Por que a evidência 2 existe (ADR-003 §2): a evidência 1 sozinha tornava a captura
     * dependente de POR QUAL RAMO DE CÓDIGO o goal passou — o prefixo `verify_` é um carimbo de
     * origem, só existe no caminho `needs_dependency`. Efeito real medido: como só `ffmpeg`
     * declara `verifyCmd` e essa entrada só resolve instalação no Linux, o aprendizado era
     * inalcançável em Windows/macOS e em todo o caminho de Pesquisa. A pergunta objetiva é sobre
     * o mundo, não sobre o plano.
     *
     * Sem verifier injetado, o comportamento é exatamente o anterior a esta mudança (só a
     * evidência 1) — nunca cai para a heurística antiga de creditar sem verificação nenhuma.
     * Uma captura isolada (mesmo já verificada) continua sendo só evidência fraca (ver
     * buildEvidenceHint) — só ganha peso de atalho tático com confirmações repetidas
     * (getTacticalCommand(), RFC-001 §2).
     */
    captureFromGoal(goal: Goal, isDependencyAvailable?: (dependency: string) => boolean): { captured: number } {
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

                const verifiedByStep = goal.attempts.some(a =>
                    a.result === 'success' &&
                    a.executedAt >= fixAttempt.executedAt &&
                    a.planStepId.startsWith('verify_')
                );
                // Só observa o ambiente quando a evidência já registrada no goal não basta —
                // evita tocar o sistema à toa no caminho determinístico, que já provou o fato.
                const verifiedByEnvironment = !verifiedByStep
                    && isDependencyAvailable !== undefined
                    && isDependencyAvailable(blocker.missingDependency!);

                if (!verifiedByStep && !verifiedByEnvironment) {
                    log.debug(`[OPKNOW-CAPTURE] goal=${goal.id} dependency=${blocker.missingDependency} fixAttempt encontrado mas sem evidência objetiva (nem step verify_ bem-sucedido, nem dependência presente no ambiente) — não captura`);
                    continue;
                }

                const evidence = verifiedByStep ? 'verify_step' : 'environment_state';
                log.info(`[OPKNOW-CAPTURE] goal=${goal.id} dependency=${blocker.missingDependency} command="${String(fixAttempt.args.command).trim().slice(0, 80)}" blocker_detected_at=${blocker.detectedAt} fix_executed_at=${fixAttempt.executedAt} evidence=${evidence}`);
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
     *
     * RFC-003 Sprint E: cada linha agora nomeia o nível de confiança (`computeConfidenceLevel()`)
     * junto com os números crus — o texto já dizia "já funcionou Nx, Mx falha(s)" antes, mas não
     * distinguia um registro degradado (falhou por último) de um limpo com o mesmo N. Isso é só
     * enriquecimento do MESMO bloco de evidência textual que já existia — continua texto pro
     * Planner ponderar, nunca uma decisão (Evidence Provider Pattern inalterado).
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
                const level = computeConfidenceLevel(r);
                const levelLabel = level === 'validated' ? 'validado (confirmado repetidamente)'
                    : level === 'degraded' ? 'degradado (a tentativa mais recente falhou)'
                    : 'recém-aprendido (ainda pouco confirmado)';
                lines.push(`- "${r.command}" — ${levelLabel}: já funcionou ${r.success_count}x, ${r.failure_count} falha(s) registrada(s).`);
            }
            lines.push('Evidência de execuções anteriores nesta instância — não é garantia, pondere como qualquer outro sinal.');
            return lines.join('\n');
        } catch {
            return '';
        }
    }

    /**
     * Consulta tática (RFC-003, Sprint A — Infraestrutura; modelo de confiança refinado na
     * Sprint E): retorna o comando aprendido SOMENTE quando `computeConfidenceLevel()` classifica
     * o registro como `'validated'` — mesmo limiar de sempre (>=2 sucessos), agora também exigindo
     * que o evento mais recente não tenha sido uma falha (fecha a lacuna "sem falha recente" que
     * RFC-001 §2 já pedia e que este método deixava documentada como pendente). Nunca decide por
     * conta própria o que fazer com a ausência (retorna `null`, Nunca Adivinhar). O CALLER
     * (`GoalEvaluator`) é responsável por checar `permissionRegistry.can('install_dependencies')`
     * antes de agir sobre este resultado — este método não conhece modo operacional, só
     * conhecimento aprendido.
     *
     * Efeito prático da recência (Sprint E): um comando que falhou no passado mas voltou a
     * funcionar depois (evento mais recente = sucesso, `last_event = 'success'`) agora É
     * elegível — antes, qualquer falha histórica (`failure_count > 0`) bloqueava o atalho tático
     * permanentemente, mesmo que o comando já tivesse se recuperado.
     */
    getTacticalCommand(tool: string): string | null {
        try {
            const platform = currentPlatform();
            const rows = this.db.prepare(`
                SELECT * FROM operational_knowledge
                WHERE tool = ? AND platform = ?
                ORDER BY success_count DESC, last_confirmed_at DESC
            `).all(tool, platform) as KnowledgeRow[];

            const validated = rows.find(r => computeConfidenceLevel(r) === 'validated');
            if (!validated) {
                log.debug(`[OPKNOW-TACTICAL] tool=${tool} platform=${platform} result=not_eligible`);
                return null;
            }
            log.info(`[OPKNOW-TACTICAL] tool=${tool} platform=${platform} eligible: success_count=${validated.success_count} command="${validated.command.slice(0, 80)}"`);
            return validated.command;
        } catch (e) {
            log.warn('get_tactical_command_failed', errorMessage(e));
            return null;
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
