/**
 * security.ts — rate limiting + proteção CSRF do dashboard.
 *
 * CodeQL js/missing-rate-limiting (22 alertas) + js/missing-token-validation (2 alertas),
 * docs/issues/seguranca-codeql-2026-07-20/SPRINTS/S5-dashboard-rate-limit-csrf.md — nenhum
 * middleware desse tipo existia antes.
 *
 * Sem dependência nova (`express-rate-limit`/`csurf`): mesmo padrão já usado nesta sessão pra
 * outros achados de segurança (scrypt nativo em vez de bcrypt, execFile em vez de lib de shell-
 * escaping) — a implementação necessária aqui é pequena o suficiente pra não justificar puxar
 * mais uma dependência de terceiros pro supply chain (e esta mesma sessão já lidou com 3
 * vulnerabilidades de dependências transitivas hoje).
 *
 * CSRF via checagem de Origin/Referer, não token: o dashboard já usa cookie `httpOnly` +
 * `sameSite: 'strict'` (auth.ts) — isso já bloqueia o navio principal do CSRF clássico em
 * navegadores modernos (sameSite=strict nunca envia o cookie em requisição cross-site, nem por
 * navegação top-level). A checagem de Origin é defesa em profundidade barata (sem exigir que o
 * frontend passe a mandar um token em cada requisição mutante) pro caso de sameSite falhar por
 * algum motivo (proxy que remove o atributo, navegador não compliant, etc.) — não é a MESMA
 * garantia de um token CSRF completo, mas é proporcional ao risco residual depois do sameSite.
 */
import { Request, Response, NextFunction } from 'express';

// ── Rate limiting (janela fixa, em memória, por IP) ─────────────────────────

interface RateLimitOptions {
    windowMs: number;
    max: number;
    message: string;
}

/**
 * Cria um middleware de rate-limit por IP com janela fixa. Estado em memória (não sobrevive
 * restart) — proporcional ao uso real: o dashboard roda num processo único, sem necessidade de
 * estado compartilhado entre instâncias.
 */
export function createRateLimiter(opts: RateLimitOptions) {
    const hits = new Map<string, { count: number; resetAt: number }>();

    // Evita crescimento ilimitado do Map — remove entradas expiradas periodicamente.
    const cleanupInterval = setInterval(() => {
        const now = Date.now();
        for (const [key, entry] of hits) {
            if (now > entry.resetAt) hits.delete(key);
        }
    }, opts.windowMs);
    if (cleanupInterval.unref) cleanupInterval.unref();

    // LIMITAÇÃO CONHECIDA (documentada, não corrigida — não há valor seguro genérico): sem
    // `app.set('trust proxy', ...)`, `req.ip` é o peer TCP direto. No bind padrão (127.0.0.1,
    // sem proxy) isso é correto. Atrás de um proxy reverso (ARCHITECTURE.md: DASHBOARD_HOST=0.0.0.0
    // + proxy), todo request chega com o MESMO `req.ip` (o do proxy) — o limite passa a ser por
    // proxy, não por usuário real. Configurar `trust proxy` corretamente exige saber quantos
    // hops de proxy confiar, uma decisão específica do operador que não dá pra assumir aqui sem
    // risco de abrir spoofing de IP via X-Forwarded-For forjado por quem já tem acesso à rede.
    return (req: Request, res: Response, next: NextFunction): void => {
        const key = req.ip || req.socket.remoteAddress || 'unknown';
        const now = Date.now();
        let entry = hits.get(key);
        if (!entry || now > entry.resetAt) {
            entry = { count: 0, resetAt: now + opts.windowMs };
            hits.set(key, entry);
        }
        entry.count++;
        if (entry.count > opts.max) {
            res.status(429).json({ error: opts.message });
            return;
        }
        next();
    };
}

/** Limite geral do dashboard: generoso o bastante pra uso normal, barra hammering. */
export const generalRateLimit = createRateLimiter({
    windowMs: 60 * 1000,
    max: 120,
    message: 'Muitas requisições — tente novamente em instantes.',
});

/**
 * Limite estrito só pra /api/auth/login — proteção contra força bruta de senha. Bem mais baixo
 * que o geral: login legítimo não precisa de mais que algumas tentativas por janela.
 */
export const loginRateLimit = createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: 'Muitas tentativas de login — aguarde alguns minutos.',
});

/**
 * Rotas de polling de alta frequência (legítimo, não é hammering) — o PowerPoint add-in consulta
 * `/api/integrations/powerpoint/commands` em intervalo curto enquanto aguarda um comando. Passar
 * pelo limite geral quebraria esse fluxo; ficam de fora do middleware global.
 */
const RATE_LIMIT_EXEMPT_PATHS = new Set([
    '/api/integrations/powerpoint/commands',
    '/api/stream',
]);

export function rateLimitMiddleware(req: Request, res: Response, next: NextFunction): void {
    if (RATE_LIMIT_EXEMPT_PATHS.has(req.path)) { next(); return; }
    generalRateLimit(req, res, next);
}

// ── CSRF: checagem de Origin/Referer em requisições mutantes autenticadas por cookie ──────────

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function csrfOriginCheck(req: Request, res: Response, next: NextFunction): void {
    if (SAFE_METHODS.has(req.method)) { next(); return; }

    // Bearer token (Authorization header) não é enviado automaticamente pelo navegador em
    // requisição cross-site — só cookie é vulnerável a CSRF. Clientes de API (PowerPoint add-in,
    // integrações externas) usam Bearer, não cookie, e não devem ser bloqueados aqui.
    const usingCookieAuth = Boolean(req.cookies?.newclaw_session) && !req.headers.authorization;
    if (!usingCookieAuth) { next(); return; }

    const origin = req.headers.origin || req.headers.referer;
    if (!origin) {
        res.status(403).json({ error: 'Requisição bloqueada: Origin/Referer ausente (proteção CSRF).' });
        return;
    }

    try {
        const originHost = new URL(origin).host;
        if (originHost !== req.headers.host) {
            res.status(403).json({ error: 'Requisição bloqueada: Origin não corresponde ao host (proteção CSRF).' });
            return;
        }
    } catch {
        res.status(403).json({ error: 'Requisição bloqueada: Origin inválido.' });
        return;
    }

    next();
}
