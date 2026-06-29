/**
 * OnboardingService — apresentação única na primeira instalação.
 *
 * Dispara UMA VEZ quando o banco está vazio (sistema recém-instalado).
 * Após o usuário informar nome e apelido, grava em DB + grafo de memória
 * e nunca mais pergunta — independente de canal ou reinício.
 *
 * Fluxo:
 *   Passo 0 → apresentação + pede nome
 *   Passo 1 → confirma apelido
 *   Completo → grava user_identity + user_profile → nunca mais dispara
 */

import { Database } from 'better-sqlite3';
import { MemoryManager } from '../memory/MemoryManager';
import { createLogger } from '../shared/AppLogger';
import type { OwnerProfileService } from './OwnerProfileService';

const log = createLogger('OnboardingService');

// ── Tipos públicos ────────────────────────────────────────────────────────────

export interface UserProfile {
    user_id: string;
    name: string | null;
    nickname: string | null;
    intent: string | null;
    assistant_name: string | null;
    expertise: string | null;
    goals: string | null;
    familiarity: string | null;
    response_style: string;
    learning_mode: string;
    autonomy_level: string;
    workspace_path: string | null;
    language_preference: string;
    onboarding_completed: number;
    created_at: string;
    updated_at: string;
}

export interface OnboardingState {
    step: number;
    userId: string;
    data: { name?: string; nickname?: string };
}

// ── OnboardingService ─────────────────────────────────────────────────────────

export class OnboardingService {
    private db: Database;
    private memory: MemoryManager;
    private ownerService: OwnerProfileService | null;

    constructor(
        db: Database,
        memory: MemoryManager,
        ownerService?: OwnerProfileService
    ) {
        this.db = db;
        this.memory = memory;
        this.ownerService = ownerService ?? null;
        this._ensureSchema();
    }

    // ── Schema ────────────────────────────────────────────────────────────────

