/**
 * GoalTypes — Tipos centrais do Goal-Centered Cognitive Runtime.
 *
 * Um Goal representa um objetivo persistente do usuário que pode sobreviver
 * múltiplos ciclos de execução, falhas de tool e replanning, até ser concluído
 * ou atingir os limites de safety.
 *
 * Filosofia: falha de tool não encerra o goal — vira um GoalBlocker que dispara
 * replanning. O goal só morre quando: completado, TTL expirado, budget esgotado
 * ou abandonado explicitamente pelo usuário.
 *
 * O modelo de domínio central (Goal, PlanStep, GoalAttempt, GoalBlocker,
 * SuccessCriterion e os tipos que eles compõem) vive fisicamente em
 * `shared/domainTypes.ts` — é consumido tanto por `loop/` (orquestração) quanto
 * por `memory/` (aprendizado), então não pertence exclusivamente a nenhuma das
 * duas camadas (ARCH-004). Reexportado aqui para que todo o resto de `loop/`
 * continue importando de `./GoalTypes` sem nenhuma mudança. Os tipos abaixo
 * desta reexportação (CycleResult, GoalResult, StepEvaluation, GoalProgressModel
 * etc.) são específicos da execução em `loop/` e continuam definidos aqui.
 */

import type {
    GoalStatus,
    BlockerKind,
    GoalBlocker,
    CriterionCheck,
    SuccessCriterion,
    PlanStep,
    ToolMutation,
    AttemptOutcome,
    GoalAttempt,
    Goal,
} from '../shared/domainTypes';

export type {
    GoalStatus,
    BlockerKind,
    GoalBlocker,
    CriterionCheck,
    SuccessCriterion,
    PlanStep,
    ToolMutation,
    AttemptOutcome,
    GoalAttempt,
    Goal,
};

// ── Resultados ────────────────────────────────────────────────────────────────

export type CycleOutcome = 'success' | 'partial' | 'blocked' | 'failed' | 'needs_auth' | 'needs_dependency';

export interface DependencyInfo {
    /** Nome do pacote/ferramenta (ex: "pandoc", "ffmpeg") */
    name: string;
    /**
     * Comando de instalação legado (histórico: sempre apt/Linux, ex: "sudo apt install pandoc -y").
     * Opcional para permitir entradas cross-platform que só usam installByPlatform.
     * NUNCA executado fora de Linux automaticamente — ver resolveInstallCommand()
     * (src/loop/planning/resolveInstallCommand.ts): sem entrada explícita em installByPlatform
     * para a plataforma atual, não-Linux sempre resolve para undefined, nunca cai neste campo.
     */
    installCmd?: string;
    /**
     * Comando de instalação por plataforma — chaves espelham OSCapabilities.platform
     * (CapabilityRegistry.ts), não process.platform. Tem precedência sobre installCmd legado.
     */
    installByPlatform?: {
        windows?: string;
        linux?: string;
        macos?: string;
    };
    /** Instrução legível para o usuário instalar manualmente */
    manualInstructions: string;
    type: 'system' | 'python' | 'node';
}

export interface CycleResult {
    outcome: CycleOutcome;
    confidence: number;
    output?: string;
    blocker?: GoalBlocker;
    authTxnId?: string;
    /** Inline keyboard options when outcome=needs_auth (preserves Telegram buttons) */
    authOptions?: { label: string; value: string }[];
    /** Populated when outcome=needs_dependency — informações da dependência ausente */
    depInfo?: DependencyInfo;
    /** FIX C: send_document diferidos capturados do AgentLoop para execução pós-validação */
    deferredSends?: Array<Record<string, unknown>>;
}

export interface GoalResult {
    goal: Goal;
    success: boolean;
    finalOutput: string;
    totalCycles: number;
    totalAttempts: number;
    totalReplans: number;
    /** Preserved from CycleResult when goal was blocked by auth */
    authOptions?: { label: string; value: string }[];
}

export interface GoalProgressUpdate {
    goalId: string;
    cycle: number;
    event:
        | 'cycle_start'
        | 'tool_executing'
        | 'tool_completed'
        | 'tool_failed'
        | 'replanning'
        | 'blocked'
        | 'completed'
        | 'failed';
    message?: string;
}

