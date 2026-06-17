/**
 * PromptRegistry — Carrega prompts de arquivos YAML versionáveis
 * 
 * Substitui os blocos hardcoded em AgentLoop.PROMPT_COMPONENTS.
 * Prompts são carregados do diretório prompts/ na inicialização
 * e podem ser recarregados em runtime (hot-reload).
 * 
 * Uso:
 *   const registry = new PromptRegistry('./prompts');
 *   const identity = registry.get('identity', 'identity');
 *   const masterPrompt = registry.buildMasterPrompt('execution');
 */

import fs from 'fs';
import path from 'path';
import { createLogger } from '../shared/AppLogger';

const log = createLogger('PromptRegistry');

// ── YAML Parser (minimal, zero deps) ────────────────────────────
// We don't need full YAML — our files use simple key: | block scalars

interface PromptMap {
    [category: string]: {
        [key: string]: string;
    };
}

export interface PromptCategoryConfig {
    /** Which domain blocks to include for each category */
    domains: string[];
}

const CATEGORY_CONFIG: Record<string, PromptCategoryConfig> = {
    light: { domains: [] },
    chat: { domains: ['response_arch', 'audio'] },
    code: { domains: ['response_arch', 'file_ops', 'academic'] },
    creation: { domains: ['response_arch', 'file_ops', 'academic', 'audio'] },
    analysis: { domains: ['response_arch', 'analysis', 'file_ops', 'audio', 'vision'] },
    execution: { domains: ['response_arch', 'file_ops', 'academic', 'audio', 'infra', 'analysis', 'vision'] },
};

export class PromptRegistry {
    private promptsDir: string;
    private cache: PromptMap = {};
    private fileTimestamps: Map<string, number> = new Map();
    private loaded: boolean = false;

    constructor(promptsDir?: string) {
        this.promptsDir = promptsDir || path.join(process.cwd(), 'prompts');
    }

