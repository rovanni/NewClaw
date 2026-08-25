/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S264 (campanha "Ollama API error: 404", Fase 3)
 *
 * Reproduz a cadeia causal completa achada na Fase 2 da investigação
 * (docs/ARCHITECTURE — ver conclusão da campanha), sem depender do Dashboard (browser):
 *
 *     ensureLocalProvider() carrega um modelo local
 *         → modelRouter[execution] = '<arquivo>.gguf', provider_execution = '' (herdar)
 *         → defaultProvider = provider local (coerente NO MOMENTO)
 *     servidor local fica indisponível / usuário troca defaultProvider pra 'ollama'
 *         → realignRouterToProvider() roda, mas o catálogo não confirma o .gguf
 *         → Nunca Adivinhar → corretamente NÃO realinha (comportamento correto, não é o bug)
 *         → modelRouter[execution] continua '<arquivo>.gguf', provider_execution continua ''
 *     turno com ferramentas chega na etapa de síntese (AgentLoop.ts:1967)
 *         → getProfileByCategory('execution') devolve o par INCONSISTENTE
 *         → chatWithFallback(provider=<herdado='ollama'>, model='<arquivo>.gguf')
 *         → Ollama 404 (nenhum provider nativo serve arquivo .gguf)
 *
 * Achado real em produção: mesma assinatura de log, 02/08 a 24/08/2026 (7+ ocorrências),
 * causa raiz nunca antes conectada ao sintoma "Ollama API error: 404" (a inconsistência em si já
 * era um gap conhecido, achado como "C4" em 23/08/2026, documentado no comentário de
 * app.js/ModelosView.js — mas nunca associado a ESTE sintoma até esta investigação).
 *
 * CORREÇÃO (Fase 3): `ModelProfileRegistry.getProfileByCategory()` — o ponto de CONSUMO por onde
 * todo mundo passa (chat principal, síntese, resolveProfile) — invalida o par antes de devolvê-lo,
 * quando E SOMENTE QUANDO o fato é determinístico e verificável sem depender do catálogo:
 * `provider` vazio (herdado) + `model` é um arquivo local (`.gguf`) + o provider herdado é um dos
 * 6 nativos (nenhum deles jamais serve arquivo local, contrato já estabelecido em
 * `routes/models.ts`/`app.js`). Isto é INVALIDAR ("este par é impossível"), nunca INFERIR quem
 * serve o modelo — a correção nunca escolhe 'llamafile' ou qualquer outro provider no lugar;
 * devolve `undefined`, e os chamadores existentes já sabem cair para um perfil seguro (`?? chatProfile`
 * em AgentLoop.ts:1967, cadeia de fallback em resolveProfile()) — nenhum comportamento novo
 * precisou ser ensinado a eles.
 *
 * REGRESSÃO SE: um par (model local, provider herdado nativo) voltar a ser devolvido intacto por
 * getProfileByCategory()/resolveProfile()/getTextProfileByCategory(); OU se a correção passar a
 * INFERIR um provider substituto em vez de só invalidar (ex.: `if (model.endsWith('.gguf'))
 * provider = 'llamafile'` — proibido explicitamente pela Fase 3 desta campanha); OU se um
 * provider explícito do operador (provider_<cat> preenchido de propósito) for descartado por
 * engano — só o par SEM provider explícito pode ser invalidado.
 *
 * Execução: npx ts-node src/__tests__/regression/S264_ModelProfileRegistry_InvalidLocalPairInvalidation.test.ts
 */

import { ModelProfileRegistry } from '../../loop/ModelProfileRegistry';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

/** ProviderFactory fake — só o suficiente para getDefaultProvider(), como o registry realmente usa. */
function makeFakeProviderFactory(defaultProvider: string) {
    return {
        getDefaultProvider: () => defaultProvider,
    } as unknown as import('../../core/ProviderFactory').ProviderFactory;
}

