/**
 * ProactiveRecovery — Camada automática de recuperação de falhas de ferramentas.
 *
 * Antes de expor uma falha ao LLM (que então decide o próximo passo),
 * este módulo tenta automaticamente:
 *   1. Retry com backoff exponencial para erros transitórios (rede, timeout)
 *   2. Mutação de argumentos para contornar erros semânticos (ex: "Cidade, Estado" → "Cidade")
 *   3. Fallback para uma ferramenta alternativa da cadeia declarada
 *
 * Só retorna `recovered: false` depois que todas as estratégias se esgotaram.
 */

import { ToolResult } from './AgentLoop';
import { createLogger } from '../shared/AppLogger';

const log = createLogger('ProactiveRecovery');

export interface ToolExecutorLike {
    execute(args: Record<string, unknown>): Promise<ToolResult>;
}

export interface RecoveryResult {
    result: ToolResult;
    finalToolName: string;
    finalArgs: Record<string, unknown>;
    recovered: boolean;
    recoveryNote?: string;
}

type ArgMutator = (args: Record<string, unknown>) => Record<string, unknown> | null;

interface ToolRecoveryConfig {
    retryablePatterns: RegExp[];
    maxRetries: number;
    argMutators: ArgMutator[];
    fallbackTools: string[];
    adaptArgsForFallback?: (targetTool: string, originalArgs: Record<string, unknown>) => Record<string, unknown>;
}

// ── Per-tool recovery configuration ────────────────────────────────────────────

const RECOVERY: Record<string, ToolRecoveryConfig> = {

    weather: {
        retryablePatterns: [/ECONNRESET/i, /ETIMEDOUT/i, /timeout/i, /fetch/i, /network/i],
        maxRetries: 1,
        argMutators: [
            // "Bandeirantes, PR" or "Bandeirantes, Paraná" → "Bandeirantes"
            (args) => {
                const city = args.city as string | undefined;
                if (!city) return null;
                if (/,/.test(city)) {
                    const stripped = city.split(',')[0].trim();
                    if (stripped && stripped !== city) return { ...args, city: stripped };
                }
                return null;
            },
            // Try without accent normalization (some geocoders are strict)
            (args) => {
                const city = args.city as string | undefined;
                if (!city) return null;
                const normalized = city.normalize('NFD').replace(/[̀-ͯ]/g, '');
                if (normalized !== city) return { ...args, city: normalized };
                return null;
            },
        ],
        fallbackTools: [],
    },

    web_search: {
        retryablePatterns: [/ECONNRESET/i, /ETIMEDOUT/i, /timeout/i, /rate.?limit/i, /429/],
        maxRetries: 1,
        argMutators: [
            // Remove year and location qualifiers to broaden query
            (args) => {
                const q = args.query as string | undefined;
                if (!q) return null;
                const simplified = q
                    .replace(/\b\d{1,2}\s+de\s+\w+\s+de\s+\d{4}\b/gi, '')
                    .replace(/\b\d{4}\b/g, '')
                    .replace(/,\s*[A-Z]{2}\b/g, '')
                    .replace(/\s+/g, ' ')
                    .trim();
                if (simplified && simplified !== q && simplified.length >= 5) {
                    return { ...args, query: simplified };
                }
                return null;
            },
        ],
        fallbackTools: [],
    },

    web_navigate: {
        retryablePatterns: [/ECONNRESET/i, /ETIMEDOUT/i, /timeout/i],
        maxRetries: 1,
        argMutators: [],
        fallbackTools: ['web_search'],
        adaptArgsForFallback: (targetTool, orig) => {
            if (targetTool === 'web_search') {
                // Extract meaningful query from URL
                const url = String(orig.url || '');
                const urlPath = url.replace(/^https?:\/\/[^/]+/, '').replace(/[-_/]/g, ' ').trim();
                return { query: urlPath || url };
            }
            return orig;
        },
    },

    memory_recall: {
        retryablePatterns: [],
        maxRetries: 0,
        argMutators: [
            // If lookup by id fails, convert id to natural-language query
            (args) => {
                if (args.id && !args.query) {
                    const naturalQuery = String(args.id).replace(/[_-]/g, ' ');
                    return { query: naturalQuery };
                }
                return null;
            },
        ],
        fallbackTools: [],
    },
};

// ── ProactiveRecovery class ─────────────────────────────────────────────────────

