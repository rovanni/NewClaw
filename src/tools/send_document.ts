import { ToolExecutor, ToolResult } from '../loop/agentLoopTypes';
import path from 'path';
import fs from 'fs';
import { resolvePath } from '../utils/crossPlatform';
import { MessageBus } from '../channels/MessageBus';
import { DiscordAdapter } from '../channels/DiscordAdapter';
import { errorMessage } from '../shared/errors';
import { createLogger } from '../shared/AppLogger';

const log = createLogger('SendDocumentTool');


export class SendDocumentTool implements ToolExecutor {
    name = 'send_document';
    description = 'Enviar um arquivo como documento ao usuário. Suporta Telegram, Discord e o chat do Dashboard web. Caminhos relativos são resolvidos a partir do workspace.';
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

    async execute(args: Record<string, any>): Promise<ToolResult> {
        const { file_path, caption, filename } = args;

        if (!file_path) {
            return { success: false, output: '', error: 'file_path é obrigatório.' };
        }

        const workspaceDir = path.resolve(process.env.WORKSPACE_DIR ?? path.join(process.cwd(), 'workspace'));
        const { resolved: resolvedPath, error: pathError } = resolvePath(file_path);
        log.info(`[ARTIFACT-PATH] tool=send_document requested="${file_path}" resolved="${resolvedPath}" workspace_dir="${workspaceDir}" canonical=${resolvedPath.startsWith(workspaceDir)} exists=${fs.existsSync(resolvedPath)}`);
        if (pathError) return { success: false, output: '', error: pathError };

        if (!fs.existsSync(resolvedPath)) {
            return { success: false, output: '', error: `Arquivo não encontrado: ${resolvedPath}` };
        }

        if (this.channel === 'discord') {
            return this.sendToDiscord(resolvedPath, this.chatId, caption, filename);
        } else if (this.channel === 'web') {
            return this.sendToWeb(resolvedPath, this.chatId, caption, filename);
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

    private async sendToWeb(resolvedPath: string, chatId: string, caption?: string, filename?: string): Promise<ToolResult> {
        const stats = fs.statSync(resolvedPath);
        // Mesmo limite do upload de anexos do dashboard (chat.ts multer) — o arquivo trafega
        // como base64 dentro do JSON de resposta (ver WebChannelAdapter), sem endpoint de
        // streaming próprio, então mantemos o mesmo teto pra não gerar payloads gigantes.
        const MAX_WEB_ATTACHMENT_BYTES = 20 * 1024 * 1024;
        if (stats.size > MAX_WEB_ATTACHMENT_BYTES) {
            return { success: false, output: '', error: `Arquivo excede 20MB (limite do chat do Dashboard web): ${(stats.size / 1024 / 1024).toFixed(1)}MB` };
        }

        if (!chatId) {
            return { success: false, output: '', error: 'Contexto de sessão web incompleto.' };
        }

        const displayName = filename || path.basename(resolvedPath);

        try {
            const fileBuffer = fs.readFileSync(resolvedPath);
            await this.bus.sendDocument('web', chatId, fileBuffer, displayName, caption);
            return { success: true, output: `✅ Documento "${displayName}" anexado à resposta do chat.` };
        } catch (error) {
            return { success: false, output: '', error: `Erro ao anexar documento no chat web: ${errorMessage(error)}` };
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
