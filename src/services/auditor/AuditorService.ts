/**
 * AuditorService — Internal Self-Diagnosis Agent
 * 
 * PRIVATE: Not exposed as a bot command. Only accessible via /audit (owner-only).
 * Uses the local LLM to analyze code, runtime behavior, and data consistency.
 * 
 * Inspired by ial-trading's QuantAnalysisAgent that detected bugs
 * static analyzers couldn't find.
 * 
 * Capabilities:
 * 1. Code Audit — Analyzes source files for logic errors, edge cases, anti-patterns
 * 2. Runtime Audit — Checks logs, error patterns, memory leaks
 * 3. Data Audit — Validates DB consistency, missing refs, orphaned records
 * 4. Integration Audit — Tests API endpoints, tool availability, service health
 * 5. Auto-Fix — Multi-agent validation pipeline with consensus-based patching
 * 
 * Auto-Fix Pipeline:
 *   /audit fix → generatePatch → validatePatch (multi-agent) → buildConsensus
 *              → validatePatchSafety (deterministic) → applyPatch → updateDB
 *   Fails safe: any step failure = rejection, no patch applied.
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

// ============================================
// TYPES
// ============================================

export interface AuditFinding {
    severity: 'critical' | 'warning' | 'info';
    category: 'code' | 'runtime' | 'data' | 'integration' | 'security';
    file?: string;
    line?: number;
    title: string;
    description: string;
    suggestion?: string;
    autoFixable: boolean;
    fixed?: boolean;
    riskLevel?: 'low' | 'medium' | 'high';
}

export interface AuditReport {
    timestamp: string;
    totalFindings: number;
    critical: number;
    warnings: number;
    info: number;
    findings: AuditFinding[];
    durationMs: number;
    summary: string;
}

export interface AuditConfig {
    ollamaUrl: string;
    model: string;
    dbPath: string;
    srcPath: string;
    logsPath: string;
    ownerChatId: string;
    maxFindingsPerCategory: number;
    enableAutoFix: boolean;
}

// ============================================
// AUTO-FIX PIPELINE TYPES
// ============================================

export interface GeneratedPatch {
    file: string;
    before: string;
    after: string;
    confidence: number;
    summary: string;
}

export interface AgentOpinion {
    agent: string;
    approve: boolean;
    confidence: number;
    reason: string;
}

export interface PatchValidation {
    opinions: AgentOpinion[];
}

export interface ConsensusResult {
    agreement: number;
    confidence: number;
    approved: boolean;
}

export interface PatchSafetyResult {
    validSyntax: boolean;
    fileExists: boolean;
    changeSizeOk: boolean;
    riskyChange: boolean;
    safe: boolean;
    reasons: string[];
}

export interface FixResult {
    findingId: number;
    title: string;
    status: 'applied' | 'rejected' | 'error';
    reason?: string;
    patchSummary?: string;
}

export interface FixReport {
    timestamp: string;
    totalAnalyzed: number;
    applied: number;
    rejected: number;
    errors: number;
    results: FixResult[];
    durationMs: number;
}

// ============================================
// AUDITOR SERVICE
// ============================================

export class AuditorService {
    private config: AuditConfig;
    private db: Database.Database;
    private findings: AuditFinding[] = [];
    private fixLogPath: string;

    constructor(config: AuditConfig, db?: Database.Database) {
        this.config = config;
        if (db) {
            this.db = db;
        } else {
            this.db = new Database(config.dbPath);
        }
        this.fixLogPath = path.join(path.dirname(config.dbPath), 'auditor', 'logs', 'fixes.log');
        this.initTables();
    }

    private initTables(): void {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS audit_reports (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp TEXT NOT NULL,
                total_findings INTEGER,
                critical INTEGER,
                warnings INTEGER,
                info_count INTEGER,
                summary TEXT,
                full_report TEXT
            );

            CREATE TABLE IF NOT EXISTS audit_findings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                report_id INTEGER,
                severity TEXT NOT NULL,
                category TEXT NOT NULL,
                file_path TEXT,
                line_number INTEGER,
                title TEXT NOT NULL,
                description TEXT,
                suggestion TEXT,
                auto_fixable BOOLEAN DEFAULT 0,
                fixed BOOLEAN DEFAULT 0,
                risk_level TEXT DEFAULT 'medium',
                FOREIGN KEY (report_id) REFERENCES audit_reports(id)
            );

            CREATE INDEX IF NOT EXISTS idx_findings_severity ON audit_findings(severity);
            CREATE INDEX IF NOT EXISTS idx_findings_category ON audit_findings(category);
            CREATE INDEX IF NOT EXISTS idx_findings_fixable ON audit_findings(auto_fixable, fixed);
        `);
    }

    // ============================================
    // MAIN AUDIT ENTRY POINT
    // ============================================

    async runFullAudit(): Promise<AuditReport> {
        const start = Date.now();
        this.findings = [];

        console.log('[AUDITOR] 🔍 Iniciando auditoria completa...');

        console.log('[AUDITOR] 📝 [1/4] Auditando código...');
        await this.auditCode();
        console.log('[AUDITOR] 📝 [2/4] Auditando runtime...');
        await this.auditRuntime();
        console.log('[AUDITOR] 📝 [3/4] Auditando dados...');
        await this.auditData();
        console.log('[AUDITOR] 📝 [4/4] Auditando integrações...');
        await this.auditIntegration();

        const report = this.buildReport(Date.now() - start);
        this.saveReport(report);

        console.log(`[AUDITOR] ✅ Auditoria concluída: ${report.totalFindings} achados (${report.critical} críticos)`);
        return report;
    }

    async runCategoryAudit(category: 'code' | 'runtime' | 'data' | 'integration'): Promise<AuditReport> {
        const start = Date.now();
        this.findings = [];

        console.log(`[AUDITOR] 🔍 Auditoria de ${category}...`);
        console.log(`[AUDITOR] 📝 Enviando para análise do LLM...`);

        switch (category) {
            case 'code': await this.auditCode(); break;
            case 'runtime': await this.auditRuntime(); break;
            case 'data': await this.auditData(); break;
            case 'integration': await this.auditIntegration(); break;
        }

        const report = this.buildReport(Date.now() - start);
        this.saveReport(report);
        return report;
    }

    // ============================================
    // 1. CODE AUDIT
    // ============================================

    private async auditCode(): Promise<void> {
        const srcPath = this.config.srcPath;
        if (!fs.existsSync(srcPath)) return;

        const files = this.getSourceFiles(srcPath);
        const maxFiles = 10;
        const filesToAudit = files.slice(0, maxFiles);

        for (const file of filesToAudit) {
            try {
                const content = fs.readFileSync(file, 'utf-8');
                const findings = await this.analyzeCodeWithLLM(file, content);
                this.findings.push(...findings);
            } catch (e: any) {
                this.findings.push({
                    severity: 'warning',
                    category: 'code',
                    file,
                    title: 'Erro ao ler arquivo',
                    description: e.message,
                    autoFixable: false
                });
            }
        }
    }

    private getSourceFiles(dir: string): string[] {
        const files: string[] = [];
        const exclude = ['node_modules', 'dist', '.git', 'data', 'logs', 'backups', 'auditor'];

        const walk = (d: string) => {
            const entries = fs.readdirSync(d, { withFileTypes: true });
            for (const entry of entries) {
                if (exclude.includes(entry.name)) continue;
                const fullPath = path.join(d, entry.name);
                if (entry.isDirectory()) {
                    walk(fullPath);
                } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.js')) {
                    files.push(fullPath);
                }
            }
        };

        walk(dir);
        return files;
    }

    private async analyzeCodeWithLLM(filePath: string, content: string): Promise<AuditFinding[]> {
        const relativePath = path.relative(this.config.srcPath, filePath);

        if (content.length > 20000) {
            content = content.substring(0, 20000) + '\n// ... truncated for audit';
        }

        const prompt = `You are a senior code auditor. Analyze this TypeScript/JavaScript file for:

1. Logic errors (wrong conditions, missing edge cases, off-by-one)
2. Unhandled errors (missing try/catch, uncaught promise rejections)
3. Anti-patterns (callback hell, memory leaks, race conditions)
4. Security issues (SQL injection, path traversal, eval usage)
5. Data consistency (wrong types, missing null checks)
6. Performance issues (N+1 queries, unnecessary loops)

File: ${relativePath}

\`\`\`typescript
${content}
\`\`\`

Respond ONLY in this JSON format (no markdown, no explanation outside JSON):
{
  "findings": [
    {
      "severity": "critical|warning|info",
      "line": 0,
      "title": "Short title",
      "description": "What's wrong",
      "suggestion": "How to fix it",
      "autoFixable": false,
      "riskLevel": "low|medium|high"
    }
  ]
}

If no issues found, return: {"findings": []}

Rules for riskLevel:
- low: Simple fix (missing null check, typo, small logic fix). Safe to auto-apply.
- medium: Moderate fix (adding try/catch, restructuring a function). Needs review.
- high: Complex fix (changing architecture, affecting multiple files). Manual only.`;

        try {
            console.log(`[AUDITOR] 🤖 LLM analisando ${relativePath}...`);
            const response = await this.callOllama(prompt);
            console.log(`[AUDITOR] ✅ ${relativePath} analisado`);
            const jsonMatch = response.match(/\{[\s\S]*\}/);
            if (!jsonMatch) return [];

            const parsed = JSON.parse(jsonMatch[0]);
            return (parsed.findings || []).map((f: any) => ({
                severity: f.severity || 'info',
                category: 'code' as const,
                file: relativePath,
                line: f.line,
                title: f.title || 'Issue found',
                description: f.description || '',
                suggestion: f.suggestion,
                autoFixable: f.autoFixable || false,
                riskLevel: f.riskLevel || 'medium'
            }));
        } catch (e) {
            return [];
        }
    }

    // ============================================
    // 2. RUNTIME AUDIT
    // ============================================

    private async auditRuntime(): Promise<void> {
        const logsPath = this.config.logsPath;
        if (fs.existsSync(logsPath)) {
            const logFiles = fs.readdirSync(logsPath)
                .filter(f => f.endsWith('.log'))
                .sort()
                .reverse()
                .slice(0, 3);

            for (const logFile of logFiles) {
                const logPath = path.join(logsPath, logFile);
                const content = fs.readFileSync(logPath, 'utf-8');
                const lines = content.split('\n').slice(-500);

                const errorLines = lines.filter(l =>
                    /error|ERRO|fail|FALHA|exception|crash|timeout|ECONNREFUSED/i.test(l)
                );

                if (errorLines.length > 0) {
                    const prompt = `Analyze these error log lines from a Telegram bot (NewClaw). 
Identify patterns, root causes, and suggest fixes.

Errors:
${errorLines.slice(0, 50).join('\n')}

Respond ONLY in JSON:
{"findings": [{"severity":"critical|warning|info","title":"...","description":"...","suggestion":"...","autoFixable":false,"riskLevel":"low|medium|high"}]}`;

                    try {
                        const response = await this.callOllama(prompt);
                        const jsonMatch = response.match(/\{[\s\S]*\}/);
                        if (jsonMatch) {
                            const parsed = JSON.parse(jsonMatch[0]);
                            (parsed.findings || []).forEach((f: any) => {
                                this.findings.push({
                                    severity: f.severity || 'warning',
                                    category: 'runtime',
                                    title: f.title || 'Runtime error pattern',
                                    description: f.description || '',
                                    suggestion: f.suggestion,
                                    autoFixable: f.autoFixable || false,
                                    riskLevel: f.riskLevel || 'medium'
                                });
                            });
                        }
                    } catch (e) {}
                }

                this.findRuntimePatterns(lines);
            }
        }

        try {
            const result = execSync('ps aux | grep -c "node.*newclaw\\|npm.*start" || echo 0', { encoding: 'utf-8' });
            const processCount = parseInt(result.trim());
            if (processCount < 2) {
                this.findings.push({
                    severity: 'critical',
                    category: 'runtime',
                    title: 'NewClaw pode estar offline',
                    description: `Encontrados apenas ${processCount} processos. Bot pode estar parado.`,
                    suggestion: 'Verificar: systemctl status newclaw ou pm2 list',
                    autoFixable: false,
                    riskLevel: 'high'
                });
            }
        } catch (e) {}
    }

    private findRuntimePatterns(lines: string[]): void {
        const errorMap = new Map<string, number>();
        lines.filter(l => /error|ERRO/i.test(l)).forEach(l => {
            const key = l.replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/, '').trim().substring(0, 100);
            errorMap.set(key, (errorMap.get(key) || 0) + 1);
        });

        for (const [error, count] of errorMap) {
            if (count >= 5) {
                this.findings.push({
                    severity: count >= 20 ? 'critical' : 'warning',
                    category: 'runtime',
                    title: `Erro repetido (${count}x): ${error.substring(0, 50)}...`,
                    description: `O mesmo erro apareceu ${count} vezes. Possível loop infinito ou problema persistente.`,
                    autoFixable: false,
                    riskLevel: 'high'
                });
            }
        }

        const memoryWarnings = lines.filter(l => /heap|memory|OOM|ENOMEM/i.test(l));
        if (memoryWarnings.length > 3) {
            this.findings.push({
                severity: 'critical',
                category: 'runtime',
                title: 'Possível memory leak',
                description: `${memoryWarnings.length} avisos de memória nos logs recentes.`,
                suggestion: 'Verificar closures, event listeners não removidos, e acumulação de dados em memória.',
                autoFixable: false,
                riskLevel: 'high'
            });
        }
    }

    // ============================================
    // 3. DATA AUDIT
    // ============================================

    private async auditData(): Promise<void> {
        try {
            const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];

            for (const table of tables) {
                try {
                    const count = (this.db.prepare(`SELECT COUNT(*) as cnt FROM "${table.name}"`).get() as any).cnt;

                    if (count === 0 && !['audit_reports', 'audit_findings', 'scheduled_tasks'].includes(table.name)) {
                        this.findings.push({
                            severity: 'info',
                            category: 'data',
                            title: `Tabela vazia: ${table.name}`,
                            description: `A tabela ${table.name} não possui registros.`,
                            autoFixable: false
                        });
                    }

                    if (count > 100000) {
                        this.findings.push({
                            severity: 'warning',
                            category: 'data',
                            title: `Tabela grande: ${table.name} (${count} registros)`,
                            description: 'Tabelas muito grandes podem degradar performance. Considerar limpeza ou arquivamento.',
                            autoFixable: false
                        });
                    }
                } catch (e) {}
            }

            try {
                const orphans = this.db.prepare(`
                    SELECT COUNT(*) as cnt FROM conversations 
                    WHERE updated_at < datetime('now', '-30 days')
                `).get() as any;

                if (orphans?.cnt > 0) {
                    this.findings.push({
                        severity: 'info',
                        category: 'data',
                        title: `${orphans.cnt} conversas antigas (>30 dias)`,
                        description: 'Conversas não acessadas há mais de 30 dias.',
                        suggestion: 'Considerar arquivamento para economizar espaço.',
                        autoFixable: false
                    });
                }
            } catch (e) {}
        } catch (e: any) {
            this.findings.push({
                severity: 'warning',
                category: 'data',
                title: 'Erro ao auditar banco de dados',
                description: e.message,
                autoFixable: false
            });
        }
    }

    // ============================================
    // 4. INTEGRATION AUDIT
    // ============================================

    private async auditIntegration(): Promise<void> {
        // ============================================
        // INFRASTRUCTURE CHECKS
        // ============================================

        // 1. Ollama (LLM provider)
        try {
            const ollamaUrl = this.config.ollamaUrl.replace(/\/api\/generate$/, '');
            const response = await fetch(`${ollamaUrl}/api/tags`, {
                signal: AbortSignal.timeout(5000)
            });
            if (!response.ok) {
                this.findings.push({
                    severity: 'critical',
                    category: 'integration',
                    title: 'Ollama retornou erro',
                    description: `Status: ${response.status}`,
                    suggestion: 'Verificar se o Ollama está rodando: systemctl status ollama',
                    autoFixable: false,
                    riskLevel: 'high'
                });
            } else {
                // Check available models
                try {
                    const models = await response.json() as any;
                    const modelNames: string[] = (models?.models || []).map((m: any) => m.name);
                    if (modelNames.length === 0) {
                        this.findings.push({
                            severity: 'warning',
                            category: 'integration',
                            title: 'Nenhum modelo Ollama disponível',
                            description: 'Ollama está rodando mas não tem modelos baixados.',
                            suggestion: 'Baixar modelo: ollama pull glm-5.1:cloud',
                            autoFixable: false,
                            riskLevel: 'medium'
                        });
                    }
                } catch (e) {}
            }
        } catch (e: any) {
            this.findings.push({
                severity: 'critical',
                category: 'integration',
                title: 'Ollama inacessível',
                description: e.message,
                suggestion: 'Iniciar Ollama: ollama serve',
                autoFixable: false,
                riskLevel: 'high'
            });
        }

        // ============================================
        // MULTI-CHANNEL CHECKS
        // ============================================

        const channelStatuses: { channel: string; connected: boolean; detail: string }[] = [];

        // 2. Telegram
        const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
        if (telegramToken) {
            try {
                const response = await fetch(`https://api.telegram.org/bot${telegramToken}/getMe`, {
                    signal: AbortSignal.timeout(5000)
                });
                const data = await response.json() as any;
                if (data.ok) {
                    const botName = data.result?.username || 'unknown';
                    channelStatuses.push({ channel: 'Telegram', connected: true, detail: `@${botName}` });
                } else {
                    channelStatuses.push({ channel: 'Telegram', connected: false, detail: `API erro: ${data.error_code || data.description}` });
                    this.findings.push({
                        severity: 'critical',
                        category: 'integration',
                        title: 'Token Telegram inválido',
                        description: `A API do Telegram rejeitou o token.`,
                        suggestion: 'Verificar TELEGRAM_BOT_TOKEN no .env',
                        autoFixable: false,
                        riskLevel: 'high'
                    });
                }
            } catch (e: any) {
                channelStatuses.push({ channel: 'Telegram', connected: false, detail: e.message });
                this.findings.push({
                    severity: 'warning',
                    category: 'integration',
                    title: 'Telegram API inacessível',
                    description: e.message,
                    suggestion: 'Verificar conexão com api.telegram.org',
                    autoFixable: false,
                    riskLevel: 'medium'
                });
            }
        } else {
            channelStatuses.push({ channel: 'Telegram', connected: false, detail: 'TELEGRAM_BOT_TOKEN não configurado' });
        }

        // 3. Discord
        const discordToken = process.env.DISCORD_BOT_TOKEN;
        if (discordToken) {
            try {
                const response = await fetch('https://discord.com/api/v10/users/@me', {
                    headers: { Authorization: `Bot ${discordToken}` },
                    signal: AbortSignal.timeout(5000)
                });
                if (response.ok) {
                    const data = await response.json() as any;
                    channelStatuses.push({ channel: 'Discord', connected: true, detail: data.username || 'connected' });
                } else {
                    channelStatuses.push({ channel: 'Discord', connected: false, detail: `HTTP ${response.status}` });
                    this.findings.push({
                        severity: 'critical',
                        category: 'integration',
                        title: 'Discord Bot Token inválido',
                        description: `Discord API retornou ${response.status}. Token pode estar revogado.`,
                        suggestion: 'Verificar DISCORD_BOT_TOKEN no .env e regenerar no Discord Developer Portal se necessário',
                        autoFixable: false,
                        riskLevel: 'high'
                    });
                }
            } catch (e: any) {
                channelStatuses.push({ channel: 'Discord', connected: false, detail: e.message });
                this.findings.push({
                    severity: 'warning',
                    category: 'integration',
                    title: 'Discord API inacessível',
                    description: e.message,
                    suggestion: 'Verificar conexão com discord.com',
                    autoFixable: false,
                    riskLevel: 'medium'
                });
            }
        } else {
            channelStatuses.push({ channel: 'Discord', connected: false, detail: 'DISCORD_BOT_TOKEN não configurado' });
        }

        // 4. WhatsApp (Baileys — no remote API to check; verify auth dir exists)
        const whatsappNumber = process.env.WHATSAPP_PHONE_NUMBER;
        const whatsappAuthDir = process.env.WHATSAPP_AUTH_DIR || './data/whatsapp-auth';
        if (whatsappNumber) {
            const authExists = fs.existsSync(whatsappAuthDir);
            if (authExists) {
                channelStatuses.push({ channel: 'WhatsApp', connected: true, detail: `${whatsappNumber} (auth dir ok)` });
            } else {
                channelStatuses.push({ channel: 'WhatsApp', connected: false, detail: 'Auth dir não encontrado — precisa escanear QR' });
                this.findings.push({
                    severity: 'warning',
                    category: 'integration',
                    title: 'WhatsApp auth não configurado',
                    description: `Diretório ${whatsappAuthDir} não existe. WhatsApp precisa de escaneamento QR.`,
                    suggestion: 'Iniciar o bot e escanear QR code para autenticar WhatsApp',
                    autoFixable: false,
                    riskLevel: 'medium'
                });
            }
        } else {
            channelStatuses.push({ channel: 'WhatsApp', connected: false, detail: 'WHATSAPP_PHONE_NUMBER não configurado' });
        }

        // 5. Signal
        const signalNumber = process.env.SIGNAL_PHONE_NUMBER;
        const signalCliPath = process.env.SIGNAL_CLI_PATH || 'signal-cli';
        if (signalNumber) {
            try {
                const signalResult = execSync(`which ${signalCliPath} 2>/dev/null || echo not_found`, { encoding: 'utf-8' }).trim();
                if (signalResult === 'not_found') {
                    channelStatuses.push({ channel: 'Signal', connected: false, detail: 'signal-cli não instalado' });
                    this.findings.push({
                        severity: 'warning',
                        category: 'integration',
                        title: 'signal-cli não encontrado',
                        description: `SIGNAL_PHONE_NUMBER configurado mas ${signalCliPath} não está instalado.`,
                        suggestion: 'Instalar signal-cli: https://github.com/AsamK/signal-cli',
                        autoFixable: false,
                        riskLevel: 'medium'
                    });
                } else {
                    channelStatuses.push({ channel: 'Signal', connected: true, detail: `${signalNumber} (cli ok)` });
                }
            } catch (e: any) {
                channelStatuses.push({ channel: 'Signal', connected: false, detail: e.message });
            }
        } else {
            channelStatuses.push({ channel: 'Signal', connected: false, detail: 'SIGNAL_PHONE_NUMBER não configurado' });
        }

        // 6. Dashboard (Web)
        const dashboardPort = process.env.DASHBOARD_PORT || '3090';
        try {
            const dashResponse = await fetch(`http://localhost:${dashboardPort}/`, {
                signal: AbortSignal.timeout(3000)
            });
            if (dashResponse.ok) {
                channelStatuses.push({ channel: 'Web Dashboard', connected: true, detail: `porta ${dashboardPort}` });
            } else {
                channelStatuses.push({ channel: 'Web Dashboard', connected: false, detail: `HTTP ${dashResponse.status}` });
            }
        } catch (e: any) {
            channelStatuses.push({ channel: 'Web Dashboard', connected: false, detail: 'não responde' });
            this.findings.push({
                severity: 'warning',
                category: 'integration',
                title: 'Dashboard Web offline',
                description: `Dashboard na porta ${dashboardPort} não está respondendo.`,
                suggestion: 'Verificar se o DashboardServer está inicializando corretamente',
                autoFixable: false,
                riskLevel: 'low'
            });
        }

        // Summary finding for channel status
        const connectedCount = channelStatuses.filter(c => c.connected).length;
        const totalChannels = channelStatuses.length;
        if (connectedCount === 0) {
            this.findings.push({
                severity: 'critical',
                category: 'integration',
                title: 'Nenhum canal conectado',
                description: 'Nenhum canal (Telegram, Discord, WhatsApp, Signal, Web) está funcional.',
                suggestion: 'Verificar .env e reiniciar o bot.',
                autoFixable: false,
                riskLevel: 'high'
            });
        } else if (connectedCount < totalChannels) {
            const offlineChannels = channelStatuses.filter(c => !c.connected).map(c => c.channel).join(', ');
            this.findings.push({
                severity: 'info',
                category: 'integration',
                title: `${connectedCount}/${totalChannels} canais conectados`,
                description: `Canais offline: ${offlineChannels}`,
                suggestion: 'Configurar tokens/chaves no .env para canais desejados',
                autoFixable: false,
                riskLevel: 'low'
            });
        }

        // ============================================
        // SYSTEM CHECKS
        // ============================================

        // Disk usage
        try {
            const df = execSync("df -h / | tail -1 | awk '{print $5}'", { encoding: 'utf-8' }).trim();
            const usage = parseInt(df);
            if (usage > 85) {
                this.findings.push({
                    severity: usage > 95 ? 'critical' : 'warning',
                    category: 'runtime',
                    title: `Disco ${usage}% cheio`,
                    description: 'Pouco espaço em disco pode causar falhas no SQLite e logs.',
                    suggestion: 'Limpar logs antigos, backups e arquivos temporários.',
                    autoFixable: false,
                    riskLevel: usage > 95 ? 'high' : 'medium'
                });
            }
        } catch (e) {}

        // Node.js version
        try {
            const nodeVersion = process.version;
            const major = parseInt(nodeVersion.slice(1).split('.')[0]);
            if (major < 18) {
                this.findings.push({
                    severity: 'warning',
                    category: 'runtime',
                    title: `Node.js ${nodeVersion} desatualizado`,
                    description: 'Versões < 18 podem ter vulnerabilidades e falta de features.',
                    suggestion: 'Atualizar para Node.js 18+ LTS',
                    autoFixable: false,
                    riskLevel: 'medium'
                });
            }
        } catch (e) {}

        // Process health
        try {
            const result = execSync('ps aux | grep -c "node.*newclaw\\|npm.*start" || echo 0', { encoding: 'utf-8' });
            const processCount = parseInt(result.trim());
            if (processCount < 2) {
                this.findings.push({
                    severity: 'critical',
                    category: 'integration',
                    title: 'NewClaw pode estar offline',
                    description: `Encontrados apenas ${processCount} processos. Bot pode estar parado.`,
                    suggestion: 'Verificar: ./start.sh restart ou pm2 list',
                    autoFixable: false,
                    riskLevel: 'high'
                });
            }
        } catch (e) {}
    }

    // ============================================
    // LLM CALL
    // ============================================

    private async callOllama(prompt: string): Promise<string> {
        console.log('[AUDITOR] 🤖 Enviando prompt ao Ollama...');
        const startTime = Date.now();
        const response = await fetch(this.config.ollamaUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: this.config.model,
                prompt,
                stream: false
            }),
            signal: AbortSignal.timeout(120000)
        });

        if (!response.ok) {
            throw new Error(`Ollama returned ${response.status}`);
        }

        const data = await response.json() as any;
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        console.log(`[AUDITOR] 🤖 Ollama respondeu em ${elapsed}s`);
        return data.response || '';
    }

    // ============================================
    // REPORT BUILDER
    // ============================================

    private buildReport(durationMs: number): AuditReport {
        const critical = this.findings.filter(f => f.severity === 'critical').length;
        const warnings = this.findings.filter(f => f.severity === 'warning').length;
        const info = this.findings.filter(f => f.severity === 'info').length;

        const summary = this.generateSummary(critical, warnings, info);

        return {
            timestamp: new Date().toISOString(),
            totalFindings: this.findings.length,
            critical,
            warnings,
            info,
            findings: this.findings.slice(0, this.config.maxFindingsPerCategory * 4),
            durationMs,
            summary
        };
    }

    private generateSummary(critical: number, warnings: number, info: number): string {
        const lines: string[] = [];

        if (critical > 0) lines.push(`🔴 ${critical} problema(s) CRÍTICO(S) — requer atenção imediata`);
        if (warnings > 0) lines.push(`🟡 ${warnings} aviso(s) — deve ser corrigido em breve`);
        if (info > 0) lines.push(`ℹ️ ${info} informação(ões) — melhorias sugeridas`);

        if (lines.length === 0) lines.push('✅ Nenhum problema encontrado! Sistema saudável.');

        return lines.join('\n');
    }

    private saveReport(report: AuditReport): void {
        try {
            const result = this.db.prepare(`
                INSERT INTO audit_reports (timestamp, total_findings, critical, warnings, info_count, summary, full_report)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `).run(
                report.timestamp,
                report.totalFindings,
                report.critical,
                report.warnings,
                report.info,
                report.summary,
                JSON.stringify(report)
            );

            const reportId = result.lastInsertRowid;

            for (const finding of report.findings) {
                this.db.prepare(`
                    INSERT INTO audit_findings (report_id, severity, category, file_path, line_number, title, description, suggestion, auto_fixable, fixed, risk_level)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `).run(
                    reportId,
                    finding.severity,
                    finding.category,
                    finding.file || null,
                    finding.line || null,
                    finding.title,
                    finding.description,
                    finding.suggestion || null,
                    finding.autoFixable ? 1 : 0,
                    finding.fixed ? 1 : 0,
                    finding.riskLevel || 'medium'
                );
            }
        } catch (e) {
            console.error('[AUDITOR] Erro ao salvar relatório:', e);
        }
    }

    // ============================================
    // HISTORY & QUERIES
    // ============================================

    getLatestReport(): any {
        return this.db.prepare(`
            SELECT * FROM audit_reports ORDER BY id DESC LIMIT 1
        `).get();
    }

    getFindings(severity?: string): any[] {
        if (severity) {
            return this.db.prepare(`
                SELECT * FROM audit_findings WHERE severity = ? ORDER BY id DESC LIMIT 50
            `).all(severity);
        }
        return this.db.prepare(`
            SELECT * FROM audit_findings ORDER BY id DESC LIMIT 50
        `).all();
    }

    getReportHistory(limit: number = 10): any[] {
        return this.db.prepare(`
            SELECT id, timestamp, total_findings, critical, warnings, info_count, summary 
            FROM audit_reports ORDER BY id DESC LIMIT ?
        `).all(limit);
    }

    // ============================================
    // FORMATTED OUTPUT (for Telegram)
    // ============================================

    formatReport(report: AuditReport): string {
        const lines: string[] = [];

        lines.push('🪐 **AUDITORIA NEWCLAW**');
        lines.push(`📅 ${new Date(report.timestamp).toLocaleString('pt-BR')}`);
        lines.push(`⏱️ ${Math.round(report.durationMs / 1000)}s de análise`);
        lines.push('');
        lines.push(report.summary);
        lines.push('');

        const bySeverity = {
            critical: report.findings.filter(f => f.severity === 'critical'),
            warning: report.findings.filter(f => f.severity === 'warning'),
            info: report.findings.filter(f => f.severity === 'info')
        };

        if (bySeverity.critical.length > 0) {
            lines.push('🔴 **CRÍTICOS:**');
            bySeverity.critical.forEach(f => {
                lines.push(`  • ${f.title}`);
                if (f.file) lines.push(`    📁 ${f.file}${f.line ? ':' + f.line : ''}`);
                if (f.suggestion) lines.push(`    💡 ${f.suggestion}`);
            });
            lines.push('');
        }

        if (bySeverity.warning.length > 0) {
            lines.push('🟡 **AVISOS:**');
            bySeverity.warning.forEach(f => {
                lines.push(`  • ${f.title}`);
                if (f.suggestion) lines.push(`    💡 ${f.suggestion}`);
            });
            lines.push('');
        }

        if (bySeverity.info.length > 0) {
            lines.push('ℹ️ **SUGESTÕES:**');
            bySeverity.info.slice(0, 5).forEach(f => {
                lines.push(`  • ${f.title}`);
            });
            if (bySeverity.info.length > 5) {
                lines.push(`  ... e mais ${bySeverity.info.length - 5} sugestões`);
            }
        }

        return lines.join('\n');
    }

    // ============================================
    // 5. AUTO-FIX PIPELINE
    // ============================================

    /**
     * Main entry point for /audit fix command.
     * Runs the full pipeline: find → generate → validate → consensus → safety → apply → update
     */
    async runFixPipeline(): Promise<FixReport> {
        const start = Date.now();
        const results: FixResult[] = [];

        // Get all unfixed, auto-fixable findings
        const fixableFindings = this.db.prepare(`
            SELECT * FROM audit_findings 
            WHERE auto_fixable = 1 AND fixed = 0 AND risk_level = 'low'
            ORDER BY severity DESC, id ASC
            LIMIT 20
        `).all() as any[];

        console.log(`[AUDITOR-FIX] 🔧 ${fixableFindings.length} correções candidatas (risk_level=low)`);

        for (const finding of fixableFindings) {
            console.log(`[AUDITOR-FIX] 🔨 Processando finding #${finding.id}: ${finding.title}`);

            try {
                // Step 1: Generate patch
                const patch = await this.generatePatch(finding);
                if (!patch) {
                    results.push({
                        findingId: finding.id,
                        title: finding.title,
                        status: 'rejected',
                        reason: 'Falha ao gerar patch'
                    });
                    this.logFix(finding.id, 'rejected', 'Falha ao gerar patch');
                    continue;
                }

                // Step 2: Multi-agent validation
                const validation = await this.validatePatch(patch, finding);

                // Step 3: Consensus
                const consensus = this.buildConsensus(validation.opinions);
                if (!consensus.approved) {
                    results.push({
                        findingId: finding.id,
                        title: finding.title,
                        status: 'rejected',
                        reason: `Consenso insuficiente (agreement=${consensus.agreement.toFixed(2)}, confidence=${consensus.confidence.toFixed(2)})`
                    });
                    this.logFix(finding.id, 'rejected', `Consenso insuficiente: agreement=${consensus.agreement.toFixed(2)}`);
                    continue;
                }

                // Step 4: Deterministic safety validation
                const safety = this.validatePatchSafety(patch);
                if (!safety.safe) {
                    results.push({
                        findingId: finding.id,
                        title: finding.title,
                        status: 'rejected',
                        reason: `Validação de segurança falhou: ${safety.reasons.join('; ')}`
                    });
                    this.logFix(finding.id, 'rejected', `Safety check falhou: ${safety.reasons.join('; ')}`);
                    continue;
                }

                // Step 5: Apply patch
                const applied = this.applyPatch(patch);
                if (!applied) {
                    results.push({
                        findingId: finding.id,
                        title: finding.title,
                        status: 'error',
                        reason: 'Erro ao aplicar patch no arquivo'
                    });
                    this.logFix(finding.id, 'rejected', 'Erro ao aplicar patch');
                    continue;
                }

                // Step 6: Update database
                this.markFindingFixed(finding.id);

                results.push({
                    findingId: finding.id,
                    title: finding.title,
                    status: 'applied',
                    patchSummary: patch.summary
                });
                this.logFix(finding.id, 'applied', `Patch aplicado: ${patch.summary}`);

            } catch (error: any) {
                results.push({
                    findingId: finding.id,
                    title: finding.title,
                    status: 'error',
                    reason: error.message
                });
                this.logFix(finding.id, 'rejected', `Exceção: ${error.message}`);
            }
        }

        const applied = results.filter(r => r.status === 'applied').length;
        const rejected = results.filter(r => r.status === 'rejected').length;
        const errors = results.filter(r => r.status === 'error').length;

        const report: FixReport = {
            timestamp: new Date().toISOString(),
            totalAnalyzed: fixableFindings.length,
            applied,
            rejected,
            errors,
            results,
            durationMs: Date.now() - start
        };

        console.log(`[AUDITOR-FIX] ✅ Pipeline concluído: ${applied} aplicados, ${rejected} rejeitados, ${errors} erros`);
        return report;
    }

    // ============================================
    // 5.1 PATCH GENERATION
    // ============================================

    /**
     * Generates a patch using the LLM for a given finding.
     * Returns null if generation fails.
     */
    async generatePatch(finding: any): Promise<GeneratedPatch | null> {
        const filePath = finding.file_path;
        const srcRoot = this.config.srcPath;
        const fullPath = filePath ? path.join(srcRoot, filePath) : null;

        // Read the file content for context
        let fileContent = '';
        if (fullPath && fs.existsSync(fullPath)) {
            fileContent = fs.readFileSync(fullPath, 'utf-8');
            // Truncate large files
            if (fileContent.length > 15000) {
                // Try to extract context around the finding line
                const targetLine = finding.line_number || 0;
                const lines = fileContent.split('\n');
                const startLine = Math.max(0, targetLine - 30);
                const endLine = Math.min(lines.length, targetLine + 30);
                fileContent = lines.slice(startLine, endLine).join('\n');
                fileContent = `// ... lines ${startLine + 1}-${endLine} of ${lines.length} ...\n` + fileContent;
            }
        }

        const prompt = `You are an expert code fixer. Given an audit finding, generate a minimal, safe patch.

FINDING:
  Title: ${finding.title}
  Description: ${finding.description}
  Suggestion: ${finding.suggestion || 'N/A'}
  File: ${filePath || 'N/A'}
  Line: ${finding.line_number || 'N/A'}

${fileContent ? `CURRENT FILE CONTENT (relevant section):\n\`\`\`typescript\n${fileContent}\n\`\`\`` : 'No file content available.'}

