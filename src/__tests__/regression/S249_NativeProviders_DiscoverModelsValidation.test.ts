/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S249
 *
 * Fatia de validação de providers nativos (2026-08-19): Gemini/DeepSeek/Groq/OpenRouter/Anthropic
 * ganham `discoverModels()`, usado só como validação objetiva de autenticação/configuração pra
 * `computeSystemReady()` — não como catálogo/UI de modelos (esse escopo foi explicitamente
 * descartado, ver `docs/analises-arquiteturais/` desta fatia).
 *
 * Verifica:
 * 1. DeepSeek/Groq reaproveitam `discoverOpenAICompatibleModels()` (extraída de OpenAIProvider,
 *    sem duplicar lógica) — batem no endpoint certo, parseiam `{data:[{id}]}` corretamente.
 * 2. Anthropic bate no endpoint real (`/v1/models`, headers `x-api-key`+`anthropic-version`),
 *    parseia `display_name`.
 * 3. Gemini bate no endpoint real (`/v1beta/models?key=`), remove o prefixo `models/` do id.
 * 4. Falha de autenticação (401) propaga como erro com status anexado, pros 4 acima.
 * 5. `ProviderFactory.getNativeProvider()` só devolve instância quando a key está configurada.
 * 6. `ModelRegistryService.discoverAll()` inclui os 5 nativos quando têm key (populando health),
 *    e NÃO dispara nenhum fetch pra quem não tem key configurada.
 * 7. `chat()` de nenhum dos 5 providers foi alterado — coberto empiricamente por S108 (Anthropic)
 *    e S192 (OpenAIProvider), que continuam passando sem alteração nesta fatia.
 */

import { DeepSeekProvider } from '../../core/DeepSeekProvider';
import { GroqProvider } from '../../core/GroqProvider';
import { AnthropicProvider } from '../../core/AnthropicProvider';
import { GeminiProvider } from '../../core/GeminiProvider';
import { OpenAIProvider } from '../../core/OpenAIProvider';
import { ProviderFactory } from '../../core/ProviderFactory';
import { ModelRegistryService } from '../../core/ModelRegistryService';

let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string, detail?: unknown): void {
    if (cond) { console.log(`  ✅ ${msg}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${msg}`, detail ?? ''); failed++; }
}

type FetchCall = { url: string; init?: RequestInit };

function mockFetch(handler: (url: string, init?: RequestInit) => { ok: boolean; status?: number; json: () => Promise<unknown> }) {
    const calls: FetchCall[] = [];
    const original = globalThis.fetch;
    (globalThis as any).fetch = async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        const res = handler(url, init);
        return { ok: res.ok, status: res.status ?? (res.ok ? 200 : 500), json: res.json } as Response;
    };
    return { calls, restore: () => { globalThis.fetch = original; } };
}

