/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S322 (issue 051; reescrito na troca ao motor único, ADR-014, 09/10/2026)
 *
 * O juiz de groundedness recebia cada evidência cortada em 2.000 chars (args em 200), um número sem justificativa
 * registrada. Em produção (set-out/2026), 25% das evidências passavam disso e 20 de 55 afirmações NOT_EVALUABLE citavam uma
 * evidência cortada. Na validação real da issue 049, um arquivo de 6,5 mil chars com os valores no fim fez o goal falhar
 * após 12 ciclos: o dado estava na evidência, o juiz não o via.
 *
 * Primeiro a evidência passou a entrar inteira, cortada só por "water-filling" quando não coubesse (corte marcado). No motor
 * único o princípio "Informação Completa para Decidir" foi levado até o fim: NADA é cortado — nem evidência, nem args, nem
 * resposta. O que não cabe no teto do motor (DECISION_PROMPT_MAX_CHARS, 60k) não é julgado: o resultado é UNVALIDATED, que
 * não autoriza entrega — nunca um veredito sobre um pedaço.
 *
 * REGRESSÃO SE: voltar um corte (fixo ou por orçamento) em evidência, args ou resposta; ou o juiz ser chamado com um prompt
 * acima do teto; ou um conjunto que não cabe virar veredito em vez de UNVALIDATED.
 *
 * Execução: npx ts-node src/__tests__/regression/S322_GroundingEvidence_WholeWithinBudget.test.ts
 */
process.env.WORKSPACE_DIR = process.env.WORKSPACE_DIR || 'D:/IA/newclaw/workspace';

import { ObserverValidator, EvidenceItem } from '../../loop/ObserverValidator';
import './_fixtures/motorLegado';   // juízes simulados no formato antigo → formato do motor único (ADR-014)

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}

const MAX_PROMPT = 60_000;
const judgeJson = JSON.stringify({ claims: [{ claim: 'O pico de 127 V RMS é 179,6 V', evidence: ['E1'], verdict: 'SUPPORTED' }] });

/** Provedor falso que captura o prompt EXATO que o juiz receberia. */
function capturingFactory(prompts: string[]): import('../../core/ProviderFactory').ProviderFactory {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getBudgetAuxiliar } = require('../../shared/auxTimeout');
    return {
        chatWithFallback: async (messages: Array<{ content: string }>) => {
            prompts.push(messages[0].content);
            return { status: 'success', content: judgeJson, attempts: [] };
        },
        getBudgetAuxiliar: (p: 'classificacao' | 'validacao') => getBudgetAuxiliar(p, null, null),
    } as unknown as import('../../core/ProviderFactory').ProviderFactory;
}

async function quiet<T>(fn: () => Promise<T>): Promise<T> {
    const orig = process.stdout.write.bind(process.stdout);
    (process.stdout.write as unknown) = (): boolean => true;
    try { return await fn(); } finally { process.stdout.write = orig; }
}

async function judge(response: string, evidences: EvidenceItem[]): Promise<{ prompts: string[]; state: string }> {
    const prompts: string[] = [];
    const v = new ObserverValidator(capturingFactory(prompts), 'm');
    const verdict = await quiet(() => v.validateGrounding(response, evidences));
    return { prompts, state: verdict.state };
}

async function main(): Promise<void> {

console.log('\n=== S322-1 — o caso da validação real: arquivo de 6,5 mil chars com o dado no FIM chega inteiro ao juiz ===');
{
    const file = 'Parágrafo de contexto. '.repeat(280) + '\n- Pico da rede de 127 V RMS: 179,6 V.';
    const { prompts, state } = await judge('O pico de 127 V RMS é 179,6 V.', [{ id: 'E1', tool: 'read', input: '{"path":"notas_aula.md"}', output: file }]);
    const prompt = prompts[0] ?? '';
    assert(file.length > 6000, 'pré-condição: evidência acima do antigo corte de 2000', file.length);
    assert(prompt.includes('179,6 V.') && prompt.includes(file), 'o texto inteiro da evidência, inclusive o fim, está no prompt do juiz');
    assert(!/TRUNCAD|trecho: primeiros/.test(prompt), 'nenhuma marca de corte: nada foi cortado');
    assert(state === 'VALIDATED', 'veredito normal', state);
}

console.log('\n=== S322-2 — args (ex.: conteúdo gravado por write) também entram inteiros ===');
{
    const content = 'linha do resumo\n'.repeat(400);
    const input = JSON.stringify({ path: 'resumo.md', content });
    const { prompts } = await judge('O resumo foi gravado.', [{ id: 'E1', tool: 'write', input, output: 'Criado: resumo.md' }]);
    assert(input.length > 200 && (prompts[0] ?? '').includes(input), 'args de 6 mil chars no prompt (antes: 200)', input.length);
    assert(!/ARGS TRUNCADOS/.test(prompts[0] ?? ''), 'sem marca de args truncados');
}

console.log('\n=== S322-3 — evidência acima do teto: NÃO é cortada e NÃO é julgada — UNVALIDATED, o juiz nem é chamado ===');
{
    const evidences: EvidenceItem[] = [
        { id: 'E1', tool: 'read', output: 'A'.repeat(50_000) },
        { id: 'E2', tool: 'web_search', output: 'B'.repeat(40_000) },
        { id: 'E3', tool: 'weather', output: 'pequena evidência intacta' },
    ];
    const { prompts, state } = await judge('Resposta curta.', evidences);
    assert(prompts.length === 0, 'o modelo não é chamado com um pedaço da evidência (antes: cortava as maiores por igual)', prompts.length);
    assert(state === 'UNVALIDATED', 'conjunto que não cabe → UNVALIDATED (não autoriza entrega; nunca um veredito sobre um pedaço)', state);
}

console.log('\n=== S322-4 — no limite: o que cabe inteiro é julgado inteiro (o prompt nunca passa do teto) ===');
{
    const { prompts, state } = await judge('r', [{ id: 'E1', tool: 'read', output: 'x'.repeat(30_000) }]);
    assert(prompts.length === 1 && prompts[0].length <= MAX_PROMPT && prompts[0].includes('x'.repeat(30_000)), `evidência de 30 mil chars entra inteira (prompt de ${prompts[0]?.length ?? 0} ≤ ${MAX_PROMPT})`);
    assert(state !== 'UNVALIDATED', 'e há julgamento', state);
}

console.log('\n=== S322-5 — a resposta nunca é cortada: acima do teto continua UNVALIDATED ===');
{
    const { prompts, state } = await judge('r'.repeat(70_000), [{ id: 'E1', tool: 'read', output: 'x' }]);
    assert(state === 'UNVALIDATED', 'resposta de 70 mil chars → UNVALIDATED (não julga um prefixo)', state);
    assert(prompts.length === 0, 'o modelo não foi chamado com a resposta cortada', prompts.length);
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S322 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;
}

main().catch((err) => { console.error('S322 erro inesperado:', err); process.exitCode = 1; });
