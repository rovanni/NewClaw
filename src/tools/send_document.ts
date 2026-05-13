import { ToolExecutor, ToolResult } from '../loop/AgentLoop';
import path from 'path';
import fs from 'fs';
import { createLogger } from '../shared/AppLogger';
import { MessageBus } from '../channels/MessageBus';
import { DiscordAdapter } from '../channels/DiscordAdapter';

const log = createLogger('SendDocument');

export class SendDocumentTool implements ToolExecutor {
    name = 'send_document';
    description = 'Enviar um arquivo como documento. Suporta Telegram e Discord. Caminhos relativos são resolvidos a partir do workspace.';
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
    private botToken: string = '';
    private channel: string = 'telegram';
    private bus: MessageBus;

    constructor(bus: MessageBus) {
        this.bus = bus;
    }

    setContext(chatId: string, botToken: string, channel?: string): void {
        this.chatId = chatId;
        this.botToken = botToken;
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

        if (this.channel === 'discord') {
            return this.sendToDiscord(resolvedPath, this.chatId, caption, filename);
        } else {
            return this.sendToTelegram(resolvedPath, this.chatId, this.botToken, caption, filename);
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
        } catch (error: any) {
            return { success: false, output: '', error: `Erro Discord: ${error.message}` };
        }
    }

    private async sendToTelegram(resolvedPath: string, chatId: string, botToken: string, caption?: string, filename?: string): Promise<ToolResult> {
        const stats = fs.statSync(resolvedPath);
        if (stats.size > 50 * 1024 * 1024) {
            return { success: false, output: '', error: 'Arquivo excede 50MB (limite Telegram).' };
        }

        if (!chatId || !botToken) {
            return { success: false, output: '', error: 'Contexto Telegram incompleto.' };
        }

        const displayName = filename || path.basename(resolvedPath);

        try {
            const fileBuffer = fs.readFileSync(resolvedPath);
            const formData = new FormData();
            formData.append('chat_id', chatId);
            formData.append('document', new File([fileBuffer], displayName));
            if (caption) formData.append('caption', caption.slice(0, 1024));

            const response = await fetch(`https://api.telegram.org/bot${botToken}/sendDocument`, {
                method: 'POST',
                body: formData,
                signal: AbortSignal.timeout(35000),
            });

            const result = await response.json() as any;
            if (result.ok) {
                return { success: true, output: `✅ Documento "${displayName}" enviado ao Telegram.` };
            } else {
                return { success: false, output: '', error: `Telegram error: ${result.description}` };
            }
        } catch (error: any) {
            return { success: false, output: '', error: `Erro Telegram: ${error.message}` };
        }
    }
}