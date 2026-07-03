/**
 * CaseMemory — Memória de casos de sucesso comprovado (S5, modo sombra).
 *
 * Pergunta que este módulo responde: "que trajetória possui evidência suficiente de que
 * ajudou o NewClaw a atingir o objetivo do usuário — e pode ser útil novamente?"
 *
 * NÃO é uma memória de `outcome==='success'`. Um Goal com status='completed' pode vir de
 * duas vias bem diferentes (GoalExecutionLoop.validateGoalCompletion):
 *   - determinística: SuccessCriterion avaliado contra GoalAttempt reais (evidência objetiva)
 *   - LLM: julgamento subjetivo — e se a CHAMADA ao LLM falhar/der timeout/parsing inválido,
 *     o código atual assume achieved=true SEM NENHUMA evidência ("assuming achieved").
 * Por isso `goal.status==='completed'` sozinho não é usado aqui como critério — ver
 * determineEvidenceTier(). Cada Caso só é gravado quando existe evidência operacional real,
 * já produzida por mecanismos existentes (nada novo é inventado):
 *   - successCriteria com status='met' (checklist determinístico do próprio Goal)
 *   - sentArtifacts não-vazio (entrega real confirmada — endurecido por bug anterior, ver
 *     S10_SentArtifacts_DeliveryGuard.test.ts: só cresce após envio de verdade, nunca agendado)
 *
 * Modo sombra (S5/S6): captura e consulta diagnóstica apenas. ZERO influência em
 * GoalPlanner.plan()/replan(), RiskAnalyzer, escolha de tools ou execução.
 *
 * Duas dimensões cognitivas DIFERENTES coexistem aqui (S6 — não são a mesma pergunta):
 *   - findSimilarShadow(plan)         → similaridade de ESTRATÉGIA: "já executei um pipeline
 *     de tools estruturalmente parecido?" — reaproveita StrategyDiversityGuard.fingerprint()
 *     (sequência de toolName, sem embeddings). Confirmado por teste adversarial (S22) que
 *     isso mede plano, não problema: falso positivo quando objetivos diferentes compartilham
 *     pipeline, falso negativo quando o mesmo objetivo é resolvido por pipelines diferentes.
 *   - findRelevantCasesShadow(objective) → similaridade de PROBLEMA: "já resolvi algo
 *     suficientemente parecido com ESTE objetivo?" — usa embedding de texto (reaproveita
 *     EmbeddingService.embed()/cosineSimilarity(), já existente no projeto via
 *     MemoryManager.getEmbeddingService(); nenhum provider/vector-DB/LLM-judge novo).
 * Nenhuma substitui a outra. planFingerprint continua servindo StrategyDiversityGuard e
 * comparação estrutural; a similaridade de objetivo é uma dimensão ADICIONAL, não uma troca.
 *
 * S7 — Applicability Gate (3ª dimensão, sobre a 2ª): "mesmo objeto/tópico" comprovadamente NÃO
 * implica "mesma intenção operacional" (S6.5, medido com Ollama+nomic-embed-text real):
 *   criar apresentação PPTX × analisar apresentação PPTX → cosine = 0.9645
 *   criar arquivo × remover arquivo                      → cosine = 0.8955
 * ambos MAIORES que um par genuinamente equivalente (criar apresentação × gerar slides = 0.7234).
 * Auditoria S7.0 (não suposição — leitura de código + medição real, ver relatório da Sprint)
 * eliminou as alternativas de reuso antes de criar qualquer coisa nova:
 *   - IntentCategory (UnifiedIntentRouter) foi cogitado primeiro (já existe, já é usado como
 *     eixo secundário por ReflectionMemory). Descartado: GoalPlanner.ts:607 já documenta que
 *     "IntentCategory não existe no caminho de goal" — não há coleta hoje. Pior: medido
 *     via routeSync() nos pares reais, ele classifica "criar arquivo" e "remover arquivo" na
 *     MESMA categoria ('creation', por causa da palavra-objeto compartilhada "arquivo") — não
 *     resolveria o Erro 2. Só acerta o Erro 1 por coincidência (categoria 'data_analysis' tem
 *     keyword forte "analis*"), não por medir operação. Reutilizá-lo seria "conveniente, não
 *     correto" (proibido explicitamente pela Sprint).
 *   - Nenhum outro classificador de verbo/operação existe no projeto (buscado: RiskAnalyzer,
 *     server_config.isDestructive — cobre só comandos shell literais tipo "rm -rf", não verbos
 *     PT-BR de objetivo).
 *   - LLM classifier (UnifiedIntentRouter.llmClassify) descartado por orçamento de latência:
 *     a Sprint proíbe adicionar chamada de LLM nova ao caminho de CaseMemory.
 * Decisão (Gate C do relatório S7.0): não existe sinal reutilizável — criar o menor contrato
 * operacional inevitável: classifyOperation()/operationalCompatibility() abaixo. Léxico de
 * verbos PT-BR genérico por família semântica (criar/corrigir/remover/inspecionar), não uma
 * lista ad hoc dos pares de teste — validado contra os 6 grupos da S6.5 + 8 grupos novos (K-T),
 * não só os 2 erros conhecidos (ver scripts/evaluate-case-retrieval.ts).
 *
 * DECISÃO DE PERSISTÊNCIA (S7.3): NENHUMA coluna nova. classifyOperation() é função pura e
 * síncrona sobre um campo que já existe (`objective`, NOT NULL desde sempre) — recomputar nos
 * ≤5 candidatos do top-K é mais barato e simples que qualquer migração/coluna nullable/backfill/
 * compatibilidade legada. "O sinal é derivável do objective?" (pergunta da própria Sprint,
 * seção BACKFILL OPERACIONAL) — sim, sempre — logo não há nada para persistir ou migrar.
 */
