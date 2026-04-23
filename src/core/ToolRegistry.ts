/**
 * ToolRegistry — Registro centralizado de tools com enable/disable
 */

import { ToolExecutor } from '../loop/AgentLoop';

interface ToolEntry {
    tool: ToolExecutor;
    enabled: boolean;
    dangerous: boolean;  // ex: exec_command
}

class ToolRegistryClass {
    private tools: Map<string, ToolEntry> = new Map();

    register(tool: ToolExecutor, options?: { dangerous?: boolean }): void {
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
        return Array.from(this.tools.values());
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