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
 *
 * Classificação do padrão (`recordPattern`'s `topicSlug`): NÃO é decidida aqui. Até 26/08/2026,
 * um `extractPattern()` interno classificava o texto do usuário via regex num de 7 padrões fixos —
 * uma decisão semântica tratada como validação estrutural (proibido por
 * docs/ARCHITECTURE/RESPONSABILIDADE_ANTES_DO_MECANISMO.md), e um vocabulário fechado que parava
 * de propor qualquer coisa nova assim que as 7 categorias já tivessem virado skill (achado real:
 * 34 combinações elegíveis, zero propostas em 7 semanas). `UnifiedIntentRouter` já roda um LLM por
 * turno para outro propósito — agora também emite `topicSlug` como subproduto dessa MESMA chamada
 * (zero LLM novo), e `recordPattern()` só valida a FORMA do valor recebido (nunca reinterpreta o
 * texto original).
 */

import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { createLogger } from '../shared/AppLogger';
import { errorMessage } from '../shared/errors';
import { KNOWN_SKILL_TOPICS, VALID_SKILL_TOPIC_SLUG } from '../shared/domainTypes';
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

export class SkillLearner {
    /**
     * Definições curadas para padrões conhecidos. Nome/gatilho/descrição/prompt/tool_sequence
     * dependem SÓ do pattern — a tool que disparou o registro (`item.tool_name` em
     * tryCreateSkillProposal) nunca entra no conteúdo para estes 7 padrões (ver createSkillFromPattern).
     * Precisa ser estático e compartilhado (não recriado a cada chamada) porque
     * tryCreateSkillProposal usa as CHAVES deste objeto para decidir a identidade de dedup.
     *
     * Tipo derivado de `KNOWN_SKILL_TOPICS` (shared/domainTypes.ts) — mesma lista que
     * `UnifiedIntentRouter` oferece ao LLM como slugs preferenciais. Uma única fonte: o
     * compilador acusa se as chaves aqui divergirem da lista compartilhada.
     */
    private static readonly SKILL_DEFS: Record<typeof KNOWN_SKILL_TOPICS[number], { name: string; trigger: string; description: string; prompt: string; toolSeq: string[] }> = {
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
        // NÃO nomear cidade aqui. Um template embarcado no código vale para TODA instalação
        // do NewClaw, no mundo inteiro — uma cidade escrita neste prompt vira o palpite
        // padrão de quem mora em qualquer outro lugar.
        //
        // Evidência real (03/08/2026, 05:02): à pergunta "Vai chover hoje, qual a temperatura
        // para hoje?", o log mostra o caminho rápido acertando —
        // `[FAST-PATH] No city in intent or memory — falling back to cognition loop` — e logo
        // depois a ferramenta sendo chamada com a cidade escrita neste prompt. A tool exige
        // `city` e recusa sem ela; quem inventou a cidade foi o modelo, seguindo este texto.
        // O usuário mora em outro estado e recebeu o clima de uma cidade distante como fato.
        //
        // É a diretriz "Nunca Adivinhar" aplicada onde ela mais importa: diante de um dado
        // não observado, perguntar — nunca inferir um valor plausível e apresentá-lo como
        // verdade. E `weather`, não `web_search`: a própria descrição da ferramenta diz
        // "Sempre use esta ferramenta para clima — NÃO use web_search para isso".
        weather: {
            name: 'Previsão do Tempo',
            trigger: '(clima|tempo|temperatura|previs[aã]o|chovendo)',
            description: 'Consulta o tempo pela ferramenta dedicada, usando a cidade que o usuário informou.',
            prompt: 'Use a ferramenta weather com a cidade que o usuário informou nesta mensagem, '
                + 'ou com a que já for conhecida da conversa/memória. '
                + 'Se nenhuma cidade for conhecida, PERGUNTE ao usuário de qual cidade ele quer a '
                + 'previsão — nunca escolha uma cidade por conta própria.',
            toolSeq: ['weather']
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

    /** Type guard único para "este pattern está em SKILL_DEFS?" — usado tanto pela checagem de
     *  dedup em tryCreateSkillProposal() quanto pelo lookup em createSkillFromPattern(), para as
     *  duas nunca divergirem sobre o que conta como "conhecido". */
    private static isKnownTopic(pattern: string): pattern is typeof KNOWN_SKILL_TOPICS[number] {
        return Object.prototype.hasOwnProperty.call(SkillLearner.SKILL_DEFS, pattern);
    }

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
        this.migrateSkillsWithHardcodedCity();
        this.cleanupDuplicateKnownPatternProposals();
    }

    /**
     * Remove propostas duplicadas de padrões CONHECIDOS já gravadas no banco antes desta correção.
     *
     * Por que uma migração e não só o fix em tryCreateSkillProposal: as linhas duplicadas
     * ("Consulta Cripto (memory_admin)", "(read)", "(write)"...) já existem em instalações rodando
     * — corrigir só a criação de propostas novas resolve o futuro, mas deixa o /config de quem já
     * está em produção poluído para sempre. Mesmo raciocínio de migrateSkillsWithHardcodedCity().
     *
     * Escopo: só `status = 'proposed'` e só `source_pattern` presente em SKILL_DEFS — skills
     * ATIVAS nunca tiveram esse problema (o operador só aprova uma vez) e padrões desconhecidos
     * legitimamente variam de conteúdo por tool, não são duplicatas. Mantém 1 linha por
     * source_pattern (a de maior prioridade/hits/mais antiga — conteúdo é idêntico entre as
     * candidatas, então a escolha de qual sobra é só um critério determinístico de desempate).
     *
     * Origem: relato do operador em /config (15/08/2026) — mesma skill reaparecendo várias vezes
     * com sufixos de tool diferentes, sem indicação de que já havia sido sugerida/ativa.
     */
    private cleanupDuplicateKnownPatternProposals(): void {
        const knownPatterns = Object.keys(SkillLearner.SKILL_DEFS);
        if (knownPatterns.length === 0) return;

        const placeholders = knownPatterns.map(() => '?').join(',');

        // Passo 1: um padrão conhecido já ATIVO não precisa de proposta nenhuma — a proposta seria
        // idêntica ao que já está no ar. Sem este passo, uma instância com "Consulta Cripto" ativa
        // ficava com "Consulta Cripto (read)" ainda proposta ao lado dela: a MESMA duplicata que
        // motivou o fix, só que sobrevivendo à primeira versão da migração (que só deduplicava
        // entre propostas, nunca comparava contra o que já estava ativo). Achado ao inspecionar o
        // banco de produção logo após o primeiro deploy deste fix (15/08/2026).
        const resultVsAtiva = this.db.prepare(`
            DELETE FROM auto_skills
            WHERE status = 'proposed'
              AND source_pattern IN (${placeholders})
              AND source_pattern IN (
                  SELECT source_pattern FROM auto_skills
                  WHERE status = 'active' AND source_pattern IN (${placeholders})
              )
        `).run(...knownPatterns, ...knownPatterns);

        // Passo 2: entre as propostas restantes (padrões ainda sem skill ativa), mantém 1 por
        // source_pattern — o caso original do fix (várias tools incidentais propondo o mesmo
        // padrão em paralelo).
        const resultEntreDuplicatas = this.db.prepare(`
            DELETE FROM auto_skills
            WHERE status = 'proposed'
              AND source_pattern IN (${placeholders})
              AND id NOT IN (
                  SELECT id FROM (
                      SELECT id, ROW_NUMBER() OVER (
                          PARTITION BY source_pattern
                          ORDER BY priority DESC, hits DESC, created_at ASC
                      ) AS rn
                      FROM auto_skills
                      WHERE status = 'proposed' AND source_pattern IN (${placeholders})
                  )
                  WHERE rn = 1
              )
        `).run(...knownPatterns, ...knownPatterns);

        const total = resultVsAtiva.changes + resultEntreDuplicatas.changes;
        if (total > 0) {
            log.info(
                `Removidas ${total} propostas duplicadas de skills conhecidas `
                + `(${resultVsAtiva.changes} já cobertas por skill ativa, ${resultEntreDuplicatas.changes} duplicadas entre si)`
            );
        }
    }

    /**
     * Reescreve skills já gravadas que carregam uma cidade fixa no prompt.
     *
     * Por que uma migração e não só a correção do template: a linha em `auto_skills` foi GERADA
     * a partir do template do código, mas depois vive por conta própria no banco. Corrigir só o
     * template conserta instalações futuras e deixa todas as existentes com a instrução ruim
     * para sempre — num projeto que qualquer pessoa instala, isso é a maioria dos casos.
     *
     * Escopo deliberadamente estreito: só toca linhas cujo prompt ainda tem a FORMA do template
     * quebrado (uma query de clima com local escrito). Uma skill que o operador editou à mão não
     * casa com o padrão e não é tocada — a fronteira de "conhecimento aprendido não é reescrito
     * por código" (docs/ARCHITECTURE/SEPARACAO_DISTRIBUIDO_APRENDIDO.md) continua valendo para
     * tudo que não seja este defeito conhecido.
     *
     * Origem: incidente de 03/08/2026 — o assistente respondeu o clima de uma cidade que o
     * usuário nunca mencionou, seguindo esta instrução.
     */
    private migrateSkillsWithHardcodedCity(): void {
        const modelo = this.createSkillFromPattern('weather', 'weather', 0);

        const afetadas = this.db.prepare(
            `SELECT id, name FROM auto_skills
             WHERE prompt LIKE '%weather"}%' AND prompt LIKE '%web_search%'`
        ).all() as Array<{ id: string; name: string }>;

        if (afetadas.length === 0) return;

        const update = this.db.prepare(
            `UPDATE auto_skills
                SET description = ?, prompt = ?, tool_sequence = ?, updated_at = ?
              WHERE id = ?`
        );
        for (const linha of afetadas) {
            update.run(
                modelo.description,
                modelo.prompt,
                modelo.tool_sequence,
                new Date().toISOString(),
                linha.id
            );
            log.info(`Skill "${linha.name}" migrada: instrução com cidade fixa substituída por "perguntar quando não souber"`);
        }
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
     * Record a tool usage pattern - called after every tool execution.
     *
     * `topicSlug`: já classificado por `UnifiedIntentRouter` (uma vez por turno, reaproveitando a
     * chamada de LLM que já roteia a mensagem — nenhuma chamada nova aqui). Ausente/malformado →
     * não registra nada para este tool call (ausência é uma saída válida, nunca se adivinha uma
     * categoria a partir do texto — NUNCA_ADIVINHAR.md). Isso é intencional mesmo quando o texto
     * do usuário "parece" pertencer a um padrão conhecido: sem o slug já computado, não há decisão
     * semântica nova tomada aqui — só validação estrutural do que já foi declarado. Não recebe mais
     * o texto do usuário: `skill_patterns` nunca o armazenou (só pattern/tool/contadores), e sem
     * `extractPattern()` não havia mais nada aqui para ler dele.
     */
    recordPattern(toolName: string, success: boolean, latencyMs: number, topicSlug?: string): void {
        const pattern = topicSlug && VALID_SKILL_TOPIC_SLUG.test(topicSlug) ? topicSlug : null;
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
            // Para padrões CONHECIDOS (em SKILL_DEFS), nome/gatilho/descrição/prompt/tool_sequence
            // são função só do pattern — a tool que disparou o registro nunca entra no conteúdo
            // (ver createSkillFromPattern: `def?.toolSeq ?? [toolName]`, o `def.toolSeq` sempre
            // vence quando existe). Manter `source_tool` na chave de dedup fazia CADA tool
            // incidental que passasse do limiar (write, read, memory_search, memory_admin...)
            // gerar uma proposta NOVA com conteúdo idêntico, só disambiguada por sufixo — é o que
            // o operador via em /config como "Consulta Cripto (memory_admin)", "(read)", "(write)"
            // repetidos. Padrões desconhecidos (fora de SKILL_DEFS) continuam chaveados por
            // (pattern, tool): ali a tool MUDA o prompt/toolSeq gerado, então são propostas
            // legitimamente distintas.
            const isKnownPattern = SkillLearner.isKnownTopic(item.pattern);
            const alreadyExists = isKnownPattern
                ? this.db.prepare(
                    'SELECT id FROM auto_skills WHERE source_pattern = ? LIMIT 1'
                  ).get(item.pattern) as { id: string } | undefined
                : this.db.prepare(
                    'SELECT id FROM auto_skills WHERE source_pattern = ? AND source_tool = ? LIMIT 1'
                  ).get(item.pattern, item.tool_name) as { id: string } | undefined;

            if (alreadyExists) continue;

            const skill = this.createSkillFromPattern(item.pattern, item.tool_name, item.success_count);

            // A identidade de uma skill é (source_pattern, source_tool) — já verificada acima. O
            // NOME, porém, vem de `skillDefs`, que é indexado só por `pattern`: `crypto_query`
            // com read, write, web_search e memory_search nasce quatro vezes como "Consulta
            // Cripto". Com o guarda de nome aplicado sobre isso, o PRIMEIRO tool a cruzar o
            // limiar gravava a skill e todos os demais eram descartados em silêncio, para sempre
            // — as duas chaves de deduplicação discordavam, e a mais grosseira vencia.
            //
            // Evidência real (03/08/2026, instância do operador): 8 skills ativas, ZERO propostas,
            // e ao mesmo tempo `crypto_query→read` com 367 sucessos, `write→read` com 225 e
            // `crypto_query→write` com 169 — todos elegíveis, nenhum proposto. O operador
            // percebeu como "o gerador parou de sugerir skills".
            //
            // Agora o nome é desambiguado pela ferramenta quando colide, preservando a intenção
            // do guarda (não criar duas skills com o mesmo rótulo na lista) sem descartar uma
            // skill legítima.
            const nameExists = this.db.prepare(
                "SELECT id FROM auto_skills WHERE name = ? LIMIT 1"
            ).get(skill.name) as { id: string } | undefined;

            if (nameExists) {
                skill.name = `${skill.name} (${item.tool_name})`;
                const aindaColide = this.db.prepare(
                    "SELECT id FROM auto_skills WHERE name = ? LIMIT 1"
                ).get(skill.name) as { id: string } | undefined;
                if (aindaColide) {
                    // Só aqui é duplicata de verdade. Sai com log — o `continue` mudo era o que
                    // tornava o problema invisível por meses.
                    log.info(
                        `Proposta ignorada: já existe skill chamada "${skill.name}" `
                        + `(${item.pattern} -> ${item.tool_name})`
                    );
                    continue;
                }
            }

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
        const def = SkillLearner.isKnownTopic(pattern) ? SkillLearner.SKILL_DEFS[pattern] : undefined;

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
            // Inclui toolName e um sufixo aleatório, não só Date.now(): tryCreateSkillProposal()
            // itera SINCRONAMENTE sobre todos os padrões maduros numa mesma chamada — quando 2+
            // amadurecem juntos (cenário real já registrado no S185: 5 combinações crypto_query/
            // write maduras ao mesmo tempo), dois INSERTs caem no mesmo milissegundo e colidem em
            // PRIMARY KEY, perdendo uma proposta em silêncio (capturado só pelo catch genérico de
            // recordPattern). Achado ao rodar S237 na suíte completa (mais rápida que isolada).
            id: `skill_${pattern}_${toolName}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
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
