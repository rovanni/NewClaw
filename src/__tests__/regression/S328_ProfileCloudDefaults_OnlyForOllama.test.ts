/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S328 (issue 054, Sprint D2; contrato atualizado pela issue 068)
 *
 * Os 6 perfis do ModelProfileRegistry nasciam com nomes da nuvem do Ollama (glm-5.2:cloud,
 * gemma4:31b-cloud, kimi-k2.6:cloud). Com um provedor local como padrão (Bonsai via llama-server,
 * 05/10/2026), o perfil `execution` pedia `kimi-k2.6:cloud` ao servidor local — o llama-server ignora o
 * nome, mas um servidor de vários modelos (LM Studio, vLLM) responderia "modelo não encontrado".
 *
 * Regra original: o padrão embutido só valia quando o provedor efetivo do perfil era o Ollama.
 * Issue 068 (07/10/2026) a substituiu por uma mais forte: NÃO há padrão embutido — a escolha do modelo vem do
 * painel. A garantia da issue 054 (nunca mandar nome de nuvem a um provedor local) continua aqui, agora porque o
 * código não tem nome nenhum para mandar. Modelo configurado nunca é tocado.
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

console.log('\n=== S328-1 — provedor padrão Ollama, nada configurado: modelo padrão do provedor (issue 068) ===');
{
    const r = quiet(() => new ModelProfileRegistry(undefined, factory('ollama')));
    assert(r.getProfileByCategory('execution')?.model === '', "execution → '' (modelo padrão do provedor)");
    assert(r.getProfileByCategory('chat')?.model === '', "chat → '' (modelo padrão do provedor)");
    assert(r.getProfileByCategory('vision') === undefined, 'vision → não configurada');
}

console.log('\n=== S328-2 — provedor padrão local (custom): nenhum nome de nuvem chega a ele ===');
{
    const r = quiet(() => new ModelProfileRegistry(undefined, factory('bonsai')));
    for (const cat of ['chat', 'code', 'light', 'analysis', 'execution'] as const) {
        assert(r.getProfileByCategory(cat)?.model === '', `${cat} → '' (sem nome de nuvem)`, r.getProfileByCategory(cat));
    }
    assert(r.resolveProfileSync('oi').model === '', 'resolveProfileSync também');
}

console.log('\n=== S328-3 — modelo configurado nunca é tocado ===');
{
    const r = quiet(() => new ModelProfileRegistry({ execution: 'meu-modelo-local' } as any, factory('bonsai')));
    assert(r.getProfileByCategory('execution')?.model === 'meu-modelo-local', 'MODEL_EXECUTION configurado é preservado');
    assert(r.getProfileByCategory('chat')?.model === '', 'os não configurados seguem sem modelo');

    const r2 = quiet(() => new ModelProfileRegistry(undefined, factory('bonsai')));
    r2.setProfile({ id: 'code-primary', model: 'qwen-coder', server: '', category: 'code', description: 'x' });
    assert(r2.getProfileByCategory('code')?.model === 'qwen-coder', 'setProfile com modelo novo → preservado');
    r2.setProfile({ id: 'chat-primary', model: '', server: '', category: 'chat', description: 'x' });
    assert(r2.getProfileByCategory('chat')?.model === '', 'regravar o perfil vazio (salvar o painel) continua vazio');
}

console.log('\n=== S328-4 — provider explícito por perfil decide, não o padrão global ===');
{
    const r = quiet(() => new ModelProfileRegistry({ vision: 'gemma4:31b-cloud', provider_vision: 'ollama' } as any, factory('bonsai')));
    assert(r.getProfileByCategory('vision')?.model === 'gemma4:31b-cloud', 'visão escolhida + PROVIDER_VISION=ollama → usada');
    const r2 = quiet(() => new ModelProfileRegistry({ chat: 'glm-5.3:cloud', provider_chat: 'ollama' } as any, factory('bonsai')));
    const code = r2.getProfileByCategory('code');
    assert(code?.model === 'glm-5.3:cloud' && code?.provider === 'ollama', `code sem escolha herda modelo e provider do chat configurado (${code?.model} / ${code?.provider})`);
}

console.log('\n=== S328-5 — sem ProviderFactory: mesmo contrato, nada embutido ===');
{
    const r = quiet(() => new ModelProfileRegistry());
    assert(r.getProfileByCategory('chat')?.model === '' && r.getProfileByCategory('vision') === undefined, 'nada é escolhido pelo código');
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S328 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;
