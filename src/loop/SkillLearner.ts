/**
 * SkillLearner - Auto-skill creation from experience
 * Inspired by Hermes Agent's self-improving learning loop
 *
 * Stage 2: generate skill proposals from repeated successful patterns,
 * but only approved skills become active in runtime.
 */

import Database from 'better-sqlite3';
import { createLogger } from '../shared/AppLogger';
const log = createLogger('Skilllearner');

export interface Skill {
    id: string;
    name: string;
    trigger: string;
    description: string;
    prompt: string;
    tool_sequence: string;
    priority: number;
    hits: number;
    status: 'proposed' | 'active' | 'rejected';
    source_pattern?: string | null;
    source_tool?: string | null;
    reviewed_at?: string | null;
    created_at: string;
    updated_at: string;
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

    constructor(db: Database.Database) {
        this.db = db;
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
            { column: 'status', sql: `ALTER TABLE auto_skills ADD COLUMN status TEXT DEFAULT 'proposed'` },
            { column: 'source_pattern', sql: `ALTER TABLE auto_skills ADD COLUMN source_pattern TEXT` },
            { column: 'source_tool', sql: `ALTER TABLE auto_skills ADD COLUMN source_tool TEXT` },
            { column: 'reviewed_at', sql: `ALTER TABLE auto_skills ADD COLUMN reviewed_at TEXT` }
        ];

        for (const migration of migrations) {
            if (!columns.has(migration.column)) {
                this.db.exec(migration.sql);
            }
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
            ).get(pattern, toolName) as any;

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