import type { Database } from 'better-sqlite3';
import { createLogger } from '../shared/AppLogger';
import type { MemoryManager } from './MemoryManager';
import type { EmbeddingService } from './EmbeddingService';
import type { Goal, PlanStep } from '../loop/GoalTypes';
import { StrategyDiversityGuard } from '../loop/StrategyDiversityGuard';

const log = createLogger('CaseMemory');

export type CaseEvidenceTier = 'deterministic_criteria' | 'confirmed_delivery';
export type CaseCaptureSkipReason = 'no_evidence' | 'already_captured';

/** S7 — eixo operacional. Deliberadamente pequeno (4 classes + unknown): representa SÓ "que
 * operação principal o usuário quer realizar", nunca domínio/tema/ferramenta/formato (ver
 * regra da Sprint: "não representar domínio; tema; ferramenta; estratégia; formato"). */
export type OperationalIntent = 'create' | 'modify' | 'remove' | 'inspect' | 'unknown';

/** 'unknown' quando qualquer um dos dois lados não tem verbo reconhecível — ausência de sinal
 * nunca vira compatible=true (ver "REGRA PARA CASOS LEGADOS": ausência de evidência não é
 * compatibilidade positiva). */
export type OperationalCompatibility = boolean | 'unknown';

// ── Léxico de verbos PT-BR (S7.2) — por FAMÍLIA semântica de operação, não por par de teste.
// Cobre infinitivo + imperativo formal/informal + 3ª pessoa presente das conjugações -ar/-er/-ir
// mais comuns. Generalizável (novos verbos da mesma família funcionam sem precisar de código
// novo), mas não pretende ser exaustivo — falha honesta e explícita (retorna 'unknown') é
// preferível a uma lista gigante mantida à mão (ver "não criar taxonomia gigante").
const CREATE_VERBS = new Set([
    'criar', 'crie', 'cria', 'gerar', 'gere', 'gera', 'produzir', 'produza', 'produz',
    'montar', 'monte', 'monta', 'desenvolver', 'desenvolva', 'desenvolve',
    'escrever', 'escreva', 'escreve', 'construir', 'construa', 'constroi',
    'instalar', 'instale', 'instala', 'adicionar', 'adicione', 'adiciona',
    'fazer', 'faça', 'faz', 'criando',
]);
const MODIFY_VERBS = new Set([
    'corrigir', 'corrija', 'corrige', 'editar', 'edite', 'edita',
    'atualizar', 'atualize', 'atualiza', 'ajustar', 'ajuste', 'ajusta',
    'migrar', 'migre', 'migra', 'converter', 'converta', 'converte',
    'alterar', 'altere', 'altera', 'modificar', 'modifique', 'modifica',
]);
const REMOVE_VERBS = new Set([
    'remover', 'remova', 'remove', 'deletar', 'delete', 'deleta',
    'apagar', 'apague', 'apaga', 'excluir', 'exclua', 'exclui',
    'desinstalar', 'desinstale', 'desinstala', 'dropar', 'drope', 'drop',
    'eliminar', 'elimine', 'elimina',
]);
const INSPECT_VERBS = new Set([
    'analisar', 'analise', 'analisa', 'revisar', 'revise', 'revisa',
    'validar', 'valide', 'valida', 'verificar', 'verifique', 'verifica',
    'consultar', 'consulte', 'consulta', 'diagnosticar', 'diagnostique', 'diagnostica',
    'examinar', 'examine', 'examina', 'checar', 'cheque', 'checa', 'inspecionar', 'inspecione',
]);

