/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S322 (issue 051)
 *
 * O juiz de groundedness recebia cada evidência cortada em 2.000 chars (args em 200), um número sem
 * justificativa registrada. Em produção (set-out/2026), 25% das evidências passavam disso e 20 de 55
 * afirmações NOT_EVALUABLE citavam uma evidência cortada. Na validação real da issue 049, um arquivo
 * de 6,5 mil chars com os valores no fim fez o goal falhar após 12 ciclos: o dado estava na evidência,
 * o juiz não o via.
 *
 * Agora a evidência entra inteira; só é cortada se o conjunto não couber no orçamento de entrada do
 * juiz (GROUNDING_MAX_PROMPT_CHARS = 60k), por "water-filling" (corta só os maiores, por igual), e o
 * corte continua marcado. A resposta nunca é cortada. O modo sombra mantém seus limites fixos.
 *
 * REGRESSÃO SE: voltar um corte fixo por evidência; o corte por orçamento deixar o prompt passar do
 * teto ou cortar textos pequenos antes dos grandes; a marca de corte sumir; ou a resposta ser cortada.
 *
 * Execução: npx ts-node src/__tests__/regression/S322_GroundingEvidence_WholeWithinBudget.test.ts
 */
process.env.WORKSPACE_DIR = process.env.WORKSPACE_DIR || 'D:/IA/newclaw/workspace';

import { ObserverValidator, EvidenceItem } from '../../loop/ObserverValidator';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}

const MAX_PROMPT = 60_000;
const MARK = '[EVIDÊNCIA TRUNCADA';
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

async function judge(response: string, evidences: EvidenceItem[]): Promise<{ prompt: string; state: string }> {
    const prompts: string[] = [];
    const v = new ObserverValidator(capturingFactory(prompts), 'm');
    const verdict = await quiet(() => v.validateGrounding(response, evidences));
    return { prompt: prompts[0] ?? '', state: verdict.state };
}

async function main(): Promise<void> {

console.log('\n=== S322-1 — o caso da validação real: arquivo de 6,5 mil chars com o dado no FIM chega inteiro ao juiz ===');
{
    const file = 'Parágrafo de contexto. '.repeat(280) + '\n- Pico da rede de 127 V RMS: 179,6 V.';
    const { prompt, state } = await judge('O pico de 127 V RMS é 179,6 V.', [{ id: 'E1', tool: 'read', input: '{"path":"notas_aula.md"}', output: file }]);
    assert(file.length > 6000, 'pré-condição: evidência acima do antigo corte de 2000', file.length);
    assert(prompt.includes('179,6 V.') && prompt.includes(file), 'o texto inteiro da evidência, inclusive o fim, está no prompt do juiz');
    assert(!prompt.includes(MARK), 'sem marca de corte quando tudo cabe');
    assert(state === 'VALIDATED', 'veredito normal', state);
}

console.log('\n=== S322-2 — args (ex.: conteúdo gravado por write) também entram inteiros ===');
{
    const content = 'linha do resumo\n'.repeat(400);
    const input = JSON.stringify({ path: 'resumo.md', content });
    const { prompt } = await judge('O resumo foi gravado.', [{ id: 'E1', tool: 'write', input, output: 'Criado: resumo.md' }]);
    assert(input.length > 200 && prompt.includes(input), 'args de 6 mil chars no prompt (antes: 200)', input.length);
    assert(!prompt.includes('[ARGS TRUNCADOS]'), 'sem marca de args truncados');
}

console.log('\n=== S322-3 — evidência acima do orçamento: corta só os maiores, por igual, marca o corte e respeita o teto ===');
{
    const small = 'pequena evidência intacta';
    const evidences: EvidenceItem[] = [
        { id: 'E1', tool: 'read', output: 'A'.repeat(50_000) },
        { id: 'E2', tool: 'web_search', output: 'B'.repeat(40_000) },
        { id: 'E3', tool: 'weather', output: small },
    ];
    const { prompt, state } = await judge('Resposta curta.', evidences);
    assert(prompt.length > 0 && prompt.length <= MAX_PROMPT, `prompt dentro do teto (${prompt.length} ≤ ${MAX_PROMPT})`, prompt.length);
    assert(prompt.includes(small), 'a evidência pequena entra inteira (o corte recai sobre as grandes)');
    const a = (prompt.match(/A+/g) ?? []).reduce((m, s) => Math.max(m, s.length), 0);
    const b = (prompt.match(/B+/g) ?? []).reduce((m, s) => Math.max(m, s.length), 0);
    assert(a < 50_000 && b < 40_000 && a === b, `as duas grandes cortadas no MESMO limite (A=${a}, B=${b})`, { a, b });
    assert((prompt.match(/\[EVIDÊNCIA TRUNCADA/g) ?? []).length === 2, 'o corte é marcado nas duas evidências cortadas');
    assert(state === 'VALIDATED', 'julgamento acontece (não vira UNVALIDATED por excesso)', state);
}

console.log('\n=== S322-4 — evidenceCapForBudget: Infinity quando cabe; 0 quando nem a resposta cabe ===');
{
    assert(ObserverValidator.evidenceCapForBudget('r', [{ id: 'E1', tool: 't', output: 'x'.repeat(30_000) }]) === Infinity, 'cabe → Infinity');
    assert(ObserverValidator.evidenceCapForBudget('r'.repeat(70_000), [{ id: 'E1', tool: 't', output: 'x' }]) === 0, 'resposta acima do teto → 0');
    const cap = ObserverValidator.evidenceCapForBudget('r', [{ id: 'E1', tool: 't', output: 'x'.repeat(100_000) }]);
    assert(cap > 50_000 && cap < 60_000, 'uma evidência gigante recebe quase todo o orçamento', cap);
}

console.log('\n=== S322-5 — a resposta nunca é cortada: acima do teto continua UNVALIDATED ===');
{
    const { state } = await judge('r'.repeat(70_000), [{ id: 'E1', tool: 'read', output: 'x' }]);
    assert(state === 'UNVALIDATED', 'resposta maior que o orçamento → UNVALIDATED (sem julgar um prefixo)', state);
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S322 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
    console.error('S322 erro inesperado:', err);
    process.exitCode = 1;
});
