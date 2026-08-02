import { Router, Request, Response } from 'express';
import express from 'express';
import crypto from 'crypto';

// ── Persistência no SQLite (injetada via initAuthPersistence) ──
interface SimpleDb {
    prepare(sql: string): {
        get(...params: unknown[]): unknown;
        run(...params: unknown[]): void;
    };
}
let persistDb: SimpleDb | null = null;

// ── Precedência entre as DUAS fontes de verdade da autenticação ──────────────
//
// (1) `DASHBOARD_PASSWORD` no ambiente — provisionamento de deploy (.env, `docker -e`,
//     systemd). (2) Estado persistido no banco — escolha explícita do operador pelo painel.
//
// Até 02/08/2026 não havia precedência declarada: o ambiente vencia sempre, em silêncio. O
// botão "desativar" do painel funcionava em runtime (zerava `enabled` e o hash), mas o bloco de
// boot mais abaixo reativava tudo a partir de `process.env` no próximo start — e o "Salvar" da
// config nunca escreveu `DASHBOARD_PASSWORD` no .env (37 chaves gravadas, essa não). Resultado
// observado em produção: o operador desativava, reiniciava, e a senha voltava. Indefinidamente.
//
// Regra agora explícita: uma DESATIVAÇÃO EXPLÍCITA do operador é persistida e vence o ambiente.
// Qualquer outro caso mantém o comportamento anterior — quem só define `DASHBOARD_PASSWORD` e
// nunca toca no painel (o caso de container/systemd) não percebe diferença nenhuma.
//
// Por que não apagar a chave do .env em vez disso: a variável pode não vir de arquivo nenhum
// (`docker run -e`, unit do systemd, export no shell). Reescrever o .env resolveria só um dos
// casos e continuaria mentindo nos outros — além de apagar um segredo do operador sem que ele
// tenha pedido isso.
const AUTH_DISABLED_KEY = 'dashboard_auth_disabled';

/** De onde veio o estado atual — reportado no /status para a UI não precisar adivinhar. */
export type AuthSource = 'environment' | 'dashboard' | 'operator_disabled' | 'none';
let authSource: AuthSource = 'none';

export function getAuthSource(): AuthSource {
    return authSource;
}

/** `DASHBOARD_PASSWORD` presente no ambiente, independente de estar em efeito. */
export function isEnvManaged(): boolean {
    return !!process.env.DASHBOARD_PASSWORD;
}

function readOperatorDisabled(): boolean {
    if (!persistDb) return false;
    try {
        const row = persistDb.prepare(
            'SELECT value FROM memory WHERE key = ?'
        ).get(AUTH_DISABLED_KEY) as { value: string } | undefined;
        return row?.value === '1';
    } catch {
        // Tabela ausente/ilegível: falha FECHADA — na dúvida a autenticação continua como está,
        // nunca desligada por não conseguirmos ler o estado.
        return false;
    }
}

function writeOperatorDisabled(disabled: boolean): void {
    if (!persistDb) return;
    try {
        if (disabled) {
            persistDb.prepare(
                "INSERT OR REPLACE INTO memory (key, value, category) VALUES (?, '1', 'system')"
            ).run(AUTH_DISABLED_KEY);
        } else {
            persistDb.prepare('DELETE FROM memory WHERE key = ?').run(AUTH_DISABLED_KEY);
        }
    } catch { /* ignore */ }
}

function loadPersistedHash(): void {
    if (!persistDb) return;

    // Desativação explícita do operador vence o ambiente — e diz isso em voz alta, porque um
    // dashboard sem autenticação com a variável definida é exatamente o tipo de estado que não
    // pode ficar implícito para quem opera o servidor.
    if (readOperatorDisabled()) {
        dashboardAuth.enabled = false;
        dashboardAuth.passwordHash = '';
        authSource = 'operator_disabled';
        if (process.env.DASHBOARD_PASSWORD) {
            console.warn(
                '[auth] DASHBOARD_PASSWORD está definida no ambiente, mas a autenticação foi '
                + 'DESATIVADA explicitamente no painel — a variável está sendo ignorada. '
                + 'Para reativar: painel → Segurança → ativar autenticação.'
            );
        }
        return;
    }

    try {
        const row = persistDb.prepare(
            "SELECT value FROM memory WHERE key = 'dashboard_password_hash'"
        ).get() as { value: string } | undefined;
        if (row?.value && !process.env.DASHBOARD_PASSWORD) {
            dashboardAuth.enabled = true;
            dashboardAuth.passwordHash = row.value;
            authSource = 'dashboard';
        }
    } catch { /* table pode não existir ainda */ }
}

function savePersistedHash(hash: string): void {
    if (!persistDb) return;
    try {
        persistDb.prepare(
            "INSERT OR REPLACE INTO memory (key, value, category) VALUES ('dashboard_password_hash', ?, 'system')"
        ).run(hash);
    } catch { /* ignore */ }
}

