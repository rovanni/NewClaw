import PQueue from 'p-queue';

export const CONCURRENCY_CONFIG = {
    classification: parseInt(process.env.MAX_CONCURRENT_CLASSIFICATION || '5', 10),
    generation: parseInt(process.env.MAX_CONCURRENT_GENERATION || '2', 10),
    cloud_generation: parseInt(process.env.MAX_CONCURRENT_CLOUD || '10', 10)
};

export const taskQueue = new PQueue({
    concurrency: CONCURRENCY_CONFIG.classification + CONCURRENCY_CONFIG.cloud_generation
});

// p-queue: higher number = runs first. CLASSIFICATION must be highest so quick
// classify() calls are never blocked behind long generation tasks.
export enum TaskPriority {
    BACKGROUND = 0,
    INTERACTIVE = 1,
    CLASSIFICATION = 2
}
