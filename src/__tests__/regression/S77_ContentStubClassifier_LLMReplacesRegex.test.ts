/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S77
 *
 * Continuação direta de S76 (09/07/2026): usuário perguntou, depois de ver que o gate de
 * content-stub em sanitizePlanSteps() já tinha sido remendado 6 vezes por incidentes reais
 * ("step_1" → "step 1" → "etapas anteriores" → "gerado pelo assistente" → "passo 1" →
 * "[resultado_do_passo_1]"), se esse filtro podia ser substituído por um LLM em vez de
 * continuar caçando vocabulário por regex indefinidamente. Resposta: sim, como segunda linha
 * de defesa (a checagem ESTRUTURAL de sawDataProducingTool continua sendo a primeira, gratuita
 * e determinística) — implementado aqui.
 *
 * Mudança: sanitizePlanSteps() (loop/planning/sanitizePlanSteps.ts) trocou o parâmetro
 * `writeContentStubPatterns: RegExp[]` por `classifyContentStub: ContentStubClassifier`
 * (shared/contentStubClassifier.ts) — uma função assíncrona que pergunta a um LLM leve
 * (gemma4:31b-cloud por padrão) "isso é conteúdo real ou uma descrição/placeholder do que
 * deveria ser gerado?" em vez de casar contra uma lista de regex. GoalPlanner e RiskAnalyzer
 * constroem o classificador real via makeContentStubClassifier(providerFactory) no construtor,
 * com um parâmetro opcional de override para testes (injetado por S12/S38/S39/S60 com um mock
 * regex-backed, preservando o comportamento histórico desses testes de "fiação").
 *
 * A lista de regex (shared/contentStubPatterns.ts, CONTENT_STUB_PATTERNS) NÃO foi removida:
 * continua em uso por write_tool.ts como última linha de defesa em RUNTIME (síncrona, sem
 * custo de rede, logo antes de gravar em disco) — só o gate de PLANEJAMENTO trocou para LLM.
 *
 * Escopo tocado: shared/contentStubClassifier.ts (novo), loop/planning/sanitizePlanSteps.ts
 * (async + troca de parâmetro), loop/GoalPlanner.ts, loop/RiskAnalyzer.ts (constroem/injetam
 * o classificador; parsePlanResponse() virou async).
 *
 * Execução: npx ts-node src/__tests__/regression/S77_ContentStubClassifier_LLMReplacesRegex.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { makeContentStubClassifier } from '../../shared/contentStubClassifier';
import { sanitizePlanSteps } from '../../loop/planning/sanitizePlanSteps';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

function readSrc(relPath: string): string {
    return fs.readFileSync(path.join(process.cwd(), 'src', relPath), 'utf-8');
}

/** ProviderFactory fake — devolve o JSON configurado como resposta do classificador. */
function makeFakeProviderFactory(getResponse: () => string) {
    return {
        getProviderWithModel: () => ({
            chat: async () => ({ content: getResponse() }),
        }),
    } as unknown as import('../../core/ProviderFactory').ProviderFactory;
}

const fakeToolRegistry = { get: (name: string) => ({ name }) };
const fakeDetectMissingRequiredArgs = (): string | null => null;

