/**
 * AuditorService — Internal Self-Diagnosis Agent
 *
 * PRIVATE: Not exposed as a bot command. Only accessible via /audit (owner-only).
 * Uses the local LLM to analyze code, runtime behavior, and data consistency.
 *
 * Auto-Fix Pipeline:
 *   /audit fix → generatePatch → validatePatch (multi-agent) → buildConsensus
 *              → validatePatchSafety (deterministic) → applyPatch → updateDB
 *   Fails safe: any step failure = rejection, no patch applied.
 */

import Database from 'better-sqlite3';
import { createLogger } from '../../shared/AppLogger';
import { errorMessage } from '../../shared/errors';

import { AuditFinding, AuditReport, AuditConfig, DbFinding, DbAuditReport, GeneratedPatch, AgentOpinion, PatchValidation, ConsensusResult, PatchSafetyResult, FixReport } from './types';
import { auditCode } from './codeChecker';
import { auditRuntime } from './runtimeChecker';
import { auditData } from './dataChecker';
import { auditIntegration } from './integrationChecker';
import { buildReport, saveReport, formatReport, formatFixReport, getLatestReport as _getLatestReport, getFindings as _getFindings, getReportHistory as _getReportHistory } from './reporter';
// autoFix pipeline removido — patches devem ser aplicados manualmente após revisão humana

export type { AuditFinding, AuditReport, AuditConfig, DbFinding, DbAuditReport, GeneratedPatch, AgentOpinion, PatchValidation, ConsensusResult, PatchSafetyResult, FixResult, FixReport } from './types';

const log = createLogger('AuditorService');

export class AuditorService {
    private config: AuditConfig;
    private db: Database.Database;
    /** Timestamp of last audit — used to only read new log lines */
    private lastAuditTimestamp: string | null = null;
    /** Titles from previous report — used for deduplication */
    private previousFindingTitles: Set<string> = new Set();

    constructor(config: AuditConfig, db?: Database.Database) {
        this.config = config;
        this.db = db ?? new Database(config.dbPath);
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

        // Migration: add risk_level column if missing (backwards compatibility)
        try {
            const columns = this.db.pragma('table_info(audit_findings)') as Array<{ name: string }>;
            const hasRiskLevel = columns.some(c => c.name === 'risk_level');
            if (!hasRiskLevel) {
                this.db.exec('ALTER TABLE audit_findings ADD COLUMN risk_level TEXT DEFAULT \'medium\'');
                log.info('migration_added_risk_level', 'Added risk_level column to audit_findings');
            }
        } catch (e) {
            log.warn('migration_risk_level_failed', errorMessage(e));
        }
    }

    // ============================================
    // MAIN AUDIT ENTRY POINTS
    // ============================================

    async runFullAudit(): Promise<AuditReport> {
        const start = Date.now();
        this.loadPreviousFindings();

        log.info('audit_start', '🔍 Iniciando auditoria completa...');

        log.info('audit_step', '📝 [1/4] Auditando código...');
        const codeFindings = await auditCode(this.config, this.callOllama.bind(this));

        log.info('audit_step', '📝 [2/4] Auditando runtime...');
        const runtimeFindings = await auditRuntime(this.config, this.callOllama.bind(this), this.lastAuditTimestamp);

        log.info('audit_step', '📝 [3/4] Auditando dados...');
        const dataFindings = await auditData(this.db);

        log.info('audit_step', '📝 [4/4] Auditando integrações...');
        const integrationFindings = await auditIntegration(this.config);

        const allFindings = [...codeFindings, ...runtimeFindings, ...dataFindings, ...integrationFindings];
        const deduped = this.deduplicateFindings(allFindings);

        const report = buildReport(deduped, Date.now() - start, this.config);
        saveReport(report, this.db);
        this.lastAuditTimestamp = new Date().toISOString();

        log.info('audit_complete', `✅ Auditoria concluída: ${report.totalFindings} achados (${report.critical} críticos)`);
        return report;
    }

    async runCategoryAudit(category: 'code' | 'runtime' | 'data' | 'integration'): Promise<AuditReport> {
        const start = Date.now();
        this.loadPreviousFindings();

        log.info('category_audit_start', `🔍 Auditoria de ${category}...`);
        log.info('llm_analysis_start', `📝 Enviando para análise do LLM...`);

        let findings: AuditFinding[];
        switch (category) {
            case 'code':        findings = await auditCode(this.config, this.callOllama.bind(this)); break;
            case 'runtime':     findings = await auditRuntime(this.config, this.callOllama.bind(this), this.lastAuditTimestamp); break;
            case 'data':        findings = await auditData(this.db); break;
            case 'integration': findings = await auditIntegration(this.config); break;
        }

        const deduped = this.deduplicateFindings(findings);
        const report = buildReport(deduped, Date.now() - start, this.config);
        saveReport(report, this.db);
        this.lastAuditTimestamp = new Date().toISOString();
        return report;
    }

