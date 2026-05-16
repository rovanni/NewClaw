import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { createLogger } from '../../shared/AppLogger';
import { errorMessage } from '../../shared/errors';
import {
    AuditConfig, AuditFinding, DbFinding,
    GeneratedPatch, AgentOpinion, PatchValidation,
    ConsensusResult, PatchSafetyResult, FixResult, FixReport
} from './types';

const log = createLogger('AutoFixPipeline');

export async function runFixPipeline(
    config: AuditConfig,
    db: Database.Database,
    callOllama: (prompt: string) => Promise<string>,
    fixLogPath: string
): Promise<FixReport> {
    const start = Date.now();
    const results: FixResult[] = [];

    const fixableFindings = db.prepare(`
        SELECT * FROM audit_findings
        WHERE auto_fixable = 1 AND fixed = 0 AND risk_level = 'low'
        ORDER BY severity DESC, id ASC
        LIMIT 20
    `).all() as unknown as DbFinding[];

    log.info('fix_pipeline_start', `🔧 ${fixableFindings.length} correções candidatas (risk_level=low)`);

    for (const finding of fixableFindings) {
        log.info('process_finding', `🔨 Processando finding #${finding.id}: ${finding.title}`);

        try {
            const patch = await generatePatch(finding, config, callOllama);
            if (!patch) {
                results.push({ findingId: finding.id ?? 0, title: finding.title ?? 'Unknown finding', status: 'rejected', reason: 'Falha ao gerar patch' });
                logFix(finding.id ?? 0, 'rejected', 'Falha ao gerar patch', fixLogPath);
                continue;
            }

            const validation = await validatePatch(patch, finding, callOllama);
            const consensus = buildConsensus(validation.opinions);
            if (!consensus.approved) {
                const reason = `Consenso insuficiente (agreement=${consensus.agreement.toFixed(2)}, confidence=${(consensus.confidence ?? 0).toFixed(2)})`;
                results.push({ findingId: finding.id ?? 0, title: finding.title ?? 'Unknown finding', status: 'rejected', reason });
                logFix(finding.id ?? 0, 'rejected', `Consenso insuficiente: agreement=${consensus.agreement.toFixed(2)}`, fixLogPath);
                continue;
            }

            const safety = validatePatchSafety(patch, config);
            if (!safety.safe) {
                const reason = `Validação de segurança falhou: ${safety.reasons.join('; ')}`;
                results.push({ findingId: finding.id ?? 0, title: finding.title ?? 'Unknown finding', status: 'rejected', reason });
                logFix(finding.id ?? 0, 'rejected', `Safety check falhou: ${safety.reasons.join('; ')}`, fixLogPath);
                continue;
            }

            const applied = applyPatch(patch, config);
            if (!applied) {
                results.push({ findingId: finding.id ?? 0, title: finding.title ?? 'Unknown finding', status: 'error', reason: 'Erro ao aplicar patch no arquivo' });
                logFix(finding.id ?? 0, 'rejected', 'Erro ao aplicar patch', fixLogPath);
                continue;
            }

            markFindingFixed(finding.id ?? 0, db);
            results.push({ findingId: finding.id ?? 0, title: finding.title ?? 'Unknown', status: 'applied', patchSummary: patch.summary });
            logFix(finding.id ?? 0, 'applied', `Patch aplicado: ${patch.summary}`, fixLogPath);

        } catch (error) {
            results.push({ findingId: finding.id ?? 0, title: finding.title ?? 'Unknown', status: 'error', reason: errorMessage(error) });
            logFix(finding.id ?? 0, 'rejected', `Exceção: ${errorMessage(error)}`, fixLogPath);
        }
    }

    const applied = results.filter(r => r.status === 'applied').length;
    const rejected = results.filter(r => r.status === 'rejected').length;
    const errors = results.filter(r => r.status === 'error').length;

    const report: FixReport = {
        timestamp: new Date().toISOString(),
        totalAnalyzed: fixableFindings.length,
        applied, rejected, errors, results,
        durationMs: Date.now() - start
    };

    log.info('fix_pipeline_complete', `✅ Pipeline concluído: ${applied} aplicados, ${rejected} rejeitados, ${errors} erros`);
    return report;
}

