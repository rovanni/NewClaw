/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S328 (issue 054, Sprint D2)
 *
 * Os 6 perfis do ModelProfileRegistry nascem com nomes da nuvem do Ollama (glm-5.2:cloud,
 * gemma4:31b-cloud, kimi-k2.6:cloud). Com um provedor local como padrão (Bonsai via llama-server,
 * 05/10/2026), o perfil `execution` pedia `kimi-k2.6:cloud` ao servidor local — o llama-server ignora o
 * nome, mas um servidor de vários modelos (LM Studio, vLLM) responderia "modelo não encontrado".
 *
 * Regra: o padrão embutido só vale quando o provedor efetivo do perfil é o Ollama; para os demais o
 * perfil sai sem modelo ("use o que o provedor serve", issue 019). Modelo configurado nunca é tocado.
 *
 * Execução: npx ts-node src/__tests__/regression/S328_ProfileCloudDefaults_OnlyForOllama.test.ts
 */
import { ModelProfileRegistry } from '../../loop/ModelProfileRegistry';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}

const factory = (defaultProvider: string) => ({ getDefaultProvider: () => defaultProvider }) as any;
const quiet = <T>(fn: () => T): T => {
    const orig = process.stdout.write.bind(process.stdout);
    (process.stdout.write as unknown) = (): boolean => true;
    try { return fn(); } finally { process.stdout.write = orig; }
};

console.log('\n=== S328-1 — provedor padrão Ollama: padrões de nuvem mantidos (nada muda em produção) ===');
{
    const r = quiet(() => new ModelProfileRegistry(undefined, factory('ollama')));
    assert(r.getProfileByCategory('execution')?.model === 'kimi-k2.6:cloud', 'execution → kimi-k2.6:cloud');
    assert(r.getProfileByCategory('vision')?.model === 'gemma4:31b-cloud', 'vision → gemma4:31b-cloud (visão preservada)');
    assert(r.getProfileByCategory('chat')?.model === 'glm-5.2:cloud', 'chat → glm-5.2:cloud');
}

console.log('\n=== S328-2 — provedor padrão local (custom): perfis sem modelo → o do provedor ===');
{
    const r = quiet(() => new ModelProfileRegistry(undefined, factory('bonsai')));
    for (const cat of ['chat', 'code', 'light', 'vision', 'analysis', 'execution'] as const) {
        assert(r.getProfileByCategory(cat)?.model === '', `${cat} → '' (sem nome de nuvem)`, r.getProfileByCategory(cat));
    }
    assert(r.resolveProfileSync('oi').model === '', 'resolveProfileSync também');
    assert(r.getProfiles().find(p => p.category === 'execution')?.model === 'kimi-k2.6:cloud', 'getProfiles (painel) continua mostrando o dado bruto — só a leitura para uso muda');
}

console.log('\n=== S328-3 — modelo configurado nunca é tocado ===');
{
    const r = quiet(() => new ModelProfileRegistry({ execution: 'meu-modelo-local' } as any, factory('bonsai')));
    assert(r.getProfileByCategory('execution')?.model === 'meu-modelo-local', 'MODEL_EXECUTION configurado é preservado');
    assert(r.getProfileByCategory('chat')?.model === '', 'os não configurados seguem sem modelo');

    const r2 = quiet(() => new ModelProfileRegistry(undefined, factory('bonsai')));
    r2.setProfile({ id: 'code-primary', model: 'qwen-coder', server: '', category: 'code', description: 'x' });
    assert(r2.getProfileByCategory('code')?.model === 'qwen-coder', 'setProfile com modelo novo → preservado');
    r2.setProfile({ id: 'chat-primary', model: 'glm-5.2:cloud', server: '', category: 'chat', description: 'x' });
    assert(r2.getProfileByCategory('chat')?.model === '', 'regravar o MESMO padrão (salvar o painel) não vira escolha explícita');
}

console.log('\n=== S328-4 — provider explícito por perfil decide, não o padrão global ===');
{
    const r = quiet(() => new ModelProfileRegistry({ provider_vision: 'ollama' } as any, factory('bonsai')));
    assert(r.getProfileByCategory('vision')?.model === 'gemma4:31b-cloud', 'PROVIDER_VISION=ollama mantém o padrão de nuvem da visão');
    const r2 = quiet(() => new ModelProfileRegistry({ provider_chat: 'bonsai' } as any, factory('ollama')));
    assert(r2.getProfileByCategory('chat')?.model === '', 'PROVIDER_CHAT=bonsai com padrão Ollama → chat sem nome de nuvem');
    assert(r2.getProfileByCategory('code')?.model === 'gemma4:31b-cloud', 'os demais seguem o Ollama herdado');
}

console.log('\n=== S328-5 — sem ProviderFactory (provedor desconhecido): comportamento anterior ===');
{
    const r = quiet(() => new ModelProfileRegistry());
    assert(r.getProfileByCategory('execution')?.model === 'kimi-k2.6:cloud', 'não decide sem saber o provedor');
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S328 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;
