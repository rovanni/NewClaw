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

import { createHash } from 'crypto';
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
    /** Args originais antes de qualquer mutação — preenchido quando recovered=true */
    originalArgs?: Record<string, unknown>;
    /** Tool original antes de fallback — preenchido quando finalToolName !== toolName original */
    originalToolName?: string;
    /** Categoria da mutação para logging estruturado */
    mutationKind?: 'arg_mutation' | 'fallback_tool';
}

type ArgMutator = (args: Record<string, unknown>) => Record<string, unknown> | null;

interface ToolRecoveryConfig {
    retryablePatterns: RegExp[];
    maxRetries: number;
    argMutators: ArgMutator[];
    fallbackTools: string[];
    adaptArgsForFallback?: (targetTool: string, originalArgs: Record<string, unknown>) => Record<string, unknown> | null;
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
                const url = String(orig.url || '');
                // Navigation path segments that carry no entity meaning — filtered out
                // so only the actual subject (e.g. "river", "bitcoin") reaches the query.
                const NAV_SEGMENTS = new Set([
                    'en','pt','es','fr','de','zh','ja','ko','ru',
                    'coins','coin','token','tokens','price','prices','currencies','currency',
                    'index','search','api','v1','v2','v3','www','crypto','cryptocurrency',
                    'markets','market','assets','asset','exchange','trade','trading',
                    'usd','eur','btc','eth','about','blog','docs','help','support',
                    'user','account','profile','home','page','news','overview',
                ]);
                try {
                    const u = new URL(url);
                    const siteName = u.hostname.replace(/^www\./, '').split('.')[0];
                    const segments = u.pathname
                        .split('/')
                        .map(s => s.replace(/[-_]/g, ' ').trim())
                        .filter(s => s.length >= 2 && !NAV_SEGMENTS.has(s.toLowerCase()));
                    // Last 3 meaningful segments + site name as context
                    const terms = [...new Set([...segments.slice(-3), siteName])].filter(Boolean);
                    if (terms.length > 0) return { query: terms.join(' ') };
                } catch { /* invalid URL — fall through */ }
                // Fallback: strip domain and clean path separators
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
    edit: {
        retryablePatterns: [],
        maxRetries: 0,
        argMutators: [
            // Se o LLM passou 'content' mas esqueceu de especificar 'append: true' ou outro modo
            (args) => {
                if (args.content && args.oldText === undefined && args.newText === undefined && args.startLine === undefined && args.endLine === undefined && args.append === undefined) {
                    return { ...args, append: true };
                }
                return null;
            }
        ],
        fallbackTools: ['write'],
        adaptArgsForFallback: (targetTool, orig) => {
            // Só faz fallback para write se content for uma string não-vazia.
            // Retorna null para impedir criação de arquivos zerados.
            if (targetTool === 'write' && orig.content && typeof orig.content === 'string' && orig.content.trim().length > 0) {
                return { path: orig.path, content: orig.content };
            }
            return null;
        }
    }
};