function clearPersistedHash(): void {
    if (!persistDb) return;
    try {
        persistDb.prepare("DELETE FROM memory WHERE key = 'dashboard_password_hash'").run();
    } catch { /* ignore */ }
}

/** Chamado pelo DashboardServer após ter acesso ao DB. */
export function initAuthPersistence(db: SimpleDb): void {
    persistDb = db;
    loadPersistedHash();
}

// ── Session tokens (in-memory, cleared on restart) ──
const API_TOKENS: Set<string> = new Set();

// ── Persistent signed tokens (survive restarts) ──
// A signed token = hmac(DASHBOARD_PASSWORD, random-bytes). Verifiable without storing.

export let dashboardAuth: { enabled: boolean; passwordHash: string } = { enabled: false, passwordHash: '' };

// scrypt: KDF lenta (custa memória+CPU por tentativa), diferente de sha256 puro — que é rápido
// demais pra hash de senha (permite brute-force em GPU a bilhões de tentativas/segundo).
// Formato novo tem prefixo "scrypt:" pra distinguir de hashes antigos já persistidos (formato
// legado sem prefixo, "salt:sha256hash") sem quebrar quem já tinha senha configurada.
const SCRYPT_KEYLEN = 64;

function hashPassword(password: string): string {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
    return `scrypt:${salt}:${hash}`;
}

function verifyPasswordScrypt(password: string, salt: string, expectedHash: string): boolean {
    try {
        const actual = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
        const expected = Buffer.from(expectedHash, 'hex');
        return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
    } catch {
        return false;
    }
}

// Mantido só pra verificar (nunca pra criar) hashes gravados antes desta mudança — ver
// migrateIfLegacy() no /login, que re-hasheia com scrypt no primeiro login bem-sucedido.
function verifyPasswordLegacySha256(password: string, salt: string, expectedHash: string): boolean {
    const actualHash = crypto.createHash('sha256').update(salt + password).digest('hex');
    try {
        return crypto.timingSafeEqual(
            Buffer.from(actualHash, 'hex'),
            Buffer.from(expectedHash, 'hex')
        );
    } catch {
        return false;
    }
}

function verifyPassword(password: string, stored: string): boolean {
    if (!stored) return false;
    if (stored.startsWith('scrypt:')) {
        const parts = stored.split(':');
        if (parts.length !== 3) return false;
        const [, salt, expectedHash] = parts;
        return verifyPasswordScrypt(password, salt, expectedHash);
    }
    if (!stored.includes(':')) return false;
    const [salt, expectedHash] = stored.split(':');
    return verifyPasswordLegacySha256(password, salt, expectedHash);
}

// ── Signed token: survives restarts ──
// Secret resolution: DASHBOARD_PASSWORD env var (primary) → stored password hash (fallback).
// Using the stored hash as fallback means tokens survive restart even without .env.
//
// GHSA-jpx8-29mp-v4hw: never fall back to a hardcoded/predictable string here. If neither a
// real secret exists, `enabled` should never have become true in the first place (enforced in
// the /config route below) — but as defense in depth, fall back to a random per-process secret
// instead of a public constant, so a stray/forged token can never be pre-computed by an attacker.
const processRandomSecret = crypto.randomBytes(32).toString('hex');

export function getEffectiveSecret(): string {
    if (process.env.DASHBOARD_PASSWORD) return process.env.DASHBOARD_PASSWORD;
    return dashboardAuth.passwordHash || processRandomSecret;
}

function createSignedToken(): string {
    const raw = crypto.randomBytes(32).toString('hex');
    const signature = crypto.createHmac('sha256', getEffectiveSecret()).update(raw).digest('hex');
    const token = `${raw}.${signature}`;
    API_TOKENS.add(token);
    return token;
}

function verifySignedToken(token: string): boolean {
    // Fast path: in-memory set
    if (API_TOKENS.has(token)) return true;

    // Slow path: verify signature (survives restart)
    const parts = token.split('.');
    if (parts.length !== 2) return false;
    const [raw, signature] = parts;
    const expected = crypto.createHmac('sha256', getEffectiveSecret()).update(raw).digest('hex');
    try {
        if (crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'))) {
            API_TOKENS.add(token);
            return true;
        }
    } catch { /* invalid format */ }
    return false;
}

// Boot: o ambiente ativa a autenticação por padrão. Isto roda ANTES de `initAuthPersistence()`
// (que só é chamado quando o DashboardServer já tem o banco), então `loadPersistedHash()` ainda
// pode reverter este estado se o operador tiver desativado explicitamente — ver a nota de
// precedência no topo do arquivo.
if (process.env.DASHBOARD_PASSWORD) {
    dashboardAuth.enabled = true;
    dashboardAuth.passwordHash = hashPassword(process.env.DASHBOARD_PASSWORD);
    authSource = 'environment';
}

