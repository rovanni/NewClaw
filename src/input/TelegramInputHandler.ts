/**
 * TelegramInputHandler — Recebe mensagens do Telegram via Grammy
 * Suporta: texto, PDF, Markdown, áudio (Whisper), voz
 */

import { Bot, Context, GrammyError } from 'grammy';
import { AgentLoop } from '../loop/AgentLoop';
import { MemoryManager } from '../memory/MemoryManager';
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';

export interface TelegramInputConfig {
    botToken: string;
    allowedUserIds: string[];
    whisperPath?: string;
    tmpDir?: string;
}

export class TelegramInputHandler {
    private bot: Bot;
    private agentLoop: AgentLoop;
    private memory: MemoryManager;
    private config: Required<TelegramInputConfig>;
    private onboardingService?: any;
    private processedMessages: Set<number> = new Set();

    constructor(config: TelegramInputConfig, agentLoop: AgentLoop, memory: MemoryManager, onboardingService?: any) {
        this.config = {
            whisperPath: '/usr/local/bin/whisper',
            tmpDir: './tmp',
            ...config
        };
        this.bot = new Bot(config.botToken);
        this.agentLoop = agentLoop;
        this.memory = memory;
        this.onboardingService = onboardingService;

        // Criar diretório tmp
        if (!fs.existsSync(this.config.tmpDir)) {
            fs.mkdirSync(this.config.tmpDir, { recursive: true });
        }
    }

    /**
     * Inicia o handler
     */
    async start(): Promise<void> {
        // Middleware de whitelist
        this.bot.use(async (ctx, next) => {
            const userId = ctx.from?.id.toString();
            if (!userId || !this.config.allowedUserIds.includes(userId)) {
                console.log(`[INPUT] Usuário não autorizado: ${userId}`);
                return;
            }
            return next();
        });

        // Comando Clear para limpar contexto preso
        this.bot.command('clear', async (ctx) => {
            const userId = ctx.from?.id.toString();
            if (userId) {
                this.memory.createNewConversation(userId);
                await ctx.reply('🧹 Contexto limpo! A IA encerrou a linha de raciocínio anterior e começará uma nova sessão (Mas seus gráficos de memória de longo prazo continuam salvos!).');
            }
        });

        // SkillLearner via Telegram
        this.bot.command('skills', async (ctx) => {
            await this.handleSkillReviewCommand(ctx);
        });

        this.bot.command('skill_approve', async (ctx) => {
            await this.handleSkillActionCommand(ctx, 'approve');
        });

        this.bot.command('skill_reject', async (ctx) => {
            await this.handleSkillActionCommand(ctx, 'reject');
        });

        // Texto (only new messages, not edits)
        this.bot.on('message:text', async (ctx) => {
            // Skip edited messages to avoid duplicate processing
            if (ctx.update.update_id && (ctx.update as any).edited_message) return;
            await this.handleText(ctx);
        });

        // Voz/Audio
        this.bot.on('message:voice', async (ctx) => {
            await this.handleAudio(ctx, true);
        });

        this.bot.on('message:audio', async (ctx) => {
            await this.handleAudio(ctx, false);
        });

        // Documentos (PDF, MD)
        this.bot.on('message:document', async (ctx) => {
            await this.handleDocument(ctx);
        });

        console.log('✅ TelegramInputHandler started');
        await this.bot.start({
            onStart: () => console.log('🤖 Bot rodando!'),
            allowed_updates: ['message']
        });
    }