// ── Dedup key helper ────────────────────────────────────────────────────────────
// Avoids storing giant serializations in the usedInputs Set when args contain
// large values (e.g. file contents). Short args keep the readable form; large
// args are hashed to a compact fingerprint.
function makeKey(toolName: string, args: Record<string, unknown>): string {
    const json = JSON.stringify(args);
    if (json.length <= 256) return `${toolName}:${json}`;
    const hash = createHash('sha1').update(json).digest('hex').slice(0, 16);
    return `${toolName}:h:${hash}`;
}

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
        signal?: AbortSignal,
        /** Contexto do goal — permite evitar fallbacks já tentados e enriquecer queries */
        goalContext?: { toolsTried: string[]; userIntent: string },
    ): Promise<RecoveryResult> {

        // ── Step 1: try with original args (+ retry on transient errors) ────────
        const step1 = await this.tryWithRetry(toolName, args, getTool, usedInputs, signal);
        if (step1.result.success) return { ...step1, recovered: false };

        const config = RECOVERY[toolName];

        // ── Step 1b: goal-aware query enrichment (web_search / crypto_analysis) ──
        // Quando a query genérica falha, tenta enriquecer com entidades do objetivo.
        if (goalContext?.userIntent) {
            const enriched = this.enrichWithGoalEntities(toolName, args, goalContext.userIntent);
            if (enriched) {
                const enrichKey = makeKey(toolName, enriched);
                if (!usedInputs.has(enrichKey)) {
                    log.info(`[RECOVERY] Goal-aware enrichment for "${toolName}": ${JSON.stringify(enriched)}`);
                    const enrichResult = await this.tryWithRetry(toolName, enriched, getTool, usedInputs, signal);
                    if (enrichResult.result.success) {
                        log.info(`[RECOVERY] "${toolName}" succeeded after goal-aware enrichment`);
                        return {
                            result: enrichResult.result,
                            finalToolName: toolName,
                            finalArgs: enriched,
                            recovered: true,
                            recoveryNote: `Recuperado: query enriquecida com entidades do objetivo`,
                            originalArgs: args,
                            originalToolName: toolName,
                            mutationKind: 'arg_mutation',
                        };
                    }
                }
            }
        }

        // ── Step 2: try arg mutations ────────────────────────────────────────────
        if (config?.argMutators?.length) {
            for (const mutator of config.argMutators) {
                const mutatedArgs = mutator(step1.finalArgs);
                if (!mutatedArgs) continue;

                const mutKey = makeKey(toolName, mutatedArgs);
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
                        originalArgs: args,
                        originalToolName: toolName,
                        mutationKind: 'arg_mutation',
                    };
                }
            }
        }

        // ── Step 3: try fallback tools ───────────────────────────────────────────
        if (config?.fallbackTools?.length) {
            for (const fallbackName of config.fallbackTools) {
                const fallbackTool = getTool(fallbackName);
                if (!fallbackTool) continue;

                // P3: skip fallbacks já tentados ao nível do goal — evita repetição inútil
                if (goalContext?.toolsTried.includes(fallbackName)) {
                    log.info(`[RECOVERY] "${fallbackName}" já tentado no nível do goal — pulando fallback`);
                    continue;
                }

                const adaptedArgs = config.adaptArgsForFallback
                    ? config.adaptArgsForFallback(fallbackName, step1.finalArgs)
                    : step1.finalArgs;

                // null = adaptArgsForFallback sinalizou que este fallback não é adequado
                if (adaptedArgs === null) {
                    log.info(`[RECOVERY] "${toolName}" — fallback "${fallbackName}" ignorado (adaptArgsForFallback retornou null)`);
                    continue;
                }

                const fallKey = makeKey(fallbackName, adaptedArgs);
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
                            originalArgs: args,
                            originalToolName: toolName,
                            mutationKind: 'fallback_tool',
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

    /**
     * Extrai entidades-chave do objetivo do usuário para enriquecer queries que falharam.
     * Aplica apenas para web_search (enriquece a query existente).
     */
    private enrichWithGoalEntities(
        toolName: string,
        args: Record<string, unknown>,
        userIntent: string,
    ): Record<string, unknown> | null {
        if (toolName !== 'web_search' || !args.query) return null;

        const STOPWORDS = new Set([
            'para', 'com', 'sem', 'uma', 'uns', 'ela', 'ele', 'que', 'não', 'por', 'mas',
            'como', 'sobre', 'estar', 'ficar', 'além', 'algumas', 'pedir', 'busque',
            'você', 'memória', 'olho', 'monitorar', 'algumas', 'gostaria', 'poderia',
            'favor', 'preciso', 'quero', 'queria', 'isso', 'esse', 'esta', 'este',
        ]);

        const entities = userIntent
            .toLowerCase()
            .replace(/[^a-z0-9áéíóúãõâêôçàü\s]/g, ' ')
            .split(/\s+/)
            .filter(t => t.length > 2 && !STOPWORDS.has(t))
            .slice(0, 6);

        if (entities.length === 0) return null;

        const currentQuery = String(args.query).toLowerCase();
        const newEntities = entities.filter(e => !currentQuery.includes(e));
        if (newEntities.length === 0) return null;

        // A query original falhou — substituir completamente por entidades do userIntent
        // (em vez de concatenar) evita queries mistas português+inglês que retornam 0 resultados
        const enrichedQuery = newEntities.join(' ').slice(0, 200);
        return { ...args, query: enrichedQuery };
    }

    // ── Retry with exponential backoff for transient errors ─────────────────────

    private async tryWithRetry(
        toolName: string,
        args: Record<string, unknown>,
        getTool: (name: string) => ToolExecutorLike | undefined,
        usedInputs: Set<string>,
        signal?: AbortSignal,
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

        const inputKey = makeKey(toolName, args);
        usedInputs.add(inputKey);

        let lastResult: ToolResult = { success: false, output: '', error: 'Não executado' };

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            if (signal?.aborted) break;
            if (attempt > 0) {
                const delay = Math.min(400 * Math.pow(2, attempt - 1), 2000);
                log.info(`[RECOVERY] Retry ${attempt}/${maxRetries} for "${toolName}" after ${delay}ms`);
                await sleep(delay, signal).catch(() => {});
                if (signal?.aborted) break;
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

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
    });
}
