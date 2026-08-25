/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S262 (D-08, campanha de consolidação de duplicidades)
 *
 * `docs/ARCHITECTURE/INVENTARIO_DUPLICACAO_2026-08-24.md`, caso D-08: `RiskAnalyzer.callRiskLLM`,
 * `contentStubClassifier.makeContentStubClassifier` e `StepSemanticValidator.llmValidate`
 * chamavam `providerFactory.getProviderWithModel(model).chat(...)` diretamente — UM único
 * provider fixo (`getProviderWithModel()` sem `providerName` cai sempre em `this.defaultProvider`,
 * ver comentário em `ProviderFactory.getProviderWithModel()`), sem NENHUM fallback. É o MESMO
 * anti-padrão que causou a falha real de entrega de clima em `ObserverValidator` (corrigido em
 * S258, 25/08/2026) — replicado nestes três consumidores, que nunca tinham disparado no dia da
 * investigação original, mas carregavam o mesmo risco (comentário já presente no topo de cada
 * arquivo desde a issue 019 reconhecendo o problema).
 *
 * Migração: os três agora chamam `providerFactory.chatWithFallback(...)`, passando o modelo
 * configurado (`RISK_MODEL`/`CONTENT_STUB_CLASSIFIER_MODEL`/`SEMANTIC_VALIDATOR_MODEL`) como
 * `modelOverride`, sem `preferredProvider` — mesmo shape que `ObserverValidator`/`GoalPlanner`
 * (S258/S222) já usam. A política de falha de CADA consumidor continua decidida no próprio
 * consumidor (RiskAnalyzer: 'timeout'|'error'; contentStubClassifier: fail-closed isStub=true;
 * StepSemanticValidator: fail-soft 'unverifiable') — só a fonte do `status` muda, de exceção
 * lançada para o campo `status` do `LLMResult`.
 *
 * REGRESSÃO SE: qualquer um dos três voltar a chamar `getProviderWithModel()` direto (perde o
 * fallback entre providers); ou se a política de falha de qualquer um deixar de ser decidida
 * localmente (ex: chatWithFallback passar a impor um veredito, violando Evidence Provider Pattern).
 *
 * Execução: npx ts-node src/__tests__/regression/S262_ProviderResilience_D08_FallbackChainConsumers.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { RiskAnalyzer } from '../../loop/RiskAnalyzer';
import { makeContentStubClassifier } from '../../shared/contentStubClassifier';
import { StepSemanticValidator } from '../../loop/StepSemanticValidator';
import { ReflectionMemory } from '../../memory/ReflectionMemory';
import { ToolRegistry } from '../../core/ToolRegistry';
import { LLMMessage, LLMResult } from '../../core/ProviderFactory';
import { PlanStep } from '../../loop/GoalTypes';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

function readSrc(relPath: string): string {
    return fs.readFileSync(path.join(process.cwd(), 'src', relPath), 'utf-8');
}

type ChatWithFallbackCall = {
    messages: LLMMessage[];
    tools: unknown;
    preferredProvider: string | undefined;
    timeoutMs: number | undefined;
    modelOverride: string | undefined;
};

/** ProviderFactory fake — grava os argumentos de cada chamada e devolve o LLMResult configurado. */
function makeRecordingProviderFactory(result: () => LLMResult) {
    const calls: ChatWithFallbackCall[] = [];
    const factory = {
        chatWithFallback: async (
            messages: LLMMessage[], tools: unknown, preferredProvider: string | undefined,
            timeoutMs: number | undefined, _externalSignal: unknown, modelOverride: string | undefined,
        ) => {
            calls.push({ messages, tools, preferredProvider, timeoutMs, modelOverride });
            return result();
        },
        getBudgetAuxiliar: () => ({ timeoutMs: 8000, perfil: 'classificacao', fonte: 'padrao' }),
    } as unknown as import('../../core/ProviderFactory').ProviderFactory;
    return { factory, calls };
}

