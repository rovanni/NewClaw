/**
 * SkillLearner - Auto-skill creation from experience
 * Inspired by Hermes Agent's self-improving learning loop
 *
 * Stage 2: generate skill proposals from repeated successful patterns,
 * but only approved skills become active in runtime.
 *
 * Lifecycle (holistic):
 *   recordPattern() → tryCreateSkillProposal() → status='proposed'
 *   approveSkill()  → exports SKILL.md to skillsDir → status='active', file_exported=1
 *   rejectSkill()   → removes SKILL.md if present → status='rejected', file_exported=0
 *   deactivateSkill() → removes SKILL.md → status='inactive', file_exported=0
 *   activateSkill() → re-exports SKILL.md → status='active', file_exported=1
 *   deleteSkill()   → removes SKILL.md + DB row
 *
 * Exported skills are picked up by SkillLoader (hot-reload) and become available
 * to SkillDiscovery's semantic matching. Skills with file_exported=1 are excluded
 * from SkillLearner's own DB-based matching to avoid double-injection.
 */

import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { createLogger } from '../shared/AppLogger';
import { errorMessage } from '../shared/errors';
const log = createLogger('Skilllearner');

/** Row da tabela skill_patterns */
interface PatternRow {
    pattern: string;
    tool_name: string;
    success_count: number;
    fail_count: number;
    avg_latency_ms: number;
    last_seen?: string;
}

/** Formato de retorno do getPatternStats() */
export interface PatternStatRow {
    pattern: string;
    tool_name: string;
    success_count: number;
    fail_count: number;
    avg_latency_ms: number;
}


export interface Skill {
    id: string;
    name: string;
    trigger: string;
    description: string;
    prompt: string;
    tool_sequence: string;
    priority: number;
    hits: number;
    status: 'proposed' | 'active' | 'rejected' | 'inactive';
    source_pattern?: string | null;
    source_tool?: string | null;
    reviewed_at?: string | null;
    created_at: string;
    updated_at: string;
    /** 1 when SKILL.md was exported to skillsDir — skill is handled by SkillLoader, not DB matching */
    file_exported?: number;
}

export interface SkillMatch {
    skill: Skill;
    confidence: number;
    preferredTools: string[];
}

export interface SkillContextResult {
    text: string;
    confidence: number;
    preferredTools: string[];
    matches: SkillMatch[];
}

interface ToolPatternStat {
    pattern: string;
    tool_name: string;
    success_count: number;
    fail_count: number;
    avg_latency_ms: number;
}

export class SkillLearner {
    private db: Database.Database;
    private skillsDir: string;
    private patternRecordCount = 0;

    constructor(db: Database.Database, skillsDir: string = './skills') {
        this.db = db;
        this.skillsDir = skillsDir;
        this.ensureTable();
    }

