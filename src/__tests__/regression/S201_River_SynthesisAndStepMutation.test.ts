/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S201
 *
 * Origem: incidente "River" (08/08/2026, Windows). Servido pelo Ollama local (localhost:11434) com
 * gemma4:e4b-it-qat — apesar de defaultProvider=llamafile, os seis papéis de modelRouter.provider_*
 * apontavam para ollama, e é o que o log mostra (`provider=ollama/gemma4:e4b-it-qat`).
 * Três perguntas idênticas — "Qual o valor da cripto River?" — e três respostas erradas, apesar
 * de o NewClaw ter obtido o dado correto aos 27 segundos do primeiro turno:
 *
 *   11:41:43  crypto_analysis ✓  → "River (RIVER) | Preço: $2,8 | 24h: -6,62% | MCap: $54.87M"
 *   11:42:46  resposta ao usuário → "$0,7834 | alta de 5,2% | ~$95 milhões"  ← 4 números fabricados
 *   11:49:17  [STEP-MUTATION] original_tool=crypto_analysis new_tool=agentloop
 *             reason="sem 'type' obrigatório"
 *   11:50:54+ AgentLoop substituto tenta web_search 4× — nunca volta a crypto_analysis
 *   11:55:29  write → workspace/RVR_cotacao.md            (grava o número fabricado)
 *   12:06:40  read  → "Com base nos registros internos de cotações… $0,7834"
 *
 * Duas causas estruturais distintas, cobertas aqui. A terceira (o arquivo de workspace nascido de
 * dado não verificado voltar como fonte citada) é RFC-006, deliberadamente fora deste teste.
 *
 * C1 — AgentLoop.ts, infoRetrievalSynthesisBody: o ramo de síntese que existe justamente para
 *      APRESENTAR dados de fonte externa não proibia fabricá-los. O ramo irmão (dedupSynthesisBody)
 *      já proibia inventar FALHA ("NÃO invente falhas para ferramentas listadas como success") —
 *      faltava a proibição simétrica sobre o DADO.
 *
 * C2 — sanitizePlanSteps.ts, bloco 'missing_args': ao rebaixar um tool-step para AgentLoop por
 *      argumento obrigatório ausente, `toolName` e `toolArgs` eram descartados e o motivo ia só
 *      para o log. Como o AgentLoop substituto recebe SOMENTE `description` como prompt
 *      (GoalExecutionLoop: `[GOAL STEP] <description>`), a informação de que existia uma
 *      ferramenta capaz — e do que faltava para usá-la — se perdia. A correção anexa esse FATO à
 *      description; não repara o argumento por inferência (isso seria adivinhar) e não obriga o
 *      AgentLoop a usar a ferramenta (isso seria decidir por ele).
 *
 * C3 — contentStubClassifier.ts: timeout fixo de 6s abortava contra modelo local (primeiro chunk
 *      medido em 14,2s no mesmo incidente), e o fail-closed rebaixava steps 'write' legítimos.
 *
 * Escopo tocado: loop/AgentLoop.ts, loop/planning/sanitizePlanSteps.ts,
 * shared/contentStubClassifier.ts. Nenhuma tool alterada, nenhuma string de usuário adicionada.
 *
 * Execução: npx ts-node src/__tests__/regression/S201_River_SynthesisAndStepMutation.test.ts
 */

// Relativo ao repositório, não um caminho absoluto de uma máquina — este teste roda em
// Windows/Linux/Mac igualmente. (Os 29 arquivos anteriores da suíte fixam 'D:/IA/newclaw/workspace';
// não são alterados aqui, é fora do escopo desta sprint.) Nenhum caso deste arquivo toca o disco —
// o guard existe só para não deixar a variável indefinida para módulos importados.
process.env.WORKSPACE_DIR = process.env.WORKSPACE_DIR || require('path').join(__dirname, '..', '..', '..', 'workspace');

