/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S331 (issue 056, Sprint F3)
 *
 * O StepSemanticValidator julgava um step só pelo texto da resposta (600 chars) e "Ferramenta executada:
 * agentloop". Validação real da issue 051 (04/10/2026): rebaixou 2× um step que tinha gravado o arquivo
 * pedido ("o step pedia criar um arquivo com ferramenta de escrita, mas o output é só texto") — custou 2
 * replans. E não tinha como notar quando NENHUMA escrita aconteceu. Agora recebe os fatos estruturais da
 * tentativa (ferramentas chamadas, que falharam, arquivos produzidos) como evidência no prompt do LLM.
 *
 * REGRESSÃO SE: os fatos deixarem de chegar ao prompt; o GoalExecutionLoop deixar de passá-los; ou o
 * validador passar a decidir pelos fatos sem o LLM (decisão determinística nova).
 *
 * Execução: npx ts-node src/__tests__/regression/S331_StepSemanticValidator_ReceivesExecutionFacts.test.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { StepSemanticValidator } from '../../loop/StepSemanticValidator';
import type { PlanStep } from '../../loop/GoalTypes';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}

function capturingFactory(prompts: string[], verdict: string) {
    return {
        getBudgetAuxiliar: () => ({ timeoutMs: 45_000, origem: 'padrao', latenciaTipicaMs: null }),
        chatWithFallback: async (messages: Array<{ content: string }>) => {
            prompts.push(messages[0].content);
            return { status: 'success', content: verdict, attempts: [] };
        },
    } as any;
}
const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
    const orig = process.stdout.write.bind(process.stdout);
    (process.stdout.write as unknown) = (): boolean => true;
    try { return await fn(); } finally { process.stdout.write = orig; }
};

// Descrição e saída sem termos em comum → o caminho rápido não decide e o LLM é chamado.
const step = { id: 'step_3', description: 'Gravar a proposta da aula 06 em aulas/aula_06.md seguindo o padrão' } as PlanStep;
const output = 'Pronto. Conteúdo elaborado conforme solicitado anteriormente, com tópicos e atividade.';

async function main(): Promise<void> {

console.log('\n=== S331-1 — com fatos: o prompt do LLM traz ferramentas, falhas e arquivos ===');
{
    const prompts: string[] = [];
    const v = new StepSemanticValidator(capturingFactory(prompts, '{"result":"relevant","confidence":0.9,"reason":"arquivo gravado"}'));
    const r = await quiet(() => v.validate(step, output, 'proponha a aula 06', {
        toolsCalled: ['read', 'write'], toolsFailed: [], artifacts: ['aulas/aula_06.md'],
    }));
    const p = prompts[0] ?? '';
    assert(prompts.length === 1, 'o LLM foi consultado (o caminho rápido não decidiu)', prompts.length);
    assert(p.includes('Fatos da execução (registrados pelo sistema, não pelo modelo):'), 'bloco de fatos presente');
    assert(p.includes('Ferramentas chamadas: read, write'), 'ferramentas chamadas');
    assert(p.includes('Arquivos gravados/produzidos: aulas/aula_06.md'), 'arquivo produzido');
    assert(p.includes('Ferramentas que falharam: nenhuma'), 'nenhuma falha');
    assert(p.includes('junto com os fatos da execução'), 'a pergunta considera os fatos');
    assert(r.result === 'relevant', 'o veredito continua sendo o do LLM', r);
}

console.log('\n=== S331-2 — "nenhuma escrita" também é fato visível ===');
{
    const prompts: string[] = [];
    const v = new StepSemanticValidator(capturingFactory(prompts, '{"result":"mismatch","confidence":0.9,"reason":"nada gravado"}'));
    const r = await quiet(() => v.validate(step, output, undefined, { toolsCalled: ['exec_command', 'exec_command'], toolsFailed: ['exec_command'], artifacts: [] }));
    const p = prompts[0] ?? '';
    assert(p.includes('Ferramentas chamadas: exec_command') && !p.includes('exec_command, exec_command'), 'repetidas aparecem uma vez');
    assert(p.includes('Ferramentas que falharam: exec_command'), 'falha listada');
    assert(p.includes('Arquivos gravados/produzidos: nenhum'), '"nenhum" arquivo é dito explicitamente');
    assert(r.result === 'mismatch' && r.shouldDowngradeToPartial === true, 'decisão continua sendo do LLM (mismatch confiante → rebaixa)', r);
}

console.log('\n=== S331-2b — arquivos NÃO registrados (step agentloop) não viram "nenhum" ===');
{
    // Visto na validação real (05/10/2026): o step agentloop chamou read+write, mas o sistema não registra
    // producedArtifactPaths para agentloop — o prompt dizia "nenhum" ao lado de "write", contraditório e falso.
    const prompts: string[] = [];
    const v = new StepSemanticValidator(capturingFactory(prompts, '{"result":"relevant","confidence":0.9}'));
    await quiet(() => v.validate(step, output, undefined, { toolsCalled: ['read', 'write'], toolsFailed: [] }));
    assert(prompts[0].includes('Arquivos gravados/produzidos: não registrado para este tipo de etapa'), 'artifacts ausente → "não registrado"', prompts[0]);
    assert(!prompts[0].includes('Arquivos gravados/produzidos: nenhum'), 'nunca "nenhum" quando não há registro');
}

console.log('\n=== S331-3 — sem fatos: prompt como antes ===');
{
    const prompts: string[] = [];
    const v = new StepSemanticValidator(capturingFactory(prompts, '{"result":"relevant","confidence":0.9}'));
    await quiet(() => v.validate(step, output));
    assert(!prompts[0].includes('Fatos da execução') && prompts[0].includes('O output acima ENDEREÇA a intenção do step?'), 'sem bloco de fatos e com a pergunta original');
}

console.log('\n=== S331-4 — estrutural: o GoalExecutionLoop passa os fatos da tentativa recém-gravada ===');
{
    const src = fs.readFileSync(path.join(__dirname, '../../loop/GoalExecutionLoop.ts'), 'utf-8');
    const idx = src.indexOf('this.semanticValidator.validate(');
    const before = src.slice(idx - 1200, idx + 200);
    assert(/a\.planStepId === pendingStep\.id/.test(before), 'lê a última tentativa DESTE step');
    assert(/subToolCalls/.test(before) && /subToolFailures/.test(before) && /producedArtifactPaths/.test(before), 'usa subToolCalls, subToolFailures e producedArtifactPaths');
    assert(/stepFacts,\s*\)/.test(before), 'os fatos são passados ao validate');
    const validator = fs.readFileSync(path.join(__dirname, '../../loop/StepSemanticValidator.ts'), 'utf-8');
    assert(!/facts\.artifacts\.length\s*[>=]=?\s*\d+\s*\)?\s*\{?\s*return\s*\{\s*result/.test(validator), 'nenhum atalho determinístico decide pelos fatos');
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S331 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;
}

main().catch((err) => { console.error('S331 erro inesperado:', err); process.exitCode = 1; });