function normalizeWords(text: string): string[] {
    return text
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean);
}

function firstMatchIndex(words: string[], lexicon: Set<string>): number {
    for (let i = 0; i < words.length; i++) {
        if (lexicon.has(words[i])) return i;
    }
    return -1;
}

// S7.5 — achado adversarial (auditoria pós-S7): classifyOperation() ignorava negação —
// "não remover o arquivo" classificava como 'remove', idêntico a "remover o arquivo". Isso é o
// único gap encontrado na auditoria que gera risco real de FALSO COMPATÍVEL (os demais —
// flexão/lifecycle/transformação incompletos — degradam para 'unknown', que é seguro). Não
// existe sinal reutilizável: UnifiedIntentRouter.REJECTION_PATTERN é ancorado (^...$) para
// classificar uma mensagem CURTA inteira como rejeição ("não"/"cancelar" sozinho), não detecta
// negação embutida no meio de uma frase maior — propósito diferente, não reaproveitável aqui.
// Advérbios de negação genéricos do PT-BR (não os 8 strings exatos usados para descobrir o
// problema) com janela curta antes do verbo — grande o suficiente para "não vá remover", pequena
// o suficiente para não apagar um "não" solto no início de uma frase longa sem relação com o
// verbo (ex.: "não sei, mas quero criar uma apresentação" preserva 'create').
const NEGATION_MARKERS = new Set(['nao', 'sem', 'nunca', 'jamais', 'evite', 'evitar']);
const NEGATION_LOOKBACK = 3;

function hasNegationBefore(words: string[], verbPos: number): boolean {
    const start = Math.max(0, verbPos - NEGATION_LOOKBACK);
    for (let i = start; i < verbPos; i++) {
        if (NEGATION_MARKERS.has(words[i])) return true;
    }
    return false;
}

/**
 * S7.1/S7.2 — classificador operacional candidato: função pura, síncrona, zero I/O, zero
 * dependência de LLM/embedding (orçamento de latência da Sprint). Pega o verbo reconhecível
 * que aparece PRIMEIRO no texto (heurística: o verbo principal de um objetivo curto em PT-BR
 * costuma vir cedo — "crie X", "analise Y"). Retorna 'unknown' quando nenhum verbo das 4
 * famílias é encontrado, OU quando o verbo encontrado está negado nas 3 palavras anteriores
 * (S7.5) — nunca adivinha, e não inventa polaridade (não mapeamos "não remover" para uma classe
 * oposta; só reconhecemos que a evidência para a classe positiva não é confiável).
 */
export function classifyOperation(text: string): OperationalIntent {
    const words = normalizeWords(text);
    const candidates: Array<{ intent: OperationalIntent; pos: number }> = [
        { intent: 'create', pos: firstMatchIndex(words, CREATE_VERBS) },
        { intent: 'modify', pos: firstMatchIndex(words, MODIFY_VERBS) },
        { intent: 'remove', pos: firstMatchIndex(words, REMOVE_VERBS) },
        { intent: 'inspect', pos: firstMatchIndex(words, INSPECT_VERBS) },
    ];
    const hits = candidates.filter(h => h.pos >= 0);
    if (hits.length === 0) return 'unknown';
    hits.sort((a, b) => a.pos - b.pos);
    const winner = hits[0];
    if (hasNegationBefore(words, winner.pos)) return 'unknown';
    return winner.intent;
}

/**
 * S7.5 — núcleo do Applicability Gate. Deliberadamente NÃO combina com semanticScore (ver
 * "NÃO COMBINAR SCORES ARBITRARIAMENTE") — só rotula um par (operação atual, operação do
 * candidato) como compatível, incompatível, ou sem evidência suficiente para decidir.
 */
export function operationalCompatibility(current: OperationalIntent, candidate: OperationalIntent): OperationalCompatibility {
    if (current === 'unknown' || candidate === 'unknown') return 'unknown';
    return current === candidate;
}