async function main(): Promise<void> {

console.log('\n=== S77-1 [runtime] — makeContentStubClassifier: LLM responde isStub=true → sanitizePlanSteps converte o step ===');
{
    const classifier = makeContentStubClassifier(makeFakeProviderFactory(() => '{"isStub": true, "reason": "descreve o processo, não o resultado"}'));
    const rawSteps = [
        { id: 'step_1', toolName: 'send_audio', toolArgs: { text: 'qualquer coisa que o LLM decidiu classificar como stub' }, description: 'Enviar áudio' },
    ];
    const result = await sanitizePlanSteps(rawSteps, fakeToolRegistry, '[TEST]', fakeDetectMissingRequiredArgs, classifier);
    const step = result.steps[0];
    assert(step.toolName === undefined, 'step convertido para AgentLoop quando o classificador LLM diz isStub=true', step);
    assert(result.mutations[0]?.reason === 'content_stub', 'mutation registrada com reason=content_stub', result.mutations);
    assert(result.mutations[0]?.detail.includes('LLM reason='), 'detail da mutation cita a razão dada pelo LLM (rastreável em log)', result.mutations[0]);
}

console.log('\n=== S77-2 [runtime] — LLM responde isStub=false → sanitizePlanSteps mantém o step intacto ===');
{
    const classifier = makeContentStubClassifier(makeFakeProviderFactory(() => '{"isStub": false, "reason": "conteúdo real e completo"}'));
    const rawSteps = [
        { id: 'step_1', toolName: 'send_audio', toolArgs: { text: 'Olá! Aqui está a previsão real do tempo para hoje: céu limpo, 25 graus.' }, description: 'Enviar áudio' },
    ];
    const result = await sanitizePlanSteps(rawSteps, fakeToolRegistry, '[TEST]', fakeDetectMissingRequiredArgs, classifier);
    const step = result.steps[0];
    assert(step.toolName === 'send_audio', 'step permanece send_audio quando o classificador LLM diz isStub=false', step);
    assert(result.mutations.length === 0, 'nenhuma mutation registrada para conteúdo aprovado', result.mutations);
}

console.log('\n=== S77-3 [runtime — fail-closed] — erro de rede/timeout do LLM é tratado como isStub=true, não deixa passar ===');
{
    const throwingProviderFactory = {
        getProviderWithModel: () => ({
            chat: async () => { throw new Error('network error simulada'); },
        }),
    } as unknown as import('../../core/ProviderFactory').ProviderFactory;
    const classifier = makeContentStubClassifier(throwingProviderFactory);
    const rawSteps = [
        { id: 'step_1', toolName: 'send_audio', toolArgs: { text: 'texto legítimo, mas o LLM classificador está fora do ar agora' }, description: 'Enviar áudio' },
    ];
    const result = await sanitizePlanSteps(rawSteps, fakeToolRegistry, '[TEST]', fakeDetectMissingRequiredArgs, classifier);
    const step = result.steps[0];
    assert(step.toolName === undefined, 'FAIL-CLOSED: erro no classificador converte o step para AgentLoop (nunca deixa vazar por omissão)', step);
}

console.log('\n=== S77-4 [runtime — fail-closed] — resposta do LLM sem JSON válido também é fail-closed ===');
{
    const classifier = makeContentStubClassifier(makeFakeProviderFactory(() => 'desculpe, não entendi o pedido'));
    const rawSteps = [
        { id: 'step_1', toolName: 'send_audio', toolArgs: { text: 'texto legítimo, mas o LLM devolveu prosa em vez de JSON' }, description: 'Enviar áudio' },
    ];
    const result = await sanitizePlanSteps(rawSteps, fakeToolRegistry, '[TEST]', fakeDetectMissingRequiredArgs, classifier);
    assert(result.steps[0].toolName === undefined, 'FAIL-CLOSED: resposta sem JSON válido também converte para AgentLoop', result.steps[0]);
}

console.log('\n=== S77-5 [runtime] — conteúdo vazio/quase vazio é rejeitado sem sequer chamar o LLM (fast path) ===');
{
    let llmCalled = false;
    const classifier = makeContentStubClassifier(makeFakeProviderFactory(() => { llmCalled = true; return '{"isStub": false, "reason": "x"}'; }));
    const rawSteps = [
        { id: 'step_1', toolName: 'send_audio', toolArgs: { text: '  ' }, description: 'Enviar áudio' },
    ];
    const result = await sanitizePlanSteps(rawSteps, fakeToolRegistry, '[TEST]', fakeDetectMissingRequiredArgs, classifier);
    assert(result.steps[0].toolName === undefined, 'texto vazio/whitespace é rejeitado', result.steps[0]);
    assert(!llmCalled, 'o LLM não chega a ser chamado para conteúdo trivialmente vazio (fast path gratuito)', llmCalled);
}

console.log('\n=== S77-6 [estrutural] — a checagem estrutural (sawDataProducingTool) continua sendo a PRIMEIRA linha, sem chamar o LLM ===');
{
    let llmCalled = false;
    const classifier = makeContentStubClassifier(makeFakeProviderFactory(() => { llmCalled = true; return '{"isStub": false, "reason": "x"}'; }));
    const rawSteps = [
        { id: 'step_1', toolName: 'weather', toolArgs: { city: 'Belo Horizonte' }, description: 'Buscar previsão' },
        { id: 'step_2', toolName: 'send_audio', toolArgs: { text: 'Vai fazer sol amanhã, 30 graus.' }, description: 'Enviar áudio' },
    ];
    const result = await sanitizePlanSteps(rawSteps, fakeToolRegistry, '[TEST]', fakeDetectMissingRequiredArgs, classifier);
    assert(result.steps[1].toolName === undefined, 'step_2 convertido pela checagem estrutural (weather precede)', result.steps[1]);
    assert(result.mutations[0]?.reason === 'premature_content', 'reason=premature_content (estrutural), não content_stub (LLM)', result.mutations);
    assert(!llmCalled, 'o classificador LLM NUNCA é chamado quando a checagem estrutural já resolve — evita custo/latência desnecessários', llmCalled);
}

console.log('\n=== S77-7 [estrutural] — GoalPlanner e RiskAnalyzer constroem/aceitam o classificador injetável ===');
{
    const plannerSrc = readSrc('loop/GoalPlanner.ts');
    assert(plannerSrc.includes('makeContentStubClassifier(providerFactory)'), 'GoalPlanner constrói o classificador real a partir do seu providerFactory', null);
    assert(/classifyContentStub\?:\s*ContentStubClassifier/.test(plannerSrc), 'GoalPlanner aceita override injetável de classifyContentStub (testabilidade)', null);
    assert(!plannerSrc.includes('WRITE_CONTENT_STUB_PATTERNS'), 'GoalPlanner não referencia mais WRITE_CONTENT_STUB_PATTERNS (removido, substituído pelo classificador)', null);

    const riskSrc = readSrc('loop/RiskAnalyzer.ts');
    assert(riskSrc.includes('makeContentStubClassifier(providerFactory)'), 'RiskAnalyzer constrói o classificador real a partir do seu providerFactory', null);
    assert(/classifyContentStub\?:\s*ContentStubClassifier/.test(riskSrc), 'RiskAnalyzer aceita override injetável de classifyContentStub (testabilidade)', null);
    assert(!riskSrc.includes('WRITE_CONTENT_STUB_PATTERNS'), 'RiskAnalyzer não referencia mais WRITE_CONTENT_STUB_PATTERNS', null);
}

console.log('\n=== S77-8 [estrutural] — CONTENT_STUB_PATTERNS (regex) continua existindo e protegendo write_tool.ts em runtime ===');
{
    const writeToolSrc = readSrc('tools/write_tool.ts');
    assert(writeToolSrc.includes("import { CONTENT_STUB_PATTERNS } from '../shared/contentStubPatterns'"), 'write_tool.ts continua importando a lista de regex — última linha de defesa em runtime não foi removida, só o gate de planejamento trocou', null);
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S77 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;

}

main().catch((err) => {
    console.error('S77 erro inesperado:', err);
    process.exitCode = 1;
});