export class ProactiveRecovery {
    /**
     * Execute a tool with automatic recovery strategies.
     *
     * The caller should use `result.finalToolName` and `result.finalArgs`
     * for logging/tracing, since they may differ from the original call.
     * If `recovered === false`, the caller should inject [FALHA] into the loop.
     * If `recovered === true`, the failure was handled transparently and the
     * caller should treat the result as a success.
     */
    async execute(
        toolName: string,
        args: Record<string, unknown>,
        getTool: (name: string) => ToolExecutorLike | undefined,
        usedInputs: Set<string>,
    ): Promise<RecoveryResult> {

        // ── Step 1: try with original args (+ retry on transient errors) ────────
        const step1 = await this.tryWithRetry(toolName, args, getTool, usedInputs);
        if (step1.result.success) return { ...step1, recovered: false };

        const config = RECOVERY[toolName];

        // ── Step 2: try arg mutations ────────────────────────────────────────────
        if (config?.argMutators?.length) {
            for (const mutator of config.argMutators) {
                const mutatedArgs = mutator(step1.finalArgs);
                if (!mutatedArgs) continue;

                const mutKey = `${toolName}:${JSON.stringify(mutatedArgs)}`;
                if (usedInputs.has(mutKey)) continue;

                log.info(`[RECOVERY] Trying arg mutation for "${toolName}": ${JSON.stringify(mutatedArgs)}`);
                const mutResult = await this.tryWithRetry(toolName, mutatedArgs, getTool, usedInputs);
                if (mutResult.result.success) {
                    log.info(`[RECOVERY] "${toolName}" succeeded after arg mutation`);
                    return {
                        result: mutResult.result,
                        finalToolName: toolName,
                        finalArgs: mutatedArgs,
                        recovered: true,
                        recoveryNote: `Recuperado: argumentos adaptados automaticamente (${JSON.stringify(mutatedArgs)} em vez de ${JSON.stringify(args)})`,
                    };
                }
            }
        }

        // ── Step 3: try fallback tools ───────────────────────────────────────────
        if (config?.fallbackTools?.length) {
            for (const fallbackName of config.fallbackTools) {
                const fallbackTool = getTool(fallbackName);
                if (!fallbackTool) continue;

                const adaptedArgs = config.adaptArgsForFallback
                    ? config.adaptArgsForFallback(fallbackName, step1.finalArgs)
                    : step1.finalArgs;

                const fallKey = `${fallbackName}:${JSON.stringify(adaptedArgs)}`;
                if (usedInputs.has(fallKey)) continue;

                log.info(`[RECOVERY] "${toolName}" failed — trying fallback "${fallbackName}"`);
                try {
                    usedInputs.add(fallKey);
                    const fallResult = await fallbackTool.execute(adaptedArgs);
                    if (fallResult.success) {
                        log.info(`[RECOVERY] Fallback "${fallbackName}" succeeded`);
                        return {
                            result: fallResult,
                            finalToolName: fallbackName,
                            finalArgs: adaptedArgs,
                            recovered: true,
                            recoveryNote: `Recuperado: "${toolName}" falhou, "${fallbackName}" usado como alternativa automática`,
                        };
                    }
                } catch (err) {
                    log.warn(`[RECOVERY] Fallback "${fallbackName}" threw: ${err}`);
                }
            }
        }

        // ── All strategies exhausted ─────────────────────────────────────────────
        return { ...step1, recovered: false };
    }

    // ── Retry with exponential backoff for transient errors ─────────────────────

    private async tryWithRetry(
        toolName: string,
        args: Record<string, unknown>,
        getTool: (name: string) => ToolExecutorLike | undefined,
        usedInputs: Set<string>,
    ): Promise<Omit<RecoveryResult, 'recovered'>> {
        const tool = getTool(toolName);
        if (!tool) {
            return {
                result: { success: false, output: '', error: `Ferramenta "${toolName}" não encontrada` },
                finalToolName: toolName,
                finalArgs: args,
            };
        }

        const config = RECOVERY[toolName];
        const maxRetries = config?.maxRetries ?? 0;
        const retryablePatterns = config?.retryablePatterns ?? [];

        const inputKey = `${toolName}:${JSON.stringify(args)}`;
        usedInputs.add(inputKey);

        let lastResult: ToolResult = { success: false, output: '', error: 'Não executado' };

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            if (attempt > 0) {
                const delay = Math.min(400 * Math.pow(2, attempt - 1), 2000);
                log.info(`[RECOVERY] Retry ${attempt}/${maxRetries} for "${toolName}" after ${delay}ms`);
                await sleep(delay);
            }

            try {
                lastResult = await tool.execute(args);
                if (lastResult.success) break;

                // Only retry if error looks transient
                const errorStr = lastResult.error ?? lastResult.output ?? '';
                const isRetryable = retryablePatterns.some(p => p.test(errorStr));
                if (!isRetryable) break;
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                lastResult = { success: false, output: '', error: msg };
                const isRetryable = retryablePatterns.some(p => p.test(msg));
                if (!isRetryable) break;
            }
        }

        return { result: lastResult, finalToolName: toolName, finalArgs: args };
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
}
