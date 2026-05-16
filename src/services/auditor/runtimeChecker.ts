import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { createLogger } from '../../shared/AppLogger';
import { AuditConfig, AuditFinding, LLMFinding } from './types';

const log = createLogger('AuditRuntimeChecker');

export async function auditRuntime(
    config: AuditConfig,
    callOllama: (prompt: string) => Promise<string>,
    lastAuditTimestamp: string | null
): Promise<AuditFinding[]> {
    const findings: AuditFinding[] = [];
    const logsPath = config.logsPath;

    if (fs.existsSync(logsPath)) {
        const logFiles = fs.readdirSync(logsPath)
            .filter(f => f.endsWith('.log'))
            .sort()
            .reverse()
            .slice(0, 3);

        for (const logFile of logFiles) {
            const logPath = path.join(logsPath, logFile);
            log.info(`[AUDIT] Analisando log: ${logPath}`);
            const content = fs.readFileSync(logPath, 'utf-8');
            let lines = content.split('\n').slice(-500);

            if (lastAuditTimestamp) {
                const cutoff = lastAuditTimestamp;
                lines = lines.filter(line => {
                    const tsMatch = line.match(/^\[(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2})/);
                    if (!tsMatch) return true;
                    return tsMatch[1] >= cutoff;
                });
            }

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
                    const response = await callOllama(prompt);
                    const jsonMatch = response.match(/\{[\s\S]*\}/);
                    if (jsonMatch) {
                        const parsed = JSON.parse(jsonMatch[0]);
                        (parsed.findings || []).forEach((f: LLMFinding) => {
                            findings.push({
                                severity: (f.severity || 'warning') as AuditFinding['severity'],
                                category: 'runtime',
                                title: f.title || 'Runtime error pattern',
                                description: f.description || '',
                                suggestion: f.suggestion,
                                autoFixable: f.autoFixable || false,
                                riskLevel: (f.riskLevel || 'medium') as AuditFinding['riskLevel']
                            });
                        });
                    }
                } catch (e) { log.debug('audit_check_skipped', String(e)); }
            }

            findings.push(...findRuntimePatterns(lines));
        }
    }

    try {
        const result = execSync('ps aux | grep -c "node.*newclaw\\|npm.*start" || echo 0', { encoding: 'utf-8' });
        const processCount = parseInt(result.trim());
        if (processCount < 2) {
            findings.push({
                severity: 'critical',
                category: 'runtime',
                title: 'NewClaw pode estar offline',
                description: `Encontrados apenas ${processCount} processos. Bot pode estar parado.`,
                suggestion: 'Verificar: systemctl status newclaw ou pm2 list',
                autoFixable: false,
                riskLevel: 'high'
            });
        }
    } catch (e) { log.debug('audit_check_skipped', String(e)); }

    // Live memory snapshot (always fresh)
    try {
        const mem = process.memoryUsage();
        const heapUsedMb = Math.round(mem.heapUsed / 1048576);
        const heapTotalMb = Math.round(mem.heapTotal / 1048576);
        const rssMb = Math.round(mem.rss / 1048576);

        // NOTE: Node.js dynamically sizes heapTotal close to heapUsed,
        // so percentage alone is misleading (40/42 MB = 96% but is fine).
        // Use ABSOLUTE thresholds to avoid false positives.
        const CRITICAL_MB = 512;
        const WARNING_MB = 256;

        if (rssMb > CRITICAL_MB) {
            findings.push({
                severity: 'critical',
                category: 'runtime',
                title: `Memória RSS alta: ${rssMb} MB (heap: ${heapUsedMb}/${heapTotalMb} MB)`,
                description: `O processo está consumindo ${rssMb} MB de memória RSS. Risco de OOM em ambientes com recursos limitados.`,
                suggestion: 'Verificar vazamentos de memória em sessões ativas, limpar caches e considerar reiniciar o processo.',
                autoFixable: false,
                riskLevel: 'high'
            });
        } else if (rssMb > WARNING_MB) {
            findings.push({
                severity: 'warning',
                category: 'runtime',
                title: `Memória RSS moderada: ${rssMb} MB (heap: ${heapUsedMb}/${heapTotalMb} MB)`,
                description: `Consumo de memória acima do esperado para operação normal.`,
                suggestion: 'Monitorar tendência. Se crescer consistentemente, investigar sessões longas ou cache.',
                autoFixable: false,
                riskLevel: 'medium'
            });
        }
    } catch (e) { log.debug('audit_check_skipped', String(e)); }

    // Live event loop check
    try {
        const { getEventLoopMonitor } = require('../../shared/EventLoopMonitor');
        const monitor = getEventLoopMonitor();
        const stats = monitor.getStats();
        if (stats.lagMs > 500) {
            findings.push({
                severity: stats.lagMs > 2000 ? 'critical' : 'warning',
                category: 'runtime',
                title: `Event loop lag: ${stats.lagMs}ms (avg: ${stats.avgLagMs}ms, peak: ${stats.peakLagMs}ms)`,
                description: `Latência alta no event loop indica bloqueio de I/O ou processamento pesado.`,
                suggestion: 'Verificar operações síncronas de arquivo, queries SQLite lentas ou loops CPU-bound.',
                autoFixable: false,
                riskLevel: stats.lagMs > 2000 ? 'high' : 'medium'
            });
        }
    } catch (e) { log.debug('audit_check_skipped', String(e)); }

    return findings;
}

function findRuntimePatterns(lines: string[]): AuditFinding[] {
    const findings: AuditFinding[] = [];
    const errorMap = new Map<string, number>();

    lines.filter(l => /error|ERRO/i.test(l)).forEach(l => {
        const key = l.replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/, '').trim().substring(0, 100);
        errorMap.set(key, (errorMap.get(key) || 0) + 1);
    });

    for (const [error, count] of errorMap) {
        if (count >= 5) {
            findings.push({
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
    if (memoryWarnings.length > 5) {
        findings.push({
            severity: memoryWarnings.length > 15 ? 'critical' : 'warning',
            category: 'runtime',
            title: 'Fragmentação ou Leak de Memória',
            description: `Detectados ${memoryWarnings.length} avisos de heap/memory nos logs. Isso pode indicar que o processo está carregando arquivos muito grandes ou que há um vazamento em sessões longas.`,
            suggestion: 'Otimizar o carregamento de logs de sessão (implementado) e reduzir o tempo de expiração de sessões inativas.',
            autoFixable: false,
            riskLevel: 'high'
        });
    }

    return findings;
}
