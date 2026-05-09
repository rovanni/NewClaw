/**
 * send_document — Enviar documentos/arquivos pelo Telegram
 *
 * MIGRATED: execSync(curl) → fetch() multipart upload (non-blocking)
 * Previous execSync blocked the event loop for up to 30s during uploads.
 * Now uses native fetch() + FormData — fully async.
 *
 * FIX: resolvePath() agora resolve caminhos relativos dentro do workspace,
 * igual ao write_tool, evitando o bug de "Arquivo não encontrado" quando
 * o LLM gera caminhos relativos ou com duplo "workspace/workspace".
 */

import { ToolExecutor, ToolResult } from '../loop/AgentLoop';
import path from 'path';
import fs from 'fs';
import { createLogger } from '../shared/AppLogger';
const log = createLogger('SendDocument');

export class SendDocumentTool implements ToolExecutor {
    name = 'send_document';
    description = 'Enviar um arquivo como documento pelo Telegram. Use para enviar HTML, PDF, imagens ou outros arquivos. Caminhos relativos são resolvidos a partir do workspace.';
    parameters = {
        type: 'object',
        properties: {
            file_path: {
                type: 'string',
                description: 'Caminho do arquivo (relativo ao workspace ou absoluto)'
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

    /** Resolve e normaliza caminho dentro do sandbox (workspace) — mesma lógica do write_tool */
    private resolvePath(inputPath: string): { resolved: string; error?: string } {
        const workspaceDir = process.env.WORKSPACE_DIR || path.join(process.cwd(), 'workspace');

        let expanded = inputPath;
        if (expanded.startsWith('~/')) {
            expanded = (process.env.HOME || '/root') + expanded.slice(1);
        } else if (expanded.startsWith('@')) {
            expanded = expanded.slice(1);
        }

        // Se caminho já é absoluto e contém /workspace/workspace/, normalizar (remover duplo)
        if (path.isAbsolute(expanded)) {
            const normalized = expanded.replace(/\/workspace\/workspace\//, '/workspace/').replace(/\/workspace\/workspace$/, '/workspace');
            return { resolved: path.normalize(normalized) };
        }

        // Caminho relativo: resolver a partir do workspace
        const resolved = path.resolve(workspaceDir, expanded);
        return { resolved };
    }

    async execute(args: Record<string, any>): Promise<ToolResult> {
        const { file_path, caption, filename } = args;

        if (!file_path) {
            return { success: false, output: '', error: 'file_path é obrigatório.' };
        }

        // Resolve path usando mesma lógica do write_tool
        const { resolved: resolvedPath, error: pathError } = this.resolvePath(file_path);
        if (pathError) {
            return { success: false, output: '', error: pathError };
        }

        // Check file exists
        if (!fs.existsSync(resolvedPath)) {
            // Fallback: tentar busca por nome no workspace
            const fileName = path.basename(resolvedPath);
            const workspaceDir = process.env.WORKSPACE_DIR || path.join(process.cwd(), 'workspace');
            try {
                const findResult = require('child_process').execSync(
                    `find "${workspaceDir}" -name "${fileName}" -type f 2>/dev/null | head -1`,
                    { timeout: 5000, encoding: 'utf-8' }
                ).trim();
                if (findResult) {
                    log.info(`[send_document] Fallback: arquivo encontrado em ${findResult} (path original: ${resolvedPath})`);
                    return this.sendFile(findResult, this.chatId, this.botToken, caption, filename);
                }
            } catch {}
            return { success: false, output: '', error: `Arquivo não encontrado: ${resolvedPath}` };
        }

        return this.sendFile(resolvedPath, this.chatId, this.botToken, caption, filename);
    }

    /** Envia arquivo via Telegram usando fetch() multipart — fully async */
    private async sendFile(resolvedPath: string, chatId: string, botToken: string, caption?: string, filename?: string): Promise<ToolResult> {

        // Check file size (max 50MB for Telegram)
        const stats = fs.statSync(resolvedPath);
        const maxSize = 50 * 1024 * 1024; // 50MB
        if (stats.size > maxSize) {
            return { success: false, output: '', error: `Arquivo muito grande: ${(stats.size / 1024 / 1024).toFixed(1)}MB (máximo 50MB)` };
        }

        if (!chatId || !botToken) {
            log.info(`[send_document] ERRO: contexto não configurado. chatId=${chatId}, botToken=${botToken ? "SET" : "EMPTY"}`);
            return { success: false, output: '', error: 'Contexto do Telegram não configurado.' };
        }

        const displayName = filename || path.basename(resolvedPath);

        try {
            const uploadStart = Date.now();
            log.info(`Uploading document "${displayName}" (${(stats.size / 1024).toFixed(1)}KB)...`);

            // Read file and send via native fetch() — fully async, no event loop blocking
            const fileBuffer = fs.readFileSync(resolvedPath);

            const formData = new FormData();
            formData.append('chat_id', chatId);
            formData.append('document', new File([fileBuffer], displayName));
            if (caption) {
                formData.append('caption', caption.slice(0, 1024));
            }

            const telegramUrl = `https://api.telegram.org/bot${botToken}/sendDocument`;

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