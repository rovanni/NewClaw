/**
 * organize_workspace — Organiza o workspace em subpastas por grupos de artefatos.
 *
 * Comportamento:
 *   - SEMPRE executa movimentações (sem dry_run implícito — bug histórico removido).
 *   - Para previewing sem modificações, use analyze_workspace_groups.
 *
 * Regras:
 *   - Só move arquivos que estão na raiz do workspace (não arquivos já em subpastas)
 *   - Reutiliza discoverGroups de analyze_workspace_groups (sem duplicar lógica)
 *   - Chama refreshWorkspaceIndex após execução para manter core_workspace atualizado
 *   - Salva estado em workspace/.newclaw/artifact_groups.json
 *
 * Separação semântica:
 *   analyze_workspace_groups → somente análise, sem mover nada
 *   organize_workspace       → sempre executa movimentações reais
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
    description = 'USE ESTA TOOL quando o usuário pedir para organizar, arrumar ou reorganizar o workspace. Agrupa arquivos da raiz em subpastas automaticamente. SEMPRE executa as movimentações reais. Para visualizar o plano sem mover arquivos, use analyze_workspace_groups primeiro.';
    parameters = {
        type: 'object' as const,
        properties: {},
        required: [],
    };

    constructor(
        private readonly db: SqlDb,
        private readonly memory?: MemoryManager,
    ) {}

    async execute(args: Record<string, unknown>): Promise<ToolResult> {
        const workspaceDir = path.resolve(process.env.WORKSPACE_DIR || './workspace');

        // Aviso de compatibilidade para args legados
        if (args.dry_run === true) {
            log.warn(
                `[WORKSPACE-ORGANIZE] dry_run=true foi passado mas é ignorado — organize_workspace` +
                ` sempre executa. Use analyze_workspace_groups para preview sem modificações.`
            );
        }

        if (!fs.existsSync(workspaceDir)) {
            return { success: false, output: '', error: 'Workspace não encontrado.' };
        }

        // ── Descoberta ────────────────────────────────────────────────────────
        const files = scanWorkspace(workspaceDir);
        if (files.length === 0) {
            log.info(`[WORKSPACE-ORGANIZE] workspace_dir=${workspaceDir} files=0 action=skip reason=empty_workspace`);
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

        const groups = discoverGroups(files, goalRows, workspaceDir);

        // ── Filtrar: apenas arquivos na raiz ──────────────────────────────────
        const rootFiles = new Set(
            files.filter(f => !f.relativePath.includes('/')).map(f => f.relativePath)
        );

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
        const groupsWithRootFiles = groups.filter(g => g.files.some(f => rootFiles.has(f)));

        log.info(
            `[WORKSPACE-ORGANIZE]` +
            ` workspace_dir=${workspaceDir}` +
            ` total_files=${files.length}` +
            ` root_files=${rootFiles.size}` +
            ` groups_detected=${groups.length}` +
            ` groups_with_root_files=${groupsWithRootFiles.length}` +
            ` moves_planned=${moves.length}` +
            ` ungrouped_root=${ungroupedRoot.length}`
        );

        if (moves.length === 0) {
            log.info(`[WORKSPACE-ORGANIZE-RESULT] success=true files_moved=0 directories_created=0 reason=already_organized`);
            return {
                success: true,
                output: `✅ Workspace já organizado — nenhum arquivo na raiz para mover. Grupos identificados: ${groups.length}. Arquivos total: ${files.length}.`,
            };
        }

        // ── Executar movimentação ─────────────────────────────────────────────
        let moved = 0;
        let directoriesCreated = 0;
        const errors: string[] = [];
        const createdDirs = new Set<string>();

        for (const move of moves) {
            const fromAbs = path.join(workspaceDir, move.from);
            const toAbs = path.join(workspaceDir, move.to);
            try {
                if (!fs.existsSync(fromAbs)) {
                    log.warn(`[WORKSPACE-ORGANIZE] move_skipped from="${move.from}" reason=file_not_found`);
                    continue;
                }
                const toDir = path.dirname(toAbs);
                if (!createdDirs.has(toDir)) {
                    const existed = fs.existsSync(toDir);
                    fs.mkdirSync(toDir, { recursive: true });
                    if (!existed) {
                        directoriesCreated++;
                        createdDirs.add(toDir);
                    }
                }
                fs.renameSync(fromAbs, toAbs);
                moved++;
                log.info(
                    `[WORKSPACE-ORGANIZE] moved="${move.from}" → "${move.to}" group=${move.group}`
                );
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
                    directories_created: directoriesCreated,
                }, null, 2),
                'utf-8'
            );
        } catch { /* não crítico */ }

        log.info(
            `[WORKSPACE-ORGANIZE-RESULT]` +
            ` success=${errors.length === 0}` +
            ` files_moved=${moved}` +
            ` moves_planned=${moves.length}` +
            ` directories_created=${directoriesCreated}` +
            ` errors=${errors.length}`
        );

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