    // ============================================
    // LLM CALL
    // ============================================

    private async callOllama(prompt: string): Promise<string> {
        log.info('ollama_request', '🤖 Enviando prompt ao Ollama...');
        const startTime = Date.now();
        const response = await fetch(this.config.ollamaUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: this.config.model, prompt, stream: false }),
            signal: AbortSignal.timeout(120000)
        });

        if (!response.ok) throw new Error(`Ollama returned ${response.status}`);

        const data = await response.json() as Record<string, unknown>;
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        log.info('ollama_response', `🤖 Ollama respondeu em ${elapsed}s`);
        return String(data.response || '');
    }

    // ============================================
    // DEDUPLICATION
    // ============================================

    /**
     * Load finding titles from the last report to detect duplicates.
     * Prevents re-reporting the same issues across consecutive audits.
     */
    private loadPreviousFindings(): void {
        this.previousFindingTitles.clear();
        try {
            const latest = this.db.prepare(
                'SELECT full_report FROM audit_reports ORDER BY id DESC LIMIT 1'
            ).get() as { full_report?: string } | undefined;
            if (latest?.full_report) {
                const report = JSON.parse(latest.full_report) as AuditReport;
                for (const f of report.findings || []) {
                    this.previousFindingTitles.add(f.title);
                }
            }
        } catch (e) {
            log.info(`No previous audit report found to deduplicate (or table not ready): ${errorMessage(e)}`);
        }
    }

    /**
     * Remove findings that were already reported in the previous audit.
     * Only keeps NEW issues or issues with changed severity.
     */
    private deduplicateFindings(findings: AuditFinding[]): AuditFinding[] {
        if (this.previousFindingTitles.size === 0) return findings;
        const before = findings.length;
        const deduped = findings.filter(f => !this.previousFindingTitles.has(f.title));
        const removed = before - deduped.length;
        if (removed > 0) {
            log.info('deduplication', `🔄 Deduplicação: ${removed} findings repetidos removidos (${deduped.length} novos)`);
        }
        return deduped;
    }

    // ============================================
    // PUBLIC API — delegates to modules
    // ============================================

    getLatestReport(): DbAuditReport | undefined { return _getLatestReport(this.db); }
    getFindings(severity?: string): DbFinding[] { return _getFindings(this.db, severity); }
    getReportHistory(limit: number = 10): DbAuditReport[] { return _getReportHistory(this.db, limit); }
    formatReport(report: AuditReport): string { return formatReport(report); }
    formatFixReport(report: FixReport): string { return formatFixReport(report); }

    /**
     * Auto-fix pipeline DESATIVADO por segurança arquitetural.
     * A geração e aplicação de patches via LLM em produção foi identificada
     * como risco crítico de corrupção silenciosa do sistema.
     * Patches devem ser aplicados manualmente após revisão humana.
     */
    async runFixPipeline(): Promise<FixReport> {
        log.warn('[AuditorService] Auto-fix pipeline está desativado. Aplique patches manualmente.');
        return {
            timestamp: new Date().toISOString(),
            totalAnalyzed: 0,
            applied: 0,
            rejected: 0,
            errors: 0,
            results: [],
            durationMs: 0,
        };
    }

    async generatePatch(_finding: AuditFinding | DbFinding): Promise<GeneratedPatch | null> {
        log.warn('[AuditorService] generatePatch desativado — use análise manual.');
        return null;
    }

    async validatePatch(_patch: GeneratedPatch, _finding: AuditFinding | DbFinding): Promise<PatchValidation> {
        return { opinions: [] };
    }

    buildConsensus(_opinions: AgentOpinion[]): ConsensusResult {
        return { approved: false, agreement: 0, confidence: 0 };
    }
    validatePatchSafety(_patch: GeneratedPatch): PatchSafetyResult {
        return { safe: false, validSyntax: false, fileExists: false, changeSizeOk: false, riskyChange: true, reasons: ['Auto-fix desativado por segurança'] };
    }
    applyPatch(_patch: GeneratedPatch): boolean { return false; }
}
