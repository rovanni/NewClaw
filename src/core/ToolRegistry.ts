/**
 * ToolRegistry — Registro centralizado de tools com enable/disable
 */

import { ToolExecutor } from '../loop/agentLoopTypes';
import { createLogger } from '../shared/AppLogger';
import { permissionRegistry } from './PermissionRegistry';
import { isReadOnlyExecCommand } from '../tools/exec_command';
const log = createLogger('Toolregistry');

interface ToolEntry {
    tool: ToolExecutor;
    enabled: boolean;
    dangerous: boolean;  // ex: exec_command
}

export class ToolRegistryClass {
    private tools: Map<string, ToolEntry> = new Map();

    register(tool: ToolExecutor, options?: { dangerous?: boolean }): void {
        if (this.tools.has(tool.name)) {
            log.warn(`Tool "${tool.name}" already registered, skipping duplicate.`);
            return;
        }
        this.tools.set(tool.name, {
            tool,
            enabled: true,
            dangerous: options?.dangerous || false
        });
    }

    get(name: string): ToolExecutor | undefined {
        const entry = this.tools.get(name);
        return entry?.enabled ? entry.tool : undefined;
    }

    getAll(): ToolEntry[] {
        return Array.from(this.tools.values()).map(e => ({ ...e }));
    }

    getEnabled(): ToolExecutor[] {
        return Array.from(this.tools.values())
            .filter(e => e.enabled)
            .map(e => e.tool);
    }

    enable(name: string): boolean {
        const entry = this.tools.get(name);
        if (entry) { entry.enabled = true; return true; }
        return false;
    }

    disable(name: string): boolean {
        const entry = this.tools.get(name);
        if (entry) { entry.enabled = false; return true; }
        return false;
    }

    isEnabled(name: string): boolean {
        return this.tools.get(name)?.enabled || false;
    }

    isDangerous(name: string): boolean {
        return this.tools.get(name)?.dangerous || false;
    }

    /**
     * Ponto ÚNICO da pergunta "esta chamada precisa de autorização humana?" (ADR-005).
     *
     * Existe aqui, e não dentro de um caminho de execução, porque a promessa do modo SAFE é do
     * sistema inteiro: `AgentLoop` (turno conversacional) e `GoalExecutionLoop` (step de plano)
     * consultam esta mesma função. Enquanto a regra morava no AgentLoop, um `exec_command`
     * planejado executava sem gate nenhum em modo SAFE — reproduzido em execução real
     * (04/08/2026, `docs/decisoes/ADR-005_ONDE_VIVE_O_GATE_DE_ACAO_PERIGOSA.md`).
     *
     * Decide por nome de tool, flag `dangerous` do registro, modo operacional e análise
     * estrutural do comando — nunca por texto de interface ou mensagem traduzida.
     */
    requiresAuthorization(name: string, args: Record<string, unknown>): boolean {
        return this.isDangerous(name)
            && !isReadOnlyExecCommand(name, args)
            && !permissionRegistry.can('auto_approve_exec');
    }

    has(name: string): boolean {
        return this.tools.has(name);
    }

    unregister(name: string): boolean {
        return this.tools.delete(name);
    }

    getStatus(): Array<{ name: string; description: string; enabled: boolean; dangerous: boolean }> {
        return Array.from(this.tools.entries()).map(([name, entry]) => ({
            name,
            description: entry.tool.description,
            enabled: entry.enabled,
            dangerous: entry.dangerous
        }));
    }
}

export const ToolRegistry = new ToolRegistryClass();
export type ToolRegistryType = InstanceType<typeof ToolRegistryClass>;