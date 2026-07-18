/**
 * analyze_workspace_groups — Descobre grupos de artefatos relacionados no workspace.
 *
 * Heurísticas (aplicadas via union-find com sistema de score por par):
 *   H1 — Mesmo Goal: arquivos criados no mesmo goal (matched por caminho relativo completo)
 *   H2 — Similaridade de tokens: nomes de arquivo com overlap de tokens >= TOKEN_THRESHOLD
 *   H3 — Janela temporal: arquivos modificados num intervalo de 3 minutos (apenas reforça H1/H2)
 *
 * Sistema de score por par (MERGE_THRESHOLD = 0.30):
 *   same_goal      = +0.30   (par explicitamente criado pelo mesmo goal)
 *   same_directory = +0.30   (arquivos no mesmo diretório)
 *   token_similarity         (valor real do Jaccard, escalonado)
 *   temporal_window = +0.17  (arquivos modificados na mesma janela temporal)
 *
 * Não move arquivos. Apenas identifica grupos e salva em workspace/.newclaw/artifact_groups.json.
 */

import { ToolExecutor, ToolResult } from '../loop/agentLoopTypes';
import fs from 'fs';
import path from 'path';
import { createLogger } from '../shared/AppLogger';

const log = createLogger('AnalyzeWorkspaceGroups');

// ── Constantes de score ───────────────────────────────────────────────────────

const SCORE_SAME_GOAL      = 0.30;
const SCORE_SAME_DIR       = 0.30;
const SCORE_TEMPORAL       = 0.17;
const TOKEN_THRESHOLD      = 0.45; // Jaccard mínimo para H2 produzir contribuição de score
const MERGE_THRESHOLD      = 0.30; // score mínimo para unir dois arquivos
const WINDOW_MS            = 3 * 60 * 1000; // 3 minutos

// Grupos com mais de N arquivos são marcados como suspeitos no summary
const SUSPICIOUS_SIZE_THRESHOLD = 8;

type SqlDb = {
    prepare(sql: string): { all(...params: unknown[]): unknown[] };
};

export interface ArtifactGroup {
    id: string;
    name: string;
    files: string[];
    confidence: number;
    reasons: string[];
}

export interface FileInfo {
    relativePath: string; // '/' separators, relativo ao workspace root
    absolutePath: string;
    mtime: number;
    size: number;
}

// ── Scan completo do workspace ────────────────────────────────────────────────

export function scanWorkspace(dir: string): FileInfo[] {
    const results: FileInfo[] = [];
    function walk(current: string): void {
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(current, { withFileTypes: true }); }
        catch { return; }
        for (const entry of entries) {
            if (entry.name.startsWith('.')) continue;
            const abs = path.join(current, entry.name);
            if (entry.isDirectory()) {
                walk(abs);
            } else {
                try {
                    const stat = fs.statSync(abs);
                    results.push({
                        relativePath: path.relative(dir, abs).replace(/\\/g, '/'),
                        absolutePath: abs,
                        mtime: stat.mtimeMs,
                        size: stat.size,
                    });
                } catch { /* pula arquivo inacessível */ }
            }
        }
    }
    walk(dir);
    return results;
}

// ── Normalização de caminho para relativo ao workspace ────────────────────────
//
// Garante que paths vindos dos GoalAttempts (absolutos, relativos, ou com prefix
// "workspace/") sejam comparados pelo mesmo espaço de endereço dos FileInfo.
//
// Retorna null quando o path está fora do workspace (não deve ser linkado).
//
export function normalizeToRelative(p: string, workspaceDir: string): string | null {
    if (!p) return null;
    const normalized = p.replace(/\\/g, '/');
    if (path.isAbsolute(p)) {
        const rel = path.relative(workspaceDir, p).replace(/\\/g, '/');
        // ".." no início significa que está fora do workspace
        if (rel.startsWith('..')) return null;
        return rel;
    }
    // Tira prefix "workspace/" que alguns models geram
    return normalized.replace(/^workspace\//, '');
}

// ── Tokenização de nomes de arquivo ──────────────────────────────────────────

function tokenize(filePath: string): Set<string> {
    return new Set(
        path.basename(filePath, path.extname(filePath))
            .toLowerCase()
            .split(/[_\-\s.]+/)
            .filter(t => t.length > 2 && !/^\d+$/.test(t))
    );
}

function jaccardTokens(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 || b.size === 0) return 0;
    let intersection = 0;
    for (const t of a) if (b.has(t)) intersection++;
    const union = a.size + b.size - intersection;
    return union === 0 ? 0 : intersection / union;
}

