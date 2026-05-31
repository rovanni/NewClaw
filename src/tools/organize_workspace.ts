/**
 * organize_workspace — Organiza o workspace em subpastas por grupos de artefatos.
 *
 * Comportamento:
 *   - dry_run=true (padrão): mostra plano sem mover nada
 *   - dry_run=false: executa criação de pastas + renomeação
 *
 * Regras:
 *   - Só move arquivos que estão na raiz do workspace (não arquivos já em subpastas)
 *   - Reutiliza discoverGroups de analyze_workspace_groups (sem duplicar lógica)
 *   - Chama refreshWorkspaceIndex após execução para manter core_workspace atualizado
 *   - Salva estado em workspace/.newclaw/artifact_groups.json
 */

import { ToolExecutor, ToolResult } from '../loop/AgentLoop';
import fs from 'fs';
import path from 'path';
import { createLogger } from '../shared/AppLogger';
import { scanWorkspace, discoverGroups } from './analyze_workspace_groups';
import type { MemoryManager } from '../memory/MemoryManager';

const log = createLogger('OrganizeWorkspace');

type SqlDb = {
    prepare(sql: string): { all(...params: unknown[]): unknown[] };
};

export class OrganizeWorkspaceTool implements ToolExecutor {
    name = 'organize_workspace';
    description = 'USE ESTA TOOL quando o usuário pedir para organizar, arrumar ou reorganizar o workspace. Agrupa arquivos relacionados em subpastas automaticamente. dry_run=true (padrão): mostra o plano sem mover nada. dry_run=false: executa. NÃO use list_workspace+write para isso — use esta tool diretamente.';
    parameters = {
        type: 'object' as const,
        properties: {
            dry_run: {
                type: 'boolean',
                description: 'Se true (padrão), exibe o plano sem mover arquivos. Se false, executa.',
            },
        },
        required: [],
    };

    constructor(
        private readonly db: SqlDb,
        private readonly memory?: MemoryManager,
    ) {}

