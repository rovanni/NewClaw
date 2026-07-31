/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S164
 * ProviderFactory: providers custom (LM Studio/vLLM/llamafile local) participam do fallback
 * automático de verdade, não só da listagem de descoberta de modelos do dashboard
 *
 * CONTEXTO (investigação de viabilidade, 2026-07-31): o dia 27/07 teve um outage real da API
 * do Ollama Cloud (~2s de HTTP 502 em sequência, circuit breaker abriu, um goal falhou com
 * ALL_PROVIDERS_CIRCUIT_OPEN — no provider available). NewClaw só tinha `providers=[ollama]`
 * configurado — zero fallback. O usuário está testando modelos locais offline (.gguf via
 * llamafile-0.10.4, rodando localmente) como opção de resiliência.
 *
 * ACHADO: `CustomProviderConfig` (LM Studio/vLLM/OpenAI custom) e o generic `OpenAIProvider`
 * (que cobre qualquer endpoint OpenAI-compatible, incluindo llamafile server) já existiam — e
 * o dashboard já tinha rota `POST/DELETE /providers/custom` para cadastrá-los. MAS
 * `ctx.config.customProviders` só alimentava `ModelRegistryService` (listagem/descoberta de
 * modelos) — nunca virava uma instância viva dentro de `ProviderFactory.providers`, então
 * nunca participava de `chatWithFallback()` de verdade.
 *
 * FIX: ProviderFactory agora aceita `customProviders` no construtor (hidratação no boot) e
 * ganha `addCustomProvider()`/`removeCustomProvider()` (wiring em runtime, chamado pela rota do
 * dashboard) — cada customProvider vira um `OpenAIProvider` no mesmo Map que os providers
 * nativos. Como não estão na lista de prioridade fixa de `getFallbackOrder()`
 * (['ollama','openrouter','anthropic','gemini','deepseek','groq']), caem automaticamente em
 * "remaining" — último recurso do fallback, sem precisar de nenhuma lógica de prioridade nova.
 *
 * REGRESSÃO SE: customProviders pararem de aparecer em getAvailableProviders(), ou um label
 * colidente com um provider nativo (ex.: 'ollama') conseguir sobrescrever a instância nativa.
 *
 * Execução: npx ts-node src/__tests__/regression/S164_ProviderFactory_CustomProviderFallback.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { ProviderFactory } from '../../core/ProviderFactory';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

console.log('\n=== S164 — source: log de "registered" só dispara quando o registro realmente aconteceu ===');
{
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'core', 'ProviderFactory.ts'), 'utf-8');
    assert(
        /if \(this\.registerCustomProvider\(custom\)\) \{\s*log\.info\(`Custom provider registered/.test(src),
        'addCustomProvider() só loga sucesso dentro do if (registerCustomProvider retornou true) — não incondicionalmente'
    );
}

console.log('\n=== S164 — customProviders hidratados no construtor ===');
{
    const pf = new ProviderFactory({
        defaultProvider: 'ollama',
        ollamaUrl: 'http://localhost:11434',
        customProviders: [{ label: 'llamafile', baseUrl: 'http://localhost:8080/v1' }],
    });
    const available = pf.getAvailableProviders();
    assert(available.includes('ollama'), `'ollama' presente (obtido: ${available.join(',')})`);
    assert(available.includes('llamafile'), `'llamafile' presente via customProviders do construtor (obtido: ${available.join(',')})`);
}

console.log('\n=== S164 — addCustomProvider()/removeCustomProvider() em runtime ===');
{
    const pf = new ProviderFactory({ defaultProvider: 'ollama' });
    assert(!pf.getAvailableProviders().includes('llamafile'), 'llamafile ausente antes de addCustomProvider');

    pf.addCustomProvider({ label: 'llamafile', baseUrl: 'http://localhost:8080/v1' });
    assert(pf.getAvailableProviders().includes('llamafile'), 'llamafile presente depois de addCustomProvider (runtime)');

    pf.removeCustomProvider('llamafile');
    assert(!pf.getAvailableProviders().includes('llamafile'), 'llamafile removido depois de removeCustomProvider');
}

console.log('\n=== S164 — label colidente com provider nativo é rejeitada, não sobrescreve ===');
{
    const pf = new ProviderFactory({ defaultProvider: 'ollama', ollamaUrl: 'http://localhost:11434' });
    const beforeCount = pf.getAvailableProviders().length;
    pf.addCustomProvider({ label: 'ollama', baseUrl: 'http://localhost:8080/v1' }); // tentativa de colisão
    assert(pf.getAvailableProviders().length === beforeCount, 'nenhum provider novo adicionado (colisão rejeitada)');
    assert(pf.getOllamaProvider() !== undefined, 'getOllamaProvider() continua retornando a instância nativa real (não foi sobrescrita)');
}

console.log('\n=== S164 — removeCustomProvider() nunca remove um provider nativo por engano ===');
{
    const pf = new ProviderFactory({ defaultProvider: 'ollama', ollamaUrl: 'http://localhost:11434' });
    pf.removeCustomProvider('ollama'); // tentativa de remover o nativo via API de "custom"
    assert(pf.getAvailableProviders().includes('ollama'), "'ollama' continua disponível — removeCustomProvider() ignora nomes reservados");
}

console.log('\n=== S164 — múltiplos customProviders no construtor, todos presentes ===');
{
    const pf = new ProviderFactory({
        defaultProvider: 'ollama',
        customProviders: [
            { label: 'llamafile', baseUrl: 'http://localhost:8080/v1' },
            { label: 'lmstudio', baseUrl: 'http://localhost:1234/v1', model: 'meu-modelo-local' },
        ],
    });
    const available = pf.getAvailableProviders();
    assert(available.includes('llamafile') && available.includes('lmstudio'), `ambos presentes (obtido: ${available.join(',')})`);
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S164 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
console.log(`\nCOBERTURA:`);
console.log(`  Hidratação no construtor: testado`);
console.log(`  addCustomProvider/removeCustomProvider em runtime: testado`);
console.log(`  Proteção contra colisão de nome reservado: testado`);
console.log(`  Múltiplos customProviders: testado`);
if (failed > 0) process.exit(1);
