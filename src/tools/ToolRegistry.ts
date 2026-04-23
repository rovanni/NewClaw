/**
 * ToolRegistry — Registro central de ferramentas do NewClaw
 */

import { ToolExecutor, ToolResult } from '../loop/AgentLoop';

export class ToolRegistry {
    private tools: Map<string, ToolExecutor> = new Map();

    register(tool: ToolExecutor): void {
        this.tools.set(tool.name, tool);
    }

    get(name: string): ToolExecutor | undefined {
        return this.tools.get(name);
    }

    getAll(): ToolExecutor[] {
        return Array.from(this.tools.values());
    }

    getDefinitions() {
        return this.getAll().map(t => ({
            name: t.name,
            description: t.description,
            parameters: t.parameters
        }));
    }
}