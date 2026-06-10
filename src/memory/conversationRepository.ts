import Database from 'better-sqlite3';
import { Message } from './memoryTypes';
import { createLogger } from '../shared/AppLogger';
const log = createLogger('ConversationRepository');

export function getOrCreateConversation(db: Database.Database, userId: string): string {
    const existing = db.prepare(
        'SELECT id, updated_at FROM conversations WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1'
    ).get(userId) as { id: string; updated_at: string } | undefined;

    if (existing) {
        const lastUpdate = new Date(existing.updated_at.replace(' ', 'T') + 'Z').getTime();
        if ((Date.now() - lastUpdate) > 4 * 60 * 60 * 1000) {
            return createNewConversation(db, userId);
        }
        return existing.id;
    }
    return createNewConversation(db, userId);
}

export function createNewConversation(db: Database.Database, userId: string): string {
    const id = `conv_${userId}_${Date.now()}`;
    db.prepare('INSERT INTO conversations (id, user_id) VALUES (?, ?)').run(id, userId);
    return id;
}

export function addMessage(
    db: Database.Database,
    conversationId: string,
    role: Message['role'],
    content: string
): void {
    try {
        db.prepare('INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)').run(conversationId, role, content);
        db.prepare('UPDATE conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(conversationId);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error('sqlite_write_failed', `[CONV] DATA LOST: messages INSERT blocked. conversationId=${conversationId} role=${role} contentLen=${content.length} error=${msg}`);
        throw err;
    }
}

export function getRecentMessages(db: Database.Database, conversationId: string, limit: number = 5): Message[] {
    return db.prepare(
        'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?'
    ).all(conversationId, limit).reverse() as Message[];
}

export function searchMessages(db: Database.Database, conversationId: string, query: string, limit: number = 6): Message[] {
    const stopWords = new Set(['o', 'a', 'os', 'as', 'de', 'do', 'da', 'dos', 'das', 'em', 'no', 'na', 'nos', 'nas', 'um', 'uma', 'uns', 'umas', 'e', 'ou', 'mas', 'se', 'que', 'não', 'para', 'com', 'por', 'como', 'isso', 'esse', 'essa', 'estes', 'estas', 'esse', 'isso', 'aquilo', 'the', 'is', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by']);
    const keywords = query.toLowerCase()
        .replace(/[^\w\sáàãâéèêíìîóòõôúùûç]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 2 && !stopWords.has(w));

    if (keywords.length === 0) return [];

    try {
        const results = db.prepare(`
            SELECT * FROM messages
            WHERE conversation_id = ? AND content LIKE '%' || ? || '%'
            ORDER BY created_at DESC LIMIT ?
        `).all(conversationId, `%${keywords[0]}%`, limit) as Message[];
        if (results.length > 0) return results.reverse();
    } catch { /* FTS not available */ }

    const conditions = keywords.map(() => 'content LIKE ?').join(' OR ');
    const params = keywords.map(k => `%${k}%`);
    const results = db.prepare(`
        SELECT * FROM messages
        WHERE conversation_id = ? AND (${conditions})
        ORDER BY created_at DESC LIMIT ?
    `).all(conversationId, ...params, limit) as Message[];

    return results.reverse();
}