export async function generatePatch(
    finding: AuditFinding | DbFinding,
    config: AuditConfig,
    callOllama: (prompt: string) => Promise<string>
): Promise<GeneratedPatch | null> {
    const filePath = (finding as DbFinding).file_path;
    const fullPath = filePath ? path.join(config.srcPath, filePath) : null;

    let fileContent = '';
    if (fullPath && fs.existsSync(fullPath)) {
        fileContent = fs.readFileSync(fullPath, 'utf-8');
        if (fileContent.length > 15000) {
            const targetLine = (finding as DbFinding).line_number || 0;
            const lines = fileContent.split('\n');
            const startLine = Math.max(0, targetLine - 30);
            const endLine = Math.min(lines.length, targetLine + 30);
            fileContent = `// ... lines ${startLine + 1}-${endLine} of ${lines.length} ...\n` + lines.slice(startLine, endLine).join('\n');
        }
    }

    const prompt = `You are an expert code fixer. Given an audit finding, generate a minimal, safe patch.

FINDING:
  Title: ${finding.title}
  Description: ${finding.description}
  Suggestion: ${finding.suggestion || 'N/A'}
  File: ${filePath || 'N/A'}
  Line: ${(finding as DbFinding).line_number || 'N/A'}

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
        log.info('patch_generation', `🤖 Gerando patch for finding #${(finding as DbFinding).id ?? '?'}...`);
        const response = await callOllama(prompt);
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

        if (patch.confidence < 0.5) {
            log.warn('patch_rejected', `⚠️ Patch com confiança baixa (${patch.confidence}) — rejeitado`);
            return null;
        }

        if (!patch.before || !patch.after || patch.before === patch.after) {
            log.warn('patch_rejected', `⚠️ Patch vazio ou sem mudança — rejeitado`);
            return null;
        }

        return patch;
    } catch (e) {
        log.error('audit_error', undefined, `[AUDITOR-FIX] ❌ Erro ao gerar patch: ${errorMessage(e)}`);
        return null;
    }
}

export async function validatePatch(
    patch: GeneratedPatch,
    finding: AuditFinding | DbFinding,
    callOllama: (prompt: string) => Promise<string>
): Promise<PatchValidation> {
    const agents = [
        { name: 'code_reviewer', role: 'senior code reviewer' },
        { name: 'bug_detector', role: 'bug detection specialist' },
        { name: 'safety_checker', role: 'security and safety reviewer' }
    ];

    const opinions: AgentOpinion[] = [];

    for (const agent of agents) {
        try {
            opinions.push(await getAgentOpinion(agent.name, agent.role, patch, finding, callOllama));
        } catch (e) {
            opinions.push({ agent: agent.name, approve: false, confidence: 0, reason: `Erro na avaliação: ${errorMessage(e)}` });
        }
    }

    return { opinions };
}

async function getAgentOpinion(
    agentName: string,
    agentRole: string,
    patch: GeneratedPatch,
    finding: AuditFinding | DbFinding,
    callOllama: (prompt: string) => Promise<string>
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

    const response = await callOllama(prompt);
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { agent: agentName, approve: false, confidence: 0, reason: 'Resposta inválida do LLM' };

    try {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
            agent: agentName,
            approve: parsed.approve === true,
            confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
            reason: parsed.reason || 'Sem justificativa'
        };
    } catch (_e) {
        return { agent: agentName, approve: false, confidence: 0, reason: 'Falha ao parsear resposta' };
    }
}

export function buildConsensus(opinions: AgentOpinion[]): ConsensusResult {
    if (opinions.length === 0) return { agreement: 0, confidence: 0, approved: false };

    const approvals = opinions.filter(o => o.approve).length;
    const agreement = approvals / opinions.length;
    const confidence = opinions.reduce((sum, o) => sum + o.confidence, 0) / opinions.length;

    return { agreement, confidence, approved: agreement >= 0.75 && confidence >= 0.8 };
}