    async execute(args: Record<string, unknown>): Promise<ToolResult> {
        const dryRun = args.dry_run !== false; // default: true
        const workspaceDir = path.resolve(process.env.WORKSPACE_DIR || './workspace');

        if (!fs.existsSync(workspaceDir)) {
            return { success: false, output: '', error: 'Workspace não encontrado.' };
        }

        // ── Descoberta ────────────────────────────────────────────────────────
        const files = scanWorkspace(workspaceDir);
        if (files.length === 0) {
            return { success: true, output: 'Workspace vazio — nada a organizar.' };
        }

        let goalRows: Array<{ id: string; attempts: string | null; user_intent: string; created_at: number }> = [];
        try {
            goalRows = this.db.prepare(
                `SELECT id, attempts, user_intent, created_at FROM goals
                 WHERE status IN ('completed', 'failed', 'abandoned')
                 ORDER BY created_at DESC LIMIT 200`
            ).all() as typeof goalRows;
        } catch { /* H1 indisponível — continua com H2 e H3 */ }

        const groups = discoverGroups(files, goalRows);

        // ── Filtrar: apenas arquivos na raiz ──────────────────────────────────
        const rootFiles = new Set(
            files.filter(f => !f.relativePath.includes('/')).map(f => f.relativePath)
        );

        // moves: apenas arquivos raiz que pertencem a algum grupo
        const moves: Array<{ from: string; to: string; group: string }> = [];
        for (const group of groups) {
            for (const file of group.files) {
                if (rootFiles.has(file)) {
                    moves.push({
                        from: file,
                        to: `${group.name}/${path.basename(file)}`,
                        group: group.name,
                    });
                }
            }
        }

        const movedSet = new Set(moves.map(m => m.from));
        const ungroupedRoot = [...rootFiles].filter(f => !movedSet.has(f));

        // ── Montar saída ──────────────────────────────────────────────────────
        const groupsWithRootFiles = groups.filter(g =>
            g.files.some(f => rootFiles.has(f))
        );

        if (moves.length === 0) {
            return { success: true, output: `✅ Workspace já organizado — nenhum arquivo na raiz para mover. Grupos identificados: ${groups.length}. Arquivos total: ${files.length}.` };
        }

        if (dryRun) {
            const lines: string[] = [];
            lines.push(`📊 *Análise: ${groupsWithRootFiles.length} grupo(s) • ${files.length} arquivo(s) total • ${moves.length} arquivo(s) para mover (dry_run=true)*\n`);
            for (const group of groupsWithRootFiles) {
                const rootInGroup = group.files.filter(f => rootFiles.has(f));
                lines.push(`📁 *${group.name}/* (confiança: ${Math.round(group.confidence * 100)}%)`);
                for (const f of rootInGroup) {
                    lines.push(`   ├── ${path.basename(f)}`);
                }
                lines.push(`   Motivo: ${group.reasons.join(' + ')}`);
                lines.push('');
            }
            if (ungroupedRoot.length > 0) {
                lines.push(`📄 *Sem grupo (permanecem na raiz):*`);
                for (const f of ungroupedRoot) lines.push(`   • ${f}`);
                lines.push('');
            }
            lines.push(`⚠️ *dry_run=true — nenhum arquivo foi movido.*`);
            lines.push(`Para executar: chame organize_workspace com dry_run=false`);
            log.info(
                `[WORKSPACE-ORGANIZE] groups=${groupsWithRootFiles.length} files_to_move=${moves.length} dry_run=true`
            );
            return { success: true, output: lines.join('\n') };
        }

        // ── Executar movimentação ─────────────────────────────────────────────
        let moved = 0;
        const errors: string[] = [];

        for (const move of moves) {
            const fromAbs = path.join(workspaceDir, move.from);
            const toAbs = path.join(workspaceDir, move.to);
            try {
                if (!fs.existsSync(fromAbs)) continue;
                fs.mkdirSync(path.dirname(toAbs), { recursive: true });
                fs.renameSync(fromAbs, toAbs);
                moved++;
                log.info(`[WORKSPACE-ORGANIZE] moved="${move.from}" → "${move.to}" group=${move.group}`);
            } catch (err) {
                const msg = String(err);
                errors.push(`${move.from}: ${msg}`);
                log.warn(`[WORKSPACE-ORGANIZE] move_failed from="${move.from}" error="${msg}"`);
            }
        }

        // ── Atualizar índice do workspace ─────────────────────────────────────
        if (this.memory) {
            try {
                const { refreshWorkspaceIndex } = await import('../core/agentMediaHandlers');
                refreshWorkspaceIndex(this.memory);
            } catch { /* não crítico */ }
        }

        // ── Persistir estado ──────────────────────────────────────────────────
        try {
            const metaDir = path.join(workspaceDir, '.newclaw');
            fs.mkdirSync(metaDir, { recursive: true });
            fs.writeFileSync(
                path.join(metaDir, 'artifact_groups.json'),
                JSON.stringify({
                    groups,
                    ungrouped: ungroupedRoot,
                    executed_at: new Date().toISOString(),
                    files_moved: moved,
                }, null, 2),
                'utf-8'
            );
        } catch { /* não crítico */ }

        log.info(
            `[WORKSPACE-ORGANIZE] groups=${groupsWithRootFiles.length} files_moved=${moved} dry_run=false`
        );

        // Sumário na primeira linha para sobreviver ao truncamento de 300 chars no GoalAttempt
        const execLines: string[] = [];
        execLines.push(`✅ *Organização concluída: ${moved} arquivo(s) movido(s) em ${groupsWithRootFiles.length} grupo(s).*`);
        if (errors.length > 0) execLines.push(`⚠️ Erros: ${errors.join('; ')}`);
        execLines.push('');
        for (const group of groupsWithRootFiles) {
            const rootInGroup = group.files.filter(f => rootFiles.has(f));
            if (rootInGroup.length === 0) continue;
            execLines.push(`📁 ${group.name}/ — ${rootInGroup.length} arquivo(s) movido(s)`);
        }
        if (ungroupedRoot.length > 0) {
            execLines.push(`📄 Na raiz (sem grupo): ${ungroupedRoot.length} arquivo(s)`);
        }

        return { success: true, output: execLines.join('\n') };
    }
}