    /**
     * Processa texto
     */
    private async handleText(ctx: Context): Promise<void> {
        const text = ctx.message?.text;
        if (!text) return;

        // Deduplicate messages (avoid processing same message twice)
        const messageId = ctx.message?.message_id;
        if (messageId) {
            if (this.processedMessages.has(messageId)) return;
            this.processedMessages.add(messageId);
            // Keep set small — remove old entries
            if (this.processedMessages.size > 1000) {
                const entries = Array.from(this.processedMessages);
                this.processedMessages = new Set(entries.slice(-500));
            }
        }

        const userId = ctx.from!.id.toString();
        console.log(`[TELEGRAM-INPUT] Texto de ${userId}: "${text.slice(0, 50)}"`);

        const handledSkillReview = await this.tryHandleNaturalSkillReview(ctx, text);
        if (handledSkillReview) return;


        // Check onboarding first
        if (this.onboardingService && this.onboardingService.isOnboardingRequired(userId)) {
            const res = await this.onboardingService.handle(userId, text);
            await ctx.reply(res.response, { parse_mode: 'Markdown' });
            return;
        }
        if (false) {
            const state = this.onboardingService.getOnboardingState(userId);
            if (!state) {
                // Start onboarding
                const first = this.onboardingService.startOnboarding(userId);
                if (first) {
                    await ctx.reply(first.question, { parse_mode: 'Markdown' });
                    return;
                }
            } else {
                // Process answer
                const result = await this.onboardingService.processAnswer(userId, text);
                if (result?.completed) {
                    await ctx.reply(result.welcomeMessage!, { parse_mode: 'Markdown' });
                    return;
                }
                if (result?.question) {
                    await ctx.reply(result.question, { parse_mode: 'Markdown' });
                    return;
                }
            }
        }

        // Passar contexto do Telegram para envio de áudio
        this.agentLoop.setTelegramContext(userId, this.config.botToken);

        await ctx.replyWithChatAction('typing');
        const actionInterval = setInterval(() => {
            ctx.replyWithChatAction('typing').catch(() => {});
        }, 4000);

        try {
            const response = await this.agentLoop.process(userId, text);
            if (response && response.trim()) {
                // Telegram limit: 4096 chars. Split if needed.
                const maxLen = 4000;
                if (response.length > maxLen) {
                    // Split into chunks
                    for (let i = 0; i < response.length; i += maxLen) {
                        const chunk = response.slice(i, i + maxLen);
                        await ctx.reply(chunk);
                    }
                } else {
                    await ctx.reply(response);
                }
            } else {
                await ctx.reply('⚠️ Resposta vazia do modelo. Tente novamente.');
            }
        } catch (error: any) {
            console.error('[INPUT] Erro:', error);
            await ctx.reply(`⚠️ Erro ao processar: ${error.message}`);
        } finally {
            clearInterval(actionInterval);
        }
    }

    private async handleSkillReviewCommand(ctx: Context): Promise<void> {
        try {
            const db = (this.memory as any).db || (this.memory as any)._db;
            if (!db) {
                await ctx.reply('⚠️ Banco de dados não disponível para revisar skills.');
                return;
            }

            const skills = db.prepare(
                `SELECT id, name, status, priority, source_pattern, source_tool, updated_at
                 FROM auto_skills
                 ORDER BY
                    CASE status WHEN 'proposed' THEN 0 WHEN 'active' THEN 1 ELSE 2 END,
                    priority DESC,
                    updated_at DESC
                 LIMIT 10`
            ).all() as Array<{
                id: string;
                name: string;
                status: 'proposed' | 'active' | 'rejected';
                priority: number;
                source_pattern?: string;
                source_tool?: string;
                updated_at?: string;
            }>;

            if (skills.length === 0) {
                await ctx.reply('Nenhuma skill automática cadastrada ainda.');
                return;
            }

            const lines = [
                '🧠 *SkillLearner*',
                '',
                ...skills.map(skill => {
                    const shortId = skill.id.slice(-8);
                    const status = skill.status === 'proposed'
                        ? 'PROPOSED'
                        : skill.status === 'active'
                            ? 'ACTIVE'
                            : 'REJECTED';
                    return [
                        `• *${skill.name}* [${status}]`,
                        `id curto: \`${shortId}\``,
                        `origem: ${skill.source_pattern || 'manual'} → ${skill.source_tool || '—'}`,
                        `prioridade: ${skill.priority}`
                    ].join('\n');
                }),
                '',
                'Ações:',
                '`/skill_approve <id_curto>`',
                '`/skill_reject <id_curto>`'
            ];

            await ctx.reply(lines.join('\n\n'), { parse_mode: 'Markdown' });
        } catch (error: any) {
            await ctx.reply(`⚠️ Erro ao listar skills: ${error.message}`);
        }
    }

