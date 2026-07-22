/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S138
 *
 * Fatia 1 do Model Registry (docs/ANALISE_ARQUITETURAL_MODEL_REGISTRY_2026-07-22.md): discovery
 * unificado de modelos via OllamaProvider.discoverModels()/OpenAIProvider.discoverModels() +
 * ModelRegistryService como fachada de cache/normalização.
 *
 * Verifica:
 * 1. guessCapabilities() classifica por padrão de nome (vision/code/reasoning/embedding/tool_calling).
 * 2. OllamaProvider.discoverModels() normaliza a resposta de /api/tags em ModelInfo[].
 * 3. OpenAIProvider.discoverModels() normaliza a resposta de /models (mesmo endpoint usado por
 *    OpenAI oficial/LM Studio/vLLM/custom) e usa o label configurado, não o nome fixo da classe.
 * 4. ModelRegistryService.discoverAll() combina Ollama + providers customizados e registra saúde
 *    (online/offline) por provider, inclusive quando um deles falha.
 * 5. ModelRegistryService.getCatalog() cacheia entre chamadas (não bate no fetch de novo) até
 *    forceRefresh=true.
 */

import { guessCapabilities } from '../../core/modelCapabilityHeuristics';
import { OllamaProvider } from '../../core/OllamaProvider';
import { OpenAIProvider } from '../../core/OpenAIProvider';
import { ModelRegistryService } from '../../core/ModelRegistryService';
import { ProviderFactory } from '../../core/ProviderFactory';

let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string, detail?: unknown): void {
    if (cond) { console.log(`  ✅ ${msg}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${msg}`, detail ?? ''); failed++; }
}

type FetchCall = { url: string; init?: RequestInit };

function mockFetch(handler: (url: string) => { ok: boolean; status?: number; json: () => Promise<unknown> }) {
    const calls: FetchCall[] = [];
    const original = globalThis.fetch;
    (globalThis as any).fetch = async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        const res = handler(url);
        return { ok: res.ok, status: res.status ?? (res.ok ? 200 : 500), json: res.json } as Response;
    };
    return { calls, restore: () => { globalThis.fetch = original; } };
}

async function main() {
    console.log('\n=== S138 — ModelRegistryService: discovery unificado + cache ===');

    // 1. guessCapabilities — heurística por nome
    {
        assert(guessCapabilities('gemma3:27b').includes('vision'), 'gemma3 detectado como vision', guessCapabilities('gemma3:27b'));
        assert(guessCapabilities('qwen2.5-coder:32b').includes('code'), 'coder detectado como code', guessCapabilities('qwen2.5-coder:32b'));
        assert(guessCapabilities('deepseek-r1:cloud').includes('reasoning'), 'r1 detectado como reasoning', guessCapabilities('deepseek-r1:cloud'));
        assert(guessCapabilities('nomic-embed-text').includes('embedding'), 'nomic-embed detectado como embedding', guessCapabilities('nomic-embed-text'));
        assert(!guessCapabilities('nomic-embed-text').includes('tool_calling'), 'embedding NÃO ganha tool_calling', guessCapabilities('nomic-embed-text'));
        assert(!guessCapabilities('nomic-embed-text').includes('chat'), 'embedding NÃO ganha chat (modelo de propósito único)', guessCapabilities('nomic-embed-text'));
        assert(guessCapabilities('llama3.1:8b').includes('tool_calling'), 'modelo de propósito geral ganha tool_calling', guessCapabilities('llama3.1:8b'));
    }

    // 2. OllamaProvider.discoverModels() — normaliza /api/tags
    {
        const { restore } = mockFetch(url => {
            assert(url.includes('/api/tags'), 'OllamaProvider bate em /api/tags', url);
            return { ok: true, json: async () => ({ models: [{ name: 'glm-5.2:cloud' }, { name: 'gemma3:27b' }] }) };
        });
        try {
            const ollama = new OllamaProvider('http://localhost:11434', 'glm-5.2:cloud', '');
            const models = await ollama.discoverModels!();
            assert(models.length === 2, 'discoverModels retorna 2 modelos', models);
            assert(models[0].provider === 'ollama', 'provider marcado como ollama', models[0]);
            assert(models[1].capabilities.includes('vision'), 'gemma3 carrega capability vision', models[1]);
        } finally { restore(); }
    }

    // 3. OpenAIProvider.discoverModels() — normaliza /models e usa o label
    {
        const { restore } = mockFetch(url => {
            assert(url === 'http://localhost:1234/v1/models', 'OpenAIProvider bate em {baseUrl}/models', url);
            return { ok: true, json: async () => ({ data: [{ id: 'llama-3.1-8b-instruct' }] }) };
        });
        try {
            const lmStudio = new OpenAIProvider('', 'unused', 'http://localhost:1234/v1', 'LM Studio');
            const models = await lmStudio.discoverModels!();
            assert(models.length === 1 && models[0].id === 'llama-3.1-8b-instruct', 'modelo normalizado corretamente', models);
            assert(models[0].provider === 'LM Studio', 'provider usa o label configurado, não "openai" fixo', models[0]);
        } finally { restore(); }
    }

    // 4. ModelRegistryService.discoverAll() — combina Ollama + custom, com um custom falhando
    {
        const { restore } = mockFetch(url => {
            if (url.includes('/api/tags')) return { ok: true, json: async () => ({ models: [{ name: 'glm-5.2:cloud' }] }) };
            if (url.includes('localhost:1234')) return { ok: true, json: async () => ({ data: [{ id: 'local-model' }] }) };
            if (url.includes('localhost:9999')) return { ok: false, status: 500, json: async () => ({}) };
            throw new Error(`unexpected URL in test: ${url}`);
        });
        try {
            const factory = new ProviderFactory({ defaultProvider: 'ollama', ollamaUrl: 'http://localhost:11434' });
            const registry = new ModelRegistryService(factory, () => [
                { label: 'LM Studio', baseUrl: 'http://localhost:1234/v1' },
                { label: 'Offline vLLM', baseUrl: 'http://localhost:9999/v1' },
            ]);

            const catalog = await registry.discoverAll();
            assert(catalog.some(m => m.provider === 'ollama'), 'catálogo inclui modelo do Ollama', catalog);
            assert(catalog.some(m => m.provider === 'LM Studio'), 'catálogo inclui modelo do LM Studio', catalog);
            assert(!catalog.some(m => m.provider === 'Offline vLLM'), 'provider offline não contribui modelos', catalog);

            const health = registry.getLastHealth();
            const lmHealth = health.find(h => h.provider === 'LM Studio');
            const offlineHealth = health.find(h => h.provider === 'Offline vLLM');
            assert(!!lmHealth?.online, 'saúde do LM Studio marcada online', lmHealth);
            assert(offlineHealth?.online === false && !!offlineHealth?.error, 'saúde do provider offline marcada com erro', offlineHealth);

            // 5. Cache — segunda chamada a getCatalog() não deve re-disparar fetch
            let fetchCount = 0;
            const originalFetch = globalThis.fetch;
            (globalThis as any).fetch = async (...args: unknown[]) => { fetchCount++; return (originalFetch as any)(...args); };
            const cached = await registry.getCatalog();
            assert(fetchCount === 0, 'getCatalog() dentro do TTL não chama fetch de novo', fetchCount);
            assert(cached.length === catalog.length, 'catálogo cacheado tem o mesmo tamanho', cached);
            globalThis.fetch = originalFetch;
        } finally { restore(); }
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S138 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    if (failed > 0) process.exit(1);
    process.exit(0);
}

main().catch(err => {
    console.error('Erro no teste S138:', err);
    process.exit(1);
});
