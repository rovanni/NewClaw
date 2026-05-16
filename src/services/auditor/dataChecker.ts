import Database from 'better-sqlite3';
import { createLogger } from '../../shared/AppLogger';
import { errorMessage } from '../../shared/errors';
import { AuditFinding } from './types';

const log = createLogger('AuditDataChecker');

export async function auditData(db: Database.Database): Promise<AuditFinding[]> {
    const findings: AuditFinding[] = [];

    try {
        const test = db.prepare('SELECT 1 as ok').get();
        if (!test) throw new Error('DB query returned no results');

        const tables = ['agent_traces', 'memory_classifications', 'tool_decisions'];
        for (const table of tables) {
            try {
                const count = (db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as { c: number }).c;
                if (count === 0) {
                    findings.push({
                        severity: 'info',
                        category: 'data',
                        title: `Tabela vazia: ${table}`,
                        description: `A tabela ${table} ainda não possui registros.`,
                        suggestion: 'O sistema começará a popular estas tabelas conforme o agente for utilizado.',
                        autoFixable: false,
                        riskLevel: 'low'
                    });
                }
            } catch (e) { log.debug('audit_check_skipped', String(e)); }
        }

        try {
            const orphans = db.prepare(`
                SELECT COUNT(*) as cnt FROM conversations
                WHERE updated_at < datetime('now', '-30 days')
            `).get() as { cnt?: number; [key: string]: unknown };

            if ((orphans?.cnt ?? 0) > 0) {
                findings.push({
                    severity: 'info',
                    category: 'data',
                    title: `${orphans.cnt} conversas antigas (>30 dias)`,
                    description: 'Conversas não acessadas há mais de 30 dias.',
                    suggestion: 'Considerar arquivamento para economizar espaço.',
                    autoFixable: false,
                    riskLevel: 'low'
                });
            }
        } catch (e) { log.debug('audit_check_skipped', String(e)); }

    } catch (e) {
        findings.push({
            severity: 'critical',
            category: 'data',
            title: 'Erro de conexão ou auditoria de dados',
            description: errorMessage(e),
            suggestion: 'Verificar se o arquivo data/newclaw.db está acessível e não está corrompido.',
            autoFixable: false,
            riskLevel: 'high'
        });
    }

    return findings;
}
