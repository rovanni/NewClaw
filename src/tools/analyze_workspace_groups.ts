/**
 * analyze_workspace_groups — Descobre grupos de artefatos relacionados no workspace.
 *
 * Heurísticas (aplicadas via union-find):
 *   H1 — Mesmo Goal: arquivos criados no mesmo goal (via GoalStore.attempts)
 *   H2 — Similaridade de tokens: nomes de arquivo com overlap de tokens >= 0.30
 *   H3 — Janela temporal: arquivos modificados num intervalo de 5 minutos
 *
 * Não move arquivos. Apenas identifica grupos e salva em workspace/.newclaw/artifact_groups.json.
 */

import { ToolExecutor, ToolResult } from '../loop/AgentLoop';
import fs from 'fs';
import path from 'path';
import { createLogger } from '../shared/AppLogger';

const log = createLogger('AnalyzeWorkspaceGroups');

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

// ── Scan completo do workspace (sem limite de linhas) ─────────────────────────

export function scanWorkspace(dir: string): FileInfo[] {
    const results: FileInfo[] = [];
    function walk(current: string): void {
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(current, { withFileTypes: true }); }
        catch { return; }
        for (const entry of entries) {
            if (entry.name.startsWith('.')) continue; // pula .newclaw e outros ocultos
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

// ── Tokenização de nomes de arquivo ──────────────────────────────────────────

function tokenize(filePath: string): Set<string> {
    return new Set(
        path.basename(filePath, path.extname(filePath))
            .toLowerCase()
            .split(/[_\-\s.]+/)
            .filter(t => t.length > 2 && !/^\d+$/.test(t)) // ignora tokens numéricos e curtos
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
    // Tokens presentes em TODOS os arquivos do grupo
    const common = new Set([...first].filter(t => tokenSets.every(s => s.has(t))));
    if (common.size > 0) return [...common].slice(0, 4).join('_');
    // Fallback: tokens mais frequentes
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

// ── Descoberta de grupos (exportada para reutilização em organize_workspace) ──

export function discoverGroups(
    files: FileInfo[],
    goalRows: Array<{ id: string; attempts: string | null; user_intent: string; created_at: number }>,
): ArtifactGroup[] {
    if (files.length === 0) return [];

    const uf = makeUnionFind();
    const filePaths = files.map(f => f.relativePath);
    for (const fp of filePaths) uf.find(fp); // inicializa todos no union-find

    // reasons[pairKey] = set de heurísticas que uniram esse par
    const pairReasons = new Map<string, Set<string>>();
    function addReason(a: string, b: string, reason: string): void {
        const key = a < b ? `${a}||${b}` : `${b}||${a}`;
        if (!pairReasons.has(key)) pairReasons.set(key, new Set());
        pairReasons.get(key)!.add(reason);
    }

    // ── H1: Mesmo Goal ────────────────────────────────────────────────────────
    for (const row of goalRows) {
        if (!row.attempts) continue;
        let attempts: Array<{ toolName?: string; args?: Record<string, unknown>; result?: string }> = [];
        try { attempts = JSON.parse(row.attempts); } catch { continue; }

        const goalBases = new Set<string>();
        for (const att of attempts) {
            if (att.result !== 'success') continue;
            if (!['write', 'edit', 'send_document'].includes(att.toolName ?? '')) continue;
            const p = String(att.args?.path ?? att.args?.file_path ?? '');
            if (p) goalBases.add(path.basename(p));
        }
        if (goalBases.size < 2) continue;

        const matched = files
            .filter(f => goalBases.has(path.basename(f.relativePath)))
            .map(f => f.relativePath);

        for (let i = 0; i < matched.length - 1; i++) {
            uf.union(matched[i], matched[i + 1]);
            addReason(matched[i], matched[i + 1], 'same_goal');
        }
    }

    // ── H2: Similaridade de tokens ────────────────────────────────────────────
    const TOKEN_THRESHOLD = 0.30;
    const tokenMap = new Map<string, Set<string>>();
    for (const f of files) tokenMap.set(f.relativePath, tokenize(f.relativePath));

    for (let i = 0; i < filePaths.length; i++) {
        const ta = tokenMap.get(filePaths[i])!;
        if (ta.size === 0) continue;
        for (let j = i + 1; j < filePaths.length; j++) {
            const tb = tokenMap.get(filePaths[j])!;
            if (tb.size === 0) continue;
            if (jaccardTokens(ta, tb) >= TOKEN_THRESHOLD) {
                uf.union(filePaths[i], filePaths[j]);
                addReason(filePaths[i], filePaths[j], 'same_prefix');
            }
        }
    }

    // ── H3: Janela temporal — apenas reforça grupos H1/H2, não cria novos ───────
    // Não usa union-find para evitar agrupamento transitivo (A→B→C mesmo que A e C
    // estejam a 10 min de distância). Só marca 'temporal_window' em pares que JÁ
    // foram unidos por H1 ou H2.
    const WINDOW_MS = 3 * 60 * 1000; // 3 minutos — janela mais conservadora
    const mtimeMap = new Map<string, number>(files.map(f => [f.relativePath, f.mtime]));
    for (const [pairKey, reasons] of pairReasons) {
        if (reasons.has('temporal_window')) continue; // já marcado
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

        // Agrega razões de todos os pares do grupo
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

        // Confiança: soma ponderada das heurísticas que contribuíram
        let confidence = 0;
        if (reasons.includes('same_goal'))       confidence += 0.50;
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
            `[ARTIFACT-GROUP] group=${name} files=${members.join(',')} confidence=${confidence.toFixed(2)} reason=${reasons.join('+')}`
        );
    }

    return groups.sort((a, b) => b.confidence - a.confidence);
}

// ── Tool ─────────────────────────────────────────────────────────────────────

export class AnalyzeWorkspaceGroupsTool implements ToolExecutor {
    name = 'analyze_workspace_groups';
    description = 'Analisa o workspace e descobre grupos de artefatos relacionados (mesmo goal, nome similar, janela temporal). Não move arquivos. Salva resultado em workspace/.newclaw/artifact_groups.json.';
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

        const groups = discoverGroups(files, goalRows);
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
