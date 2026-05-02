/**
 * auditCommand — Owner-only /audit command for NewClaw
 * 
 * Multi-channel: Works on Telegram, Discord, WhatsApp, Signal, and Web.
 * Uses the MessageBus command system so /audit works on ANY channel.
 * Also registers directly with Grammy for Telegram-specific features.
 * 
 * Usage (any channel):
 *   /audit          — Full audit
 *   /audit code     — Code audit only
 *   /audit runtime  — Runtime audit only
 *   /audit data     — Data audit only
 *   /audit integration — Integration audit only
 *   /audit history  — Last 10 audit reports
 *   /audit fix      — Run auto-fix pipeline (only low-risk, multi-validated fixes)
 */

import { AuditorService, AuditReport, FixReport } from './AuditorService';
import { Bot, Context } from 'grammy';
import { MessageBus } from '../../channels/MessageBus';
import { NormalizedMessage } from '../../channels/ChannelAdapter';

// ============================================
// MULTI-CHANNEL HANDLER (works on ALL channels)
// ============================================

/**
 * Register /audit as a MessageBus command.
 * This makes it work on Telegram, Discord, WhatsApp, Signal, and Web.
 */
export function registerAuditCommand(
    bus: MessageBus,
    auditor: AuditorService,
    ownerIds: string[]
): void {

    bus.registerCommand('/audit', async (msg: NormalizedMessage): Promise<string | null> => {
        // Security: owner-only
        if (!ownerIds.includes(msg.userId)) {
            return '⛔ Acesso negado. Auditoria restrita ao proprietário.';
        }

        const text = msg.text || '/audit';
        const parts = text.split(/\s+/);
        const subCommand = (parts[1] || 'full').toLowerCase();

        try {
            switch (subCommand) {
                case 'history': {
                    const history = auditor.getReportHistory(10);
                    let historyText = '📋 *Histórico de Auditorias:*\n\n';
                    history.forEach((r: any) => {
                        const emoji = r.critical > 0 ? '🔴' : r.warnings > 0 ? '🟡' : '✅';
                        const date = new Date(r.timestamp).toLocaleString('pt-BR');
                        historyText += `${emoji} ${date} — ${r.total_findings} achados (${r.critical}C/${r.warnings}W/${r.info_count}I)\n`;
                    });
                    if (history.length === 0) historyText += 'Nenhuma auditoria realizada ainda.';
                    return historyText;
                }
                case 'fix': {
                    const fixReport = await auditor.runFixPipeline();
                    return auditor.formatFixReport(fixReport);
                }
                default: {
                    let report: AuditReport;
                    if (subCommand === 'code') {
                        report = await auditor.runCategoryAudit('code');
                    } else if (subCommand === 'runtime') {
                        report = await auditor.runCategoryAudit('runtime');
                    } else if (subCommand === 'data') {
                        report = await auditor.runCategoryAudit('data');
                    } else if (subCommand === 'integration') {
                        report = await auditor.runCategoryAudit('integration');
                    } else {
                        report = await auditor.runFullAudit();
                    }

                    return auditor.formatReport(report);
                }
            }
        } catch (error: any) {
            return `❌ Erro na auditoria: ${error.message}`;
        }
    });

    console.log('[AUDITOR] ✅ Comando /audit registrado no MessageBus (multi-canal, owner-only)');
}

// ============================================
// TELEGRAM-SPECIFIC REGISTRATION (Grammy)
// ============================================

/**
 * Register /audit directly with Grammy for richer Telegram features
 * (parse_mode, chunked messages, etc.)
 * This is called IN ADDITION to the MessageBus registration.
 */
export function registerAuditCommandTelegram(
    bot: Bot<Context>,
    auditor: AuditorService,
    ownerChatId: string
): void {

    bot.command('audit', async (ctx) => {
        const chatId = ctx.chat.id.toString();

        // Security: owner-only
        if (chatId !== ownerChatId) {
            await ctx.reply('⛔ Acesso negado. Auditoria restrita ao proprietário.');
            return;
        }

        const text = ctx.msg.text || '/audit';
        const parts = text.split(/\s+/);
        const subCommand = (parts[1] || 'full').toLowerCase();

        await ctx.reply('🔍 Iniciando auditoria... Isso pode levar alguns minutos.');

        try {
            switch (subCommand) {
                case 'history': {
                    const history = auditor.getReportHistory(10);
                    let historyText = '📋 *Histórico de Auditorias:*\n\n';
                    history.forEach((r: any) => {
                        const emoji = r.critical > 0 ? '🔴' : r.warnings > 0 ? '🟡' : '✅';
                        const date = new Date(r.timestamp).toLocaleString('pt-BR');
                        historyText += `${emoji} ${date} — ${r.total_findings} achados (${r.critical}C/${r.warnings}W/${r.info_count}I)\n`;
                    });
                    if (history.length === 0) historyText += 'Nenhuma auditoria realizada ainda.';
                    await ctx.reply(historyText, { parse_mode: 'Markdown' });
                    return;
                }
                case 'fix': {
                    await ctx.reply('🔧 Executando pipeline de correção automática...\n\n⚠️ Apenas correções de baixo risco (risk_level=low) com consenso multi-agente serão aplicadas.');
                    
                    const fixReport = await auditor.runFixPipeline();
                    const formatted = auditor.formatFixReport(fixReport);
                    
                    if (formatted.length > 4000) {
                        const chunks = formatted.match(/[\s\S]{1,4000}/g) || [formatted];
                        for (const chunk of chunks) {
                            await ctx.reply(chunk).catch(() => ctx.reply(chunk));
                        }
                    } else {
                        await ctx.reply(formatted).catch(() => ctx.reply(formatted));
                    }
                    return;
                }
                default: {
                    let report: AuditReport;
                    if (subCommand === 'code') {
                        report = await auditor.runCategoryAudit('code');
                    } else if (subCommand === 'runtime') {
                        report = await auditor.runCategoryAudit('runtime');
                    } else if (subCommand === 'data') {
                        report = await auditor.runCategoryAudit('data');
                    } else if (subCommand === 'integration') {
                        report = await auditor.runCategoryAudit('integration');
                    } else {
                        report = await auditor.runFullAudit();
                    }

                    const formatted = auditor.formatReport(report);

                    // Telegram message limit: 4096 chars
                    if (formatted.length > 4000) {
                        const chunks = formatted.match(/[\s\S]{1,4000}/g) || [formatted];
                        for (const chunk of chunks) {
                            await ctx.reply(chunk, { parse_mode: 'Markdown' }).catch(() => {
                                ctx.reply(chunk);
                            });
                        }
                    } else {
                        await ctx.reply(formatted, { parse_mode: 'Markdown' }).catch(() => {
                            ctx.reply(formatted);
                        });
                    }
                }
            }
        } catch (error: any) {
            await ctx.reply(`❌ Erro na auditoria: ${error.message}`);
        }
    });

    console.log('[AUDITOR] ✅ Comando /audit registrado no Telegram/Grammy (owner-only)');
}