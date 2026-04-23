/**
 * TelegramOutputHandler — Estratégias de saída do NewClaw
 * Texto, Chunking, Arquivo (.md), Áudio (Edge-TTS)
 */

import { Context, InputFile } from 'grammy';
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';

export interface OutputConfig {
    maxMessageLength: number;
    audioVoice: string;
    audioRate: string;
    tmpDir: string;
}

export class TelegramOutputHandler {
    private config: OutputConfig;

    constructor(config?: Partial<OutputConfig>) {
        this.config = {
            maxMessageLength: 4096,
            audioVoice: 'pt-BR-ThalitaNeural',
            audioRate: '+0%',
            tmpDir: './tmp',
            ...config
        };

        if (!fs.existsSync(this.config.tmpDir)) {
            fs.mkdirSync(this.config.tmpDir, { recursive: true });
        }
    }

    async send(ctx: Context, content: string, isAudio: boolean = false): Promise<void> {
        if (isAudio) {
            await this.sendAudio(ctx, content);
        } else if (this.isMarkdownFile(content)) {
            await this.sendFile(ctx, content);
        } else if (content.length > this.config.maxMessageLength) {
            await this.sendChunked(ctx, content);
        } else {
            await this.sendText(ctx, content);
        }
    }

    private async sendText(ctx: Context, content: string): Promise<void> {
        try {
            await ctx.reply(content, { parse_mode: 'Markdown' });
        } catch {
            await ctx.reply(content);
        }
    }

    private async sendChunked(ctx: Context, content: string): Promise<void> {
        const chunks = this.splitIntoChunks(content, this.config.maxMessageLength);
        for (const chunk of chunks) {
            try {
                await ctx.reply(chunk, { parse_mode: 'Markdown' });
            } catch {
                await ctx.reply(chunk);
            }
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }

    private async sendFile(ctx: Context, content: string): Promise<void> {
        const fileName = this.extractFileName(content) || `documento_${Date.now()}.md`;
        const cleanContent = this.cleanMarkdownHeader(content);
        const filePath = path.join(this.config.tmpDir, fileName);
        
        fs.writeFileSync(filePath, cleanContent);

        try {
            await ctx.replyWithDocument(new InputFile(filePath, fileName));
        } finally {
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        }
    }

    private async sendAudio(ctx: Context, content: string): Promise<void> {
        const mp3Path = path.join(this.config.tmpDir, `audio_${Date.now()}.mp3`);
        const oggPath = path.join(this.config.tmpDir, `audio_${Date.now()}.ogg`);

        try {
            const cleanText = this.stripMarkdown(content);
            await this.generateAudio(cleanText, mp3Path);
            await this.convertToOgg(mp3Path, oggPath);
            await ctx.replyWithVoice(new InputFile(oggPath));
        } catch (error: any) {
            console.error('[OUTPUT] Erro ao gerar áudio:', error);
            await ctx.reply(content);
        } finally {
            [mp3Path, oggPath].forEach(f => {
                if (fs.existsSync(f)) fs.unlinkSync(f);
            });
        }
    }

    private async generateAudio(text: string, outputPath: string): Promise<void> {
        const escaped = text.replace(/"/g, '\\"').replace(/`/g, '').slice(0, 5000);
        const scriptPath = path.join(__dirname, '../../scripts/newclaw-tts.sh');
        
        return new Promise((resolve, reject) => {
            const command = `bash ${scriptPath} "${escaped}" ${outputPath} ${this.config.audioVoice} "${this.config.audioRate}"`;
            execFile('sh', ['-c', command], (error, stdout, stderr) => {
                if (error) {
                    console.error('[TTS] Erro:', stderr || error.message);
                    reject(error);
                } else {
                    resolve();
                }
            });
        });
    }

    private async convertToOgg(mp3Path: string, oggPath: string): Promise<void> {
        return new Promise((resolve, reject) => {
            execFile('ffmpeg', ['-i', mp3Path, '-c:a', 'libopus', '-b:a', '64k', oggPath, '-y'], (error) => {
                if (error) reject(error);
                else resolve();
            });
        });
    }

    private splitIntoChunks(text: string, maxLength: number): string[] {
        const chunks: string[] = [];
        const lines = text.split('\n');
        let current = '';

        for (const line of lines) {
            if ((current + '\n' + line).length > maxLength) {
                if (current) chunks.push(current);
                current = line;
            } else {
                current = current ? current + '\n' + line : line;
            }
        }

        if (current) chunks.push(current);
        return chunks;
    }

    private isMarkdownFile(content: string): boolean {
        return content.startsWith('---\n') || content.includes('```') || content.length > 8000;
    }

    private extractFileName(content: string): string | null {
        const match = content.match(/---\nname:\s*(.+)\n/);
        return match ? match[1].trim() : null;
    }

    private cleanMarkdownHeader(content: string): string {
        return content.replace(/^---\n[\s\S]*?\n---\n/, '');
    }

    private stripMarkdown(text: string): string {
        return text
            .replace(/```[\s\S]*?```/g, '')
            .replace(/\*\*(.*?)\*\*/g, '$1')
            .replace(/\*(.*?)\*/g, '$1')
            .replace(/`([^`]+)`/g, '$1')
            .replace(/#{1,6}\s/g, '')
            .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
            .replace(/^[>-]\s/gm, '')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
    }
}