import * as fs from 'fs';
import * as path from 'path';
import { sanitizePlanSteps } from '../../loop/planning/sanitizePlanSteps';
import { detectMissingRequiredArgs } from '../../loop/GoalPlanner';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

// Resolve qualquer tool — o alvo destes casos é a validação de args, não o registry.
const fakeToolRegistry = { get: (name: string) => ({ name }) };
// Nenhum caso deste arquivo exercita conteúdo inline; classificador neutro mantém o foco.
const neverStub = async () => ({ isStub: false, reason: 'não é o alvo de S201' });

async function main(): Promise<void> {

console.log('\n=== S201-1 — C1: a síntese de info-retrieval proíbe fabricar valores ===');
{
    const source = fs.readFileSync(path.join(__dirname, '../../loop/AgentLoop.ts'), 'utf-8');

    // Recorta o corpo da IIFE do ramo info-retrieval — a proibição precisa estar NESTE ramo, não
    // em qualquer ponto do arquivo (o ramo de dedup já tinha a dele desde antes deste fix).
    const infoStart = source.indexOf('const infoRetrievalSynthesisBody');
    const infoEnd = source.indexOf('const synthesisBody', infoStart);
    assert(infoStart > 0 && infoEnd > infoStart, 'pré-condição: infoRetrievalSynthesisBody localizado no arquivo', { infoStart, infoEnd });
    const infoBranch = source.slice(infoStart, infoEnd);

    assert(
        /NÃO FABRIQUE DADO|não fabrique dado/i.test(infoBranch),
        'o ramo info-retrieval carrega uma proibição explícita de fabricar dado',
        infoBranch.slice(0, 200),
    );
    assert(
        /LITERALMENTE/.test(infoBranch),
        'a regra exige que o valor apareça literalmente no resultado de ferramenta (não "baseado em")',
    );
    assert(
        /não foi obtido|não estiver nos resultados/i.test(infoBranch),
        'a regra oferece a saída honesta: admitir que o dado não veio, em vez de estimar',
    );

    // Não-regressão: o ramo irmão continua com a proibição PRÓPRIA dele (inventar falha).
    // Um refactor que trocasse os dois corpos passaria nos asserts acima e quebraria aqui.
    const dedupStart = source.indexOf('const dedupSynthesisBody');
    const dedupEnd = source.indexOf('const INFO_TOOLS', dedupStart);
    const dedupBranch = source.slice(dedupStart, dedupEnd);
    assert(
        /NÃO invente falhas/.test(dedupBranch),
        'o ramo de dedup mantém a própria proibição (inventar FALHA) — os dois ramos não foram trocados',
    );
}

console.log('\n=== S201-2 — C2: o step rebaixado por arg ausente carrega a intenção do plano ===');
{
    // Reprodução literal do plano de 11:49:11: crypto_analysis sem 'type'.
    const rawSteps = [
        {
            id: 'step_1',
            toolName: 'crypto_analysis',
            toolArgs: { symbol: 'river' },
            description: 'Buscar o valor de mercado da criptomoeda River',
        },
    ];
    const result = await sanitizePlanSteps(rawSteps, fakeToolRegistry, '[TEST]', detectMissingRequiredArgs, neverStub);
    const step = result.steps[0];

    // Comportamento histórico preservado: continua virando AgentLoop, o arg NÃO é inventado.
    assert(step.toolName === undefined, 'o step continua sendo rebaixado para AgentLoop (comportamento preservado)', step.toolName);
    assert(step.toolArgs === undefined, 'toolArgs continua descartado — o argumento ausente NÃO é inferido (NUNCA_ADIVINHAR)', step.toolArgs);
    assert(
        result.mutations[0]?.reason === 'missing_args',
        'a mutation continua registrada como missing_args',
        result.mutations[0],
    );

    // O que mudou: a intenção sobrevive até o prompt do AgentLoop.
    assert(
        step.description.includes('crypto_analysis'),
        'a description agora nomeia a ferramenta que o plano pretendia usar',
        step.description,
    );
    assert(
        step.description.includes("sem 'type' obrigatório"),
        'a description agora diz QUAL argumento faltou',
        step.description,
    );
    assert(
        step.description.startsWith('Buscar o valor de mercado da criptomoeda River'),
        'a description original é preservada — a intenção é acrescentada, não substituída',
        step.description,
    );
}

console.log('\n=== S201-3 — C2 é genérico: vale para qualquer tool de detectMissingRequiredArgs ===');
{
    // Se a correção fosse um `if (tool === "crypto_analysis")`, este bloco falharia. Cada caso
    // usa uma tool e um argumento obrigatório diferentes.
    const cases: Array<{ tool: string; args: Record<string, unknown>; expectFragment: string }> = [
        { tool: 'weather',        args: {},                          expectFragment: "sem 'city' obrigatório" },
        { tool: 'read',           args: {},                          expectFragment: "sem 'path' obrigatório" },
        { tool: 'send_document',  args: {},                          expectFragment: "sem 'file_path' obrigatório" },
        { tool: 'web_navigate',   args: { action: 'search' },        expectFragment: "action=search exige 'query'" },
    ];

    for (const c of cases) {
        const result = await sanitizePlanSteps(
            [{ id: 'step_1', toolName: c.tool, toolArgs: c.args, description: `Executar ${c.tool}` }],
            fakeToolRegistry, '[TEST]', detectMissingRequiredArgs, neverStub,
        );
        const step = result.steps[0];
        assert(
            step.toolName === undefined && step.description.includes(c.tool) && step.description.includes(c.expectFragment),
            `${c.tool}: intenção preservada na description (não é um caso especial de crypto)`,
            step.description,
        );
    }
}

console.log('\n=== S201-4 — C2 não-regressão: step com args completos passa intacto ===');
{
    const original = 'Buscar o detalhe de mercado do Bitcoin';
    const result = await sanitizePlanSteps(
        [{ id: 'step_1', toolName: 'crypto_analysis', toolArgs: { type: 'detail', symbol: 'btc' }, description: original }],
        fakeToolRegistry, '[TEST]', detectMissingRequiredArgs, neverStub,
    );
    const step = result.steps[0];
    assert(step.toolName === 'crypto_analysis', 'tool válida sobrevive com o toolName intacto', step.toolName);
    assert(step.description === original, 'description NÃO é alterada quando não houve mutation de args', step.description);
    assert(result.mutations.length === 0, 'nenhuma mutation registrada para um step válido', result.mutations);
}

console.log('\n=== S201-5 — C3: o timeout do classificador de stub é configurável ===');
{
    const source = fs.readFileSync(path.join(__dirname, '../../shared/contentStubClassifier.ts'), 'utf-8');
    assert(
        /CONTENT_STUB_CLASSIFIER_TIMEOUT_MS/.test(source),
        'o timeout lê CONTENT_STUB_CLASSIFIER_TIMEOUT_MS do ambiente',
    );
    assert(
        !/const TIMEOUT_MS = 6_000/.test(source),
        'o valor fixo de 6s (que abortava contra modelo local) não está mais hard-coded',
    );
    assert(
        /isStub: true, reason: 'erro na classificação LLM \(fail-closed\)'/.test(source),
        'o fail-closed continua intacto — só o prazo mudou, não a postura em caso de erro',
    );

    const envExample = fs.readFileSync(path.join(__dirname, '../../../.env.example'), 'utf-8');
    assert(
        /CONTENT_STUB_CLASSIFIER_TIMEOUT_MS=/.test(envExample),
        'a variável está documentada em .env.example (instalação em qualquer SO)',
    );
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S201 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;

}

main().catch((err) => {
    console.error('S201 erro inesperado:', err);
    process.exitCode = 1;
});
