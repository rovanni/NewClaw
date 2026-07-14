import { ToolExecutor, ToolResult } from '../loop/AgentLoop';
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
            // FUZZY-MATCH: quando o LLM alucina o nome do arquivo (confirmado ao vivo em
            // 14/07/2026: modelo pediu "seguranca_redes_senac_final.pptx" mas o arquivo real
            // era "seguranca_redes_senac.pptx" — 2 falhas consecutivas antes do GoalLoop
            // resolver via list_workspace+exec_command), tenta encontrar candidatos similares
            // no workspace. Busca arquivos com mesma extensão que compartilhem substrings
            // significativas do nome pedido. Auto-resolve se houver exatamente 1 candidato;
            // lista todos se houver múltiplos — o LLM escolhe na próxima tentativa.
            const candidates = this.findSimilarFiles(resolvedPath, workspaceDir);
            if (candidates.length === 1) {
                const match = candidates[0];
                log.info(`[FUZZY-MATCH] requested="${file_path}" auto_resolved="${match}" reason=single_candidate`);
                // Auto-resolve: usa o candidato único
                if (this.channel === 'discord') {
                    return this.sendToDiscord(match, this.chatId, caption, filename);
                } else if (this.channel === 'web') {
                    return this.sendToWeb(match, this.chatId, caption, filename);
                } else {
                    return this.sendToTelegram(match, this.chatId, caption, filename);
                }
            } else if (candidates.length > 1) {
                const list = candidates.map(c => path.basename(c)).join(', ');
                log.info(`[FUZZY-MATCH] requested="${file_path}" candidates=${candidates.length} files="${list}"`);
                return {
                    success: false,
                    output: '',
                    error: `Arquivo não encontrado: ${path.basename(resolvedPath)}. ` +
                        `Encontrei ${candidates.length} arquivos similares no workspace: ${list}. ` +
                        `Especifique o nome exato.`
                };
            }
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

    /**
     * Busca arquivos com nome similar no workspace quando o nome exato não existe.
     * Algoritmo: mesma extensão + pelo menos um token significativo (≥5 chars) em comum.
     * Busca no workspace root e no subdiretório tmp/.
     */
    private findSimilarFiles(requestedPath: string, workspaceDir: string): string[] {
        const ext = path.extname(requestedPath).toLowerCase();
        if (!ext) return [];

        const basename = path.basename(requestedPath, ext).toLowerCase();
        // Divide o nome em tokens significativos (separados por _, - ou espaço)
        const tokens = basename.split(/[_\-\s]+/).filter(t => t.length >= 5);
        if (tokens.length === 0) return [];

        const candidates: string[] = [];
        const searchDirs = [workspaceDir];
        const tmpDir = path.join(workspaceDir, 'tmp');
        if (fs.existsSync(tmpDir)) searchDirs.push(tmpDir);

        for (const dir of searchDirs) {
            try {
                const entries = fs.readdirSync(dir, { withFileTypes: true });
                for (const entry of entries) {
                    if (!entry.isFile()) continue;
                    if (path.extname(entry.name).toLowerCase() !== ext) continue;

                    const candidateBase = path.basename(entry.name, ext).toLowerCase();
                    // O candidato compartilha pelo menos 1 token significativo?
                    const hasSharedToken = tokens.some(token => candidateBase.includes(token));
                    if (hasSharedToken) {
                        candidates.push(path.join(dir, entry.name));
                    }
                }
            } catch {
                // Diretório inacessível — ignora silenciosamente
            }
        }

        return candidates;
    }
}