    private async handleSkillActionCommand(ctx: Context, action: 'approve' | 'reject'): Promise<void> {
        const text = ctx.message?.text || '';
        const [, rawId] = text.trim().split(/\s+/, 2);

        if (!rawId) {
            await ctx.reply(`Use /skill_${action} <id_curto>. Veja os IDs com /skills`);
            return;
        }

        try {
            const db = (this.memory as any).db || (this.memory as any)._db;
            if (!db) {
                await ctx.reply('⚠️ Banco de dados não disponível para revisar skills.');
                return;
            }

            const skill = db.prepare(
                `SELECT id, name, status
                 FROM auto_skills
                 WHERE id LIKE ? COLLATE NOCASE
                 ORDER BY updated_at DESC
                 LIMIT 1`
            ).get(`%${rawId}`) as { id: string; name: string; status: string } | undefined;

            if (!skill) {
                await ctx.reply(`⚠️ Skill não encontrada para id curto "${rawId}". Use /skills para conferir.`);
                return;
            }

            const nextStatus = action === 'approve' ? 'active' : 'rejected';
            db.prepare(
                `UPDATE auto_skills
                 SET status = ?, reviewed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?`
            ).run(nextStatus, skill.id);

            await ctx.reply(
                action === 'approve'
                    ? `✅ Skill aprovada: ${skill.name}`
                    : `🛑 Skill rejeitada: ${skill.name}`
            );
        } catch (error: any) {
            await ctx.reply(`⚠️ Erro ao revisar skill: ${error.message}`);
        }
    }

    private async tryHandleNaturalSkillReview(ctx: Context, text: string): Promise<boolean> {
        const lower = text.toLowerCase().trim();

        if (/^(listar|mostrar|ver|quais s[aã]o|me mostra).*(skills|propostas).*(pendentes|autom[aá]ticas)?$/i.test(lower)
            || /^(skills|propostas)\s+(pendentes|autom[aá]ticas|do skilllearner)$/i.test(lower)) {
            await this.handleSkillReviewCommand(ctx);
            return true;
        }

        const approveMatch = lower.match(/(?:aprova|aprove|aprovar|ativar|ative)\s+(?:a\s+)?(?:skill|proposta)?\s*([a-z0-9_-]{4,})/i);
        if (approveMatch?.[1]) {
            await this.handleSkillActionFromNaturalText(ctx, 'approve', approveMatch[1]);
            return true;
        }

        const rejectMatch = lower.match(/(?:rejeita|rejeite|rejeitar|descartar|descarta)\s+(?:a\s+)?(?:skill|proposta)?\s*([a-z0-9_-]{4,})/i);
        if (rejectMatch?.[1]) {
            await this.handleSkillActionFromNaturalText(ctx, 'reject', rejectMatch[1]);
            return true;
        }

        return false;
    }

    private async handleSkillActionFromNaturalText(ctx: Context, action: 'approve' | 'reject', rawId: string): Promise<void> {
        try {
            const db = (this.memory as any).db || (this.memory as any)._db;
            if (!db) {
                await ctx.reply('⚠️ Banco de dados não disponível para revisar skills.');
                return;
            }

            const skill = db.prepare(
                `SELECT id, name
                 FROM auto_skills
                 WHERE id LIKE ? COLLATE NOCASE
                 ORDER BY updated_at DESC
                 LIMIT 1`
            ).get(`%${rawId}`) as { id: string; name: string } | undefined;

            if (!skill) {
                await ctx.reply(`⚠️ Skill não encontrada para "${rawId}". Use /skills para conferir os IDs curtos.`);
                return;
            }

            const nextStatus = action === 'approve' ? 'active' : 'rejected';
            db.prepare(
                `UPDATE auto_skills
                 SET status = ?, reviewed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?`
            ).run(nextStatus, skill.id);

            await ctx.reply(
                action === 'approve'
                    ? `✅ Skill aprovada: ${skill.name}`
                    : `🛑 Skill rejeitada: ${skill.name}`
            );
        } catch (error: any) {
            await ctx.reply(`⚠️ Erro ao revisar skill: ${error.message}`);
        }
    }