            this.tryCreateSkillProposal();
        } catch (error: any) {
            log.error(`Error recording pattern: ${error.message}`);
        }
    }

    /**
     * Check if any active auto-skill matches the user input
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
                CASE status WHEN 'active' THEN 0 WHEN 'proposed' THEN 1 ELSE 2 END,
                priority DESC,
                hits DESC,
                updated_at DESC`
        ).all() as Skill[];
    }

    getPatternStats(): any[] {
        return this.db.prepare(
            'SELECT pattern, tool_name, success_count, fail_count, avg_latency_ms FROM skill_patterns WHERE success_count >= 2 ORDER BY success_count DESC'
        ).all();
    }

    approveSkill(id: string): boolean {
        const result = this.db.prepare(
            `UPDATE auto_skills
             SET status = 'active', reviewed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
             WHERE id = ? AND status != 'active'`
        ).run(id);

        return result.changes > 0;
    }

    rejectSkill(id: string): boolean {
        const result = this.db.prepare(
            `UPDATE auto_skills
             SET status = 'rejected', reviewed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
             WHERE id = ? AND status != 'rejected'`
        ).run(id);

        return result.changes > 0;
    }

    private extractPattern(input: string): string | null {
        const lower = input.toLowerCase().trim();

        if (/(pre[cÃ§]o|cota[cÃ§][aÃ£]o|valor|quanto (custa|vale))/.test(lower)) return 'crypto_price';
        if (/(bitcoin|btc|ethereum|eth|solana|sol|cardano|ada|xrp|dogecoin|doge|river)/.test(lower)) return 'crypto_query';
        if (/(clima|tempo|temperatura|previs[aÃ£]o|chovendo)/.test(lower)) return 'weather';
        if (/(Ã¡udio|audio|voz|tts|falar|narre)/.test(lower) && /(gerar|criar|enviar|manda|mande|fale)/.test(lower)) return 'audio_request';
        if (/(lembre|lembrete|guarde|salve|memorize|anote)/.test(lower)) return 'memory_write';
        if (/(lembra|o que voc[eÃª] sabe|buscar na mem)/.test(lower)) return 'memory_search';
        if (/(arquivo|html|css|site|p[aÃ¡]gina)/.test(lower)) return 'file_ops';

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
        return Math.max(0, successRate * sampleWeight + successRate * (1 - sampleWeight) - latencyPenalty);
    }

    private getTopSkillMatches(userInput: string, maxMatches: number = 2): SkillMatch[] {
        const lower = userInput.toLowerCase().trim();

        try {
            const skills = this.db.prepare(
                `SELECT * FROM auto_skills
                 WHERE status = 'active'
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

    /**
     * Create skill proposals from strong patterns with manual approval.
     */
    private tryCreateSkillProposal(): void {
        const patterns = this.db.prepare(
            `SELECT pattern, tool_name, success_count, fail_count, avg_latency_ms
             FROM skill_patterns
             WHERE success_count >= 3
               AND (success_count * 1.0 / (success_count + fail_count)) >= 0.8
               AND (success_count + fail_count) >= 3
             ORDER BY success_count DESC, fail_count ASC, avg_latency_ms ASC`
        ).all() as any[];

        for (const item of patterns) {
            const alreadyExists = this.db.prepare(
                'SELECT id FROM auto_skills WHERE source_pattern = ? AND source_tool = ? LIMIT 1'
            ).get(item.pattern, item.tool_name) as { id: string } | undefined;

            if (alreadyExists) continue;

            const skill = this.createSkillFromPattern(item.pattern, item.tool_name, item.success_count);
            if (!skill) continue;

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

    private createSkillFromPattern(pattern: string, toolName: string, successCount: number): Skill | null {
        const skillDefs: Record<string, { name: string; trigger: string; description: string; prompt: string; toolSeq: string[] }> = {
            crypto_price: {
                name: 'PreÃ§o de Cripto',
                trigger: '(pre[cÃ§]o|cota[cÃ§][aÃ£]o|valor|quanto).*(bitcoin|btc|ethereum|eth|solana|sol|river|doge|ada|xrp)',
                description: 'Busca preÃ§o de criptomoedas via web_search com instruÃ§Ã£o focada.',
                prompt: 'Sempre que perguntarem sobre preÃ§o de criptomoedas, use web_search com {"query": "preÃ§o NOMEMOEDA"}. Formate o resultado com preÃ§o em USD, variaÃ§Ã£o 24h e market cap.',
                toolSeq: ['web_search']
            },
            crypto_query: {
                name: 'Consulta Cripto',
                trigger: '(bitcoin|btc|ethereum|eth|solana|sol|river|doge|ada|xrp)',
                description: 'Consulta geral sobre criptomoedas com formato consistente.',
                prompt: 'Use web_search para buscar dados de criptomoedas. Sempre inclua preÃ§o, variaÃ§Ã£o 24h e volume.',
                toolSeq: ['web_search']
            },
            weather: {
                name: 'PrevisÃ£o do Tempo',
                trigger: '(clima|tempo|temperatura|previs[aÃ£]o|chovendo)',
                description: 'Busca previsÃ£o do tempo com cidade padrÃ£o quando a mensagem nÃ£o especifica local.',
                prompt: 'Use web_search com {"query": "SÃ£o Paulo Brasil weather"} para clima. Se o usuÃ¡rio citar outra cidade, use essa cidade.',
                toolSeq: ['web_search']
            },
            audio_request: {
                name: 'Pedido de Ãudio',
                trigger: '(gerar|criar|enviar|manda|mande|fale).*(Ã¡udio|audio|voz|tts)',
                description: 'Gera Ã¡udio TTS com conteÃºdo relevante em vez de repetir o pedido do usuÃ¡rio.',
                prompt: 'Quando pedirem Ã¡udio, NUNCA repita o pedido. Gere o CONTEÃšDO REAL para TTS. Use send_audio com {"text": "conteÃºdo gerado pelo assistente"}. Para Ã¡udio com dados, busque dados primeiro.',
                toolSeq: ['send_audio']
            },
            memory_write: {
                name: 'Salvar MemÃ³ria',
                trigger: '(lembre|lembrete|guarde|salve|memorize|anote)',
                description: 'Salva informaÃ§Ãµes na memÃ³ria persistente com formato mais consistente.',
                prompt: 'Use memory_write com {"action":"create","id":"fact_TIMESTAMP","type":"fact","name":"resumo","content":"texto completo"} para salvar.',
                toolSeq: ['memory_write']
            },
            memory_search: {
                name: 'Buscar MemÃ³ria',
                trigger: '(lembra|o que voc[eÃª] sabe|buscar na mem)',
                description: 'Busca informaÃ§Ãµes na memÃ³ria semÃ¢ntica.',
                prompt: 'Use memory_search com {"query": "termo de busca"} para encontrar informaÃ§Ãµes salvas.',
                toolSeq: ['memory_search']
            },
            file_ops: {
                name: 'OperaÃ§Ãµes de Arquivo',
                trigger: '(arquivo|html|css|site|p[aÃ¡]gina)',
                description: 'Lista, cria ou verifica arquivos em caminhos de trabalho comuns.',
                prompt: 'Use file_ops para operaÃ§Ãµes de arquivo. Liste diretÃ³rios com {"action":"list","path":"./workspace/sites/"}.',
                toolSeq: ['file_ops']
            }
        };

        const def = skillDefs[pattern];
        if (!def) return null;

        return {
            id: `skill_${pattern}_${Date.now()}`,
            name: def.name,
            trigger: def.trigger,
            description: def.description,
            prompt: def.prompt,
            tool_sequence: JSON.stringify(def.toolSeq),
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
    /**
     * Observe a meta-event or state change in the system.
     */
    observe(event: string, metadata?: any): void {
        log.info(`Observed event: ${event}`, metadata || '');
        this.db.prepare(
            'INSERT INTO skill_patterns (pattern, tool_name, success_count, fail_count, avg_latency_ms, last_seen) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP) ON CONFLICT(pattern, tool_name) DO UPDATE SET last_seen = CURRENT_TIMESTAMP, success_count = success_count + 1'
        ).run(`event:${event}`, 'system', 1, 0, 0);
    }
}
