import PQueue from 'p-queue';

export const CONCURRENCY_CONFIG = {
    classification: parseInt(process.env.MAX_CONCURRENT_CLASSIFICATION || '5', 10),
    generation: parseInt(process.env.MAX_CONCURRENT_GENERATION || '2', 10),
    cloud_generation: parseInt(process.env.MAX_CONCURRENT_CLOUD || '10', 10)
};

// p-queue: higher number = runs first. CLASSIFICATION must be highest so quick
// classify() calls are never blocked behind long generation tasks.
export enum TaskPriority {
    BACKGROUND = 0,
    INTERACTIVE = 1,
    CLASSIFICATION = 2
}

/** Fila mista: classificação + chamadas cloud de geração. */
export const taskQueue = new PQueue({
    concurrency: CONCURRENCY_CONFIG.classification + CONCURRENCY_CONFIG.cloud_generation
});

/**
 * Fila dedicada para geração LLM do AgentLoop.
 * Concurrency configurável via MAX_CONCURRENT_GENERATION (default: 2).
 * Substitui o llmQueue hardcoded concurrency=1 — permite múltiplos usuários simultâneos.
 */
export const generationQueue = new PQueue({
    concurrency: CONCURRENCY_CONFIG.generation
});