async function main(): Promise<void> {

console.log('\n=== S264-1 — reprodução exata: modelo local + provider herdado nativo → par invalidado, não devolvido ===');
{
    // Estado exatamente como ensureLocalProvider() deixa depois que defaultProvider muda e
    // realignRouterToProvider() corretamente desiste por falta de evidência no catálogo.
    const registry = new ModelProfileRegistry(
        { execution: 'GLM-4.7-Flash-Q4_K_M.gguf' }, // provider_execution ausente = herdar (mesmo shape que '' no dashboard)
        makeFakeProviderFactory('ollama'),
    );
    const profile = registry.getProfileByCategory('execution');
    assert(profile === undefined, 'getProfileByCategory("execution") devolve undefined em vez do par impossível (model=.gguf, provider herdado=ollama)', profile);
}

console.log('\n=== S264-2 — AgentLoop.ts:1967 shape: fallback existente (?? chatProfile) assume sozinho, sem código novo ===');
{
    const registry = new ModelProfileRegistry(
        { execution: 'GLM-4.7-Flash-Q4_K_M.gguf' },
        makeFakeProviderFactory('ollama'),
    );
    const chatProfileFallback = { id: 'chat-primary', model: 'glm-5.2:cloud', server: '', category: 'chat' as const, description: '' };
    const synthesisProfile = registry.getProfileByCategory('execution') ?? chatProfileFallback;
    assert(synthesisProfile.model === 'glm-5.2:cloud', 'com o par inválido descartado, a síntese usa o perfil de chat (mesma cadeia de fallback já existente em AgentLoop.ts) — nunca chega a mandar .gguf pro Ollama', synthesisProfile);
}

console.log('\n=== S264-3 — contra-teste: provider explícito do operador NUNCA é descartado, mesmo com modelo .gguf ===');
{
    const registry = new ModelProfileRegistry(
        { execution: 'GLM-4.7-Flash-Q4_K_M.gguf', provider_execution: 'llamafile' },
        makeFakeProviderFactory('ollama'),
    );
    const profile = registry.getProfileByCategory('execution');
    assert(profile?.model === 'GLM-4.7-Flash-Q4_K_M.gguf' && profile?.provider === 'llamafile', 'provider explícito preservado — a invalidação só se aplica a provider HERDADO (vazio), nunca a uma escolha declarada do operador', profile);
}

console.log('\n=== S264-4 — contra-teste: modelo de nuvem normal (não .gguf) com provider herdado continua intacto ===');
{
    const registry = new ModelProfileRegistry(
        { execution: 'glm-5.2:cloud' },
        makeFakeProviderFactory('ollama'),
    );
    const profile = registry.getProfileByCategory('execution');
    assert(profile?.model === 'glm-5.2:cloud' && profile?.provider === undefined, 'modelo de nuvem com provider herdado é um par legítimo — nunca invalidado (só arquivo local dispara a checagem)', profile);
}

console.log('\n=== S264-5 — contra-teste: modelo .gguf + defaultProvider já é um provider custom (ex.: llamafile) → par legítimo ===');
{
    // Cenário coerente de verdade: usuário carregou o modelo local e AINDA está com ele como
    // defaultProvider (ensureLocalProvider deixou tudo alinhado) — nada deve ser invalidado aqui.
    const registry = new ModelProfileRegistry(
        { execution: 'GLM-4.7-Flash-Q4_K_M.gguf' },
        makeFakeProviderFactory('llamafile'), // provider custom, não um dos 6 nativos
    );
    const profile = registry.getProfileByCategory('execution');
    assert(profile?.model === 'GLM-4.7-Flash-Q4_K_M.gguf', 'modelo local + defaultProvider custom (não-nativo) é um par coerente — não invalida (não temos evidência de que está errado)', profile);
}

console.log('\n=== S264-6 — sem ProviderFactory (contexto de teste/isolado): não invalida por falta de evidência, não trava ===');
{
    const registry = new ModelProfileRegistry({ execution: 'foo.gguf' }); // sem providerFactory
    const profile = registry.getProfileByCategory('execution');
    assert(profile?.model === 'foo.gguf', 'sem providerFactory não há como saber o defaultProvider — não invalida sem evidência (Nunca Adivinhar vale nos dois sentidos)', profile);
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S264 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;

}

main().catch((err) => {
    console.error('S264 erro inesperado:', err);
    process.exitCode = 1;
});
