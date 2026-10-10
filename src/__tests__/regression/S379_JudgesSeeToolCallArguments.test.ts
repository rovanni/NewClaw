/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S379 (10/10/2026, Sprint A depois do S378: "o que uma pessoa teria no lugar do juiz")
 *
 * Os juízes de qualidade e de resultado do passo relataram, no campo `faltou`, que o resultado de uma gravação diz só
 * "atualizado" e que não conseguiam conferir o conteúdo gravado — que estava nos ARGUMENTOS da chamada. Só o juiz de grounding
 * os recebia. Agora os três os recebem, no mesmo formato, e valores gigantes são cortados POR VALOR com o corte declarado.
 *
 * S379-1 — `descreverArgumentos`: o formato único (e o corte declarado por valor).
 * S379-2 — juiz de qualidade: `args=` junto da saída de cada ferramenta.
 * S379-3 — juiz de resultado do passo: seção de argumentos, separada do resultado.
 * S379-4 — fiação: os caminhos reais passam os argumentos.
 *
 * Execução: npx ts-node src/__tests__/regression/S379_JudgesSeeToolCallArguments.test.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { descreverArgumentos } from '../../shared/argumentosDaChamada';
import { ObserverValidator } from '../../loop/ObserverValidator';
import { StepSemanticValidator } from '../../loop/StepSemanticValidator';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}
const ler = (rel: string): string => fs.readFileSync(path.join(process.cwd(), rel), 'utf-8');

function fabrica(prompts: string[], veredito: object) {
    return {
        getBudgetAuxiliar: () => ({ timeoutMs: 30_000, origem: 'padrao', latenciaTipicaMs: null }),
        chatWithFallback: async (m: Array<{ content: string }>) => {
            prompts.push(m[0].content);
            return { status: 'success', content: JSON.stringify(veredito), attempts: [] };
        },
    } as any;
}

async function main(): Promise<void> {

console.log('\n=== S379-1 — o formato único dos argumentos ===');
{
    assert(descreverArgumentos({ name: 'Análise', content: 'Preço US$ 1,17' }) === '{"name":"Análise","content":"Preço US$ 1,17"}', 'objeto: JSON, íntegro quando cabe');
    assert(descreverArgumentos('{"a":1}') === '{"a":1}', 'texto JSON (como o rastro guarda): lido de volta');
    assert(descreverArgumentos(undefined) === undefined && descreverArgumentos({}) === undefined && descreverArgumentos(null) === undefined, 'sem argumentos: nada (a tela/prompt não inventa)');
    const longo = 'x'.repeat(5000);
    const cortado = descreverArgumentos({ path: 'a.txt', content: longo })!;
    assert(cortado.includes('"path":"a.txt"') && cortado.includes('primeiros 2000 de 5000 caracteres — o corte é do sistema, não do dado') && cortado.length < 2500, 'valor gigante: cortado POR VALOR, com os números, e o resto dos argumentos intacto', cortado.length);
    assert(descreverArgumentos(['y'.repeat(3000)])!.includes('primeiros 2000 de 3000'), 'vale também dentro de listas');
}

console.log('\n=== S379-2 — o juiz de qualidade vê os argumentos da chamada ===');
{
    const prompts: string[] = [];
    const obs = new ObserverValidator(fabrica(prompts, { estado: 'aprovado', itens: [], tipo_de_falha: 'none' }));
    await obs.validate('salve a análise', 'action', 'memory_write', 'atualizado', 'Salvei a análise da River na memória com sucesso.', undefined,
        [{ tool: 'memory_write', input: descreverArgumentos({ name: 'Análise River', content: 'Preço US$ 1,17; ATH US$ 87,73' }), output: 'atualizado' }]);
    const p = prompts[0] ?? '';
    assert(p.includes('[1] ferramenta=memory_write args={"name":"Análise River","content":"Preço US$ 1,17; ATH US$ 87,73"}\natualizado'), 'o prompt traz o conteúdo gravado (args=…) junto do "atualizado"', p.slice(0, 200));
    assert(/os argumentos da chamada \(args=…\)/.test(p), 'o rótulo da seção diz que há argumentos');
    const sem: string[] = [];
    await new ObserverValidator(fabrica(sem, { estado: 'aprovado', itens: [], tipo_de_falha: 'none' })).validate('p', 'action', 'memory_write', 'atualizado', 'Salvei a análise da River na memória com sucesso.');
    assert(/\[1\] ferramenta=memory_write\natualizado/.test(sem[0] ?? '') && !/ferramenta=memory_write args=/.test(sem[0] ?? ''), 'sem argumentos: o formato anterior, sem linha inventada');
}

console.log('\n=== S379-3 — o juiz de resultado do passo vê os argumentos, separados do resultado ===');
{
    const prompts: string[] = [];
    const validador = new StepSemanticValidator(fabrica(prompts, { estado: 'aprovado', itens: [{ item: 'trata do passo', confere: 'sim' }], confianca: 0.9 }));
    const step: any = { id: 's1', description: 'Salvar na memória a análise consolidada da River', status: 'pending', fallbackSteps: [], toolName: 'memory_write', toolArgs: { name: 'Análise River', content: 'Resumo consolidado com preço e ATH' } };
    await validador.validate(step, 'atualizado: nó gravado com sucesso na memória de longo prazo, aguardando indexação posterior pelo sistema.', 'salve a análise');
    const p = prompts[0] ?? '';
    assert(/Argumentos da chamada da ferramenta \(o que foi pedido a ela — não é o resultado\)/.test(p) && p.includes('"content":"Resumo consolidado com preço e ATH"'), 'o prompt traz o que foi pedido à ferramenta', p.slice(-600));
    assert(p.indexOf('Argumentos da chamada') > p.indexOf('O QUE ESTÁ SENDO JULGADO'), 'fica na seção de contexto da execução, depois do resultado julgado — nunca como se fosse o resultado');
    const semArgs: string[] = [];
    await new StepSemanticValidator(fabrica(semArgs, { estado: 'aprovado', itens: [{ item: 'x', confere: 'sim' }], confianca: 0.9 }))
        .validate({ ...step, toolArgs: undefined }, 'atualizado: nó gravado com sucesso na memória de longo prazo, aguardando indexação posterior pelo sistema.', 'p');
    assert(!(semArgs[0] ?? '').includes('Argumentos da chamada'), 'passo sem argumentos: a seção não aparece');
}

console.log('\n=== S379-4 — a fiação dos caminhos reais ===');
{
    const loop = ler('src/loop/AgentLoop.ts');
    assert(/conversationId, undefined, atomicData\.action\?\.input\)/.test(loop) && /conversationId, undefined, toolCall\.arguments\)/.test(loop), 'os dois caminhos que validam a ferramenta logo após a execução passam os argumentos');
    assert(/input: descreverArgumentos\(e\.input\), output: e\.output/.test(loop), 'o julgamento de qualidade da resposta final recebe os argumentos de TODAS as ferramentas do turno');
    assert(/\[\{ tool: toolName, input: descreverArgumentos\(toolInput\), output: toolOutput \}\]/.test(loop), 'o validador pós-ferramenta monta a entrada com os argumentos');
    assert(/argumentos: descreverArgumentos\(step\.toolArgs\)/.test(ler('src/loop/StepSemanticValidator.ts')), 'o juiz do passo recebe os argumentos do passo');
    const sh = ler('src/shared/argumentosDaChamada.ts');
    assert(!/glm|gemma|qwen|llama/i.test(sh), 'módulo-folha sem nome de modelo');
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S379 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;
}

main().catch(e => { console.error(e); process.exit(1); });
