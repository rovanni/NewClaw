import fs from 'fs';
import path from 'path';
import { createLogger } from '../../shared/AppLogger';
import { errorMessage } from '../../shared/errors';
import { AuditConfig, AuditFinding, LLMFinding } from './types';

const log = createLogger('AuditCodeChecker');

export async function auditCode(
    config: AuditConfig,
    callOllama: (prompt: string) => Promise<string>
): Promise<AuditFinding[]> {
    const findings: AuditFinding[] = [];
    const srcPath = config.srcPath;
    if (!fs.existsSync(srcPath)) return findings;

    const files = getSourceFiles(srcPath);
    const shuffled = files.sort(() => Math.random() - 0.5);
    const filesToAudit = shuffled.slice(0, 10);

    for (const file of filesToAudit) {
        try {
            const content = fs.readFileSync(file, 'utf-8');
            const fileFindings = await analyzeCodeWithLLM(file, content, srcPath, callOllama);
            findings.push(...fileFindings);
        } catch (e) {
            findings.push({
                severity: 'warning',
                category: 'code',
                file,
                title: 'Erro ao ler arquivo',
                description: errorMessage(e),
                autoFixable: false
            });
        }
    }

    return findings;
}

function getSourceFiles(dir: string): string[] {
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

async function analyzeCodeWithLLM(
    filePath: string,
    content: string,
    srcPath: string,
    callOllama: (prompt: string) => Promise<string>
): Promise<AuditFinding[]> {
    const relativePath = path.relative(srcPath, filePath);

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
        log.info('file_analysis_start', `🤖 LLM analisando ${relativePath}...`);
        const response = await callOllama(prompt);
        log.info('file_analysis_complete', `✅ ${relativePath} analisado`);
        const jsonMatch = response.match(/\{[\s\S]*\}/);
        if (!jsonMatch) return [];

        const parsed = JSON.parse(jsonMatch[0]);
        return (parsed.findings || []).map((f: LLMFinding) => ({
            severity: (f.severity || 'info') as AuditFinding['severity'],
            category: 'code' as const,
            file: relativePath,
            line: f.line,
            title: f.title || 'Issue found',
            description: f.description || '',
            suggestion: f.suggestion,
            autoFixable: f.autoFixable || false,
            riskLevel: (f.riskLevel || 'medium') as AuditFinding['riskLevel']
        }));
    } catch (_e) {
        return [];
    }
}