async function main(): Promise<void> {

console.log('\n=== S262-1 [estrutural] — nenhum dos 3 consumidores chama getProviderWithModel() direto ===');
{
    const riskSrc = readSrc('loop/RiskAnalyzer.ts');
    const stubSrc = readSrc('shared/contentStubClassifier.ts');
    const validatorSrc = readSrc('loop/StepSemanticValidator.ts');
    // Checa a CHAMADA (`.getProviderWithModel(`), não a palavra — os três arquivos citam
    // "getProviderWithModel()" em comentários explicando a migração, o que uma checagem por
    // substring simples confundiria com uma chamada real ainda presente.
    assert(!riskSrc.includes('.getProviderWithModel('), 'RiskAnalyzer.ts não chama mais getProviderWithModel()', null);
    assert(!stubSrc.includes('.getProviderWithModel('), 'contentStubClassifier.ts não chama mais getProviderWithModel()', null);
    assert(!validatorSrc.includes('.getProviderWithModel('), 'StepSemanticValidator.ts não chama mais getProviderWithModel()', null);
    assert(riskSrc.includes('chatWithFallback'), 'RiskAnalyzer.ts chama chatWithFallback', null);
    assert(stubSrc.includes('chatWithFallback'), 'contentStubClassifier.ts chama chatWithFallback', null);
    assert(validatorSrc.includes('chatWithFallback'), 'StepSemanticValidator.ts chama chatWithFallback', null);
}

console.log('\n=== S262-2 [funcional] — RiskAnalyzer.callRiskLLM: sucesso via chatWithFallback, modelOverride = this.model ===');
{
    const { factory, calls } = makeRecordingProviderFactory(() => ({ status: 'success', content: '{"risks":[]}', attempts: [] }));
    const reflectionMemory = { findHardConstraints: () => [], findToolFailures: () => undefined } as unknown as ReflectionMemory;
    const analyzer = new RiskAnalyzer(factory, ToolRegistry, reflectionMemory);
    analyzer.setModel('risk-model-teste');
    const result = await (analyzer as any).callRiskLLM([{ role: 'user', content: 'x' }], 12345);
    assert(result.status === 'success' && result.content === '{"risks":[]}', 'callRiskLLM devolve status/content do chatWithFallback em caso de sucesso', result);
    assert(calls.length === 1, 'chatWithFallback chamado exatamente 1x', calls);
    assert(calls[0]?.modelOverride === 'risk-model-teste', 'modelOverride = modelo configurado via setModel (RISK_MODEL)', calls[0]);
    assert(calls[0]?.preferredProvider === undefined, 'preferredProvider não é fixado — cai no defaultProvider, como getProviderWithModel(model) sem providerName fazia', calls[0]);
    assert(calls[0]?.timeoutMs === 12345, 'timeoutMs repassado sem alteração', calls[0]);
}

console.log('\n=== S262-3 [funcional] — RiskAnalyzer.callRiskLLM: falha (status=timeout) mapeada pela política local, não pelo ProviderFactory ===');
{
    const { factory } = makeRecordingProviderFactory(() => ({ status: 'timeout', content: '', attempts: [] }));
    const reflectionMemory = { findHardConstraints: () => [], findToolFailures: () => undefined } as unknown as ReflectionMemory;
    const analyzer = new RiskAnalyzer(factory, ToolRegistry, reflectionMemory);
    const result = await (analyzer as any).callRiskLLM([{ role: 'user', content: 'x' }], 5000);
    assert(result.status === 'timeout' && result.content === '', 'status=timeout do chatWithFallback vira {status:"timeout", content:""} — política decidida em RiskAnalyzer', result);
}
{
    const { factory } = makeRecordingProviderFactory(() => ({ status: 'error', content: '', attempts: [] }));
    const reflectionMemory = { findHardConstraints: () => [], findToolFailures: () => undefined } as unknown as ReflectionMemory;
    const analyzer = new RiskAnalyzer(factory, ToolRegistry, reflectionMemory);
    const result = await (analyzer as any).callRiskLLM([{ role: 'user', content: 'x' }], 5000);
    assert(result.status === 'error' && result.content === '', 'status=error do chatWithFallback vira {status:"error", content:""}', result);
}

console.log('\n=== S262-4 [funcional] — contentStubClassifier: fail-closed (isStub=true) quando chatWithFallback não retorna sucesso ===');
{
    const { factory, calls } = makeRecordingProviderFactory(() => ({ status: 'error', content: '', attempts: [] }));
    const classifier = makeContentStubClassifier(factory);
    const verdict = await classifier('conteúdo qualquer, suficientemente longo pra passar do fast-path de vazio', 'send_audio');
    assert(verdict.isStub === true, 'FAIL-CLOSED preservado: chatWithFallback falhando ainda produz isStub=true (política do consumidor, não do ProviderFactory)', verdict);
    assert(calls[0]?.modelOverride === (process.env['CONTENT_STUB_CLASSIFIER_MODEL'] ?? ''), 'modelOverride = CONTENT_STUB_CLASSIFIER_MODEL (issue 019: sem padrão embutido)', calls[0]);
}

console.log('\n=== S262-5 [funcional] — contentStubClassifier: sucesso via chatWithFallback é interpretado normalmente ===');
{
    const { factory } = makeRecordingProviderFactory(() => ({ status: 'success', content: '{"isStub": false, "reason": "conteúdo real"}', attempts: [] }));
    const classifier = makeContentStubClassifier(factory);
    const verdict = await classifier('conteúdo real, suficientemente longo pra passar do fast-path de vazio', 'write');
    assert(verdict.isStub === false && verdict.reason === 'conteúdo real', 'resposta de sucesso do chatWithFallback interpretada normalmente (isStub=false)', verdict);
}

console.log('\n=== S262-6 [funcional] — StepSemanticValidator.validate: fail-soft (unverifiable) quando chatWithFallback não retorna sucesso ===');
{
    const { factory, calls } = makeRecordingProviderFactory(() => ({ status: 'timeout', content: '', attempts: [] }));
    const validator = new StepSemanticValidator(factory);
    // Texto longo, SEM overlap de termos-chave com a description — força o fast path a ser
    // inconclusivo e escalar para o LLM (slow path), que é o que este teste quer exercitar.
    const step: PlanStep = { id: 's1', description: 'Buscar cotação específica de criptomoeda rara', status: 'pending', fallbackSteps: [] };
    const toolOutput = 'dados registrados no sistema para análise posterior, aguardando revisão da equipe responsável pelo acompanhamento do cronograma estabelecido pela coordenação técnica envolvida.';
    const validation = await validator.validate(step, toolOutput);
    assert(validation.result === 'unverifiable', 'FAIL-SOFT preservado: chatWithFallback falhando ainda produz result="unverifiable" (política do consumidor)', validation);
    assert(calls.length === 1, 'chatWithFallback chamado 1x (slow path acionado, fast path inconclusivo)', calls);
    assert(calls[0]?.modelOverride === (process.env['SEMANTIC_VALIDATOR_MODEL'] ?? ''), 'modelOverride = SEMANTIC_VALIDATOR_MODEL (issue 019: sem padrão embutido)', calls[0]);
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S262 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;

}

main().catch((err) => {
    console.error('S262 erro inesperado:', err);
    process.exitCode = 1;
});
