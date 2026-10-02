/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S310 (Campanha A, S-A1/S-A2)
 * Projeção factual do histórico do goal para o replan, em MODO SOMBRA.
 *
 *   1  → sem attempts, ou sem attempts com informação → '' (controle negativo: nada a acrescentar).
 *   2  → caso do incidente de 23/09 (goal_1790214597600_ov9eh): a saída do attempt 7 chega à projeção,
 *        com o caminho tmp/extracao_aulas.txt.
 *   3  → tetos respeitados com 100 attempts (passos, chars por passo, total).
 *   4  → saída enorme: início E fim são preservados (a linha de conclusão costuma ser a última).
 *   5  → função pura: não altera os attempts recebidos.
 *   6  → o bloco é rotulado como dado, sem linguagem imperativa.
 *   7  → estrutura: a projeção só é calculada sob REPLAN_FACTS=on|shadow e só entra em buildReplanPrompt sob `on`
 *        (antes do S-A4 fixava "só sombra"; ver o comentário na seção [7] e S313 [1] para o comportamento).
 *
 * Execução: npx ts-node src/__tests__/regression/S310_GoalPlanner_ReplanFactsShadow_ProjectsAttemptsWithoutChangingPrompt.test.ts
 */
process.env.WORKSPACE_DIR = process.env.WORKSPACE_DIR || 'D:/IA/newclaw/workspace';

import fs from 'fs';
import path from 'path';
import {
    buildAttemptFactsBlock,
    REPLAN_FACTS_MAX_STEPS,
    REPLAN_FACTS_MAX_CHARS_PER_STEP,
    REPLAN_FACTS_MAX_TOTAL_CHARS,
} from '../../loop/GoalPlanner';
import { GoalAttempt } from '../../loop/GoalTypes';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}

function attempt(over: Partial<GoalAttempt>): GoalAttempt {
    return {
        id: 'a', planStepId: 's', toolName: 'exec_command', args: {}, result: 'success',
        durationMs: 1, executedAt: 0, ...over,
    } as GoalAttempt;
}

console.log('\n[1] controle negativo');
assert(buildAttemptFactsBlock([]) === '', 'sem attempts → vazio');
assert(buildAttemptFactsBlock([attempt({ output: '' }), attempt({ output: '   ' })]) === '', 'só saídas vazias → vazio');
assert(buildAttemptFactsBlock([attempt({ result: 'failure', error: '' })]) === '', 'falha sem erro → vazio');

console.log('\n[2] caso do incidente');
const incident: GoalAttempt[] = [
    attempt({ toolName: 'memory_search', args: { query: 'Excel' }, output: 'x'.repeat(300) }),
    attempt({ toolName: 'agentloop', result: 'partial', output: 'resposta parcial' }),
    attempt({ toolName: 'exec_command', args: { command: 'python extrator_aulas.py' }, output: 'Extração concluída: tmp/extracao_aulas.txt (9 arquivos processados)' }),
    attempt({ toolName: 'read', result: 'failure', args: { path: 'aulas_extraidas.md' }, error: 'Arquivo não encontrado: aulas_extraidas.md' }),
];
const incidentBlock = buildAttemptFactsBlock(incident);
assert(incidentBlock.includes('tmp/extracao_aulas.txt'), 'o caminho da saída do attempt 7 chega ao bloco', incidentBlock);
assert(incidentBlock.includes('python extrator_aulas.py'), 'o comando do passo aparece');
assert(incidentBlock.indexOf('Passo 3') < incidentBlock.indexOf('Passo 4'), 'ordem cronológica preservada');

console.log('\n[3] tetos com 100 attempts');
const many = Array.from({ length: 100 }, (_, i) => attempt({ toolName: 'exec_command', args: { command: `cmd ${i}` }, output: `saída ${i} ` + 'y'.repeat(2000) }));
const capped = buildAttemptFactsBlock(many);
assert(capped.length <= REPLAN_FACTS_MAX_TOTAL_CHARS, `total ≤ ${REPLAN_FACTS_MAX_TOTAL_CHARS}`, capped.length);
assert((capped.match(/^Passo /gm) ?? []).length <= REPLAN_FACTS_MAX_STEPS, `≤ ${REPLAN_FACTS_MAX_STEPS} passos`);
assert(capped.includes('Passo 100'), 'os mais recentes têm prioridade');
assert(capped.split('\n').filter(l => l.startsWith('  saída: ')).every(l => l.length <= REPLAN_FACTS_MAX_CHARS_PER_STEP + 10), 'chars por passo respeitados');

console.log('\n[4] saída enorme: início e fim');
const huge = 'INICIO ' + 'z'.repeat(5000) + ' Extração concluída: tmp/final.txt';
const hugeBlock = buildAttemptFactsBlock([attempt({ output: huge })]);
assert(hugeBlock.includes('INICIO') && hugeBlock.includes('tmp/final.txt'), 'início e linha final preservados', hugeBlock);

console.log('\n[5] pureza');
const before = JSON.stringify(incident);
buildAttemptFactsBlock(incident);
assert(JSON.stringify(incident) === before, 'attempts inalterados');

console.log('\n[6] rótulo de dado, sem imperativo');
assert(/não instruções/.test(incidentBlock), 'rotulado como dado observado');
assert(!/\b(use|utilize|não repita|deve|obrigat)/i.test(incidentBlock.split('\n')[0]), 'cabeçalho sem imperativo');

// S-A4 (01/10/2026): esta seção fixava "só sombra" (a projeção só consumida pelo gancho de sombra, nunca argumento de
// buildReplanPrompt). O modo `on` tornou essas duas asserções obsoletas por construção — foram reescritas, não removidas.
// O COMPORTAMENTO da sombra (prompt idêntico, byte a byte, ao de REPLAN_FACTS ausente) é verificado em S313 [1].
console.log('\n[7] estrutura: o bloco só chega ao prompt sob REPLAN_FACTS=on');
const src = fs.readFileSync(path.join(__dirname, '../../loop/GoalPlanner.ts'), 'utf8');
const uses = src.match(/buildAttemptFactsBlock\(/g) ?? [];
assert(uses.length === 2, 'só a definição e UM ponto de uso referenciam a projeção', uses.length);
assert(/factsMode === 'on' \|\| factsMode === 'shadow' \? buildAttemptFactsBlock\(goal\.attempts\) : ''/.test(src), 'a projeção só é calculada sob REPLAN_FACTS=on|shadow');
assert(/factsMode === 'on' \? factsBlock : undefined\)/.test(src), 'só o modo `on` passa a projeção a buildReplanPrompt (a sombra nunca)');

console.log(`\n${passed} passou, ${failed} falhou`);
process.exit(failed === 0 ? 0 : 1);