export function validatePatchSafety(patch: GeneratedPatch, config: AuditConfig): PatchSafetyResult {
    const reasons: string[] = [];
    const fullPath = path.join(config.srcPath, patch.file);

    const fileExists = fs.existsSync(fullPath);
    if (!fileExists) reasons.push(`Arquivo não encontrado: ${patch.file}`);

    let validSyntax = false;
    if (fileExists) {
        try {
            const content = fs.readFileSync(fullPath, 'utf-8');
            validSyntax = content.includes(patch.before);
            if (!validSyntax) reasons.push('String "before" não encontrada no arquivo — patch não aplicável');
        } catch (e) {
            reasons.push(`Erro ao ler arquivo: ${errorMessage(e)}`);
        }
    }

    const beforeLen = patch.before.length;
    const afterLen = patch.after.length;
    const changeRatio = Math.max(beforeLen, afterLen) / Math.max(Math.min(beforeLen, afterLen), 1);
    const changeSizeOk = changeRatio < 5 && afterLen < 2000;
    if (!changeSizeOk) reasons.push(`Mudança muito grande (ratio=${changeRatio.toFixed(1)}, after=${afterLen} chars)`);

    const riskyPatterns = [
        /import\s+.*from\s+['"]fs['"]/,
        /import\s+.*from\s+['"]path['"]/,
        /process\.exit/,
        /class\s+\w+\s*\{/,
        /export\s+(default\s+)?function/,
    ];

    let riskyChange = false;
    for (const pattern of riskyPatterns) {
        if (pattern.test(patch.before) && !pattern.test(patch.after)) {
            riskyChange = true;
            reasons.push(`Patch remove bloco crítico: ${pattern.source}`);
            break;
        }
    }

    const destructivePatterns = [/rm\s+-rf/, /child_process/, /eval\s*\(/, /\.exec\s*\(/, /process\.env/];
    for (const pattern of destructivePatterns) {
        if (pattern.test(patch.after) && !pattern.test(patch.before)) {
            riskyChange = true;
            reasons.push(`Patch adiciona padrão perigoso: ${pattern.source}`);
            break;
        }
    }

    return { validSyntax, fileExists, changeSizeOk, riskyChange, safe: fileExists && validSyntax && changeSizeOk && !riskyChange, reasons };
}

export function applyPatch(patch: GeneratedPatch, config: AuditConfig): boolean {
    const fullPath = path.join(config.srcPath, patch.file);

    try {
        if (!fs.existsSync(fullPath)) {
            log.error('audit_error', undefined, `[AUDITOR-FIX] ❌ Arquivo não encontrado: ${fullPath}`);
            return false;
        }

        const content = fs.readFileSync(fullPath, 'utf-8');
        if (!content.includes(patch.before)) {
            log.error('audit_error', undefined, `[AUDITOR-FIX] ❌ String "before" não encontrada no arquivo`);
            return false;
        }

        const backupPath = fullPath + '.bak';
        fs.writeFileSync(backupPath, content, 'utf-8');
        log.info('backup_created', `💾 Backup criado: ${backupPath}`);

        const newContent = content.replace(patch.before, patch.after);
        if (newContent === content) {
            log.error('audit_error', undefined, `[AUDITOR-FIX] ❌ Patch não alterou o conteúdo`);
            return false;
        }

        fs.writeFileSync(fullPath, newContent, 'utf-8');
        log.info('patch_applied', `✅ Patch aplicado em: ${patch.file}`);
        return true;
    } catch (e) {
        log.error('audit_error', undefined, `[AUDITOR-FIX] ❌ Erro ao aplicar patch: ${errorMessage(e)}`);
        try {
            const backupPath = fullPath + '.bak';
            if (fs.existsSync(backupPath)) {
                fs.writeFileSync(fullPath, fs.readFileSync(backupPath, 'utf-8'), 'utf-8');
                log.info('backup_restored', `🔄 Restaurado do backup: ${fullPath}`);
            }
        } catch (restoreError) {
            log.error('audit_error', undefined, `[AUDITOR-FIX] ❌ Falha ao restaurar backup: ${restoreError}`);
        }
        return false;
    }
}

function markFindingFixed(findingId: number, db: Database.Database): void {
    db.prepare('UPDATE audit_findings SET fixed = 1 WHERE id = ?').run(findingId);
    log.info('finding_fixed', `📝 Finding #${findingId} marcado como corrigido`);
}

function logFix(findingId: number, result: 'applied' | 'rejected', reason: string, fixLogPath: string): void {
    try {
        const logDir = path.dirname(fixLogPath);
        if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
        const logLine = `[${new Date().toISOString()}] finding=#${findingId} result=${result} reason="${reason.replace(/"/g, '\\"')}"\n`;
        fs.appendFileSync(fixLogPath, logLine, 'utf-8');
    } catch (e) {
        log.error('audit_error', undefined, `[AUDITOR-FIX] Erro ao escrever log: ${e}`);
    }
}
