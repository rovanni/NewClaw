/**
 * send_document — Enviar documentos/arquivos pelo Telegram
 * 
 * MIGRATED: execSync(curl) → fetch() multipart upload (non-blocking)
 * Previous execSync blocked the event loop for up to 30s during uploads.
 * Now uses native fetch() + FormData — fully async.
 */

import { ToolExecutor, ToolResult } from '../loop/AgentLoop';
import path from 'path';
import fs from 'fs';
import { createLogger } from '../shared/AppLogger';
const log = createLogger('SendDocument');

export class SendDocumentTool implements ToolExecutor {
    name = 'send_document';
    description = 'Enviar um arquivo como documento pelo Telegram. Use para enviar HTML, PDF, imagens ou outros arquivos. O arquivo deve existir no servidor.';
    parameters = {
        type: 'object',
        properties: {
            file_path: {
                type: 'string',
                description: 'Caminho absoluto do arquivo no servidor (ex: /home/venus/newclaw/workspace/sites/river.html)'
            },
            caption: {
                type: 'string',
                description: 'Legenda do documento (opcional, máximo 1024 caracteres)'
            },
            filename: {
                type: 'string',
                description: 'Nome do arquivo como aparecerá no Telegram (opcional, padrão: nome original)'
            }
        },
        required: ['file_path']
    };

    private chatId: string = '';
    private botToken: string = '';

    setContext(chatId: string, botToken: string): void {
        this.chatId = chatId;
        this.botToken = botToken;
    }

    async execute(args: Record<string, any>): Promise<ToolResult> {
        const { file_path, caption, filename } = args;

        if (!file_path) {
            return { success: false, output: '', error: 'file_path é obrigatório.' };
        }

        // Resolve path
        const resolvedPath = path.resolve(file_path);

        // Check file exists
        if (!fs.existsSync(resolvedPath)) {
            return { success: false, output: '', error: `Arquivo não encontrado: ${resolvedPath}` };
        }

        // Check file size (max 50MB for Telegram)
        const stats = fs.statSync(resolvedPath);
        const maxSize = 50 * 1024 * 1024; // 50MB
        if (stats.size > maxSize) {
            return { success: false, output: '', error: `Arquivo muito grande: ${(stats.size / 1024 / 1024).toFixed(1)}MB (máximo 50MB)` };
        }

        if (!this.chatId || !this.botToken) {
            log.info(`[send_document] ERRO: contexto não configurado. chatId=${this.chatId}, botToken=${this.botToken ? "SET" : "EMPTY"}`);
            return { success: false, output: '', error: 'Contexto do Telegram não configurado.' };
        }

        const displayName = filename || path.basename(resolvedPath);

        try {
            const uploadStart = Date.now();
            log.info(`Uploading document "${displayName}" (${(stats.size / 1024).toFixed(1)}KB)...`);

            // Read file and send via native fetch() — fully async, no event loop blocking
            const fileBuffer = fs.readFileSync(resolvedPath);

            const formData = new FormData();
            formData.append('chat_id', this.chatId);
            formData.append('document', new File([fileBuffer], displayName));
            if (caption) {
                formData.append('caption', caption.slice(0, 1024));
            }

            const telegramUrl = `https://api.telegram.org/bot${this.botToken}/sendDocument`;

            const response = await fetch(telegramUrl, {
                method: 'POST',
                body: formData,
                signal: AbortSignal.timeout(35000),
            });

            const result = await response.json() as any;
            const uploadMs = Date.now() - uploadStart;
            log.info(`Document upload done in ${uploadMs}ms`);

            if (result.ok) {
                const docName = result.result?.document?.file_name || displayName;
                const docSize = result.result?.document?.file_size
                    ? `(${(result.result.document.file_size / 1024).toFixed(1)}KB)`
                    : '';
                return {
                    success: true,
                    output: `✅ Documento "${docName}" ${docSize} enviado com sucesso.`
                };
            } else {
                return {
                    success: false,
                    output: '',
                    error: `Telegram API error: ${result.description || 'Unknown error'}`
                };
            }
        } catch (error: any) {
            return {
                success: false,
                output: '',
                error: `Erro ao enviar documento: ${error.message}`
            };
        }
    }
}