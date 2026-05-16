import Database from 'better-sqlite3';
import { createLogger } from '../../shared/AppLogger';
import { AuditConfig, AuditFinding, AuditReport, DbAuditReport, DbFinding, FixReport } from './types';

const log = createLogger('AuditReporter');

export function buildReport(
    findings: AuditFinding[],
    durationMs: number,
    config: AuditConfig
): AuditReport {
    const critical = findings.filter(f => f.severity === 'critical').length;
    const warnings = findings.filter(f => f.severity === 'warning').length;
    const info = findings.filter(f => f.severity === 'info').length;

    return {
        timestamp: new Date().toISOString(),
        totalFindings: findings.length,
        critical,
        warnings,
        info,
        findings: findings.slice(0, config.maxFindingsPerCategory * 4),
        durationMs,
        summary: generateSummary(critical, warnings, info)
    };
}

function generateSummary(critical: number, warnings: number, info: number): string {
    const lines: string[] = [];
    if (critical > 0) lines.push(`🔴 ${critical} problema(s) CRÍTICO(S) — requer atenção imediata`);
    if (warnings > 0) lines.push(`🟡 ${warnings} aviso(s) — deve ser corrigido em breve`);
    if (info > 0) lines.push(`ℹ️ ${info} informação(ões) — melhorias sugeridas`);
    if (lines.length === 0) lines.push('✅ Nenhum problema encontrado! Sistema saudável.');
    return lines.join('\n');
}

export function saveReport(report: AuditReport, db: Database.Database): void {
    try {
        const result = db.prepare(`
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
            db.prepare(`
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
        log.error('audit_error', e, 'Erro ao salvar relatório:');
    }
}

export function getLatestReport(db: Database.Database): DbAuditReport | undefined {
    return db.prepare('SELECT * FROM audit_reports ORDER BY id DESC LIMIT 1').get() as DbAuditReport | undefined;
}

export function getFindings(db: Database.Database, severity?: string): DbFinding[] {
    if (severity) {
        return db.prepare(
            'SELECT * FROM audit_findings WHERE severity = ? ORDER BY id DESC LIMIT 50'
        ).all(severity) as unknown as DbFinding[];
    }
    return db.prepare(
        'SELECT * FROM audit_findings ORDER BY id DESC LIMIT 50'
    ).all() as unknown as DbFinding[];
}

export function getReportHistory(db: Database.Database, limit: number = 10): DbAuditReport[] {
    return db.prepare(`
        SELECT id, timestamp, total_findings, critical, warnings, info_count, summary
        FROM audit_reports ORDER BY id DESC LIMIT ?
    `).all(limit) as unknown as DbAuditReport[];
}

export function formatReport(report: AuditReport): string {
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

export function formatFixReport(report: FixReport): string {
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
            if (r.patchSummary && r.status === 'applied') lines.push(`     📝 ${r.patchSummary}`);
            if (r.reason && r.status !== 'applied') lines.push(`     💡 ${r.reason}`);
        }
    } else {
        lines.push('ℹ️ Nenhuma correção pendente encontrada.');
    }

    return lines.join('\n');
}