// ── Derivar nome do grupo a partir dos tokens compartilhados ─────────────────

function deriveGroupName(files: string[]): string {
    if (files.length === 0) return 'grupo';
    const tokenSets = files.map(f => tokenize(f));
    const first = tokenSets[0];
    const common = new Set([...first].filter(t => tokenSets.every(s => s.has(t))));
    if (common.size > 0) return [...common].slice(0, 4).join('_');
    const freq = new Map<string, number>();
    for (const ts of tokenSets) for (const t of ts) freq.set(t, (freq.get(t) ?? 0) + 1);
    const sorted = [...freq.entries()].sort((a, b) => b[1] - a[1]);
    return sorted.slice(0, 3).map(([t]) => t).join('_') || 'grupo';
}

// ── Union-Find simples ────────────────────────────────────────────────────────

function makeUnionFind() {
    const parent = new Map<string, string>();
    function find(x: string): string {
        if (!parent.has(x)) parent.set(x, x);
        const p = parent.get(x)!;
        if (p !== x) { const r = find(p); parent.set(x, r); return r; }
        return x;
    }
    function union(x: string, y: string): void {
        parent.set(find(x), find(y));
    }
    function getGroups(): Map<string, string[]> {
        const groups = new Map<string, string[]>();
        for (const x of [...parent.keys()]) {
            const root = find(x);
            if (!groups.has(root)) groups.set(root, []);
            groups.get(root)!.push(x);
        }
        return groups;
    }
    return { find, union, getGroups };
}

// ── Pontuação de par (score-based merge decision) ────────────────────────────

interface PairScore {
    sameGoal: boolean;
    sameDirectory: boolean;
    jaccard: number;
    temporal: boolean;
    finalScore: number;
}

function scorePair(
    fileA: string,
    fileB: string,
    sameGoal: boolean,
    mtimeA: number,
    mtimeB: number,
    tokenA: Set<string>,
    tokenB: Set<string>,
): PairScore {
    const dirA = fileA.includes('/') ? fileA.slice(0, fileA.lastIndexOf('/')) : '';
    const dirB = fileB.includes('/') ? fileB.slice(0, fileB.lastIndexOf('/')) : '';
    const sameDirectory = dirA === dirB;
    const jaccard = jaccardTokens(tokenA, tokenB);
    const temporal = Math.abs(mtimeA - mtimeB) <= WINDOW_MS;

    let finalScore = 0;
    if (sameGoal)      finalScore += SCORE_SAME_GOAL;
    if (sameDirectory) finalScore += SCORE_SAME_DIR;
    // jaccard contribui proporcionalmente (max +0.20 quando Jaccard = 1.0)
    if (jaccard > 0)   finalScore += jaccard * 0.20;
    if (temporal)      finalScore += SCORE_TEMPORAL;

    return { sameGoal, sameDirectory, jaccard, temporal, finalScore };
}

// ── Descoberta de grupos (exportada para reutilização em organize_workspace) ──