export function authMiddleware(req: Request, res: Response, next: express.NextFunction): void {
    if (!dashboardAuth.enabled) { next(); return; }
    const headerToken = req.headers.authorization?.replace('Bearer ', '') || req.query.token;
    const cookieToken = req.cookies?.newclaw_session;
    const token = headerToken || cookieToken;
    if (token && verifySignedToken(String(token))) { next(); return; }
    const normalizedPath = req.path.endsWith('/') && req.path.length > 1 ? req.path.slice(0, -1) : req.path;
    const allowedPaths = ['/', '/config', '/help', '/traces', '/memory', '/memory-graph', '/memory-review', '/shared.js', '/shared.css', '/favicon.ico', '/api/auth/login', '/health'];
    if (allowedPaths.includes(normalizedPath) || normalizedPath.endsWith('.html') || normalizedPath.endsWith('.js') || normalizedPath.endsWith('.css')) {
        next();
        return;
    }
    res.status(401).json({ error: 'Unauthorized' });
}

// Keep API_TOKENS export for backward compat
export { API_TOKENS };

export function createAuthRouter(): Router {
    const router = Router();

    router.post('/login', (req: Request, res: Response) => {
        const { password } = req.body;
        if (!dashboardAuth.enabled) {
            return res.json({ success: true, token: 'no-auth-required' });
        }
        if (password && verifyPassword(password, dashboardAuth.passwordHash)) {
            // Migração transparente: login legítimo com hash no formato antigo (sha256, sem
            // KDF) — re-hasheia com scrypt e persiste, sem exigir troca de senha do operador.
            if (!dashboardAuth.passwordHash.startsWith('scrypt:')) {
                const migrated = hashPassword(password);
                dashboardAuth.passwordHash = migrated;
                savePersistedHash(migrated);
            }
            const token = createSignedToken();
            // Set httpOnly cookie for session persistence across page loads
            res.cookie('newclaw_session', token, {
                httpOnly: true,
                sameSite: 'strict',
                maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
                path: '/',
            });
            res.json({ success: true, token });
        } else {
            res.status(401).json({ success: false, error: 'Invalid password' });
        }
    });

    router.post('/logout', (_req: Request, res: Response) => {
        res.clearCookie('newclaw_session', { path: '/' });
        res.json({ success: true });
    });

    router.get('/status', (_req: Request, res: Response) => {
        res.json({
            success: true,
            auth: {
                enabled: dashboardAuth.enabled,
                hasPassword: !!dashboardAuth.passwordHash,
                // De onde veio o estado, para a UI reportar em vez de adivinhar. `envManaged`
                // continua true mesmo quando a variável está sendo IGNORADA por desativação
                // explícita — é justamente aí que o operador precisa saber que ela existe.
                source: authSource,
                envManaged: isEnvManaged(),
            },
        });
    });

    router.post('/config', (req: Request, res: Response) => {
        const { enabled, password } = req.body;
        // GHSA-jpx8-29mp-v4hw: nunca permitir enabled=true sem uma senha real (nesta requisição
        // ou já persistida) — essa combinação deixa dashboardAuth.passwordHash vazio, forçando
        // getEffectiveSecret() a cair no fallback e login/verificação ficarem impossíveis.
        if (enabled === true && !password && !dashboardAuth.passwordHash) {
            res.status(400).json({ success: false, error: 'Defina uma senha antes de ativar a autenticação' });
            return;
        }
        if (typeof enabled === 'boolean') {
            dashboardAuth.enabled = enabled;
            // Desativando auth: remove hash persistido E registra a decisão, para que ela
            // sobreviva ao restart mesmo com DASHBOARD_PASSWORD no ambiente. Sem este registro,
            // o bloco de boot reativava tudo e o botão virava um no-op silencioso após reiniciar.
            if (!enabled) {
                dashboardAuth.passwordHash = '';
                clearPersistedHash();
                writeOperatorDisabled(true);
                authSource = 'operator_disabled';
            } else {
                writeOperatorDisabled(false);
                authSource = isEnvManaged() ? 'environment' : 'dashboard';
            }
        }
        if (password) {
            const hash = hashPassword(password);
            dashboardAuth.passwordHash = hash;
            dashboardAuth.enabled = true;
            savePersistedHash(hash);
            // Definir senha é reativar: limpa a desativação explícita, senão o próximo boot
            // desligaria a autenticação que acabou de ser configurada.
            writeOperatorDisabled(false);
            authSource = isEnvManaged() ? 'environment' : 'dashboard';
            // Invalida todos os tokens antigos — obriga novo login com a nova senha
            API_TOKENS.clear();
        }
        res.json({
            success: true,
            auth: {
                enabled: dashboardAuth.enabled,
                hasPassword: !!dashboardAuth.passwordHash,
                source: authSource,
                envManaged: isEnvManaged(),
            },
        });
    });

    return router;
}