    private _ensureSchema(): void {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS user_profile (
                user_id             TEXT PRIMARY KEY,
                name                TEXT,
                nickname            TEXT,
                intent              TEXT,
                assistant_name      TEXT,
                expertise           TEXT,
                goals               TEXT,
                familiarity         TEXT,
                response_style      TEXT DEFAULT 'adaptive',
                learning_mode       TEXT DEFAULT 'enabled',
                autonomy_level      TEXT DEFAULT 'balanced',
                workspace_path      TEXT,
                language_preference TEXT DEFAULT 'system',
                onboarding_completed INTEGER DEFAULT 0,
                created_at          TEXT DEFAULT CURRENT_TIMESTAMP,
                updated_at          TEXT DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS onboarding_state (
                id      INTEGER PRIMARY KEY CHECK (id = 1),
                step    INTEGER DEFAULT 0,
                name    TEXT,
                user_id TEXT
            );
        `);

        // Migrations idempotentes
        const cols = new Set(
            (this.db.prepare('PRAGMA table_info(user_profile)').all() as Array<{ name: string }>)
                .map(c => c.name)
        );
        const add = (sql: string) => { try { this.db.exec(sql); } catch { /* já existe */ } };
        if (!cols.has('nickname'))   add("ALTER TABLE user_profile ADD COLUMN nickname TEXT");
        if (!cols.has('created_at')) add("ALTER TABLE user_profile ADD COLUMN created_at TEXT DEFAULT CURRENT_TIMESTAMP");
        if (!cols.has('onboarding_completed')) add("ALTER TABLE user_profile ADD COLUMN onboarding_completed INTEGER DEFAULT 0");
    }

    // ── API pública ───────────────────────────────────────────────────────────

    /**
     * Verifica se onboarding ainda é necessário.
     * É uma verificação GLOBAL: basta um usuário ter completado para
     * o sistema nunca mais pedir.
     */
    isOnboardingRequired(): boolean {
        try {
            // Qualquer linha com onboarding_completed = 1 → sistema configurado
            const done = this.db.prepare(
                'SELECT 1 FROM user_profile WHERE onboarding_completed = 1 LIMIT 1'
            ).get();
            if (done) return false;

            // user_identity com nome real também conta
            const identityNode = this.memory.getNode('user_identity');
            if (identityNode?.name && identityNode.name !== 'USER' && identityNode.name.length > 1) {
                return false;
            }

            return true;
        } catch {
            return false; // em caso de erro, não bloqueie o usuário
        }
    }

    /**
     * Processa a mensagem do usuário dentro do fluxo de onboarding.
     * Retorna { reply } com a próxima pergunta, ou { reply, completed: true }
     * quando o onboarding termina.
     */
    async processMessage(
        userId: string,
        text: string
    ): Promise<{ reply: string; completed?: boolean }> {
        const state = this._loadState();

        // Passo 0: primeira mensagem → apresentação + pede nome
        if (state == null || state.step === 0) {
            this._saveState({ step: 1, user_id: userId, name: null });
            return {
                reply: this._msgPresentation(),
            };
        }

        // Passo 1: usuário respondeu com o nome
        if (state.step === 1) {
            const name = this._extractName(text);
            this._saveState({ step: 2, user_id: userId, name });
            return {
                reply: `Prazer em te conhecer, *${name}*! 😊\n\nComo prefere que eu te chame? Pode confirmar _${name}_ ou me dar um apelido.`,
            };
        }

        // Passo 2: usuário confirmou/deu apelido
        if (state.step === 2) {
            const name     = state.name || this._extractName(text);
            const nickname = this._extractName(text) || name;
            this._complete(userId, name, nickname);
            return {
                reply: this._msgWelcome(nickname),
                completed: true,
            };
        }

        // Fallback: reinicia
        this._saveState({ step: 1, user_id: userId, name: null });
        return { reply: this._msgPresentation() };
    }

    /** Retorna o perfil do usuário, se existir. */
    getUserProfile(userId: string): UserProfile | null {
        return this.db.prepare(
            'SELECT * FROM user_profile WHERE user_id = ?'
        ).get(userId) as UserProfile | null;
    }

    /** Retorna o nome/apelido do dono do sistema (qualquer userId com onboarding completo). */
    getOwnerNickname(): string | null {
        const row = this.db.prepare(
            'SELECT nickname, name FROM user_profile WHERE onboarding_completed = 1 LIMIT 1'
        ).get() as { nickname: string | null; name: string | null } | undefined;
        return row?.nickname || row?.name || null;
    }

    // ── Internos ──────────────────────────────────────────────────────────────

    private _loadState(): { step: number; user_id: string | null; name: string | null } | null {
        return this.db.prepare('SELECT * FROM onboarding_state WHERE id = 1').get() as
            { step: number; user_id: string | null; name: string | null } | null;
    }

    private _saveState(s: { step: number; user_id: string | null; name: string | null }): void {
        this.db.prepare(`
            INSERT INTO onboarding_state (id, step, user_id, name)
            VALUES (1, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET step = excluded.step, user_id = excluded.user_id, name = excluded.name
        `).run(s.step, s.user_id, s.name);
    }

    private _complete(userId: string, name: string, nickname: string): void {
        const now = new Date().toISOString();

        // Persiste no user_profile
        this.db.prepare(`
            INSERT INTO user_profile (user_id, name, nickname, onboarding_completed, created_at, updated_at)
            VALUES (?, ?, ?, 1, ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET
                name = excluded.name,
                nickname = excluded.nickname,
                onboarding_completed = 1,
                updated_at = excluded.updated_at
        `).run(userId, name, nickname, now, now);

        // Persiste no grafo de memória (user_identity)
        try {
            this.memory.setUserName(userId, nickname);
            // Atualiza conteúdo do core_user para o agente saber o nome
            this.memory.addNode({
                id: 'core_user',
                type: 'identity',
                name: 'USER',
                content: `Perfil do dono: nome=${name}, apelido preferido=${nickname}. Sempre se refira a ele como ${nickname}.`,
                confidence: 1.0,
            });
            log.info('onboarding_complete', `Usuário identificado: ${name} (${nickname})`);
        } catch (e) {
            log.warn('onboarding_memory_write_failed', String(e));
        }

        // Persiste no OwnerProfileService se disponível
        if (this.ownerService) {
            try { this.ownerService.confirmOwnerName(name, userId, 'onboarding'); } catch { /* ok */ }
        }

        // Limpa estado transitório
        this.db.prepare('DELETE FROM onboarding_state WHERE id = 1').run();
    }

    private _extractName(text: string): string {
        // Dois passes: remove saudação, depois frase introdutória
        let s = text.trim();
        s = s.replace(/^(olá[,!.]*\s*|oi[,!.]*\s*|hey[,!.]*\s*)+/i, '').trim();
        s = s.replace(/^(meu nome é|me chamo|sou o|sou a|pode me chamar de|me chama de)[,\s]*/i, '').trim();
        return s
            .split(/\s+/)
            .slice(0, 3)
            .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
            .join(' ')
            || text.trim().slice(0, 40);
    }

    private _msgPresentation(): string {
        return (
            `👋 *Olá! Eu sou o NewClaw* — seu assistente cognitivo local.\n\n` +
            `Acabei de ser instalado e quero me configurar para te servir melhor.\n\n` +
            `Para começar: *qual é o seu nome?*`
        );
    }

    private _msgWelcome(nickname: string): string {
        return (
            `✅ *Tudo pronto, ${nickname}!*\n\n` +
            `Já gravei seu perfil na memória. A partir de agora vou me lembrar de você ` +
            `e personalizar minhas respostas.\n\n` +
            `Como posso te ajudar hoje?`
        );
    }
}