async function main() {
    console.log('\n=== S249 — discoverModels() dos 5 providers nativos: validação, não catálogo ===');

    // 1. discoverOpenAICompatibleModels() extraída — OpenAIProvider ainda funciona idêntico
    {
        const { restore } = mockFetch(url => {
            assert(url === 'http://localhost:1234/v1/models', 'OpenAIProvider ainda bate em {baseUrl}/models', url);
            return { ok: true, json: async () => ({ data: [{ id: 'llama-3.1-8b-instruct' }] }) };
        });
        try {
            const p = new OpenAIProvider('', 'unused', 'http://localhost:1234/v1', 'LM Studio');
            const models = await p.discoverModels!();
            assert(models.length === 1 && models[0].id === 'llama-3.1-8b-instruct', 'OpenAIProvider.discoverModels() comportamento preservado após extração', models);
        } finally { restore(); }
    }

    // 2. DeepSeek — reaproveita a função compartilhada
    {
        const { restore } = mockFetch(url => {
            assert(url === 'https://api.deepseek.com/v1/models', 'DeepSeek bate no endpoint oficial', url);
            return { ok: true, json: async () => ({ object: 'list', data: [{ id: 'deepseek-chat', object: 'model', owned_by: 'deepseek' }] }) };
        });
        try {
            const p = new DeepSeekProvider('fake-key');
            const models = await p.discoverModels!();
            assert(models.length === 1 && models[0].id === 'deepseek-chat', 'DeepSeek.discoverModels() parseia corretamente', models);
            assert(models[0].provider === 'deepseek', 'provider marcado como deepseek', models[0]);
        } finally { restore(); }
    }

    // 3. Groq — reaproveita a função compartilhada
    {
        const { restore } = mockFetch(url => {
            assert(url === 'https://api.groq.com/openai/v1/models', 'Groq bate no endpoint oficial', url);
            return { ok: true, json: async () => ({ object: 'list', data: [{ id: 'llama-3.3-70b-versatile', object: 'model', owned_by: 'Meta' }] }) };
        });
        try {
            const p = new GroqProvider('fake-key');
            const models = await p.discoverModels!();
            assert(models.length === 1 && models[0].id === 'llama-3.3-70b-versatile', 'Groq.discoverModels() parseia corretamente', models);
        } finally { restore(); }
    }

    // 4. Anthropic — endpoint/headers/shape próprios
    {
        const { restore } = mockFetch((url, init) => {
            assert(url === 'https://api.anthropic.com/v1/models', 'Anthropic bate no endpoint oficial', url);
            const headers = init?.headers as Record<string, string> | undefined;
            assert(headers?.['x-api-key'] === 'fake-key', 'Anthropic autentica via x-api-key, não Authorization', headers);
            assert(headers?.['anthropic-version'] === '2023-06-01', 'Anthropic envia anthropic-version', headers);
            return { ok: true, json: async () => ({ data: [{ id: 'claude-opus-4-6', display_name: 'Claude Opus 4.6' }], first_id: 'claude-opus-4-6', has_more: false }) };
        });
        try {
            const p = new AnthropicProvider('fake-key');
            const models = await p.discoverModels!();
            assert(models.length === 1 && models[0].id === 'claude-opus-4-6', 'Anthropic.discoverModels() parseia id corretamente', models);
            assert(models[0].label === 'Claude Opus 4.6', 'Anthropic usa display_name como label', models[0]);
        } finally { restore(); }
    }

    // 5. Gemini — endpoint/auth/shape próprios (query param, prefixo "models/")
    {
        const { restore } = mockFetch(url => {
            assert(url === 'https://generativelanguage.googleapis.com/v1beta/models?key=fake-key', 'Gemini autentica via query param key=', url);
            return { ok: true, json: async () => ({ models: [{ name: 'models/gemini-2.0-flash', displayName: 'Gemini 2.0 Flash' }] }) };
        });
        try {
            const p = new GeminiProvider('fake-key');
            const models = await p.discoverModels!();
            assert(models.length === 1 && models[0].id === 'gemini-2.0-flash', 'Gemini remove o prefixo "models/" do id', models);
            assert(models[0].label === 'Gemini 2.0 Flash', 'Gemini usa displayName como label', models[0]);
        } finally { restore(); }
    }

    // 6. Falha de autenticação (401) — erro com status anexado, pros 4 que expõem discoverModels novo
    {
        const { restore } = mockFetch(() => ({ ok: false, status: 401, json: async () => ({}) }));
        try {
            for (const [label, provider] of [
                ['DeepSeek', new DeepSeekProvider('bad-key')],
                ['Groq', new GroqProvider('bad-key')],
                ['Anthropic', new AnthropicProvider('bad-key')],
                ['Gemini', new GeminiProvider('bad-key')],
            ] as const) {
                let threw = false;
                let status: number | undefined;
                try {
                    await provider.discoverModels!();
                } catch (err) {
                    threw = true;
                    status = (err as { status?: number }).status;
                }
                assert(threw, `${label}: falha de autenticação propaga como erro (não engole silenciosamente)`, label);
                assert(status === 401, `${label}: status 401 anexado ao erro`, status);
            }
        } finally { restore(); }
    }

    // 7. ProviderFactory.getNativeProvider() — só existe com key configurada
    {
        const semKey = new ProviderFactory({ defaultProvider: 'ollama', ollamaUrl: 'http://localhost:11434' });
        assert(semKey.getNativeProvider('gemini') === undefined, 'sem geminiKey, getNativeProvider("gemini") devolve undefined', semKey.getNativeProvider('gemini'));
        assert(semKey.getNativeProvider('anthropic') === undefined, 'sem anthropicKey, getNativeProvider("anthropic") devolve undefined', semKey.getNativeProvider('anthropic'));

        const comKey = new ProviderFactory({ defaultProvider: 'ollama', ollamaUrl: 'http://localhost:11434', geminiKey: 'fake-key' });
        assert(comKey.getNativeProvider('gemini') !== undefined, 'com geminiKey, getNativeProvider("gemini") devolve instância', comKey.getNativeProvider('gemini'));
        assert(comKey.getNativeProvider('gemini')?.discoverModels !== undefined, 'a instância devolvida expõe discoverModels', comKey.getNativeProvider('gemini'));
    }

    // 8. ModelRegistryService.discoverAll() — inclui só quem tem key, sem chamada indevida pros outros
    {
        const { restore } = mockFetch(url => {
            if (url.includes('/api/tags')) return { ok: true, json: async () => ({ models: [] }) };
            if (url === 'https://api.anthropic.com/v1/models') {
                return { ok: true, json: async () => ({ data: [{ id: 'claude-opus-4-6', display_name: 'Claude Opus 4.6' }] }) };
            }
            // Qualquer URL de gemini/deepseek/groq/openrouter aqui seria uma chamada indevida —
            // este teste configura API key SÓ pra anthropic, então nenhuma outra deveria aparecer.
            throw new Error(`chamada de rede inesperada (provider sem key configurada?): ${url}`);
        });
        try {
            const factory = new ProviderFactory({ defaultProvider: 'anthropic', ollamaUrl: 'http://localhost:11434', anthropicKey: 'fake-key' });
            const registry = new ModelRegistryService(factory);
            const catalog = await registry.discoverAll();

            assert(catalog.some(m => m.provider === 'anthropic' && m.id === 'claude-opus-4-6'), 'catálogo inclui o modelo descoberto da Anthropic', catalog);

            const health = registry.getLastHealth();
            const anthropicHealth = health.find(h => h.provider === 'anthropic');
            assert(!!anthropicHealth?.online, 'health da Anthropic marcada online', anthropicHealth);
            assert(!health.some(h => h.provider === 'gemini' || h.provider === 'deepseek' || h.provider === 'groq' || h.provider === 'openrouter'), 'providers nativos sem key não geram entrada de health (nem tentativa de chamada)', health);
        } finally { restore(); }
    }

    // 8b. ModelRegistryService.discoverAll() — falha de auth de um nativo vira health offline, sem derrubar o resto
    {
        const { restore } = mockFetch(url => {
            if (url.includes('/api/tags')) return { ok: true, json: async () => ({ models: [{ name: 'glm-5.2:cloud' }] }) };
            if (url === 'https://api.anthropic.com/v1/models') return { ok: false, status: 401, json: async () => ({}) };
            throw new Error(`unexpected URL in test: ${url}`);
        });
        try {
            const factory = new ProviderFactory({ defaultProvider: 'ollama', ollamaUrl: 'http://localhost:11434', anthropicKey: 'bad-key' });
            const registry = new ModelRegistryService(factory);
            const catalog = await registry.discoverAll();

            assert(catalog.some(m => m.provider === 'ollama'), 'Ollama continua funcionando mesmo com Anthropic falhando', catalog);
            const health = registry.getLastHealth();
            const anthropicHealth = health.find(h => h.provider === 'anthropic');
            assert(anthropicHealth?.online === false && !!anthropicHealth?.error, 'falha de auth da Anthropic vira health offline com erro, não exceção não tratada', anthropicHealth);
        } finally { restore(); }
    }

    // 9. computeSystemReady() (ModelosView.js) — reprodução da fórmula com o formato de health que
    //    discoverAll() agora produz pros nativos. A função em si não foi alterada nesta fatia (é
    //    genérica desde antes); isso prova que o novo health[] a alimenta corretamente sem precisar
    //    tocar nela. Mesma técnica de reprodução usada em S182-5.
    {
        const computeSystemReady = (h: { online: boolean; count: number }, defaultModel: string, catalogo: Array<{ id: string; provider: string }>, prov: string) => {
            const servidos = catalogo.filter(m => m.provider === prov).map(m => m.id);
            const modeloServido = servidos.length === 0 || servidos.includes(defaultModel);
            return h.online && h.count > 0 && !!defaultModel && modeloServido;
        };
        const catalogoAnthropic = [{ id: 'claude-opus-4-6', provider: 'anthropic' }];

        assert(
            computeSystemReady({ online: true, count: 1 }, 'claude-opus-4-6', catalogoAnthropic, 'anthropic') === true,
            'com discoverModels() funcionando e modelo escolhido batendo no catálogo, computeSystemReady() aprova a Anthropic sem nenhuma mudança na própria função',
        );
        assert(
            computeSystemReady({ online: false, count: 0 }, 'claude-opus-4-6', catalogoAnthropic, 'anthropic') === false,
            'key inválida (discovery falhou, online=false) continua reprovando — é exatamente o bloqueio que esta fatia existe pra resolver',
        );
        assert(
            computeSystemReady({ online: true, count: 1 }, '', catalogoAnthropic, 'anthropic') === false,
            'LIMITAÇÃO CONHECIDA (documentada, não corrigida nesta fatia): sem modelo escolhido no Model Router — mesmo com o fallback do construtor garantindo que o chat funcionaria — computeSystemReady() ainda reprova, porque !!defaultModel falha com string vazia. Decisão consciente: não relaxar essa condição aqui (fora do escopo aprovado desta fatia).',
        );
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S249 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    if (failed > 0) process.exit(1);
    process.exit(0);
}

main().catch(err => {
    console.error('Erro no teste S249:', err);
    process.exit(1);
});
