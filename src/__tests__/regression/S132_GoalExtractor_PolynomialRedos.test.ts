/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S132 (CodeQL alert #56, js/polynomial-redos)
 *
 * Duas regexes em `NOT_GOAL_SIGNALS` (`GoalExtractor.ts`) tinham quantificadores adjacentes
 * disputando o mesmo alfabeto de espaço em branco — ambiguidade de partição que causa
 * backtracking polinomial quando a entrada tem uma sequência longa de whitespace e o resto do
 * padrão nunca casa:
 *
 * 1. `[\w\s]+\s+[eé]...` — `[\w\s]+` já inclui espaço no próprio charset, seguido de outro
 *    `\s+` adjacente. Witness do CodeQL: string começando com muitos `\t`.
 * 2. `sim\s*,?\s*(é|foi)` — dois `\s*` adjacentes ao redor de uma vírgula opcional. Witness do
 *    CodeQL: "sim" + muitas repetições de `' '`.
 *
 * Medido nesta sessão (node -e, fora do teste): em N=40000, a versão antiga de cada regex leva
 * ~1.4-1.6s; a nova (alternância `\w+`/`\s+` sem sobreposição de alfabeto, e charset único
 * `[\s,]*`) leva ~0-1ms — mesmo resultado de match (`false`, não casa), ordem de grandeza
 * diferente de tempo.
 *
 * Execução: npx ts-node src/__tests__/regression/S132_GoalExtractor_PolynomialRedos.test.ts
 */

import { GoalExtractor } from '../../loop/GoalExtractor';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  OK ${message}`); passed++; }
    else { console.error(`  FALHOU: ${message}`, detail ?? ''); failed++; }
}

// quickClassify é privado — GoalExtractor não precisa de LLM real pra esse método (é a
// heurística rápida, síncrona, sem I/O), então um providerFactory fake é suficiente aqui.
function quickClassify(msg: string): boolean | null {
    const extractor = new GoalExtractor({} as any);
    return (extractor as any).quickClassify(msg);
}

function timeMs(fn: () => void): number {
    const start = Date.now();
    fn();
    return Date.now() - start;
}

async function main() {
    const N = 40000;
    const TIMEOUT_MS = 500; // old code leva ~1400-1600ms em N=40000; new leva ~0-1ms

    console.log('\n=== S132.1 — string adversarial (muitos "\\t") não trava mais no padrão [\\w\\s]+\\s+[eé]... ===');
    {
        // quickClassify() faz message.trim() antes de qualquer regex — uma string de whitespace
        // puro (o witness literal do CodeQL) desapareceria inteira no trim(), testando contra ''
        // em vez do padrão adversarial de verdade. Ancorar com um caractere não-whitespace em
        // cada ponta preserva os tabs internos através do trim().
        const adversarial = 'A' + '\t'.repeat(N) + 'A';
        const elapsed = timeMs(() => quickClassify(adversarial));
        assert(elapsed < TIMEOUT_MS, `quickClassify(N=${N} tabs, ancorado) completa em <${TIMEOUT_MS}ms`, `${elapsed}ms`);
    }

    console.log('\n=== S132.2 — string adversarial ("sim" + muitos espaços) não trava mais no padrão sim\\s*,?\\s*(é|foi) ===');
    {
        const adversarial = 'sim' + ' '.repeat(N) + 'x';
        const elapsed = timeMs(() => quickClassify(adversarial));
        assert(elapsed < TIMEOUT_MS, `quickClassify("sim"+N=${N} espaços, ancorado) completa em <${TIMEOUT_MS}ms`, `${elapsed}ms`);
    }

    console.log('\n=== S132.3 — regressão do caminho feliz: os dois padrões ainda casam o que casavam antes ===');
    {
        // Padrão "[curso/disciplina/...] de/sobre/para" — descrição nominal, não é goal.
        const r1 = quickClassify('Assistente de TI e um curso de manutenção de computadores');
        assert(r1 === false, 'frase descritiva "X e um curso de..." ainda é classificada como não-goal', r1);

        // Padrão "sim, é/foi" — confirmação, não é goal.
        const r2 = quickClassify('sim, é isso mesmo');
        assert(r2 === false, '"sim, é isso mesmo" ainda é classificado como não-goal (confirmação)', r2);

        const r3 = quickClassify('sim foi');
        assert(r3 === false, '"sim foi" (sem vírgula) ainda é classificado como não-goal', r3);
    }

    console.log(`\n=== RESULTADO: ${passed} passou, ${failed} falhou ===`);
    if (failed > 0) process.exit(1);
}

main().catch(err => { console.error(err); process.exit(1); });
