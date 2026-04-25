/**
 * thorial_graph — Query the Thorial cognitive graph from NewClaw
 * Shares memory between Thorial (Marte) and NewClaw (Venus)
 * 
 * Reads: /home/rover/.openclaw/workspace/system/graph/cognitive_graph.json
 * Also reads: /home/rover/.openclaw/workspace/MEMORY.md and memory/*.md
 */

import { ToolExecutor, ToolResult } from '../loop/AgentLoop';
import { exec } from 'child_process';

export class ThorialGraphTool implements ToolExecutor {
    name = 'thorial_graph';
    description = 'Query the Thorial cognitive graph for shared memory and knowledge. Use this BEFORE answering questions about infrastructure, servers, projects, or historical context. Available queries: search (semantic search), nodes (list nodes), info (node details).';
    parameters = {
        type: 'object',
        properties: {
            query: {
                type: 'string',
                description: 'Search query for the cognitive graph (e.g. "whisper gpu setup", "newclaw github rule", "home lab servers")'
            },
            action: {
                type: 'string',
                enum: ['search', 'nodes', 'info'],
                description: 'Action to perform: search (semantic query), nodes (list graph nodes), info (get specific node details)'
            },
            node_id: {
                type: 'string',
                description: 'Node ID for info action (e.g. "doc:WHISPER_VULKAN_SETUP")'
            }
        },
        required: ['query']
    };

    // Thorial workspace path (accessible via SSH)
    private readonly thorialWorkspace = '/home/rover/.openclaw/workspace';

    async execute(args: Record<string, any>): Promise<ToolResult> {
        const query = args.query as string;
        const action = (args.action as string) || 'search';
        const nodeId = args.node_id as string;

        if (!query && action !== 'nodes') {
            return { success: false, output: '', error: 'Query parameter is required' };
        }

        try {
            // Try local file first (if on same machine or mounted)
            // Fall back to SSH if on Venus
            const isLocal = process.env.THORIAL_LOCAL === 'true' || 
                           process.env.HOSTNAME === 'marte' || 
                           process.env.HOSTNAME === 'rover';

            if (isLocal) {
                return await this.queryLocal(query, action, nodeId);
            } else {
                return await this.querySSH(query, action, nodeId);
            }
        } catch (error: any) {
            return { success: false, output: '', error: `Graph query failed: ${error.message}` };
        }
    }

    private async queryLocal(query: string, action: string, nodeId: string): Promise<ToolResult> {
        const scriptPath = `${this.thorialWorkspace}/scripts/cognitive_context.py`;
        const cmd = action === 'nodes'
            ? `python3 ${scriptPath} --nodes "${query}"`
            : action === 'info'
            ? `python3 ${scriptPath} --info "${nodeId}"`
            : `python3 ${scriptPath} "${query}"`;

        const output = await this.execCommand(cmd);
        return { success: true, output: output.trim().slice(0, 8000) };
    }

    private async querySSH(query: string, action: string, nodeId: string): Promise<ToolResult> {
        // Query Thorial graph via SSH to Marte
        const scriptPath = `${this.thorialWorkspace}/scripts/cognitive_context.py`;
        const sshCmd = action === 'nodes'
            ? `ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no user@server5 "python3 ${scriptPath} --nodes '${query.replace(/'/g, "\\'")}'"`
            : action === 'info'
            ? `ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no user@server5 "python3 ${scriptPath} --info '${nodeId}'"`
            : `ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no user@server5 "python3 ${scriptPath} '${query.replace(/'/g, "\\'")}'"`;

        const output = await this.execCommand(sshCmd);
        return { success: true, output: output.trim().slice(0, 8000) };
    }

    private execCommand(command: string): Promise<string> {
        return new Promise((resolve, reject) => {
            exec(command, { timeout: 30000 }, (error, stdout, stderr) => {
                if (error) {
                    reject(error);
                } else {
                    resolve(stdout + (stderr ? '\n' + stderr : ''));
                }
            });
        });
    }
}