export function discoverGroups(
    files: FileInfo[],
    goalRows: Array<{ id: string; attempts: string | null; user_intent: string; created_at: number }>,
    workspaceDir?: string,
): ArtifactGroup[] {
    if (files.length === 0) return [];

    const uf = makeUnionFind();
    const filePaths = files.map(f => f.relativePath);
    for (const fp of filePaths) uf.find(fp);

    const pairReasons = new Map<string, Set<string>>();
    const pairScores  = new Map<string, PairScore>();
    function addReason(a: string, b: string, reason: string): void {
        const key = a < b ? `${a}||${b}` : `${b}||${a}`;
        if (!pairReasons.has(key)) pairReasons.set(key, new Set());
        pairReasons.get(key)!.add(reason);
    }

    const mtimeMap   = new Map<string, number>(files.map(f => [f.relativePath, f.mtime]));
    const tokenMap   = new Map<string, Set<string>>();
    for (const f of files) tokenMap.set(f.relativePath, tokenize(f.relativePath));

    const resolvedWorkspaceDir = workspaceDir ?? (process.env.WORKSPACE_DIR ?? './workspace');

    // ── H1: Mesmo Goal (com matching por caminho relativo completo) ───────────
    //
    // Fix crítico: goalBases antes usava path.basename(), causando matches incorretos
    // entre arquivos em diretórios diferentes com o mesmo nome de arquivo.
    // Agora usamos o caminho relativo normalizado para garantir identidade real.
    //
    for (const row of goalRows) {
        if (!row.attempts) continue;
        let attempts: Array<{ toolName?: string; args?: Record<string, unknown>; result?: string }> = [];
        try { attempts = JSON.parse(row.attempts); } catch { continue; }

        const goalPaths = new Set<string>();
        for (const att of attempts) {
            if (att.result !== 'success') continue;
            if (!['write', 'edit', 'send_document'].includes(att.toolName ?? '')) continue;
            const p = String(att.args?.path ?? att.args?.file_path ?? '');
            if (!p) continue;
            const rel = normalizeToRelative(p, resolvedWorkspaceDir);
            if (rel) goalPaths.add(rel);
        }
        if (goalPaths.size < 2) continue;

        // Filtra arquivos do workspace que foram criados por este goal (match exato de caminho)
        const matched = files
            .filter(f => goalPaths.has(f.relativePath))
            .map(f => f.relativePath);

        if (matched.length < 2) continue;

        // Avaliação par-a-par com sistema de score
        for (let i = 0; i < matched.length - 1; i++) {
            for (let j = i + 1; j < matched.length; j++) {
                const fa = matched[i];
                const fb = matched[j];
                const pairKey = fa < fb ? `${fa}||${fb}` : `${fb}||${fa}`;

                const ta = tokenMap.get(fa) ?? new Set<string>();
                const tb = tokenMap.get(fb) ?? new Set<string>();
                const ps = scorePair(fa, fb, true, mtimeMap.get(fa) ?? 0, mtimeMap.get(fb) ?? 0, ta, tb);
                pairScores.set(pairKey, ps);

                const decision = ps.finalScore >= MERGE_THRESHOLD ? 'merge' : 'skip';

                log.info(
                    `[ARTIFACT-GROUP-SCORE]` +
                    ` file_a=${fa} file_b=${fb}` +
                    ` same_goal=true` +
                    ` same_directory=${ps.sameDirectory}` +
                    ` same_prefix=${ps.jaccard.toFixed(2)}` +
                    ` jaccard=${ps.jaccard.toFixed(2)}` +
                    ` temporal=${ps.temporal}` +
                    ` final_score=${ps.finalScore.toFixed(2)}` +
                    ` threshold=${MERGE_THRESHOLD}` +
                    ` decision=${decision}` +
                    ` goal_id=${row.id}`
                );

                if (decision === 'merge') {
                    const rootBefore = uf.find(fa);
                    const alreadySame = rootBefore === uf.find(fb);
                    uf.union(fa, fb);
                    addReason(fa, fb, 'same_goal');
                    if (ps.sameDirectory) addReason(fa, fb, 'same_directory');
                    if (!alreadySame) {
                        log.info(
                            `[ARTIFACT-GROUP-UNION]` +
                            ` file_a=${fa} file_b=${fb}` +
                            ` reason=same_goal` +
                            ` score=${ps.finalScore.toFixed(2)}` +
                            ` union_source=H1_goal_id:${row.id}`
                        );
                    }
                }
            }
        }
    }

    // ── H2: Similaridade de tokens ────────────────────────────────────────────
    // Threshold 0.45 exige que >50% dos tokens únicos sejam compartilhados.
    // Arquivos com 1 token único (main.js, style.css) são ignorados — seriam
    // "pontes" transitivas entre grupos não relacionados.
    for (let i = 0; i < filePaths.length; i++) {
        const ta = tokenMap.get(filePaths[i])!;
        if (ta.size < 2) continue;
        for (let j = i + 1; j < filePaths.length; j++) {
            const tb = tokenMap.get(filePaths[j])!;
            if (tb.size < 2) continue;
            const similarity = jaccardTokens(ta, tb);
            if (similarity >= TOKEN_THRESHOLD) {
                const fa = filePaths[i];
                const fb = filePaths[j];
                const pairKey = fa < fb ? `${fa}||${fb}` : `${fb}||${fa}`;

                const existingScore = pairScores.get(pairKey);
                const ps = existingScore ?? scorePair(fa, fb, false, mtimeMap.get(fa) ?? 0, mtimeMap.get(fb) ?? 0, ta, tb);

                const rootBefore = uf.find(fa);
                const alreadySame = rootBefore === uf.find(fb);
                uf.union(fa, fb);
                addReason(fa, fb, 'same_prefix');
                if (!alreadySame) {
                    log.info(
                        `[ARTIFACT-GROUP-SCORE]` +
                        ` file_a=${fa} file_b=${fb}` +
                        ` same_goal=${ps.sameGoal}` +
                        ` same_directory=${ps.sameDirectory}` +
                        ` same_prefix=${similarity.toFixed(2)}` +
                        ` jaccard=${similarity.toFixed(2)}` +
                        ` temporal=${ps.temporal}` +
                        ` final_score=${(ps.finalScore + similarity * 0.20).toFixed(2)}` +
                        ` threshold=${MERGE_THRESHOLD}` +
                        ` decision=merge`
                    );
                    log.info(
                        `[ARTIFACT-GROUP-UNION]` +
                        ` file_a=${fa} file_b=${fb}` +
                        ` reason=token_similarity` +
                        ` score=${similarity.toFixed(2)}` +
                        ` union_source=H2_jaccard`
                    );
                }
            }
        }
    }

    // ── H3: Janela temporal — apenas reforça grupos H1/H2, não cria novos ─────
    for (const [pairKey, reasons] of pairReasons) {
        if (reasons.has('temporal_window')) continue;
        const [a, b] = pairKey.split('||');
        const ma = mtimeMap.get(a) ?? 0;
        const mb = mtimeMap.get(b) ?? 0;
        if (Math.abs(ma - mb) <= WINDOW_MS) {
            reasons.add('temporal_window');
        }
    }

    // ── Construir grupos finais ───────────────────────────────────────────────
    const rawGroups = uf.getGroups();
    const groups: ArtifactGroup[] = [];

    for (const [, members] of rawGroups) {
        if (members.length < 2) continue;

        const reasonSet = new Set<string>();
        for (let i = 0; i < members.length; i++) {
            for (let j = i + 1; j < members.length; j++) {
                const key = members[i] < members[j]
                    ? `${members[i]}||${members[j]}`
                    : `${members[j]}||${members[i]}`;
                for (const r of pairReasons.get(key) ?? []) reasonSet.add(r);
            }
        }
        const reasons = [...reasonSet];

        let confidence = 0;
        if (reasons.includes('same_goal'))       confidence += 0.50;
        if (reasons.includes('same_directory'))  confidence += 0.20;
        if (reasons.includes('same_prefix'))     confidence += 0.33;
        if (reasons.includes('temporal_window')) confidence += 0.17;
        confidence = Math.min(confidence, 0.99);

        const name = deriveGroupName(members);
        const gid = `group_${groups.length}_${name.slice(0, 12)}`;

        groups.push({
            id: gid,
            name,
            files: members.slice().sort(),
            confidence,
            reasons,
        });

        log.info(
            `[ARTIFACT-GROUP] group=${name} files=${members.length} confidence=${confidence.toFixed(2)} reason=${reasons.join('+')}`
        );
    }

    const sorted = groups.sort((a, b) => b.confidence - a.confidence);

    // ── [ARTIFACT-GROUP-SUMMARY] ─────────────────────────────────────────────
    const groupSizes = sorted.map(g => g.files.length);
    const largestGroup = groupSizes.length > 0 ? Math.max(...groupSizes) : 0;
    const avgSize = groupSizes.length > 0 ? groupSizes.reduce((a, b) => a + b, 0) / groupSizes.length : 0;
    const suspiciousGroups = sorted.filter(g => g.files.length >= SUSPICIOUS_SIZE_THRESHOLD);

    log.info(
        `[ARTIFACT-GROUP-SUMMARY]` +
        ` groups=${sorted.length}` +
        ` total_files_grouped=${sorted.reduce((s, g) => s + g.files.length, 0)}` +
        ` largest_group=${largestGroup}` +
        ` average_group_size=${avgSize.toFixed(1)}` +
        ` suspicious_groups=${suspiciousGroups.length}` +
        (suspiciousGroups.length > 0
            ? ` suspicious_names=${suspiciousGroups.map(g => g.name).join(',')}`
            : '')
    );

    if (suspiciousGroups.length > 0) {
        log.warn(
            `[ARTIFACT-GROUP-SUMMARY] ⚠️ ${suspiciousGroups.length} grupo(s) suspeito(s) com ≥${SUSPICIOUS_SIZE_THRESHOLD} arquivos` +
            ` — possível contaminação por agrupamento transitivo.` +
            ` Grupos: ${suspiciousGroups.map(g => `${g.name}(${g.files.length})`).join(', ')}`
        );
    }

    return sorted;
}