    /**
     * Processa áudio/voz via Whisper
     */
    private async handleAudio(ctx: Context, isVoiceNote: boolean): Promise<void> {
        const userId = ctx.from!.id.toString();
        const fileId = isVoiceNote ? ctx.message?.voice?.file_id : (ctx.message as any)?.audio?.file_id;
        
        if (!fileId) {
            await ctx.reply('⚠️ Não consegui processar o áudio.');
            return;
        }

        console.log(`[INPUT] Áudio de ${userId} (voice=${isVoiceNote})`);
        await ctx.replyWithChatAction('record_voice');
        const actionInterval = setInterval(() => {
            ctx.replyWithChatAction('record_voice').catch(() => {});
        }, 4000);

        try {
            // Baixar arquivo
            const file = await ctx.api.getFile(fileId);
            const filePath = path.join(this.config.tmpDir, `${fileId}.ogg`);
            
            const arrayBuffer = await fetch(`https://api.telegram.org/file/bot${this.config.botToken}/${file.file_path}`);
            const buffer = Buffer.from(await arrayBuffer.arrayBuffer());
            fs.writeFileSync(filePath, buffer);

            // Converter para WAV ( Whisper precisa)
            const wavPath = filePath.replace('.ogg', '.wav');
            await this.execCommand('ffmpeg', ['-i', filePath, '-ar', '16000', '-ac', '1', wavPath]);

            // Transcrever com Whisper API
            const transcript = await this.transcribeWithWhisperAPI(wavPath);

            // Limpar arquivos temporários
            fs.unlinkSync(filePath);
            if (fs.existsSync(wavPath)) fs.unlinkSync(wavPath);

            if (!transcript || transcript.trim() === '') {
                await ctx.reply('Áudio vazio ou não compreendido. Pode reenviar?');
                return;
            }

            console.log(`[INPUT] Transcrição: "${transcript.slice(0, 50)}"`);

            // Processar como texto, sinalizando que foi áudio
            const response = await this.agentLoop.process(userId, transcript);
            
            // Se o input foi áudio, marcar para resposta em áudio
            if (isVoiceNote) {
                // TODO: Implementar resposta em áudio via TelegramOutputHandler
                await ctx.reply(response);
            } else {
                await ctx.reply(response);
            }

        } catch (error: any) {
            console.error('[INPUT] Erro no áudio:', error);
            await ctx.reply(`⚠️ Erro ao processar áudio: ${error.message}`);
        } finally {
            clearInterval(actionInterval);
        }
    }

    /**
     * Processa documentos (PDF, MD)
     */
    private async handleDocument(ctx: Context): Promise<void> {
        const userId = ctx.from!.id.toString();
        const doc = (ctx.message as any)?.document;
        
        if (!doc) return;

        const mimeType = doc.mime_type || '';
        const fileName = doc.file_name || '';
        const fileId = doc.file_id;

        console.log(`[INPUT] Documento de ${userId}: ${fileName} (${mimeType})`);

        if (!mimeType.includes('pdf') && !mimeType.includes('html') && !fileName.endsWith('.md') && !fileName.endsWith('.txt') && !fileName.endsWith('.html') && !fileName.endsWith('.css') && !fileName.endsWith('.js') && !fileName.endsWith('.json')) {
            await ctx.reply('⚠️ No momento só consigo processar PDF, Markdown e texto.');
            return;
        }

        await ctx.replyWithChatAction('typing');
        const actionInterval = setInterval(() => {
            ctx.replyWithChatAction('typing').catch(() => {});
        }, 4000);

        try {
            const file = await ctx.api.getFile(fileId);
            const filePath = path.join(this.config.tmpDir, fileName);
            
            const arrayBuffer = await fetch(`https://api.telegram.org/file/bot${this.config.botToken}/${file.file_path}`);
            const buffer = Buffer.from(await arrayBuffer.arrayBuffer());
            fs.writeFileSync(filePath, buffer);

            let content: string;

            if (mimeType.includes('pdf')) {
                content = await this.extractPdfText(filePath);
            } else {
                content = fs.readFileSync(filePath, 'utf-8');
            }

            // Para HTML/CSS/JS/JSON: salvar no workspace em vez de processar como texto
            const isWebFile = fileName.endsWith('.html') || fileName.endsWith('.css') || fileName.endsWith('.js') || fileName.endsWith('.json');
            if (isWebFile) {
                const workspaceDir = process.env.WORKSPACE_DIR || path.join(process.cwd(), 'workspace', 'sites');
                const savedPath = path.join(workspaceDir, fileName);
                const dir = path.dirname(savedPath);
                if (!fs.existsSync(dir)) {
                    fs.mkdirSync(dir, { recursive: true });
                }
                // Copy from tmp to workspace
                fs.copyFileSync(filePath, savedPath);
                console.log(`[INPUT] Arquivo web salvo: ${savedPath}`);
                
                // Clean tmp file
                fs.unlinkSync(filePath);
                
                // Process with context about the file
                const caption = (ctx.message as any)?.caption || '';
                const contentPreview = content.slice(0, 500);
                const fullText = caption ? `Arquivo recebido e salvo em: ${savedPath}\nInstrução do usuário: ${caption}\nConteúdo resumido: ${contentPreview}` : `Arquivo recebido e salvo em: ${savedPath}. Conteúdo resumido: ${contentPreview}`;
                const response = await this.agentLoop.process(userId, fullText);
                await ctx.reply(response);
            } else {
                // Limpar arquivo temporário
                fs.unlinkSync(filePath);

                if (!content || content.trim() === '') {
                    await ctx.reply('⚠️ Não consegui extrair texto do documento.');
                    return;
                }

                // Processar com contexto do documento
                const caption = (ctx.message as any)?.caption || '';
                const fullText = caption ? `${caption}\n\n${content}` : content;
                const response = await this.agentLoop.process(userId, fullText);
                await ctx.reply(response);
            }

        } catch (error: any) {
            console.error('[INPUT] Erro no documento:', error);
            await ctx.reply(`⚠️ Erro ao processar documento: ${error.message}`);
        } finally {
            clearInterval(actionInterval);
        }
    }

