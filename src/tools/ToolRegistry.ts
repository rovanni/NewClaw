/**
 * ToolRegistry — Registro central de ferramentas do NewClaw
 */

import { ToolExecutor, ToolResult } from '../loop/AgentLoop';
import { createLogger } from '../shared/AppLogger';
const log = createLogger('Toolregistry');

export class ToolRegistry {
    private tools: Map<string, ToolExecutor> = new Map();

    register(tool: ToolExecutor): void {
        if (this.tools.has(tool.name)) {
            log.warn(`Tool "${tool.name}" already registered, skipping duplicate.`);
            return;
        }
        this.tools.set(tool.name, tool);
    }

    get(name: string): ToolExecutor | undefined {
        return this.tools.get(name);
    }

    getAll(): ToolExecutor[] {
        return Array.from(this.tools.values()).map(t => ({ ...t }));
    }

    has(name: string): boolean {
        return this.tools.has(name);
    }

    unregister(name: string): boolean {
        return this.tools.delete(name);
    }

    getDefinitions() {
        return this.getAll().map(t => ({
            name: t.name,
            description: t.description,
            parameters: t.parameters
        }));
    }
}