export interface CaseRecord {
    id: string;
    goalId: string;
    objective: string;
    planFingerprint: string;
    toolsUsed: string[];
    hadRecovery: boolean;
    blockerKinds: string[];
    evidenceTier: CaseEvidenceTier;
    evidenceSummary: string;
    capturedAt: number;
}

interface CaseRow {
    id: string;
    goal_id: string;
    objective: string;
    plan_fingerprint: string;
    tools_used: string;
    had_recovery: number;
    blocker_kinds: string | null;
    evidence_tier: string;
    evidence_summary: string;
    captured_at: number;
    objective_embedding: Buffer | null;
}

/** Resultado de findRelevantCasesShadow — score é um detalhe de RECUPERAÇÃO, não faz
 * parte da entidade CaseRecord persistida (ver S6, item "não adicionar campos sem necessidade"). */
export interface ScoredCaseRecord extends CaseRecord {
    score: number;
}

/** S7.5 — resultado do Applicability Gate. Estende ScoredCaseRecord (não substitui): score
 * continua sendo a similaridade SEMÂNTICA (findRelevantCasesShadow), intocada. Os dois campos
 * novos são a dimensão OPERACIONAL, mantida deliberadamente separada (ver docstring do módulo,
 * "NÃO COMBINAR SCORES ARBITRARIAMENTE"). */
export interface ApplicableCaseRecord extends ScoredCaseRecord {
    /** Classe operacional do OBJETIVO DO CASO candidato (não persistida — derivada agora). */
    operationalIntent: OperationalIntent;
    /** Comparação entre operationalIntent do candidato e o do objetivo atual (não do Caso). */
    operationalCompatibility: OperationalCompatibility;
}

export class CaseMemory {
    private readonly db: Database;
    private readonly embeddingService: EmbeddingService;

    constructor(memory: MemoryManager) {
        this.db = memory.getDatabase();
        this.embeddingService = memory.getEmbeddingService();
        this.initSchema();
    }

    private initSchema(): void {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS cases (
                id                TEXT PRIMARY KEY,
                goal_id           TEXT NOT NULL,
                objective         TEXT NOT NULL,
                plan_fingerprint  TEXT NOT NULL,
                tools_used        TEXT NOT NULL,
                had_recovery      INTEGER NOT NULL DEFAULT 0,
                blocker_kinds     TEXT,
                evidence_tier     TEXT NOT NULL,
                evidence_summary  TEXT NOT NULL,
                captured_at       INTEGER NOT NULL
            )
        `);
        this.db.exec('CREATE INDEX IF NOT EXISTS idx_cases_fingerprint ON cases(plan_fingerprint)');
        this.db.exec('CREATE INDEX IF NOT EXISTS idx_cases_goal ON cases(goal_id)');
        // S6: coluna nullable — mesma convenção defensiva usada em ReflectionMemory (S2) e no
        // padrão de armazenamento de vetor já existente no projeto (memory_embeddings,
        // conversation_chunks.embedding): Buffer.from(new Float64Array(vec).buffer).
        try { this.db.exec('ALTER TABLE cases ADD COLUMN objective_embedding BLOB'); } catch { /* já existe */ }
        log.info('[CaseMemory] schema ready');
    }

    /**
     * Decide se o goal tem evidência forte o bastante para virar Caso — ver docstring do
     * módulo. Não promove tool success / step success / validation success / commit success
     * isolados: só olha para os 2 sinais de NÍVEL DE GOAL já existentes e endurecidos.
     */
    private determineEvidenceTier(goal: Goal): { tier: CaseEvidenceTier; summary: string } | null {
        const metCriteria = (goal.successCriteria ?? []).filter(c => c.status === 'met');
        if (metCriteria.length > 0) {
            return {
                tier: 'deterministic_criteria',
                summary: metCriteria
                    .map(c => (c.evidence ? `${c.description}: ${c.evidence}` : c.description))
                    .join(' | ')
                    .slice(0, 500),
            };
        }
        const delivered = goal.sentArtifacts ?? [];
        if (delivered.length > 0) {
            return {
                tier: 'confirmed_delivery',
                summary: `Artefatos entregues: ${delivered.join(', ')}`.slice(0, 500),
            };
        }
        return null;
    }

    /**
     * Ponto único de captura. Chamar SOMENTE depois de goalStore.setStatus(id, 'completed').
     * Modo sombra: nunca lança, nunca bloqueia o fluxo de conclusão do goal — só grava.
     */
    captureIfEligible(goal: Goal): { captured: boolean; reason?: CaseCaptureSkipReason; tier?: CaseEvidenceTier } {
        log.debug(`[CASE-CAPTURE-ATTEMPT] goal=${goal.id}`);

        const existing = this.db.prepare('SELECT id FROM cases WHERE goal_id = ?').get(goal.id);
        if (existing) {
            log.debug(`[CASE-CAPTURE-SKIPPED] goal=${goal.id} reason=already_captured`);
            return { captured: false, reason: 'already_captured' };
        }

        const evidence = this.determineEvidenceTier(goal);
        if (!evidence) {
            log.debug(`[CASE-CAPTURE-SKIPPED] goal=${goal.id} reason=no_evidence`);
            return { captured: false, reason: 'no_evidence' };
        }

        const planFingerprint = StrategyDiversityGuard.fingerprint(goal.currentPlan);
        const blockerKinds = [...new Set(goal.blockers.map(b => b.kind))];
        const record: CaseRecord = {
            id: `case_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            goalId: goal.id,
            objective: goal.objective.slice(0, 500),
            planFingerprint,
            toolsUsed: goal.toolsTried,
            hadRecovery: goal.blockers.length > 0,
            blockerKinds,
            evidenceTier: evidence.tier,
            evidenceSummary: evidence.summary,
            capturedAt: Date.now(),
        };

