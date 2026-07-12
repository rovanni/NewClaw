/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S65
 * Implementação pedida pelo usuário após a auditoria de regex ([[project_session_bugs_jul2026_ai]]):
 * "a auditoria eu queria substituir regex pela llm, quando possível". Escopo acordado
 * explicitamente com o usuário (ver AskUserQuestion na sessão): SÓ `DomainRegistry.classifyDomain`,
 * e dentro dele SÓ os pontos de chamada JÁ ASSÍNCRONOS — `MemoryManager.addNode()` é síncrono e
 * tem 36 call-sites em 12 arquivos, converter pra async ficaria fora de escopo.
 *
 * `createDomainClassifierLLM()` (DomainRegistry.ts) cria um classificador async que chama o LLM
 * com um prompt listando os 10 domínios (usando `description`, não a keyword list) e pede um
 * JSON {domainId, confidence}. Em QUALQUER falha (status != success, JSON inválido, domainId
 * desconhecido), cai de volta pro `classifyDomain()` (regex, já corrigido nesta sessão) — nunca
 * quebra a feature inteira por causa de uma falha de LLM.
 *
 * Injeção via padrão de setter opcional já existente no projeto (`entityFallbackExtractor` em
 * ContextBuilder.ts, nunca chamado por ninguém antes desta sessão): `ContextBuilder` ganhou
 * `setDomainClassifierLLM()`, `MemoryWriteTool` também — se nunca chamado, comportamento
 * IDÊNTICO ao anterior (regex). `CMIIngestionPipeline` já tinha ProviderFactory injetado, usa
 * diretamente sem setter. Wiring real feito em `AgentController.ts` usando o mesmo modelo
 * "classifier" (leve/rápido) já configurado pra `GoalExtractor`.
 *
 * Escopo tocado: memory/DomainRegistry.ts (novo), loop/ContextBuilder.ts, tools/memory_write.ts,
 * memory/conversational/CMIIngestionPipeline.ts, core/AgentController.ts (wiring).
 *
 * Execução: npx ts-node src/__tests__/regression/S65_DomainClassifierLLM.test.ts
 */

process.env.WORKSPACE_DIR = process.env.WORKSPACE_DIR || 'D:/IA/newclaw/workspace';

import { createDomainClassifierLLM, classifyDomain } from '../../memory/DomainRegistry';
import type { ProviderFactory } from '../../core/ProviderFactory';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

/** Fake ProviderFactory — mesmo padrão usado em S12/outros testes desta suíte. */
function makeFakeProviderFactory(response: () => { status: string; content: string }) {
    return {
        chatWithFallback: async () => response(),
    } as unknown as ProviderFactory;
}

async function main(): Promise<void> {

console.log('\n=== S65-1 — resposta válida do LLM é parseada corretamente ===');
{
    const fake = makeFakeProviderFactory(() => ({
        status: 'success',
        content: '{"domainId": "domain_cripto", "confidence": 0.92}',
    }));
    const classifier = createDomainClassifierLLM(fake);
    const result = await classifier('Bitcoin subiu 5% hoje');
    assert(result?.domainId === 'domain_cripto', 'domainId retornado corretamente', result);
    assert(result?.confidence === 0.92, 'confidence retornada corretamente', result);
}

console.log('\n=== S65-2 — resposta com markdown fences (```json) é limpa antes do parse ===');
{
    const fake = makeFakeProviderFactory(() => ({
        status: 'success',
        content: '```json\n{"domainId": "domain_clima", "confidence": 0.8}\n```',
    }));
    const classifier = createDomainClassifierLLM(fake);
    const result = await classifier('vai chover amanhã?');
    assert(result?.domainId === 'domain_clima', 'JSON dentro de markdown fences é parseado', result);
}

console.log('\n=== S65-3 — status != success cai de volta pro regex (classifyDomain) ===');
{
    const fake = makeFakeProviderFactory(() => ({ status: 'timeout', content: '' }));
    const classifier = createDomainClassifierLLM(fake);
    const text = 'Meu namorado mora em Londrina.';
    const llmResult = await classifier(text);
    const regexResult = classifyDomain(text);
    assert(llmResult?.domainId === regexResult?.domainId, 'fallback pro regex quando LLM tem timeout', { llmResult, regexResult });
}

console.log('\n=== S65-4 — JSON inválido cai de volta pro regex ===');
{
    const fake = makeFakeProviderFactory(() => ({ status: 'success', content: 'isso não é JSON' }));
    const classifier = createDomainClassifierLLM(fake);
    const text = 'Preciso resolver esse problema no sistema.';
    const llmResult = await classifier(text);
    const regexResult = classifyDomain(text);
    assert(llmResult?.domainId === regexResult?.domainId, 'fallback pro regex quando JSON é inválido', { llmResult, regexResult });
}

console.log('\n=== S65-5 — domainId desconhecido (alucinado pelo LLM) cai de volta pro regex ===');
{
    const fake = makeFakeProviderFactory(() => ({
        status: 'success',
        content: '{"domainId": "domain_inventado_pelo_llm", "confidence": 0.9}',
    }));
    const classifier = createDomainClassifierLLM(fake);
    const text = 'Tenho aulas de matemática hoje.';
    const llmResult = await classifier(text);
    const regexResult = classifyDomain(text);
    assert(llmResult?.domainId === regexResult?.domainId, 'fallback pro regex quando domainId não existe em DOMAIN_DEFINITIONS', { llmResult, regexResult });
}

console.log('\n=== S65-6 — domainId null (LLM decide que não se encaixa em nenhum domínio) ===');
{
    const fake = makeFakeProviderFactory(() => ({
        status: 'success',
        content: '{"domainId": null, "confidence": 0.0}',
    }));
    const classifier = createDomainClassifierLLM(fake);
    const result = await classifier('Mensagem qualquer sem domínio claro.');
    assert(result === null, 'domainId null retorna null (sem forçar fallback pro regex)', result);
}

console.log('\n=== S65-7 — texto vazio retorna null sem chamar o LLM ===');
{
    let called = false;
    const fake = makeFakeProviderFactory(() => { called = true; return { status: 'success', content: '{}' }; });
    const classifier = createDomainClassifierLLM(fake);
    const result = await classifier('');
    assert(result === null, 'texto vazio retorna null', result);
    assert(!called, 'LLM não é chamado pra texto vazio (evita custo desnecessário)', called);
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S65 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;

}

main().catch((err) => {
    console.error('S65 erro inesperado:', err);
    process.exitCode = 1;
});
