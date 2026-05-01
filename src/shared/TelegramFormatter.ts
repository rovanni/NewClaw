/**
 * mdToTelegramHTML — Convert common Markdown to Telegram-compatible HTML
 * 
 * Telegram supports these HTML tags:
 * <b>bold</b>, <i>italic</i>, <u>underline</u>, <s>strikethrough</s>,
 * <code>inline</code>, <pre>block</pre>, <a href="">link</a>,
 * <blockquote>quote</blockquote>, <tg-spoiler>spoiler</tg-spoiler>
 * 
 * It does NOT support: headings, tables, horizontal rules, images
 */

export function mdToTelegramHTML(md: string): string {
    let html = md;

    // 1. Code blocks (``` ... ```) → <pre>
    html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, (_match, _lang, code) => {
        return `<pre>${escapeHtml(code.trim())}</pre>`;
    });

    // 2. Inline code (`code`) → <code>
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

    // 3. Bold (**text** or __text__) → <b>
    html = html.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
    html = html.replace(/__(.+?)__/g, '<b>$1</b>');

    // 4. Italic (*text* or _text_) → <i>  (but not inside tags)
    html = html.replace(/(?<!\w)\*(?!\*)(.+?)(?<!\*)\*(?!\w)/g, '<i>$1</i>');
    html = html.replace(/(?<!\w)_(?!_)(.+?)(?<!_)_(?!\w)/g, '<i>$1</i>');

    // 5. Strikethrough (~~text~~) → <s>
    html = html.replace(/~~(.+?)~~/g, '<s>$1</s>');

    // 6. Headings (### text) → <b>text</b> (Telegram has no headings)
    html = html.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>');

    // 7. Blockquotes (> text) → <blockquote>
    html = html.replace(/^>\s+(.+)$/gm, '<blockquote>$1</blockquote>');
    // Merge consecutive blockquotes
    html = html.replace(/<\/blockquote>\n<blockquote>/g, '\n');

    // 8. Links [text](url) → <a href="url">text</a>
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

    // 9. Unordered lists (- item or * item) → • item
    html = html.replace(/^[\-\*]\s+(.+)$/gm, '• $1');

    // 10. Ordered lists (1. item) → 1. item (keep as-is, Telegram renders fine)

    // 11. Horizontal rules (--- or ***) → newline separator
    html = html.replace(/^[-]{3,}|^[*]{3,}$/gm, '━━━━━━━━━━');

    // 12. Clean up escaped newlines from LLM output
    html = html.replace(/\\n/g, '\n');

    // 13. Collapse excessive blank lines
    html = html.replace(/\n{3,}/g, '\n\n');

    return html.trim();
}

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

/**
 * Safe reply — try HTML first, fallback to plain text
 */
export function safeReply(ctx: any, text: string, extra: any = {}): Promise<any> {
    const html = mdToTelegramHTML(text);
    return ctx.reply(html, { ...extra, parse_mode: 'HTML' })
        .catch(() => ctx.reply(text, extra));
}

/**
 * Safe send message — for bot.api.sendMessage
 */
export function safeSendMessage(api: any, chatId: string | number, text: string, extra: any = {}): Promise<any> {
    const html = mdToTelegramHTML(text);
    return api.sendMessage(chatId, html, { ...extra, parse_mode: 'HTML' })
        .catch(() => api.sendMessage(chatId, text, extra));
}