        this.db.prepare(`
            INSERT INTO cases (
                id, goal_id, objective, plan_fingerprint, tools_used,
                had_recovery, blocker_kinds, evidence_tier, evidence_summary, captured_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            record.id,
            record.goalId,
            record.objective,
            record.planFingerprint,
            JSON.stringify(record.toolsUsed),
            record.hadRecovery ? 1 : 0,
            JSON.stringify(record.blockerKinds),
            record.evidenceTier,
            record.evidenceSummary,
            record.capturedAt,
        );

        log.info(
            `[CASE-CAPTURED] goal=${goal.id} tier=${evidence.tier}` +
            ` fingerprint="${planFingerprint}" hadRecovery=${record.hadRecovery}` +
            ` blockers=${blockerKinds.join(',') || 'none'}`
        );

        // S6: embedding do objetivo é best-effort e em BACKGROUND (fire-and-forget) — nunca
        // bloqueia a conclusão do goal nem muda o contrato síncrono de captureIfEligible()
        // (S20 continua validando isso). Fail-open: EmbeddingService.embed() já retorna null
        // sem lançar se o Ollama estiver indisponível; aqui só registramos e seguimos.
        this.embedObjectiveShadow(record.id, record.objective).catch((err) => {
            log.debug(`[CASE-EMBED-FAILED] case=${record.id} error=${String(err)}`);
        });

        return { captured: true, tier: evidence.tier };
    }

    /** Preenche objective_embedding em background — nunca lança, nunca bloqueia captura. */
    private async embedObjectiveShadow(caseId: string, objective: string): Promise<void> {
        await this.embedAndStore(caseId, objective);
    }

    /** Núcleo compartilhado entre embedObjectiveShadow (1 Caso, no momento da captura) e
     * backfillMissingEmbeddings (retroativo, em lote) — mesma lógica, uma só fonte. */
    private async embedAndStore(caseId: string, objective: string): Promise<boolean> {
        const vector = await this.embeddingService.embed(objective);
        if (!vector) {
            log.debug(`[CASE-EMBED-SKIPPED] case=${caseId} reason=embedding_unavailable`);
            return false;
        }
        const blob = Buffer.from(new Float64Array(vector).buffer);
        this.db.prepare('UPDATE cases SET objective_embedding = ? WHERE id = ?').run(blob, caseId);
        log.debug(`[CASE-EMBED-STORED] case=${caseId} dim=${vector.length}`);
        return true;
    }

    /**
     * S6.5a — Integridade do ciclo de embedding: um Caso cujo embed() falhou no momento da
     * captura (Ollama indisponível/timeout) ficava PERMANENTEMENTE invisível a
     * findRelevantCasesShadow() — nada reprocessava esses registros (gap real confirmado,
     * Opção B do gate de integridade). Backfill idempotente e limitado, mesmo padrão de
     * query já usado em EmbeddingService.embedMissing() (para memory_nodes), reimplementado
     * no domínio correto (cases) em vez de generalizar aquele método para servir dois
     * domínios diferentes. Idempotente (WHERE objective_embedding IS NULL nunca reprocessa
     * um Caso já indexado), limitado (LIMIT), observável ([CASE-EMBED-BACKFILL]), fail-open
     * (nunca lança — cada linha usa embedAndStore, que já é fail-open).
     */
    async backfillMissingEmbeddings(limit = 5): Promise<{ attempted: number; embedded: number }> {
        const rows = this.db.prepare(
            'SELECT id, objective FROM cases WHERE objective_embedding IS NULL LIMIT ?'
        ).all(limit) as Array<{ id: string; objective: string }>;

        let embedded = 0;
        for (const row of rows) {
            const ok = await this.embedAndStore(row.id, row.objective);
            if (ok) embedded++;
            // Mesmo rate-limit já usado em EmbeddingService.embedMissing() — evita saturar o
            // Ollama local quando há muitos Casos pendentes de uma vez.
            await new Promise((r) => setTimeout(r, 100));
        }
        log.info(`[CASE-EMBED-BACKFILL] attempted=${rows.length} embedded=${embedded}`);
        return { attempted: rows.length, embedded };
    }

    /**
     * Consulta DIAGNÓSTICA em modo sombra — mede quantos Casos anteriores têm a mesma
     * assinatura de ESTRATÉGIA (sequência de tools) que o plano recém-gerado. Puramente
     * observacional: quem chama este método NÃO deve usar o retorno para alterar plano,
     * prompt ou decisão nenhuma nesta Sprint (ver GoalExecutionLoop, chamado só para log
     * após this.planner.plan()). Responde "já executei um PIPELINE parecido?" — não
     * "já resolvi um PROBLEMA parecido?" (essa é findRelevantCasesShadow, abaixo).
     */
    findSimilarShadow(plan: PlanStep[]): CaseRecord[] {
        const fingerprint = StrategyDiversityGuard.fingerprint(plan);
        const rows = this.db.prepare(
            'SELECT * FROM cases WHERE plan_fingerprint = ? ORDER BY captured_at DESC LIMIT 5'
        ).all(fingerprint) as CaseRow[];
        log.debug(`[CASE-SHADOW-QUERY] type=strategy fingerprint="${fingerprint}" candidates=${rows.length}`);
        return rows.map(r => this.rowToCase(r));
    }

    /**
     * Consulta DIAGNÓSTICA em modo sombra (S6) — responde "já resolvi algo suficientemente
     * RELACIONADO a este objetivo?", via similaridade textual de embedding (não de pipeline).
     * Candidate generation apenas: NÃO gera plano, NÃO define estratégia, NÃO é lida por
     * GoalPlanner/RiskAnalyzer. Top-K sem threshold — S6 está calibrando com dados reais,
     * não declarando "match confiável" ainda (ver relatório S6, item Threshold).
     * Fail-open: se o embedding falhar (Ollama indisponível), retorna [] e loga o motivo —
     * nunca lança, nunca bloqueia o chamador.
     */
    async findRelevantCasesShadow(objective: string, topK = 5): Promise<ScoredCaseRecord[]> {
        const t0 = Date.now();
        const queryVector = await this.embeddingService.embed(objective);
        if (!queryVector) {
            log.debug(
                `[CASE-SHADOW-QUERY] type=problem objective="${objective.slice(0, 60)}"` +
                ` result=embedding_unavailable candidates=0 latencyMs=${Date.now() - t0}`
            );
            return [];
        }

        const rows = this.db.prepare(
            'SELECT * FROM cases WHERE objective_embedding IS NOT NULL'
        ).all() as CaseRow[];

        const scored: ScoredCaseRecord[] = rows.map((row) => {
            const vec = Array.from(new Float64Array(
                row.objective_embedding!.buffer, row.objective_embedding!.byteOffset, row.objective_embedding!.byteLength / 8
            ));
            const score = this.embeddingService.cosineSimilarity(queryVector, vec);
            return { ...this.rowToCase(row), score };
        });
        scored.sort((a, b) => b.score - a.score);
        const top = scored.slice(0, topK);

        log.info(
            `[CASE-SHADOW-RECOVERY] type=problem objective="${objective.slice(0, 60)}"` +
            ` candidates=${top.length} scores=[${top.map(c => c.score.toFixed(3)).join(',')}]` +
            ` latencyMs=${Date.now() - t0}`
        );
        return top;
    }

    /**
     * S7.5 — Applicability Gate. Segunda etapa OPCIONAL sobre os candidatos já gerados por
     * findRelevantCasesShadow (não duplica a busca semântica, só anota). Responde uma pergunta
     * DIFERENTE da similaridade de problema: "a operação que o Caso resolveu é compatível com a
     * operação que o objetivo atual pede?" — sem isso, "criar PPTX" recupera "analisar PPTX"
     * com score 0.9645 e nada sinaliza que são operações opostas (ver docstring do módulo).
     * NÃO filtra, NÃO reordena, NÃO combina semanticScore+compatibilidade em score único — só
     * anota cada candidato com dois campos explícitos e separados (ver "NÃO COMBINAR SCORES
     * ARBITRARIAMENTE"). Ainda modo sombra: o único consumidor hoje é logging diagnóstico em
     * GoalExecutionLoop — zero influência em GoalPlanner/RiskAnalyzer/execução.
     */
    async findApplicableCasesShadow(objective: string, topK = 5): Promise<ApplicableCaseRecord[]> {
        const candidates = await this.findRelevantCasesShadow(objective, topK);
        const currentIntent = classifyOperation(objective);
        const applicable: ApplicableCaseRecord[] = candidates.map((c) => {
            const operationalIntent = classifyOperation(c.objective);
            return {
                ...c,
                operationalIntent,
                operationalCompatibility: operationalCompatibility(currentIntent, operationalIntent),
            };
        });

        const compatible = applicable.filter(c => c.operationalCompatibility === true).length;
        const incompatible = applicable.filter(c => c.operationalCompatibility === false).length;
        const unknown = applicable.filter(c => c.operationalCompatibility === 'unknown').length;
        log.info(
            `[CASE-APPLICABILITY-GATE] objective="${objective.slice(0, 60)}" currentIntent=${currentIntent}` +
            ` candidates=${applicable.length} compatible=${compatible} incompatible=${incompatible} unknown=${unknown}`
        );
        return applicable;
    }

    /**
     * Comparação de ESTRATÉGIA (segunda etapa, opcional) sobre um candidato já gerado por
     * similaridade de problema — não gera candidatos, só rotula um já existente. Reaproveita
     * o mesmo fingerprint, sem combinar em score único (ver "Não fazer": não combinar sinais
     * em score arbitrário nesta Sprint).
     */
    isSameStrategy(candidate: CaseRecord, plan: PlanStep[]): boolean {
        return candidate.planFingerprint === StrategyDiversityGuard.fingerprint(plan);
    }

    private rowToCase(row: CaseRow): CaseRecord {
        return {
            id: row.id,
            goalId: row.goal_id,
            objective: row.objective,
            planFingerprint: row.plan_fingerprint,
            toolsUsed: JSON.parse(row.tools_used || '[]'),
            hadRecovery: row.had_recovery === 1,
            blockerKinds: JSON.parse(row.blocker_kinds || '[]'),
            evidenceTier: row.evidence_tier as CaseEvidenceTier,
            evidenceSummary: row.evidence_summary,
            capturedAt: row.captured_at,
        };
    }

    /**
     * Observabilidade — contadores mínimos, reaproveitando o mesmo log estruturado do projeto.
     * S6.5c: enriquecido com cobertura de embedding — único dado que os eventos
     * [CASE-EMBED-STORED]/[CASE-EMBED-SKIPPED] (por evento, não agregados) ainda não permitiam
     * responder ("quantos Casos têm embedding AGORA?"). Nenhum subsistema de métricas novo —
     * é a mesma query de contagem, só com mais uma coluna.
     */
    getStats(): { total: number; byTier: Record<string, number>; withEmbedding: number; withoutEmbedding: number } {
        const total = (this.db.prepare('SELECT COUNT(*) as c FROM cases').get() as { c: number }).c;
        const byTierRows = this.db.prepare(
            'SELECT evidence_tier, COUNT(*) as c FROM cases GROUP BY evidence_tier'
        ).all() as Array<{ evidence_tier: string; c: number }>;
        const byTier: Record<string, number> = {};
        for (const r of byTierRows) byTier[r.evidence_tier] = r.c;
        const withEmbedding = (this.db.prepare('SELECT COUNT(*) as c FROM cases WHERE objective_embedding IS NOT NULL').get() as { c: number }).c;
        return { total, byTier, withEmbedding, withoutEmbedding: total - withEmbedding };
    }
}
