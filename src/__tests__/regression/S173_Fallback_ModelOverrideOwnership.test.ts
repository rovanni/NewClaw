/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S173
 * O modelo escolhido para um provider NUNCA é aplicado a outro no fallback.
 *
 * CONTEXTO (incidente real em produção, 02/08/2026, rastreado no log de auditoria): o usuário
 * tinha um servidor local como provider padrão, com `gemma-4-26B-A4B-it-Q4_K_M.gguf` escolhido
 * para as categorias. O servidor local saiu do ar; o circuit breaker o removeu da fila, como
 * deve; e então o Ollama passou a receber o NOME DO ARQUIVO .gguf como modelo:
 *
 *     chatWithFallback START providers=[llamafile,ollama,Modelo local]
 *        → START provider=ollama/gemma-4-26B-A4B-it-Q4_K_M.gguf
 *        → [STREAM] HTTP 404 · Ollama API error: 404
 *        → EXHAUSTED attempts=4
 *
 * O goal falhou inteiro tendo um provider saudável disponível — o Ollama responderia
 * normalmente com o modelo que ele próprio tem configurado.
 *
 * CAUSA: `modelOverride` era aplicado a `activeProviders[0]`, isto é, "o primeiro que sobrou
 * depois do circuit breaker" — e não ao provider PARA O QUAL aquele modelo foi escolhido. Um
 * nome de modelo só existe dentro do provider que o serve; carregá-lo para o próximo da fila
 * transforma um fallback saudável em erro garantido.
 *
 * REGRESSÃO SE: o modelo de um provider voltar a vazar para outro quando o preferido cai. Vale
 * para qualquer par (provider A com modelo X → fallback B sem X), não só para modelos locais.
 *
 * Execução: npx ts-node src/__tests__/regression/S173_Fallback_ModelOverrideOwnership.test.ts
 */

import { ProviderFactory, OllamaProvider, OpenAIProvider } from '../../core/ProviderFactory';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

/** Modelo efetivo de uma instância de provider, seja ela Ollama ou OpenAI-Compatible. */
function modelOf(p: unknown): string {
    if (p instanceof OllamaProvider) return p.getModel();
    return (p as { model?: string }).model ?? '';
}

console.log('\n=== S173 — o modelo pertence ao provider para o qual foi escolhido ===');
{
    const pf = new ProviderFactory({
        defaultProvider: 'servidor-local',
        ollamaUrl: 'http://localhost:11434',
        ollamaModel: 'glm-5.2:cloud',
        customProviders: [{ label: 'servidor-local', baseUrl: 'http://localhost:8080/v1' }],
    });

    // O dono do override recebe o modelo escolhido...
    const dono = pf.getProviderWithModel('modelo-local.gguf', 'servidor-local');
    assert(dono instanceof OpenAIProvider, 'provider dono do modelo é o endpoint local');
    assert(modelOf(dono) === 'modelo-local.gguf', `dono recebe o modelo escolhido (obtido: ${modelOf(dono)})`);

    // ...e o Ollama, quando pedido explicitamente com esse nome, o recebe — este método é uma
    // ferramenta de baixo nível. A proteção está em QUEM o chama, verificado abaixo.
    const forcado = pf.getProviderWithModel('modelo-local.gguf', 'ollama');
    assert(forcado instanceof OllamaProvider, 'getProviderWithModel continua honrando um pedido explícito');
}

console.log('\n=== S173 — no fallback, cada provider usa o SEU modelo ===');
{
    // Reproduz o incidente: preferido fora do ar, fallback saudável, modelo do preferido não
    // pode vazar. A verificação é sobre qual instância seria usada em cada posição da fila.
    const pf = new ProviderFactory({
        defaultProvider: 'servidor-local',
        ollamaUrl: 'http://localhost:11434',
        ollamaModel: 'glm-5.2:cloud',
        customProviders: [{ label: 'servidor-local', baseUrl: 'http://localhost:8080/v1' }],
    });

    const src = require('fs').readFileSync(
        require('path').join(process.cwd(), 'src', 'core', 'ProviderFactory.ts'), 'utf-8'
    ) as string;

    assert(
        /const modelOverrideOwner = preferredProvider \|\| this\.defaultProvider/.test(src),
        'o dono do override é o provider preferido (ou o padrão), não o primeiro da fila ativa'
    );
    assert(
        /providerName === modelOverrideOwner/.test(src),
        'o override só é aplicado ao provider dono'
    );
    assert(
        !/providerName === primaryProviderName/.test(src),
        'não volta a usar "primeiro da fila ativa" — era isso que fazia o modelo vazar quando o preferido caía'
    );

    // A instância compartilhada do Ollama mantém o modelo próprio: é ela que o fallback usa.
    const compartilhado = pf.getProvider('ollama');
    assert(
        modelOf(compartilhado) === 'glm-5.2:cloud',
        `instância compartilhada do Ollama mantém o modelo dele (obtido: ${modelOf(compartilhado)})`
    );
}

console.log('\n=== S173 — o caso normal (preferido saudável) não muda ===');
{
    const pf = new ProviderFactory({
        defaultProvider: 'ollama',
        ollamaUrl: 'http://localhost:11434',
        ollamaModel: 'glm-5.2:cloud',
    });
    const p = pf.getProviderWithModel('kimi-k2.6:cloud', 'ollama');
    assert(
        modelOf(p) === 'kimi-k2.6:cloud',
        `com Ollama como preferido, o modelo por categoria continua sendo aplicado (obtido: ${modelOf(p)})`
    );
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S173 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
console.log(`\nCOBERTURA:`);
console.log(`  Modelo aplicado só ao provider dono: testado`);
console.log(`  Fallback usando a instância própria de cada provider: testado`);
console.log(`  Caso normal (preferido saudável) preservado: testado`);
if (failed > 0) process.exit(1);