    /**
     * Load all prompt files from disk.
     * Called automatically on first get() if not loaded yet.
     */
    load(): void {
        this.cache = {};
        this.fileTimestamps.clear();

        if (!fs.existsSync(this.promptsDir)) {
            log.warn(`Prompts directory not found: ${this.promptsDir} — using empty registry`);
            this.loaded = true;
            return;
        }

        const files = fs.readdirSync(this.promptsDir).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));

        for (const file of files) {
            const filePath = path.join(this.promptsDir, file);
            const category = path.basename(file, path.extname(file));

            try {
                const content = fs.readFileSync(filePath, 'utf-8');
                const stat = fs.statSync(filePath);
                this.fileTimestamps.set(filePath, stat.mtimeMs);

                // Parse simple YAML key: | block scalar format
                const parsed = this.parseSimpleYaml(content);
                this.cache[category] = parsed;

                const keyCount = Object.keys(parsed).length;
                log.info(`Loaded ${keyCount} prompt(s) from ${file}`);
            } catch (err) {
                log.error(`Failed to load ${file}:`, (err as Error).message);
            }
        }

        this.loaded = true;
        log.info(`PromptRegistry loaded: ${Object.keys(this.cache).length} categories, ${this.totalPromptCount()} total prompts`);
    }

    /**
     * Get a prompt by category and key.
     * Returns empty string if not found.
     */
    get(category: string, key: string): string {
        if (!this.loaded) this.load();
        return this.cache[category]?.[key] || '';
    }

    /**
     * Get all prompts in a category.
     */
    getCategory(category: string): Record<string, string> {
        if (!this.loaded) this.load();
        return this.cache[category] || {};
    }

    /**
     * Build the master prompt for a given task category.
     * Mirrors AgentLoop.buildMasterPrompt logic but from YAML files.
     */
    buildMasterPrompt(taskCategory: string): string {
        if (!this.loaded) this.load();

        const identity = this.get('identity', 'identity');
        if (!identity) {
            log.warn('No identity prompt loaded — falling back to hardcoded');
            return '';
        }

        let prompt = identity + '\n\n';

        const config = CATEGORY_CONFIG[taskCategory] || CATEGORY_CONFIG['chat'];
        for (const domain of config.domains) {
            // Find the domain prompt in any category file
            const domainPrompt = this.findDomainPrompt(domain);
            if (domainPrompt) {
                prompt += domainPrompt + '\n\n';
            }
        }

        // Always append JSON format at the end
        const jsonFormat = this.get('format', 'json_format');
        if (jsonFormat) {
            prompt += jsonFormat;
        }

        return prompt;
    }

    /**
     * Find a domain prompt by key name across all category files.
     */
    private findDomainPrompt(key: string): string | null {
        for (const category of Object.keys(this.cache)) {
            if (this.cache[category][key]) {
                return this.cache[category][key];
            }
        }
        return null;
    }

    /**
     * Hot-reload: check file timestamps and reload if changed.
     */
    reloadIfChanged(): boolean {
        if (!this.loaded) {
            this.load();
            return true;
        }

        let changed = false;

        if (!fs.existsSync(this.promptsDir)) return false;

        const files = fs.readdirSync(this.promptsDir).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));

        for (const file of files) {
            const filePath = path.join(this.promptsDir, file);
            try {
                const stat = fs.statSync(filePath);
                const lastKnown = this.fileTimestamps.get(filePath) || 0;
                if (stat.mtimeMs > lastKnown) {
                    changed = true;
                    break;
                }
            } catch { /* skip */ }
        }

        if (changed) {
            log.info('Detected prompt file changes — reloading...');
            this.loaded = false;
            this.load();
            return true;
        }

        return false;
    }

    /**
     * Force reload all prompts.
     */
    reload(): void {
        this.loaded = false;
        this.load();
    }

    /**
     * Get stats for observability.
     */
    getStats(): { categories: number; prompts: number; files: number } {
        return {
            categories: Object.keys(this.cache).length,
            prompts: this.totalPromptCount(),
            files: this.fileTimestamps.size,
        };
    }

    private totalPromptCount(): number {
        return Object.values(this.cache).reduce((sum, cat) => sum + Object.keys(cat).length, 0);
    }

    /**
     * Minimal YAML parser for key: | block scalar format.
     * Handles:
     *   key: |
     *     multiline content
     *     more content
     *   other_key: |
     *     ...
     */
    private parseSimpleYaml(content: string): Record<string, string> {
        const result: Record<string, string> = {};
        const lines = content.split('\n');
        let currentKey: string | null = null;
        let currentValue: string[] = [];
        let inBlock = false;
        let blockIndent = 0;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            // Check for "key: |" pattern
            const keyMatch = line.match(/^(\w[\w_]*):\s*\|\s*$/);
            if (keyMatch) {
                // Save previous block
                if (currentKey !== null) {
                    result[currentKey] = this.dedentBlock(currentValue, blockIndent);
                }
                currentKey = keyMatch[1];
                currentValue = [];
                inBlock = true;
                blockIndent = 0;
                continue;
            }

            if (inBlock && currentKey !== null) {
                // Empty line preserves in block
                if (line.trim() === '') {
                    currentValue.push('');
                    continue;
                }

                // Determine block indent from first non-empty line
                const indent = line.search(/\S/);
                if (blockIndent === 0 && indent > 0) {
                    blockIndent = indent;
                }

                // If line is at or deeper than block indent, it's part of the block
                if (indent >= blockIndent || line.startsWith(' '.repeat(blockIndent))) {
                    currentValue.push(line);
                } else {
                    // End of block — save and start over
                    result[currentKey] = this.dedentBlock(currentValue, blockIndent);
                    currentKey = null;
                    currentValue = [];
                    inBlock = false;

                    // Re-process this line (might be a new key)
                    i--;
                }
            }
        }

        // Save last block
        if (currentKey !== null) {
            result[currentKey] = this.dedentBlock(currentValue, blockIndent);
        }

        return result;
    }

    /**
     * Remove common leading indent from block scalar lines.
     */
    private dedentBlock(lines: string[], blockIndent: number): string {
        if (lines.length === 0) return '';
        return lines
            .map(line => line.substring(blockIndent))
            .join('\n')
            .trim();
    }
}

// ── Singleton ────────────────────────────────────────────────────
export const promptRegistry = new PromptRegistry();
export default promptRegistry;