RULES:
1. Generate the MINIMAL change needed to fix the issue
2. The "before" field must be an EXACT substring from the current file content
3. The "after" field must be the corrected version
4. Do NOT change anything beyond what is needed for the fix
5. Do NOT add new features or refactor
6. If you cannot safely fix this, return confidence: 0

Respond ONLY in JSON (no markdown, no explanation):
{
  "file": "${filePath || ''}",
  "before": "exact string to find in the file",
  "after": "replacement string",
  "confidence": 0.0-1.0,
  "summary": "Brief description of what the fix does"
}`;

        try {
            console.log(`[AUDITOR-FIX] 🤖 Gerando patch para finding #${finding.id}...`);
            const response = await this.callOllama(prompt);
            const jsonMatch = response.match(/\{[\s\S]*\}/);
            if (!jsonMatch) return null;

            const parsed = JSON.parse(jsonMatch[0]);

            const patch: GeneratedPatch = {
                file: parsed.file || filePath || '',
                before: parsed.before || '',
                after: parsed.after || '',
                confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0,
                summary: parsed.summary || 'Patch gerado automaticamente'
            };

            // Reject if LLM has low confidence
            if (patch.confidence < 0.5) {
                console.log(`[AUDITOR-FIX] ⚠️ Patch com confiança baixa (${patch.confidence}) — rejeitado`);
                return null;
            }

            // Reject if before/after are empty or identical
            if (!patch.before || !patch.after || patch.before === patch.after) {
                console.log(`[AUDITOR-FIX] ⚠️ Patch vazio ou sem mudança — rejeitado`);
                return null;
            }

            return patch;
        } catch (e: any) {
            console.error(`[AUDITOR-FIX] ❌ Erro ao gerar patch: ${e.message}`);
            return null;
        }
    }

    // ============================================
    // 5.2 MULTI-AGENT VALIDATION
    // ============================================

    /**
     * Simulates multi-agent validation using different LLM prompts/roles.
     * Each "agent" reviews the patch independently.
     */
    async validatePatch(patch: GeneratedPatch, finding: any): Promise<PatchValidation> {
        const agents = [
            { name: 'code_reviewer', role: 'senior code reviewer' },
            { name: 'bug_detector', role: 'bug detection specialist' },
            { name: 'safety_checker', role: 'security and safety reviewer' }
        ];

        const opinions: AgentOpinion[] = [];

        for (const agent of agents) {
            try {
                const opinion = await this.getAgentOpinion(agent.name, agent.role, patch, finding);
                opinions.push(opinion);
            } catch (e: any) {
                // On error, default to rejection
                opinions.push({
                    agent: agent.name,
                    approve: false,
                    confidence: 0,
                    reason: `Erro na avaliação: ${e.message}`
                });
            }
        }

        return { opinions };
    }

    private async getAgentOpinion(
        agentName: string,
        agentRole: string,
        patch: GeneratedPatch,
        finding: any
    ): Promise<AgentOpinion> {
        const prompt = `You are a ${agentRole}. Review this proposed code patch and decide if it should be applied.

FINDING:
  Title: ${finding.title}
  Description: ${finding.description}

PROPOSED PATCH:
  File: ${patch.file}
  Summary: ${patch.summary}
  Confidence: ${patch.confidence}

  BEFORE:
\`\`\`
${patch.before}
\`\`\`

  AFTER:
\`\`\`
${patch.after}
\`\`\`

Evaluate:
1. Does the patch correctly fix the described issue?
2. Could the patch introduce new bugs?
3. Is the change minimal and focused?
4. Are there any side effects or risks?

Respond ONLY in JSON:
{
  "approve": true|false,
  "confidence": 0.0-1.0,
  "reason": "Brief explanation of your decision"
}`;

        const response = await this.callOllama(prompt);
        const jsonMatch = response.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            return {
                agent: agentName,
                approve: false,
                confidence: 0,
                reason: 'Resposta inválida do LLM'
            };
        }

        try {
            const parsed = JSON.parse(jsonMatch[0]);
            return {
                agent: agentName,
                approve: parsed.approve === true,
                confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
                reason: parsed.reason || 'Sem justificativa'
            };
        } catch (e) {
            return {
                agent: agentName,
                approve: false,
                confidence: 0,
                reason: 'Falha ao parsear resposta'
            };
        }
    }

    // ============================================
    // 5.3 CONSENSUS ENGINE
    // ============================================

    /**
     * Builds consensus from multiple agent opinions.
     * approved = agreement >= 0.75 AND confidence >= 0.8
     */
    buildConsensus(opinions: AgentOpinion[]): ConsensusResult {
        if (opinions.length === 0) {
            return { agreement: 0, confidence: 0, approved: false };
        }

        const approvals = opinions.filter(o => o.approve).length;
        const agreement = approvals / opinions.length;
        const confidence = opinions.reduce((sum, o) => sum + o.confidence, 0) / opinions.length;

        return {
            agreement,
            confidence,
            approved: agreement >= 0.75 && confidence >= 0.8
        };
    }

    // ============================================
    // 5.4 DETERMINISTIC SAFETY VALIDATION
    // ============================================

    /**
     * Deterministic checks that must ALL pass before a patch is applied.
     * No LLM involved — pure code validation.
     */
    validatePatchSafety(patch: GeneratedPatch): PatchSafetyResult {
        const reasons: string[] = [];
        const srcRoot = this.config.srcPath;
        const fullPath = path.join(srcRoot, patch.file);

        // 1. File must exist
        const fileExists = fs.existsSync(fullPath);
        if (!fileExists) {
            reasons.push(`Arquivo não encontrado: ${patch.file}`);
        }

        // 2. 'before' must exist in the file
        let validSyntax = false;
        if (fileExists) {
            try {
                const content = fs.readFileSync(fullPath, 'utf-8');
                validSyntax = content.includes(patch.before);
                if (!validSyntax) {
                    reasons.push('String "before" não encontrada no arquivo — patch não aplicável');
                }
            } catch (e: any) {
                reasons.push(`Erro ao ler arquivo: ${e.message}`);
            }
        }

        // 3. Change size check — diff cannot be too large
        const beforeLen = patch.before.length;
        const afterLen = patch.after.length;
        const changeRatio = Math.max(beforeLen, afterLen) / Math.max(Math.min(beforeLen, afterLen), 1);
        const changeSizeOk = changeRatio < 5 && afterLen < 2000;
        if (!changeSizeOk) {
            reasons.push(`Mudança muito grande (ratio=${changeRatio.toFixed(1)}, after=${afterLen} chars)`);
        }

        // 4. Risky change detection — must not remove critical blocks
        const riskyPatterns = [
            /import\s+.*from\s+['"]fs['"]/,   // Don't remove fs imports
            /import\s+.*from\s+['"]path['"]/, // Don't remove path imports
            /process\.exit/,                    // Don't remove exit calls
            /class\s+\w+\s*\{/,                // Don't remove class declarations
            /export\s+(default\s+)?function/,   // Don't remove exports
        ];

        let riskyChange = false;
        // Check if the patch REMOVES something matching a risky pattern
        for (const pattern of riskyPatterns) {
            if (pattern.test(patch.before) && !pattern.test(patch.after)) {
                riskyChange = true;
                reasons.push(`Patch remove bloco crítico: ${pattern.source}`);
                break;
            }
        }

        // Also check: patch should not contain destructive commands
        const destructivePatterns = [
            /rm\s+-rf/,
            /child_process/,
            /eval\s*\(/,
            /\.exec\s*\(/,
            /process\.env/,
        ];
        for (const pattern of destructivePatterns) {
            if (pattern.test(patch.after) && !pattern.test(patch.before)) {
                riskyChange = true;
                reasons.push(`Patch adiciona padrão perigoso: ${pattern.source}`);
                break;
            }
        }

        const safe = fileExists && validSyntax && changeSizeOk && !riskyChange;

        return {
            validSyntax,
            fileExists,
            changeSizeOk,
            riskyChange,
            safe,
            reasons
        };
    }

    // ============================================
    // 5.5 APPLY PATCH
    // ============================================

    /**
     * Applies a patch to the filesystem.
     * Creates a .bak backup before modifying.
     * Returns true if successfully applied.
     */
    applyPatch(patch: GeneratedPatch): boolean {
        const srcRoot = this.config.srcPath;
        const fullPath = path.join(srcRoot, patch.file);

        try {
            if (!fs.existsSync(fullPath)) {
                console.error(`[AUDITOR-FIX] ❌ Arquivo não encontrado: ${fullPath}`);
                return false;
            }

            const content = fs.readFileSync(fullPath, 'utf-8');

            // Verify 'before' exists in current content
            if (!content.includes(patch.before)) {
                console.error(`[AUDITOR-FIX] ❌ String "before" não encontrada no arquivo`);
                return false;
            }

            // Create backup
            const backupPath = fullPath + '.bak';
            fs.writeFileSync(backupPath, content, 'utf-8');
            console.log(`[AUDITOR-FIX] 💾 Backup criado: ${backupPath}`);

            // Apply patch (replace first occurrence only)
            const newContent = content.replace(patch.before, patch.after);

            // Verify the replacement actually happened
            if (newContent === content) {
                console.error(`[AUDITOR-FIX] ❌ Patch não alterou o conteúdo`);
                return false;
            }

            // Write the modified file
            fs.writeFileSync(fullPath, newContent, 'utf-8');
            console.log(`[AUDITOR-FIX] ✅ Patch aplicado em: ${patch.file}`);

            return true;
        } catch (e: any) {
            console.error(`[AUDITOR-FIX] ❌ Erro ao aplicar patch: ${e.message}`);
            // Try to restore from backup
            try {
                const backupPath = fullPath + '.bak';
                if (fs.existsSync(backupPath)) {
                    const backup = fs.readFileSync(backupPath, 'utf-8');
                    fs.writeFileSync(fullPath, backup, 'utf-8');
                    console.log(`[AUDITOR-FIX] 🔄 Restaurado do backup: ${fullPath}`);
                }
            } catch (restoreError) {
                console.error(`[AUDITOR-FIX] ❌ Falha ao restaurar backup: ${restoreError}`);
            }
            return false;
        }
    }

    // ============================================
    // 5.6 UPDATE DATABASE
    // ============================================

    private markFindingFixed(findingId: number): void {
        this.db.prepare(`
            UPDATE audit_findings SET fixed = 1 WHERE id = ?
        `).run(findingId);
        console.log(`[AUDITOR-FIX] 📝 Finding #${findingId} marcado como corrigido`);
    }

    // ============================================
    // 5.7 FIX LOGGING
    // ============================================

    private logFix(findingId: number, result: 'applied' | 'rejected', reason: string): void {
        try {
            // Ensure log directory exists
            const logDir = path.dirname(this.fixLogPath);
            if (!fs.existsSync(logDir)) {
                fs.mkdirSync(logDir, { recursive: true });
            }

            const timestamp = new Date().toISOString();
            const logLine = `[${timestamp}] finding=#${findingId} result=${result} reason="${reason.replace(/"/g, '\\"')}"\n`;
            fs.appendFileSync(this.fixLogPath, logLine, 'utf-8');
        } catch (e) {
            console.error(`[AUDITOR-FIX] Erro ao escrever log: ${e}`);
        }
    }

    // ============================================
    // FIX REPORT FORMATTER (for Telegram)
    // ============================================

    formatFixReport(report: FixReport): string {
        const lines: string[] = [];

        lines.push('🔧 **AUTO-FIX PIPELINE**');
        lines.push(`📅 ${new Date(report.timestamp).toLocaleString('pt-BR')}`);
        lines.push(`⏱️ ${Math.round(report.durationMs / 1000)}s de processamento`);
        lines.push('');

        lines.push(`📊 **Resumo:**`);
        lines.push(`  • Total analisados: ${report.totalAnalyzed}`);
        lines.push(`  • ✅ Aplicados: ${report.applied}`);
        lines.push(`  • ❌ Rejeitados: ${report.rejected}`);
        lines.push(`  • ⚠️ Erros: ${report.errors}`);
        lines.push('');

        if (report.results.length > 0) {
            lines.push('📋 **Detalhes:**');
            for (const r of report.results) {
                const emoji = r.status === 'applied' ? '✅' : r.status === 'rejected' ? '❌' : '⚠️';
                lines.push(`  ${emoji} #${r.findingId} ${r.title}`);
                if (r.patchSummary && r.status === 'applied') {
                    lines.push(`     📝 ${r.patchSummary}`);
                }
                if (r.reason && r.status !== 'applied') {
                    lines.push(`     💡 ${r.reason}`);
                }
            }
        } else {
            lines.push('ℹ️ Nenhuma correção pendente encontrada.');
        }

        return lines.join('\n');
    }
}