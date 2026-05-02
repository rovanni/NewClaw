/**
 * auditCommand — Owner-only /audit command for NewClaw (Grammy)
 * 
 * Usage (Telegram):
 *   /audit          — Full audit
 *   /audit code     — Code audit only
 *   /audit runtime  — Runtime audit only
 *   /audit data     — Data audit only
 *   /audit integration — Integration audit only
 *   /audit history  — Last 10 audit reports
 *   /audit fix      — Run auto-fix pipeline (only low-risk, multi-validated fixes)
 */

import { AuditorService, AuditReport } from './AuditorService';
import { Bot, Context } from 'grammy';

export function registerAuditCommand(
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
                    // NEW: Full auto-fix pipeline
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
                                ctx.reply(chunk); // fallback without markdown
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

    console.log('[AUDITOR] ✅ Comando /audit registrado (owner-only)');
}