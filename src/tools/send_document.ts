import { ToolExecutor, ToolResult } from '../loop/AgentLoop';
import path from 'path';
import fs from 'fs';
import { MessageBus } from '../channels/MessageBus';
import { DiscordAdapter } from '../channels/DiscordAdapter';
import { errorMessage } from '../shared/errors';


export class SendDocumentTool implements ToolExecutor {
    name = 'send_document';
    description = 'Enviar um arquivo como documento ao usuário. Suporta Telegram e Discord. ⚠️ NUNCA envie arquivos .html — se o objetivo é entregar um PDF, passe o caminho do .pdf. Caminhos relativos são resolvidos a partir do workspace.';
    parameters = {
        type: 'object',
        properties: {
            file_path: {
                type: 'string',
                description: 'Caminho do arquivo (relativo ao workspace ou absoluto)'
            },
            caption: {
                type: 'string',
                description: 'Legenda do documento (opcional)'
            },
            filename: {
                type: 'string',
                description: 'Nome exibido do arquivo (opcional)'
            }
        },
        required: ['file_path']
    };

    private chatId: string = '';
    private channel: string = 'telegram';
    private bus: MessageBus;

    constructor(bus: MessageBus) {
        this.bus = bus;
    }

    setContext(chatId: string, channel?: string): void {
        this.chatId = chatId;
        this.channel = channel || 'telegram';
    }

    /** Resolve e normaliza caminho dentro do sandbox (workspace) */
    private resolvePath(inputPath: string): { resolved: string; error?: string } {
        const workspaceDir = process.env.WORKSPACE_DIR || path.join(process.cwd(), 'workspace');
        let expanded = inputPath;

        if (!expanded.startsWith('/') && expanded.startsWith('workspace/')) {
            expanded = expanded.slice('workspace/'.length);
        }

        if (expanded.startsWith('~/')) {
            expanded = (process.env.HOME || '/root') + expanded.slice(1);
        }

        if (path.isAbsolute(expanded)) {
            const normalized = expanded.replace(/\/workspace\/workspace\//, '/workspace/').replace(/\/workspace\/workspace$/, '/workspace');
            return { resolved: path.normalize(normalized) };
        }

        const resolved = path.resolve(workspaceDir, expanded);
        return { resolved };
    }

    async execute(args: Record<string, any>): Promise<ToolResult> {
        const { file_path, caption, filename } = args;

        if (!file_path) {
            return { success: false, output: '', error: 'file_path é obrigatório.' };
        }

        const { resolved: resolvedPath, error: pathError } = this.resolvePath(file_path);
        if (pathError) return { success: false, output: '', error: pathError };

        if (!fs.existsSync(resolvedPath)) {
            return { success: false, output: '', error: `Arquivo não encontrado: ${resolvedPath}` };
        }

        // Safety: reject .html files — the LLM should send .pdf, not .html
        if (resolvedPath.toLowerCase().endsWith('.html')) {
            return { success: false, output: '', error: `❌ RECUSADO: Tentativa de enviar arquivo .html ("${path.basename(resolvedPath)}"). Se você converteu um HTML para PDF, use o caminho do .pdf. O send_document NÃO deve enviar arquivos .html.` };
        }

        if (this.channel === 'discord') {
            return this.sendToDiscord(resolvedPath, this.chatId, caption, filename);
        } else {
            return this.sendToTelegram(resolvedPath, this.chatId, caption, filename);
        }
    }

    private async sendToDiscord(resolvedPath: string, channelId: string, caption?: string, filename?: string): Promise<ToolResult> {
        try {
            const adapter = this.bus.getAdapter('discord') as DiscordAdapter;
            if (!adapter) return { success: false, output: '', error: 'Discord adapter não disponível.' };

            const displayName = filename || path.basename(resolvedPath);
            
            await adapter.send({
                text: caption || '',
                format: 'markdown',
                attachments: [{
                    type: 'document',
                    data: resolvedPath,
                    fileName: displayName
                }]
            }, channelId);

            return { success: true, output: `✅ Documento "${displayName}" enviado com sucesso ao Discord.` };
        } catch (error) {
            return { success: false, output: '', error: `Erro Discord: ${errorMessage(error)}` };
        }
    }

    private async sendToTelegram(resolvedPath: string, chatId: string, caption?: string, filename?: string): Promise<ToolResult> {
        const stats = fs.statSync(resolvedPath);
        if (stats.size > 50 * 1024 * 1024) {
            return { success: false, output: '', error: 'Arquivo excede 50MB (limite Telegram).' };
        }

        if (!chatId) {
            return { success: false, output: '', error: 'Contexto Telegram incompleto.' };
        }

        const displayName = filename || path.basename(resolvedPath);

        try {
            const fileBuffer = fs.readFileSync(resolvedPath);
            await this.bus.sendDocument('telegram', chatId, fileBuffer, displayName, caption);
            return { success: true, output: `✅ Documento "${displayName}" enviado ao Telegram.` };
        } catch (error) {
            return { success: false, output: '', error: `Erro Telegram: ${errorMessage(error)}` };
        }
    }
}