    /**
     * Transcreve áudio com Whisper local
     */
    /**
     * Transcreve áudio via Whisper API server (Marte:8177)
     * Fallback para whisper-cli local se API indisponível
     */
    private async transcribeWithWhisperAPI(wavPath: string): Promise<string> {
        const whisperApiUrl = process.env.WHISPER_API_URL || 'http://localhost:8177';
        
        try {
            const fileBuffer = fs.readFileSync(wavPath);
            const blob = new Blob([fileBuffer], { type: 'audio/wav' });
            const formData = new FormData();
            formData.append('file', blob, 'audio.wav');
            formData.append('language', 'pt');

            const response = await fetch(`${whisperApiUrl}/inference`, {
                method: 'POST',
                body: formData,
                signal: AbortSignal.timeout(120000)
            });

            if (!response.ok) {
                const errText = await response.text();
                throw new Error(`Whisper API ${response.status}: ${errText}`);
            }

            const data = await response.json() as any;
            const text = data.text || data.transcription || '';
            
            if (text.trim()) {
                console.log(`[WHISPER-API] Transcrição OK (${text.length} chars)`);
                return text.trim();
            }
        } catch (error: any) {
            console.error('[WHISPER-API] Erro, tentando local:', error.message);
        }

        // Fallback: whisper-cli local
        return this.transcribeWithWhisper(wavPath);
    }

    private async transcribeWithWhisper(wavPath: string): Promise<string> {
        const whisperPath = this.config.whisperPath || '/usr/local/bin/whisper';
        const modelPath = process.env.WHISPER_MODEL || '/usr/local/share/whisper/ggml-base.bin';
        
        // Check if whisper binary exists
        try { fs.accessSync(whisperPath, fs.constants.X_OK); } catch {
            console.error('[WHISPER] Binary not found:', whisperPath);
            return '[Áudio recebido - Whisper não instalado no servidor. Instale com: cd ~/whisper.cpp && make]';
        }
        // Check if model exists
        if (!fs.existsSync(modelPath)) {
            console.error('[WHISPER] Model not found:', modelPath);
            return '[Áudio recebido - Modelo Whisper não encontrado. Baixe com: ~/whisper.cpp/models/download-ggml-model.sh base]';
        }
        
        return new Promise((resolve) => {
            const command = `${whisperPath} -m ${modelPath} -f ${wavPath} -l pt --no-timestamps`;
            execFile('sh', ['-c', command], (error, stdout) => {
                if (error) {
                    console.error('[WHISPER] Erro:', error);
                    resolve('');
                    return;
                }
                resolve(stdout.trim());
            });
        });
    }

    /**
     * Extrai texto de PDF
     */
    private async extractPdfText(filePath: string): Promise<string> {
        // TODO: Implementar com pdf-parse
        return `[Conteúdo do PDF: ${path.basename(filePath)}]`;
    }

    /**
     * Executa comando shell
     */
    private execCommand(command: string, args: string[]): Promise<void> {
        return new Promise((resolve, reject) => {
            execFile(command, args, (error) => {
                if (error) reject(error);
                else resolve();
            });
        });
    }
}