    private ensureTable(): void {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS auto_skills (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                trigger TEXT NOT NULL,
                description TEXT NOT NULL,
                prompt TEXT NOT NULL,
                tool_sequence TEXT DEFAULT '[]',
                priority INTEGER DEFAULT 5,
                hits INTEGER DEFAULT 0,
                status TEXT DEFAULT 'proposed',
                source_pattern TEXT,
                source_tool TEXT,
                reviewed_at TEXT,
                created_at TEXT DEFAULT (datetime('now')),
                updated_at TEXT DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS skill_patterns (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                pattern TEXT NOT NULL,
                tool_name TEXT NOT NULL,
                success_count INTEGER DEFAULT 1,
                fail_count INTEGER DEFAULT 0,
                avg_latency_ms INTEGER DEFAULT 0,
                last_seen TEXT DEFAULT (datetime('now')),
                created_at TEXT DEFAULT (datetime('now')),
                UNIQUE(pattern, tool_name)
            );
        `);

        const columns = new Set(
            (this.db.prepare(`PRAGMA table_info(auto_skills)`).all() as Array<{ name: string }>).map(col => col.name)
        );

        const migrations: Array<{ column: string; sql: string }> = [
            { column: 'status',        sql: `ALTER TABLE auto_skills ADD COLUMN status TEXT DEFAULT 'proposed'` },
            { column: 'source_pattern', sql: `ALTER TABLE auto_skills ADD COLUMN source_pattern TEXT` },
            { column: 'source_tool',   sql: `ALTER TABLE auto_skills ADD COLUMN source_tool TEXT` },
            { column: 'reviewed_at',   sql: `ALTER TABLE auto_skills ADD COLUMN reviewed_at TEXT` },
            { column: 'file_exported', sql: `ALTER TABLE auto_skills ADD COLUMN file_exported INTEGER DEFAULT 0` }
        ];

        for (const migration of migrations) {
            if (!columns.has(migration.column)) {
                this.db.exec(migration.sql);
            }
        }

        this.cleanupCorruptedSkills();
    }

    private cleanupCorruptedSkills(): void {
        const corrupted = this.db.prepare(
            `DELETE FROM auto_skills WHERE name LIKE '%Ã%' OR name LIKE '%Â%'`
        ).run();
        if (corrupted.changes > 0) {
            log.info(`Removed ${corrupted.changes} skills with corrupted encoding`);
        }

        const dupes = this.db.prepare(`
            DELETE FROM auto_skills
            WHERE rowid NOT IN (
                SELECT MAX(rowid) FROM auto_skills
                GROUP BY name, status
            )
            AND status = 'proposed'
        `).run();
        if (dupes.changes > 0) {
            log.info(`Removed ${dupes.changes} duplicate proposed skills`);
        }
    }

    /**
     * Record a tool usage pattern - called after every tool execution
     */
    recordPattern(userInput: string, toolName: string, success: boolean, latencyMs: number): void {
        const pattern = this.extractPattern(userInput);
        if (!pattern) return;

        try {
            const existing = this.db.prepare(
                'SELECT * FROM skill_patterns WHERE pattern = ? AND tool_name = ?'
            ).get(pattern, toolName) as PatternRow | undefined;

            if (existing) {
                const newSuccess = existing.success_count + (success ? 1 : 0);
                const newFail = existing.fail_count + (success ? 0 : 1);
                const baselineCount = Math.max(1, Number(existing.success_count) + Number(existing.fail_count));
                const newTotal = baselineCount + 1;
                const previousAvg = Number(existing.avg_latency_ms) || 0;
                const newAvgLatency = Math.round(((previousAvg * baselineCount) + latencyMs) / newTotal);

                this.db.prepare(
                    'UPDATE skill_patterns SET success_count = ?, fail_count = ?, avg_latency_ms = ?, last_seen = CURRENT_TIMESTAMP WHERE pattern = ? AND tool_name = ?'
                ).run(newSuccess, newFail, newAvgLatency, pattern, toolName);
            } else {
                this.db.prepare(
                    'INSERT INTO skill_patterns (pattern, tool_name, success_count, fail_count, avg_latency_ms) VALUES (?, ?, ?, ?, ?)'
                ).run(pattern, toolName, success ? 1 : 0, success ? 0 : 1, latencyMs);
            }

            this.patternRecordCount++;
            if (this.patternRecordCount % 10 === 0) {
                this.tryCreateSkillProposal();
            }
        } catch (error) {
            log.error(`Error recording pattern: ${errorMessage(error)}`);
        }
    }

    /**
     * Check if any active auto-skill matches the user input.
     * Only DB-only skills (file_exported = 0) are checked here;
     * exported skills are handled by SkillLoader + SkillDiscovery.
     */
    matchSkill(userInput: string): Skill | null {
        const [topMatch] = this.getTopSkillMatches(userInput, 1);
        if (!topMatch) return null;

        this.bumpSkillHit(topMatch.skill.id);
        return topMatch.skill;
    }

    /**
     * Get skill context to inject into the system prompt
     */
    getSkillContext(userInput: string): string {
        return this.buildSkillContext(userInput)?.text || '';
    }

    buildSkillContext(userInput: string, maxMatches: number = 2): SkillContextResult | null {
        const matches = this.getTopSkillMatches(userInput, maxMatches);
        if (matches.length === 0) return null;

        this.bumpSkillHit(matches[0].skill.id);

        const preferredTools = Array.from(
            new Set(matches.flatMap(match => match.preferredTools))
        ).slice(0, 2);

        const sections = matches.map((match, index) => {
            const label = index === 0 ? 'Skill Principal' : `Skill Complementar ${index}`;
            const toolsLine = match.preferredTools.length > 0
                ? `Ferramentas sugeridas: ${match.preferredTools.join(', ')}.`
                : '';
            return [
                `## ${label}: ${match.skill.name}`,
                `Confianca: ${match.confidence.toFixed(2)}`,
                match.skill.prompt,
                toolsLine
            ].filter(Boolean).join('\n');
        });

        return {
            text: sections.join('\n\n'),
            confidence: matches[0].confidence,
            preferredTools,
            matches
        };
    }

    getRecommendedTools(userInput: string): string[] {
        const stats = this.getPatternToolStats(userInput);
        return stats
            .filter(stat => this.computeConfidence(stat) >= 0.6)
            .slice(0, 3)
            .map(stat => stat.tool_name);
    }

    getToolHints(userInput: string): string {
        const stats = this.getPatternToolStats(userInput);
        if (stats.length === 0) return '';

        const preferred = stats
            .filter(stat => this.computeConfidence(stat) >= 0.6)
            .slice(0, 2);
        const discouraged = stats
            .filter(stat => this.computeConfidence(stat) < 0.45 && (stat.success_count + stat.fail_count) >= 3)
            .slice(0, 2);

        const lines: string[] = [];
        if (preferred.length > 0) {
            lines.push('Ferramentas com bom historico para este padrao:');
            preferred.forEach(stat => {
                const successRate = Math.round(this.computeSuccessRate(stat) * 100);
                lines.push(`- ${stat.tool_name}: ${successRate}% de sucesso, latencia media ${stat.avg_latency_ms}ms`);
            });
        }
        if (discouraged.length > 0) {
            lines.push('Ferramentas menos confiaveis para este padrao:');
            discouraged.forEach(stat => {
                const successRate = Math.round(this.computeSuccessRate(stat) * 100);
                lines.push(`- ${stat.tool_name}: ${successRate}% de sucesso`);
            });
        }
        lines.push('Use essas informacoes como prioridade suave; o agente ainda pode escolher outra ferramenta se o contexto pedir.');

        return lines.join('\n');
    }

    getAllSkills(): Skill[] {
        return this.db.prepare(
            `SELECT * FROM auto_skills
             ORDER BY
                CASE status WHEN 'active' THEN 0 WHEN 'proposed' THEN 1 WHEN 'inactive' THEN 2 ELSE 3 END,
                priority DESC,
                hits DESC,
                updated_at DESC`
        ).all() as Skill[];
    }

    getPatternStats(): PatternStatRow[] {
        return this.db.prepare(
            'SELECT pattern, tool_name, success_count, fail_count, avg_latency_ms FROM skill_patterns WHERE success_count >= 2 ORDER BY success_count DESC'
        ).all() as PatternStatRow[];
    }

    // ── Lifecycle operations ──────────────────────────────────────────────────

    /**
     * Approve a proposed skill: writes SKILL.md to skillsDir so SkillLoader picks it up.
     * After export, skill is excluded from DB-based matching (file_exported=1) to avoid
     * double-injection alongside SkillLoader's output.
     */
    approveSkill(id: string): boolean {
        const skill = this.db.prepare(
            `SELECT * FROM auto_skills WHERE id = ? AND status = 'proposed'`
        ).get(id) as Skill | undefined;
        if (!skill) return false;

        this.exportSkillFile({ ...skill, status: 'active' });

        const result = this.db.prepare(
            `UPDATE auto_skills
             SET status = 'active', file_exported = 1,
                 reviewed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`
        ).run(id);

        return result.changes > 0;
    }

    /**
     * Reject a skill (any status): removes SKILL.md if present.
     */
    rejectSkill(id: string): boolean {
        const skill = this.db.prepare(
            `SELECT * FROM auto_skills WHERE id = ?`
        ).get(id) as Skill | undefined;
        if (!skill) return false;

        this.removeSkillFile(skill);

        const result = this.db.prepare(
            `UPDATE auto_skills
             SET status = 'rejected', file_exported = 0,
                 reviewed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`
        ).run(id);

        return result.changes > 0;
    }

    /**
     * Re-activate a rejected or inactive skill: re-exports SKILL.md.
     */
    activateSkill(id: string): boolean {
        const skill = this.db.prepare(
            `SELECT * FROM auto_skills WHERE id = ? AND status IN ('rejected', 'inactive')`
        ).get(id) as Skill | undefined;
        if (!skill) return false;

        this.exportSkillFile({ ...skill, status: 'active' });

        const result = this.db.prepare(
            `UPDATE auto_skills
             SET status = 'active', file_exported = 1,
                 reviewed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`
        ).run(id);

        return result.changes > 0;
    }

    /**
     * Deactivate an active skill: removes SKILL.md so SkillLoader stops serving it.
     */
    deactivateSkill(id: string): boolean {
        const skill = this.db.prepare(
            `SELECT * FROM auto_skills WHERE id = ? AND status = 'active'`
        ).get(id) as Skill | undefined;
        if (!skill) return false;

        this.removeSkillFile(skill);

        const result = this.db.prepare(
            `UPDATE auto_skills
             SET status = 'inactive', file_exported = 0,
                 reviewed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`
        ).run(id);

        return result.changes > 0;
    }

    /**
     * Permanently delete a skill: removes SKILL.md and DB row.
     */
    deleteSkill(id: string): boolean {
        const skill = this.db.prepare(
            `SELECT * FROM auto_skills WHERE id = ?`
        ).get(id) as Skill | undefined;
        if (!skill) return false;

        this.removeSkillFile(skill);

        const result = this.db.prepare('DELETE FROM auto_skills WHERE id = ?').run(id);
        return result.changes > 0;
    }

    // ── Pattern extraction ────────────────────────────────────────────────────

    private extractPattern(input: string): string | null {
        const lower = input.toLowerCase().trim();

        if (/(pre[cç]o|cota[cç][aã]o|valor|quanto (custa|vale))/.test(lower)) return 'crypto_price';
        if (/(bitcoin|btc|ethereum|eth|solana|sol|cardano|ada|xrp|dogecoin|doge|river)/.test(lower)) return 'crypto_query';
        if (/(clima|tempo|temperatura|previs[aã]o|chovendo)/.test(lower)) return 'weather';
        if (/(áudio|audio|voz|tts|falar|narre)/.test(lower) && /(gerar|criar|enviar|manda|mande|fale)/.test(lower)) return 'audio_request';
        if (/(lembre|lembrete|guarde|salve|memorize|anote)/.test(lower)) return 'memory_write';
        if (/(lembra|o que voc[eê] sabe|buscar na mem)/.test(lower)) return 'memory_search';
        if (/(arquivo|html|css|site|p[aá]gina)/.test(lower)) return 'write';

        return null;
    }

    private getPatternToolStats(userInput: string): ToolPatternStat[] {
        const pattern = this.extractPattern(userInput);
        if (!pattern) return [];

        return this.db.prepare(
            `SELECT pattern, tool_name, success_count, fail_count, avg_latency_ms
             FROM skill_patterns
             WHERE pattern = ?
             ORDER BY
                (success_count * 1.0 / (success_count + fail_count + 0.0001)) DESC,
                success_count DESC,
                avg_latency_ms ASC`
        ).all(pattern) as ToolPatternStat[];
    }

    private computeSuccessRate(stat: ToolPatternStat): number {
        const total = stat.success_count + stat.fail_count;
        if (total <= 0) return 0;
        return stat.success_count / total;
    }

    private computeConfidence(stat: ToolPatternStat): number {
        const total = stat.success_count + stat.fail_count;
        if (total <= 0) return 0;
        const successRate = this.computeSuccessRate(stat);
        const sampleWeight = Math.min(1, total / 5);
        const latencyPenalty = stat.avg_latency_ms > 0 ? Math.min(0.15, stat.avg_latency_ms / 10000) : 0;
        return Math.max(0, successRate * sampleWeight - latencyPenalty);
    }

    /**
     * Returns only DB-resident active skills (file_exported = 0).
     * Skills with file_exported = 1 are served by SkillLoader and must not be double-injected.
     */
    private getTopSkillMatches(userInput: string, maxMatches: number = 2): SkillMatch[] {
        const lower = userInput.toLowerCase().trim();

        try {
            const skills = this.db.prepare(
                `SELECT * FROM auto_skills
                 WHERE status = 'active' AND (file_exported = 0 OR file_exported IS NULL)
                 ORDER BY priority DESC, hits DESC`
            ).all() as Skill[];

            return skills
                .map(skill => this.scoreSkillMatch(skill, lower))
                .filter((match): match is SkillMatch => match !== null)
                .sort((a, b) => {
                    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
                    if (b.skill.priority !== a.skill.priority) return b.skill.priority - a.skill.priority;
                    return b.skill.hits - a.skill.hits;
                })
                .slice(0, Math.max(1, maxMatches));
        } catch {
            return [];
        }
    }

    private scoreSkillMatch(skill: Skill, lowerInput: string): SkillMatch | null {
        try {
            const regex = new RegExp(skill.trigger, 'i');
            if (!regex.test(lowerInput)) return null;
        } catch {
            return null;
        }

        const priorityScore = Math.min(0.2, Math.max(0, skill.priority) / 10 * 0.2);
        const usageScore = Math.min(0.1, Math.log10(skill.hits + 1) * 0.08);
        const preferredTools = this.parseToolSequence(skill.tool_sequence);
        const toolScore = preferredTools.length > 0 ? 0.05 : 0;
        const confidence = Math.min(0.98, 0.65 + priorityScore + usageScore + toolScore);

        return {
            skill,
            confidence,
            preferredTools
        };
    }

    private parseToolSequence(toolSequence: string): string[] {
        try {
            const parsed = JSON.parse(toolSequence);
            if (!Array.isArray(parsed)) return [];
            return parsed.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
        } catch {
            return [];
        }
    }

    private bumpSkillHit(skillId: string): void {
        try {
            this.db.prepare(
                'UPDATE auto_skills SET hits = hits + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
            ).run(skillId);
        } catch {
            // noop
        }
    }

    // ── Skill proposals ───────────────────────────────────────────────────────

    /**
     * Create skill proposals from strong patterns with manual approval.
     * Disable by setting SKILL_LEARNER_PROPOSALS=false in .env
     */
    private tryCreateSkillProposal(): void {
        if (process.env.SKILL_LEARNER_PROPOSALS === 'false') return;
        const patterns = this.db.prepare(
            `SELECT pattern, tool_name, success_count, fail_count, avg_latency_ms
             FROM skill_patterns
             WHERE success_count >= 3
               AND (success_count * 1.0 / (success_count + fail_count)) >= 0.8
               AND (success_count + fail_count) >= 3
             ORDER BY success_count DESC, fail_count ASC, avg_latency_ms ASC`
        ).all() as PatternRow[];

        for (const item of patterns) {
            const alreadyExists = this.db.prepare(
                'SELECT id FROM auto_skills WHERE source_pattern = ? AND source_tool = ? LIMIT 1'
            ).get(item.pattern, item.tool_name) as { id: string } | undefined;

            if (alreadyExists) continue;

            const skill = this.createSkillFromPattern(item.pattern, item.tool_name, item.success_count);

            const nameExists = this.db.prepare(
                "SELECT id FROM auto_skills WHERE name = ? LIMIT 1"
            ).get(skill.name) as { id: string } | undefined;

            if (nameExists) continue;

            this.db.prepare(
                `INSERT INTO auto_skills
                 (id, name, trigger, description, prompt, tool_sequence, priority, hits, status, source_pattern, source_tool, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            ).run(
                skill.id,
                skill.name,
                skill.trigger,
                skill.description,
                skill.prompt,
                skill.tool_sequence,
                skill.priority,
                skill.hits,
                skill.status,
                skill.source_pattern,
                skill.source_tool,
                skill.created_at,
                skill.updated_at
            );

            log.info(`Proposal created: ${skill.name} (${item.pattern} -> ${item.tool_name})`);
        }
    }

    /**
     * Build a Skill record from an observed pattern.
     * Known patterns get curated definitions; unknown patterns get a generic template
     * so learning is never blocked by the absence of a pre-defined entry.
     */
    private createSkillFromPattern(pattern: string, toolName: string, successCount: number): Skill {
        const skillDefs: Record<string, { name: string; trigger: string; description: string; prompt: string; toolSeq: string[] }> = {
            crypto_price: {
                name: 'Preço de Cripto',
                trigger: '(pre[cç]o|cota[cç][aã]o|valor|quanto).*(bitcoin|btc|ethereum|eth|solana|sol|river|doge|ada|xrp)',
                description: 'Busca preço de criptomoedas via web_search com instrução focada.',
                prompt: 'Sempre que perguntarem sobre preço de criptomoedas, use web_search com {"query": "preço NOMEMOEDA"}. Formate o resultado com preço em USD, variação 24h e market cap.',
                toolSeq: ['web_search']
            },
            crypto_query: {
                name: 'Consulta Cripto',
                trigger: '(bitcoin|btc|ethereum|eth|solana|sol|river|doge|ada|xrp)',
                description: 'Consulta geral sobre criptomoedas com formato consistente.',
                prompt: 'Use web_search para buscar dados de criptomoedas. Sempre inclua preço, variação 24h e volume.',
                toolSeq: ['web_search']
            },
            weather: {
                name: 'Previsão do Tempo',
                trigger: '(clima|tempo|temperatura|previs[aã]o|chovendo)',
                description: 'Busca previsão do tempo com cidade padrão quando a mensagem não especifica local.',
                prompt: 'Use web_search com {"query": "São Paulo Brasil weather"} para clima. Se o usuário citar outra cidade, use essa cidade.',
                toolSeq: ['web_search']
            },
            audio_request: {
                name: 'Pedido de Áudio',
                trigger: '(gerar|criar|enviar|manda|mande|fale).*(áudio|audio|voz|tts)',
                description: 'Gera áudio TTS com conteúdo relevante em vez de repetir o pedido do usuário.',
                prompt: 'Quando pedirem áudio, NUNCA repita o pedido. Gere o CONTEÚDO REAL para TTS. Use send_audio com {"text": "conteúdo gerado pelo assistente"}. Para áudio com dados, busque dados primeiro.',
                toolSeq: ['send_audio']
            },
            memory_write: {
                name: 'Salvar Memória',
                trigger: '(lembre|lembrete|guarde|salve|memorize|anote)',
                description: 'Salva informações na memória persistente com formato mais consistente.',
                prompt: 'Use memory_write com {"action":"create","id":"fact_TIMESTAMP","type":"fact","name":"resumo","content":"texto completo"} para salvar.',
                toolSeq: ['memory_write']
            },
            memory_search: {
                name: 'Buscar Memória',
                trigger: '(lembra|o que voc[eê] sabe|buscar na mem)',
                description: 'Busca informações na memória semântica.',
                prompt: 'Use memory_search com {"query": "termo de busca"} para encontrar informações salvas.',
                toolSeq: ['memory_search']
            },
            write: {
                name: 'Operações de Arquivo',
                trigger: '(arquivo|html|css|site|p[aá]gina)',
                description: 'Cria ou sobrescreve arquivos no workspace.',
                prompt: 'Use write com {"path": "caminho/arquivo.html", "content": "conteudo"} para criar arquivos.',
                toolSeq: ['write']
            }
        };

        const def = skillDefs[pattern];

        // Generic template for patterns not yet in skillDefs — learning is never blocked
        const name = def?.name ?? pattern.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        const trigger = def?.trigger ?? pattern.replace(/_/g, '|');
        const description = def?.description ??
            `Padrão aprendido automaticamente: ${successCount} usos bem-sucedidos com ${toolName}.`;
        const prompt = def?.prompt ??
            `Quando detectar este padrão, use ${toolName} para processar a solicitação. ` +
            `Analise a mensagem do usuário para extrair os parâmetros necessários.`;
        const toolSeq = def?.toolSeq ?? [toolName];

        return {
            id: `skill_${pattern}_${Date.now()}`,
            name,
            trigger,
            description,
            prompt,
            tool_sequence: JSON.stringify(toolSeq),
            priority: Math.min(10, 5 + Math.floor(successCount / 3)),
            hits: 0,
            status: 'proposed',
            source_pattern: pattern,
            source_tool: toolName,
            reviewed_at: null,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        };
    }

    // ── SKILL.md export / remove ──────────────────────────────────────────────

    /**
     * Writes a SKILL.md for the given skill so SkillLoader and SkillDiscovery can use it.
     * Directory is created if absent. Errors are logged but do not throw.
     */
    private exportSkillFile(skill: Skill): void {
        try {
            const folderName = this.sanitizeSkillFolderName(skill);
            const skillDir = path.resolve(this.skillsDir, folderName);
            fs.mkdirSync(skillDir, { recursive: true });
            fs.writeFileSync(path.join(skillDir, 'SKILL.md'), this.buildSkillMd(skill), 'utf-8');
            log.info(`Exported SKILL.md: "${skill.name}" → ${skillDir}`);
        } catch (error) {
            log.error(`Failed to export SKILL.md for "${skill.name}": ${errorMessage(error)}`);
        }
    }

    /**
     * Removes the SKILL.md directory for the given skill.
     * Silently skips if the directory does not exist.
     */
    private removeSkillFile(skill: Skill): void {
        try {
            const folderName = this.sanitizeSkillFolderName(skill);
            const skillDir = path.resolve(this.skillsDir, folderName);
            if (fs.existsSync(skillDir)) {
                fs.rmSync(skillDir, { recursive: true, force: true });
                log.info(`Removed SKILL.md: "${skill.name}" ← ${skillDir}`);
            }
        } catch (error) {
            log.error(`Failed to remove SKILL.md for "${skill.name}": ${errorMessage(error)}`);
        }
    }

    /**
     * Generates the SKILL.md content for a skill.
     * Includes triggers (extracted from regex) and tags (derived from source_pattern and tool)
     * so SkillDiscovery's semantic matching can work on auto-skills without extra configuration.
     */
    private buildSkillMd(skill: Skill): string {
        const keywords = this.extractTriggerKeywords(skill.trigger);
        const tools = this.parseToolSequence(skill.tool_sequence);
        const tags = this.deriveTagsFromSkill(skill);

        const lines: string[] = ['---', `name: ${skill.name}`, `description: ${skill.description}`];
        if (keywords.length > 0) lines.push(`triggers: ${keywords.join(',')}`);
        if (tools.length > 0) lines.push(`tools: ${tools.join(',')}`);
        if (tags.length > 0) {
            lines.push('tags:');
            tags.forEach(t => lines.push(`  - ${t}`));
        }
        lines.push('---', '', skill.prompt);
        return lines.join('\n');
    }

    /**
     * Extracts plain-text keywords from a regex trigger string.
     * Used to populate the `triggers:` field in SKILL.md for SkillLoader's simple includes-match.
     */
    private extractTriggerKeywords(trigger: string): string[] {
        return trigger
            .replace(/\[[^\]]*\]/g, ' ')          // remove char classes [...]
            .replace(/[().*+?^${}|\\[\]]/g, ' ')  // remove regex metacharacters
            .split(/\s+/)
            .map(s => s.trim())
            .filter(s => s.length >= 3 && !/^\d+$/.test(s))
            .slice(0, 10);
    }

    /**
     * Derives semantic tags for a skill based on its source metadata.
     * These tags enable SkillDiscovery's capability-based matching for auto-skills.
     */
    private deriveTagsFromSkill(skill: Skill): string[] {
        const tags: string[] = [];
        if (skill.source_pattern) tags.push(skill.source_pattern.replace(/_/g, '-'));
        if (skill.source_tool) tags.push(skill.source_tool.replace(/_/g, '-'));
        const nameWords = skill.name
            .toLowerCase()
            .normalize('NFD')
            .replace(/[̀-ͯ]/g, '')
            .split(/\s+/)
            .filter(w => w.length >= 4);
        tags.push(...nameWords.slice(0, 3));
        return [...new Set(tags)];
    }

    /**
     * Sanitizes a skill name into a safe filesystem folder name.
     * Uses source_pattern (already ASCII) when available; falls back to skill name.
     */
    private sanitizeSkillFolderName(skill: Skill): string {
        const base = skill.source_pattern ?? skill.name;
        return base
            .toLowerCase()
            .normalize('NFD')
            .replace(/[̀-ͯ]/g, '')
            .replace(/[^a-z0-9]+/g, '_')
            .replace(/^_|_$/g, '');
    }

    // ── System observation ────────────────────────────────────────────────────

    /**
     * Observe a meta-event or state change in the system.
     */
    observe(event: string, metadata?: Record<string, unknown>): void {
        log.info(`Observed event: ${event}${metadata ? ` ${JSON.stringify(metadata)}` : ''}`);
        this.db.prepare(
            'INSERT INTO skill_patterns (pattern, tool_name, success_count, fail_count, avg_latency_ms, last_seen) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP) ON CONFLICT(pattern, tool_name) DO UPDATE SET last_seen = CURRENT_TIMESTAMP, success_count = success_count + 1'
        ).run(`event:${event}`, 'system', 1, 0, 0);
    }
}
