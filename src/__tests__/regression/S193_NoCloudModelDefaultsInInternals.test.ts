/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S193 (issue 019)
 *
 * Achado no teste de uso como usuário leigo (04/08/2026), instância configurada SÓ com provedor
 * local (`Modelo local` → 127.0.0.1:8080, servindo um `.gguf`), sem nenhum provedor de nuvem:
 *
 *     START provider=Modelo local/gemma4:31b-cloud
 *
 * Um nome de modelo da Ollama Cloud sendo pedido ao servidor local. A origem não era configuração
 * do usuário: era padrão embutido em código, em CINCO lugares — `ModelProfileRegistry`
 * (classifierModel), `GoalPlanner`, `RiskAnalyzer`, `StepSemanticValidator` e
 * `contentStubClassifier`. Cada categoria que o operador não configurasse explicitamente pedia um
 * modelo de nuvem ao provedor ATIVO, qualquer que fosse ele.
 *
 * Sintoma para o usuário: `404 model not found` no meio de um turno, ou o servidor local ignorando
 * o campo e respondendo com outro modelo — nunca um erro claro de configuração.
 *
 * Decisão (issue 019, opção "usar o que o provedor serve"): quem chama sem modelo está dizendo
 * "use o que este provedor serve", não "escolha um por mim". Quem sabe a resposta é o provedor —
 * `custom.model` para OpenAI-compatible, `OLLAMA_MODEL` para o Ollama — e a decisão mora em
 * `ProviderFactory.getProviderWithModel()`, não espalhada em `??` por cinco arquivos.
 *
 * Execução: npx ts-node src/__tests__/regression/S193_NoCloudModelDefaultsInInternals.test.ts
 */

import { ProviderFactory } from '../../core/ProviderFactory';

let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string, detail?: unknown): void {
    if (cond) { console.log(`  OK ${msg}`); passed++; }
    else { console.error(`  FALHOU: ${msg}`, detail ?? ''); failed++; }
}

function modeloDe(p: unknown): string {
    const anyP = p as { getModel?: () => string; model?: string };
    return anyP.getModel ? anyP.getModel() : (anyP.model ?? '');
}

async function main() {
    console.log('\n=== S193 — componente interno não carrega modelo de nuvem embutido (issue 019) ===');

    console.log('\n--- S193.1 — instalação só-local: sem modelo pedido, usa o do provedor ---');
    {
        const f = new ProviderFactory({
            defaultProvider: 'Modelo local',
            ollamaUrl: 'http://localhost:11434',
            ollamaModel: 'modelo-do-ollama',
            customProviders: [{ label: 'Modelo local', baseUrl: 'http://127.0.0.1:8080/v1', model: 'meu-modelo.gguf' }],
        } as any);

        const semModelo = f.getProviderWithModel(undefined);
        assert(modeloDe(semModelo) === 'meu-modelo.gguf',
            'sem modelo pedido, o provedor local responde com o modelo que ELE serve', modeloDe(semModelo));
        assert(!/cloud/i.test(modeloDe(semModelo)),
            'nenhum nome de modelo de nuvem aparece numa instalação sem provedor de nuvem', modeloDe(semModelo));

        const comModelo = f.getProviderWithModel('escolha-explicita');
        assert(modeloDe(comModelo) === 'escolha-explicita',
            'escolha explícita do operador continua vencendo — nada mudou para quem configura', modeloDe(comModelo));
    }

    console.log('\n--- S193.2 — instalação Ollama: cai no OLLAMA_MODEL configurado ---');
    {
        const f = new ProviderFactory({
            defaultProvider: 'ollama',
            ollamaUrl: 'http://localhost:11434',
            ollamaModel: 'modelo-do-operador',
        } as any);
        assert(modeloDe(f.getProviderWithModel(undefined)) === 'modelo-do-operador',
            'sem modelo pedido, usa o que o operador configurou em OLLAMA_MODEL', modeloDe(f.getProviderWithModel(undefined)));
        assert(modeloDe(f.getProviderWithModel('')) === 'modelo-do-operador',
            'string vazia tem o mesmo significado que ausente — os componentes internos usam ""');
    }

    console.log('\n--- S193.3 — nenhum nome de modelo de nuvem embutido nos componentes internos ---');
    {
        const fs = require('fs');
        const path = require('path');
        const arquivos = [
            ['ModelProfileRegistry', '../../loop/ModelProfileRegistry.ts'],
            ['GoalPlanner',          '../../loop/GoalPlanner.ts'],
            ['RiskAnalyzer',         '../../loop/RiskAnalyzer.ts'],
            ['StepSemanticValidator','../../loop/StepSemanticValidator.ts'],
            ['contentStubClassifier','../../shared/contentStubClassifier.ts'],
        ];
        for (const [nome, rel] of arquivos) {
            const src: string = fs.readFileSync(path.join(__dirname, rel), 'utf-8');
            // Ignora linhas de comentário: a documentação PODE citar o nome como exemplo
            // histórico; o que não pode é ele ser valor de fallback em código.
            const codigo = src.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
            const temFallbackDeNuvem = /(\|\||\?\?)\s*['"][^'"]*:cloud['"]/.test(codigo)
                || /:\s*['"][^'"]*:cloud['"]\s*,?\s*$/m.test(codigo.split('profiles:')[0] ?? '');
            assert(!temFallbackDeNuvem,
                `${nome} não usa nome de modelo de nuvem como valor padrão em código`);
        }
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S193 RESULTADO: ${passed} passou | ${failed} falhou`);
    if (failed > 0) process.exit(1);
    process.exit(0);
}

main().catch(err => { console.error('Erro no teste S193:', err); process.exit(1); });
