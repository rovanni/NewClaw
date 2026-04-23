/**
 * send_document — Enviar documentos/arquivos pelo Telegram
 *
 * Suporta envio de qualquer arquivo (HTML, PDF, PNG, etc.)
 * como documento do Telegram.
 */

import { ToolExecutor, ToolResult } from '../loop/AgentLoop';
import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';

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
            console.log(`[send_document] ERRO: contexto não configurado. chatId=${this.chatId}, botToken=${this.botToken ? "SET" : "EMPTY"}`);
            return { success: false, output: '', error: 'Contexto do Telegram não configurado.' };
        }

        // Build curl command
        const telegramUrl = `https://api.telegram.org/bot${this.botToken}/sendDocument`;
        const displayName = filename || path.basename(resolvedPath);
        const captionText = caption || '';

        let cmd = `curl -s -F "chat_id=${this.chatId}" -F "document=@${resolvedPath}"`;

        // Set filename via multipart
        cmd += ` -F "filename=${displayName}"`;

        if (captionText) {
            // Escape quotes in caption
            const escapedCaption = captionText.replace(/'/g, "'\\''").replace(/"/g, '\\"');
            cmd += ` -F "caption=${escapedCaption}"`;
        }

        cmd += ` "${telegramUrl}"`;

        try {
            const result = execSync(cmd, {
                timeout: 30000,
                maxBuffer: 1024 * 1024
            }).toString();

            // Check for Telegram API errors
            try {
                const response = JSON.parse(result);
                if (response.ok) {
                    const docName = response.result?.document?.file_name || displayName;
                    const docSize = response.result?.document?.file_size
                        ? `(${(response.result.document.file_size / 1024).toFixed(1)}KB)`
                        : '';
                    return {
                        success: true,
                        output: `✅ Documento "${docName}" ${docSize} enviado com sucesso.`
                    };
                } else {
                    return {
                        success: false,
                        output: '',
                        error: `Telegram API error: ${response.description || 'Unknown error'}`
                    };
                }
            } catch {
                // If response is not JSON, check for common errors
                if (result.includes('error_code') || result.includes('Bad Request')) {
                    return { success: false, output: '', error: `Telegram error: ${result.slice(0, 200)}` };
                }
                // Assume success if not JSON error
                return { success: true, output: `✅ Documento "${displayName}" enviado.` };
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