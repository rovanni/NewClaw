/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S222
 *
 * Origem: investigação do incidente "River" #2 (2026-08-11 19:21-19:24). Causa raiz 2 do plano
 * de correção (S221-S224): GoalPlanner.callPlannerLLM() chamava providerFactory.getProviderWithModel()
 * — UM único provider, preso ao modelo resolvido deterministicamente para a role do Planner (ex:
 * "analysis" → gemma4:e4b-it-qat) — sem nenhuma cadeia de fallback entre providers. Quando esse
 * provider falhava, plan()/replan() degradavam direto para o plano genérico de 1 step
 * (fallbackPlan/emergencyFallback), mesmo havendo outro provider saudável disponível — foi
 * exatamente o que aconteceu no log real: enquanto o Planner falhava sempre com
 * model=gemma4:e4b-it-qat status=error, as chamadas de ferramenta do próprio AgentLoop (que já
 * usam chatWithFallback([llamafile, ollama])) conseguiam responder via ollama/glm-5.2:cloud.
 *
 * Esta sprint faz callPlannerLLM reusar chatWithFallback — o mesmo mecanismo já usado por
 * AgentLoop e pela validação de goal — em vez de inventar um mecanismo de fallback novo.
 *
 * REGRESSÃO SE: callPlannerLLM voltar a usar getProviderWithModel() direto (perde o fallback);
 * ou parar de repassar `this.model` como modelOverride (perde a role determinística já resolvida
 * pelo ModelProfileRegistry — RFC-005/ADR relacionada); ou passar preferredProvider fixo (mudaria
 * a ordem de fallback sem necessidade).
 *
 * Execução: npx ts-node src/__tests__/regression/S222_GoalPlanner_ProviderFallbackChain.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { GoalPlanner } from '../../loop/GoalPlanner';
import type { LLMMessage, ProviderFactory } from '../../core/ProviderFactory';
import type { ReflectionMemory } from '../../memory/ReflectionMemory';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

function makePlanner(chatWithFallback: ProviderFactory['chatWithFallback']): GoalPlanner {
    const fakeProviderFactory = {
        getProviderWithModel: () => {
            throw new Error('S222: callPlannerLLM não deve mais chamar getProviderWithModel diretamente');
        },
        chatWithFallback,
    } as unknown as ProviderFactory;
    const fakeReflectionMemory = {} as unknown as ReflectionMemory;
    return new GoalPlanner(fakeProviderFactory, fakeReflectionMemory);
}

type Planner = { callPlannerLLM: (m: LLMMessage[], t: number) => Promise<{ status: string; content: string }> };

async function main(): Promise<void> {

console.log('\n=== S222-1 — estrutural: callPlannerLLM não usa mais um único provider fixo ===');
{
    const source = fs.readFileSync(path.join(__dirname, '../../loop/GoalPlanner.ts'), 'utf-8');
    const start = source.indexOf('private async callPlannerLLM');
    const end = source.indexOf('\n    }\n', start);
    const body = source.slice(start, end);

    assert(!/\.getProviderWithModel\(/.test(body), 'callPlannerLLM não CHAMA mais getProviderWithModel (a menção em comentário explicativo é esperada)');
    assert(/this\.providerFactory\.chatWithFallback\(/.test(body), 'callPlannerLLM chama chatWithFallback — mesma cadeia de resiliência do AgentLoop');
}

console.log('\n=== S222-2 — funcional: sucesso via chatWithFallback repassa modelo e timeout corretamente ===');
{
    let capturedArgs: unknown[] = [];
    const planner = makePlanner((async (...args: unknown[]) => {
        capturedArgs = args;
        return { status: 'success', content: 'plano ok', attempts: [] };
    }) as ProviderFactory['chatWithFallback']);
    planner.setModel('modelo-da-role-analysis');

    const messages: LLMMessage[] = [{ role: 'user', content: 'objetivo de teste' }];
    const result = await (planner as unknown as Planner).callPlannerLLM(messages, 42_000);

    assert(result.status === 'success' && result.content === 'plano ok', 'resultado de sucesso repassado sem alteração', result);
    assert(capturedArgs[0] === messages, 'as mensagens são repassadas sem cópia/mutação');
    assert(capturedArgs[3] === 42_000, 'o timeout calculado (computeDynamicTimeout) chega intacto ao chatWithFallback', capturedArgs[3]);
    assert(
        capturedArgs[5] === 'modelo-da-role-analysis',
        'o modelo resolvido para a role do Planner (ModelProfileRegistry) é passado como modelOverride — preserva a role determinística',
        capturedArgs[5],
    );
    assert(
        capturedArgs[2] === undefined,
        'preferredProvider não é fixado — a ordem de fallback continua a padrão (não restringe a um único provider)',
        capturedArgs[2],
    );
}

console.log('\n=== S222-3 — funcional: quando TODOS os providers falham, contrato de erro é preservado ===');
{
    const planner = makePlanner((async () => ({
        status: 'error',
        content: '',
        attempts: [
            { provider: 'llamafile', model: 'modelo-x', duration: 15000, status: 'error' as const, errorMessage: 'fetch failed' },
            { provider: 'ollama', model: 'modelo-x', duration: 30000, status: 'error' as const, errorMessage: 'ECONNREFUSED' },
        ],
    })) as ProviderFactory['chatWithFallback']);
    planner.setModel('modelo-x');

    const result = await (planner as unknown as Planner).callPlannerLLM([{ role: 'user', content: 'x' }], 5000);
    assert(result.status === 'error' && result.content === '', 'contrato preservado: plan()/replan() ainda reconhecem falha e caem no fallbackPlan/emergencyFallback', result);
}

console.log('\n=== S222-4 — não-regressão: sucesso de UM provider (não necessariamente o primeiro) ainda conta como sucesso ===');
{
    // Simula o caso real do incidente: o primeiro provider (llamafile/modelo local) já falhou
    // dentro de chatWithFallback antes de retornar — o que importa para o Planner é o resultado
    // FINAL agregado, não qual provider especificamente respondeu.
    const planner = makePlanner((async () => ({
        status: 'success',
        content: '{"steps":[{"toolName":"crypto_analysis","toolArgs":{"symbol":"river","type":"detail"}}],"strategy":"consultar preço direto"}',
        attempts: [
            { provider: 'llamafile', model: 'gemma4:e4b-it-qat', duration: 15000, status: 'error' as const, errorMessage: 'fetch failed' },
            { provider: 'ollama', model: 'glm-5.2:cloud', duration: 2200, status: 'success' as const },
        ],
    })) as ProviderFactory['chatWithFallback']);
    planner.setModel('gemma4:e4b-it-qat');

    const result = await (planner as unknown as Planner).callPlannerLLM([{ role: 'user', content: 'Qual o valor do River, criptomoeda?' }], 60_000);
    assert(result.status === 'success', 'o Planner agora consegue produzir um plano estruturado mesmo com o modelo offline indisponível — este é exatamente o caso que faltava no incidente real', result);
    assert(result.content.includes('crypto_analysis'), 'o plano recuperado decompõe em ferramenta real, não no fallback genérico agentloop');
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S222 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;

}

main().catch((err) => {
    console.error('S222 erro inesperado:', err);
    process.exitCode = 1;
});