// ── Classificação de goal ─────────────────────────────────────────────────────

export interface GoalClassification {
    isGoal: boolean;
    confidence: number;
    objective?: string;
    requiredTools?: string[];
    estimatedSteps?: number;
    reason?: string;
    /** true quando o objetivo é identificado como goal mas a intenção é ambígua — pedir clarificação */
    isAmbiguous?: boolean;
    /** Pergunta de clarificação sugerida quando isAmbiguous=true */
    clarificationQuestion?: string;
    isConstruction?: boolean;
    /** true quando o objetivo foi explicitamente solicitado; false quando inferido dos dados sem pedido explícito */
    hasExplicitEvidence?: boolean;
    /** true quando o GoalExtractor LLM estourou o timeout ou retornou conteúdo não-JSON (thinking) */
    timedOut?: boolean;
    /** true quando o fast path determinístico foi usado — LLM não foi chamado */
    usedFastPath?: boolean;
}

// ── Avaliação de step (heurística + escalation) ───────────────────────────────

/**
 * Resultado da avaliação determinística de um step.
 * confidence < 0.6 dispara escalation para LLM (casos ambíguos).
 */
export interface StepEvaluation {
    success: boolean;
    /** 0.0 – 1.0 — determinado pela heurística; < 0.6 = ambíguo */
    confidence: number;
    reason?: string;
    /** Quando true, o caller deve chamar o LLM para desempate */
    shouldEscalateToLLM?: boolean;
}

// ── Contexto cognitivo persistente entre steps ────────────────────────────────

/**
 * Acumula descobertas entre steps de um mesmo goal.
 * Permite que cada AgentLoop comece com conhecimento do que já foi feito,
 * eliminando releituras redundantes e rediscoverys desnecessários.
 */
export interface StepCognitiveContext {
    /** Arquivos lidos por steps anteriores (caminho + hash no momento da leitura) */
    filesRead: Array<{ path: string; summary?: string; hash?: string }>;
    /** Arquivos criados ou modificados */
    filesModified: string[];
    /** Artefatos gerados (relatórios, imagens, documentos) com caminho no workspace */
    generatedArtifacts: string[];
    /** Descobertas relevantes (ex: "a pasta /workspace/src tem 3 arquivos .ts") */
    discoveries: string[];
    /** Estratégias que falharam — evita repetição */
    failedStrategies: string[];
    /** Outputs importantes dos steps anteriores (max 200 chars cada) */
    importantOutputs: string[];
    /** Comandos executados com sucesso */
    executedCommands: string[];
}

export function createEmptyStepCognitiveContext(): StepCognitiveContext {
    return {
        filesRead: [],
        filesModified: [],
        generatedArtifacts: [],
        discoveries: [],
        failedStrategies: [],
        importantOutputs: [],
        executedCommands: [],
    };
}

// ── Progresso dimensional do goal ─────────────────────────────────────────────

/**
 * Representa o progresso de um componente individual do goal
 * (ex: "cotação do ZEC", "relatório gerado", "envio ao usuário").
 *
 * Populado pelo StepSemanticValidator conforme steps são concluídos
 * e pela GoalExecutionLoop com base em attempts bem-sucedidos.
 */
export interface ProgressComponent {
    id: string;
    label: string;
    status: 'pending' | 'in_progress' | 'completed' | 'failed';
    /** Trecho de evidência que comprova o status (ex: output truncado) */
    evidence?: string;
    completedAt?: number;
}

/**
 * Modelo de progresso multidimensional de um goal.
 * Substitui a avaliação binária (sucesso/falha) por uma visão por componente,
 * permitindo que o GoalPlanner e GracefulDeliveryOrchestrator saibam
 * exatamente o que foi e o que não foi entregue.
 */
export interface GoalProgressModel {
    goalId: string;
    components: ProgressComponent[];
    /** 0–100: percentual calculado pelo ratio de componentes completed/total */
    overallPercent: number;
    updatedAt: number;
}

// ── Capabilities do ambiente ──────────────────────────────────────────────────

export interface EnvironmentCapabilities {
    tools: Record<string, boolean>;
    pythonPkgs: Record<string, boolean>;
    probeTimestamp: number;
    /** Bloco de texto pronto para injeção em prompts de planejamento. */
    summary: string;
}
