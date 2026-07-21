/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S137 (CodeQL cluster S5: js/missing-rate-limiting ×22,
 * js/missing-token-validation ×2 — src/dashboard/security.ts)
 *
 * Único sprint arquitetural do programa (docs/issues/seguranca-codeql-2026-07-20/SPRINTS/S5) —
 * introduz middleware novo e central (rate-limit + CSRF), passou pelas 5 fases da
 * DIRETRIZ_ARQUITETURA_2026-07-13 antes de codar (sem dependência nova — mesmo padrão de scrypt
 * nativo/execFile já usado nesta sessão; CSRF via checagem de Origin, não token, já que
 * sameSite:'strict' no cookie já mitiga o CSRF clássico).
 *
 * HTTP real contra um servidor Express real (nada mockado) — Etapa 4 da Validação Progressiva
 * é especialmente relevante aqui por ser o item arquitetural do programa.
 *
 * Execução: npx ts-node src/__tests__/regression/S137_DashboardSecurity_RateLimitCSRF.test.ts
 */

import express from 'express';
import cookieParser from 'cookie-parser';
import { createRateLimiter, rateLimitMiddleware, csrfOriginCheck } from '../../dashboard/security';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  OK ${message}`); passed++; }
    else { console.error(`  FALHOU: ${message}`, detail ?? ''); failed++; }
}

async function withServer(app: express.Express, run: (base: string) => Promise<void>): Promise<void> {
    const server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    const port = (server.address() as any).port;
    try {
        await run(`http://127.0.0.1:${port}`);
    } finally {
        server.close();
    }
}

async function main() {
    console.log('\n=== S137.1 — rate limit real: N+1ª requisição na janela recebe 429 ===');
    {
        const app = express();
        const strict = createRateLimiter({ windowMs: 60_000, max: 3, message: 'limite atingido' });
        app.get('/x', strict, (_req, res) => res.json({ ok: true }));

        await withServer(app, async (base) => {
            const statuses: number[] = [];
            for (let i = 0; i < 5; i++) {
                const r = await fetch(`${base}/x`);
                statuses.push(r.status);
            }
            assert(statuses.slice(0, 3).every(s => s === 200), 'as 3 primeiras requisições (dentro do limite) passam com 200', statuses);
            assert(statuses[3] === 429 && statuses[4] === 429, 'a 4ª e 5ª requisição (acima do limite) recebem 429', statuses);
        });
    }

    console.log('\n=== S137.2 — rota de polling (exempt) não é limitada pelo rate-limit geral ===');
    {
        const app = express();
        app.get('/api/integrations/powerpoint/commands', rateLimitMiddleware, (_req, res) => res.json({ ok: true }));

        await withServer(app, async (base) => {
            const statuses: number[] = [];
            // Bem mais que o limite geral (120/min) pra provar que não é throttled.
            for (let i = 0; i < 130; i++) {
                const r = await fetch(`${base}/api/integrations/powerpoint/commands`);
                statuses.push(r.status);
            }
            assert(statuses.every(s => s === 200), '130 requisições na rota de polling isenta continuam todas 200 (não quebra o add-in)', statuses.filter(s => s !== 200).length);
        });
    }

    console.log('\n=== S137.3 — CSRF: POST autenticado por COOKIE com Origin diferente do Host é bloqueado (403) ===');
    {
        const app = express();
        app.use(express.json());
        app.use(cookieParser());
        app.use(csrfOriginCheck);
        app.post('/mutate', (req, res) => { req.cookies; res.json({ ok: true }); });

        await withServer(app, async (base) => {
            const r = await fetch(`${base}/mutate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Cookie: 'newclaw_session=fake-token', Origin: 'https://attacker.evil' },
                body: '{}',
            });
            assert(r.status === 403, 'POST com cookie de sessão + Origin de outro site é bloqueado', r.status);
        });
    }

    console.log('\n=== S137.4 — CSRF: POST autenticado por COOKIE com Origin igual ao Host passa normalmente ===');
    {
        const app = express();
        app.use(express.json());
        app.use(cookieParser());
        app.use(csrfOriginCheck);
        app.post('/mutate', (_req, res) => res.json({ ok: true }));

        await withServer(app, async (base) => {
            const r = await fetch(`${base}/mutate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Cookie: 'newclaw_session=fake-token', Origin: base },
                body: '{}',
            });
            assert(r.status === 200, 'POST com cookie de sessão + Origin igual ao próprio host passa (fluxo legítimo do dashboard não quebra)', r.status);
        });
    }

    console.log('\n=== S137.5 — CSRF: POST autenticado por BEARER (sem cookie) nunca é bloqueado, mesmo sem Origin — não quebra o suplemento PowerPoint ===');
    {
        const app = express();
        app.use(express.json());
        app.use(cookieParser());
        app.use(csrfOriginCheck);
        app.post('/mutate', (_req, res) => res.json({ ok: true }));

        await withServer(app, async (base) => {
            // Simula o suplemento PowerPoint: Authorization Bearer, origem diferente do
            // dashboard (roda em outra porta/domínio), sem cookie (sameSite:strict já impede o
            // navegador de mandar o cookie cross-origin de qualquer forma).
            const r = await fetch(`${base}/mutate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: 'Bearer real-api-token' },
                body: '{}',
            });
            assert(r.status === 200, 'POST autenticado por Bearer (sem cookie) passa mesmo sem Origin — cliente de API/add-in não é afetado', r.status);
        });
    }

    console.log('\n=== S137.6 — CSRF: GET nunca é bloqueado, independente de Origin ===');
    {
        const app = express();
        app.use(cookieParser());
        app.use(csrfOriginCheck);
        app.get('/read', (_req, res) => res.json({ ok: true }));

        await withServer(app, async (base) => {
            const r = await fetch(`${base}/read`, { headers: { Cookie: 'newclaw_session=fake-token', Origin: 'https://attacker.evil' } });
            assert(r.status === 200, 'GET com Origin de outro site nunca é bloqueado (CSRF só se aplica a métodos mutantes)', r.status);
        });
    }

    console.log(`\n=== RESULTADO: ${passed} passou, ${failed} falhou ===`);
    if (failed > 0) process.exit(1);
}

main().catch(err => { console.error(err); process.exit(1); });