// ── Tool ─────────────────────────────────────────────────────────────────────

export class AnalyzeWorkspaceGroupsTool implements ToolExecutor {
    name = 'analyze_workspace_groups';
    description = 'Agrupa artefatos do workspace do usuário (documentos, slides, HTML, PDFs, imagens) por projeto/objetivo — USO EXCLUSIVO para organização de arquivos gerados pelo agente. NÃO analisa código-fonte, dependências de bibliotecas ou referências a APIs (ex: ollama, openai). Para buscar padrões em código, use exec_command com grep. Não move arquivos. Retorna JSON com grupos e confiança.';
    parameters = {
        type: 'object' as const,
        properties: {
            save: {
                type: 'boolean',
                description: 'Persiste resultado em workspace/.newclaw/artifact_groups.json (padrão: true).',
            },
        },
        required: [],
    };

    constructor(private readonly db: SqlDb) {}

    async execute(args: Record<string, unknown>): Promise<ToolResult> {
        const shouldSave = args.save !== false;
        const workspaceDir = path.resolve(process.env.WORKSPACE_DIR || './workspace');

        if (!fs.existsSync(workspaceDir)) {
            return { success: false, output: '', error: 'Workspace não encontrado.' };
        }

        const files = scanWorkspace(workspaceDir);
        if (files.length === 0) {
            return { success: true, output: JSON.stringify({ groups: [], total_files: 0 }, null, 2) };
        }

        let goalRows: Array<{ id: string; attempts: string | null; user_intent: string; created_at: number }> = [];
        try {
            goalRows = this.db.prepare(
                `SELECT id, attempts, user_intent, created_at FROM goals
                 WHERE status IN ('completed', 'failed', 'abandoned')
                 ORDER BY created_at DESC LIMIT 200`
            ).all() as typeof goalRows;
        } catch (err) {
            log.warn(`[AnalyzeWorkspaceGroups] GoalStore query skipped: ${String(err)}`);
        }

        const groups = discoverGroups(files, goalRows, workspaceDir);
        const allGrouped = new Set(groups.flatMap(g => g.files));
        const ungrouped = files.map(f => f.relativePath).filter(rp => !allGrouped.has(rp));

        const result = {
            groups,
            total_files: files.length,
            grouped_files: allGrouped.size,
            ungrouped_files: ungrouped,
            generated_at: new Date().toISOString(),
            workspace: workspaceDir,
        };

        if (shouldSave) {
            try {
                const metaDir = path.join(workspaceDir, '.newclaw');
                fs.mkdirSync(metaDir, { recursive: true });
                fs.writeFileSync(
                    path.join(metaDir, 'artifact_groups.json'),
                    JSON.stringify(result, null, 2),
                    'utf-8'
                );
            } catch (err) {
                log.warn(`[AnalyzeWorkspaceGroups] save failed: ${String(err)}`);
            }
        }

        return { success: true, output: JSON.stringify(result, null, 2) };
    }
}
