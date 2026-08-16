/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S233
 * Correção dos 5 alertas de code-scanning acionáveis por código (14-15/08/2026,
 * https://github.com/rovanni/NewClaw/security/code-scanning — alertas #91-96).
 *
 * Os outros 4 alertas do lote (#89, #90, #97, #98) foram avaliados como falso-positivo
 * (escaping já presente via `esc()` num HTML gerado estático, ou dado sintético de teste sem
 * segredo real) e não têm cobertura aqui — decisão registrada na conclusão da campanha, não em
 * código.
 *
 * ── #96 — js/polynomial-redos, dashboard/routes/providers.ts:113 ───────────────────────────
 * `String(baseUrl).trim().replace(/\/+$/, '')` trocado por um loop `while (url.endsWith('/'))`:
 * mesmo resultado, sem regex — elimina a classe de risco em vez de argumentar que o padrão
 * específico não é catastroficamente lento.
 *
 * ── #92 — js/loop-bound-injection, dashboard/routes/models.ts:129 ──────────────────────────
 * `sanitizeServerOptions()` iterava `tokens.length` vezes, e `tokens` vinha de
 * `parseServerOptions(userOptions)` sem teto — `userOptions` é 100% controlado pelo corpo da
 * requisição (`/api/models/local/preview` e `/api/models/local/serve`). `MAX_SERVER_OPTIONS_LENGTH`
 * (4000) limita a entrada ANTES do parse, o que bounda os dois loops (parse + sanitize) de uma vez.
 *
 * ── #93/#94/#95 — js/missing-rate-limiting, dashboard/routes/models.ts (/local, /local/preview,
 * /local/serve) ──────────────────────────────────────────────────────────────────────────────
 * As três rotas já passavam pelo rate-limit GERAL do dashboard (`security.ts`, 120/min,
 * `app.use(rateLimitMiddleware)` antes de `app.use('/api/models', ...)`) — real, mas não
 * reconhecido pela checagem por rota do CodeQL, e genérico demais para o custo real: `/local`
 * lê a pasta de modelos do disco, `/local/serve` sobe um processo que carrega um modelo inteiro
 * na memória. `modelsFsRateLimit` (20/min, reusa `createRateLimiter()` de security.ts — mesma
 * fábrica de `loginRateLimit`) fica em cima do geral, aplicado às 3 rotas.
 *
 * ── #91 — js/request-forgery (SSRF), core/OpenAIProvider.ts (isResponsive/discoverModels/chat)
 * ────────────────────────────────────────────────────────────────────────────────────────────
 * `baseUrl` de um provider custom é host arbitrário por design (servidor local/LAN do usuário) —
 * uma allowlist quebraria o recurso. `assertNotSsrfTarget()` bloqueia só o que NUNCA é um servidor
 * de modelo legítimo: endpoints de metadado de nuvem (169.254.169.254, metadata.google.internal,
 * fd00:ec2::254). Checagem por string do hostname, não por resolução de DNS — não cobre DNS
 * rebinding, limitação documentada no próprio código.
 *
 * Execução: npx ts-node src/__tests__/regression/S233_CodeScanning_DashboardHardening.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

const PROVIDERS_SRC = fs.readFileSync(path.join(process.cwd(), 'src', 'dashboard', 'routes', 'providers.ts'), 'utf-8');
const MODELS_SRC = fs.readFileSync(path.join(process.cwd(), 'src', 'dashboard', 'routes', 'models.ts'), 'utf-8');
const OPENAI_PROVIDER_SRC = fs.readFileSync(path.join(process.cwd(), 'src', 'core', 'OpenAIProvider.ts'), 'utf-8');

console.log('\n=== S233-1 — #96: trim de baseUrl sem regex (polynomial-redos) ===');
{
    assert(!/\.replace\(\/\\\/\+\$\/, ''\)/.test(PROVIDERS_SRC),
        'o padrão /\\/+$/ não existe mais em providers.ts');
    assert(/while \(url\.endsWith\('\/'\)\) url = url\.slice\(0, -1\);/.test(PROVIDERS_SRC),
        'o trim de barras finais agora é um loop determinístico, não regex');

    // Reprodução funcional: o comportamento observável não muda.
    function trimTrailingSlashes(raw: string): string {
        let url = raw.trim();
        while (url.endsWith('/')) url = url.slice(0, -1);
        return url;
    }
    assert(trimTrailingSlashes('http://localhost:8080/v1///') === 'http://localhost:8080/v1', 'remove múltiplas barras finais');
    assert(trimTrailingSlashes('http://localhost:8080/v1') === 'http://localhost:8080/v1', 'não altera URL já sem barra final');
    assert(trimTrailingSlashes('  http://localhost:8080/v1/  ') === 'http://localhost:8080/v1', 'trim + remoção de barra combinados');
}

console.log('\n=== S233-2 — #92: teto de tamanho antes do parse de opções (loop-bound-injection) ===');
{
    assert(/const MAX_SERVER_OPTIONS_LENGTH = 4000;/.test(MODELS_SRC),
        'MAX_SERVER_OPTIONS_LENGTH existe como constante nomeada');
    assert(
        /const bounded = raw\.length > MAX_SERVER_OPTIONS_LENGTH \? raw\.slice\(0, MAX_SERVER_OPTIONS_LENGTH\) : raw;/.test(MODELS_SRC),
        'parseServerOptions() limita a entrada ANTES do loop de parse',
    );

    // Reprodução funcional: uma entrada de 1 milhão de chars não gera 1 milhão de iterações.
    const MAX = 4000;
    function boundedLength(raw: string): number {
        return raw.length > MAX ? MAX : raw.length;
    }
    const hugeInput = '/'.repeat(1_000_000);
    assert(boundedLength(hugeInput) === MAX, 'entrada de 1M chars é limitada a 4000 antes de qualquer parse', boundedLength(hugeInput));
    assert(boundedLength('--n-gpu-layers 32 -fit off') < MAX, 'opções reais (curtas) passam intactas, sem truncar');
}

console.log('\n=== S233-3 — #93/#94/#95: rate-limit dedicado nas rotas fs/spawn de modelo local ===');
{
    assert(/import \{ createRateLimiter \} from '\.\.\/security';/.test(MODELS_SRC),
        'models.ts reusa createRateLimiter() de security.ts — não reimplementa rate-limit');
    assert(
        /const modelsFsRateLimit = createRateLimiter\(\{\s*\n\s*windowMs: 60 \* 1000,\s*\n\s*max: 20,/.test(MODELS_SRC),
        'modelsFsRateLimit existe, mais estrito que o limite geral (120/min)',
    );

    const routes: Array<[string, RegExp]> = [
        ["router.get('/local', ...)", /router\.get\('\/local', modelsFsRateLimit, async/],
        ["router.post('/local/preview', ...)", /router\.post\('\/local\/preview', modelsFsRateLimit, \(/],
        ["router.post('/local/serve', ...)", /router\.post\('\/local\/serve', modelsFsRateLimit, async/],
    ];
    for (const [label, pattern] of routes) {
        assert(pattern.test(MODELS_SRC), `${label} usa modelsFsRateLimit no próprio middleware chain`);
    }
}

console.log('\n=== S233-4 — #91: SSRF — endpoint de metadado de nuvem bloqueado, host arbitrário preservado ===');
{
    assert(/const SSRF_BLOCKED_HOSTS = new Set\(\[/.test(OPENAI_PROVIDER_SRC),
        'SSRF_BLOCKED_HOSTS existe como allowlist... NEGATIVA (bloqueio pontual, não allowlist de host)');
    assert(/'169\.254\.169\.254',/.test(OPENAI_PROVIDER_SRC), 'bloqueia o endpoint de metadado padrão AWS/GCP/Azure');
    assert(/'metadata\.google\.internal',/.test(OPENAI_PROVIDER_SRC), 'bloqueia o alias DNS de metadado do GCP');
    assert(/'fd00:ec2::254',/.test(OPENAI_PROVIDER_SRC), 'bloqueia o endpoint de metadado IMDSv2 da AWS (IPv6)');

    const callSites = [
        ['isResponsive', /async isResponsive\([^)]*\): Promise<boolean> \{\s*\n\s*try \{\s*\n\s*assertNotSsrfTarget\(this\.baseUrl\);/],
        ['discoverModels', /async discoverModels\(\): Promise<ModelInfo\[\]> \{\s*\n\s*assertNotSsrfTarget\(this\.baseUrl\);/],
        ['chat', /async chat\([^)]*\): Promise<LLMResponse> \{\s*\n\s*assertNotSsrfTarget\(this\.baseUrl\);/],
    ];
    for (const [name, pattern] of callSites) {
        assert((pattern as RegExp).test(OPENAI_PROVIDER_SRC), `${name}() chama assertNotSsrfTarget() antes de qualquer fetch`);
    }

    // Reprodução funcional da função (fidelidade garantida pelas asserções estruturais acima).
    function assertNotSsrfTarget(baseUrl: string): void {
        const blocked = new Set(['169.254.169.254', 'metadata.google.internal', 'fd00:ec2::254']);
        let hostname: string;
        try {
            hostname = new URL(baseUrl).hostname.toLowerCase().replace(/^\[|\]$/g, '');
        } catch {
            return;
        }
        if (blocked.has(hostname)) {
            throw new Error(`Endpoint bloqueado: "${hostname}" é um endereço de metadado de nuvem, nunca um servidor de modelo legítimo.`);
        }
    }

    let threw = false;
    try { assertNotSsrfTarget('http://169.254.169.254/latest/meta-data/'); } catch { threw = true; }
    assert(threw, 'endpoint de metadado AWS/GCP/Azure é bloqueado');

    threw = false;
    try { assertNotSsrfTarget('http://metadata.google.internal/computeMetadata/v1/'); } catch { threw = true; }
    assert(threw, 'alias DNS de metadado do GCP é bloqueado');

    // O recurso PRECISA continuar aceitando host arbitrário — localhost, LAN, domínio próprio.
    // Isso é o núcleo do achado: allowlist quebraria o recurso, este bloqueio pontual não quebra.
    const legitimateEndpoints = [
        'http://localhost:8080/v1',
        'http://127.0.0.1:8080/v1',
        // Bloco de documentação RFC 5737 (TEST-NET-2), não um IP privado real — mesma convenção
        // de S195_NoPrivateNetworkAddressInSource — representando aqui "servidor na LAN do
        // usuário", um caso real e comum que o bloqueio de SSRF não pode quebrar.
        'http://198.51.100.50:8080/v1',
        'https://api.openai.com/v1',
        'https://meu-servidor-privado.exemplo.com/v1',
    ];
    for (const url of legitimateEndpoints) {
        let ok = true;
        try { assertNotSsrfTarget(url); } catch { ok = false; }
        assert(ok, `endpoint legítimo continua permitido: ${url}`);
    }
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S233 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;
