/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S407
 * A dica que o goal acrescenta a um passo depois de um bloqueio ([VERIFICAÇÃO — …] do juiz de grounding, [ATENÇÃO — …] do
 * validador do passo) chega INTEIRA ao retry e ao juiz do passo — nunca partida no meio (Informação Completa para Decidir).
 *
 * ORIGEM (Telegram, 15/10/2026): o juiz do passo comentou "a intenção do passo está truncada no meio da marcação
 * [VERIFICAÇÃO], impedindo conhecer o restante dos requisitos" — a descrição montada era cortada em 1.200 chars e terminava
 * em "(os dados coletados contradizem — na". O aviso irmão cortava o motivo do validador em 120 chars ("…mas os fatos do
 * sistema regist") e a descrição inteira em 500 — num passo de descrição longa o aviso sumia.
 *
 * REGRESSÃO SE: qualquer das duas dicas voltar a ser cortada.
 *
 * Execução: npx ts-node src/__tests__/regression/S407_DicaDoRetry_Inteira.test.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { GoalExecutionLoop } from '../../loop/GoalExecutionLoop';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}

console.log('\n=== S407-1 — [VERIFICAÇÃO — …] com 5 afirmações e o trecho de cada fonte chega inteira ===');
{
    const loop = Object.create(GoalExecutionLoop.prototype) as any;
    let plano: Array<{ id: string; description: string }> = [];
    loop.recordFailedAttempt = () => {};
    loop.goalStore = { update: (_id: string, patch: { currentPlan: typeof plano }) => { plano = patch.currentPlan; } };
    const descricao = 'Com base nas duas pesquisas, estruture o conteúdo didático da aula sobre sistemas de armazenamento secundário: ' +
        'HD mecânico (CMR e SMR), SSD SATA, SSD NVMe, eMMC, UFS, cartões SD, pendrive USB e fita LTO, com analogias e uma atividade prática.';
    const step = { id: 'step_3', description: descricao, toolName: undefined };
    const goal = { id: 'g1', retryBudget: 3, replanBudget: 5, expiresAt: Date.now() + 3_600_000, currentPlan: [step] };
    const afirmacao = (n: number) => ({
        claim: `Afirmação ${n}: NVMe Gen${n} chega a ${n} mil MB/s de leitura sequencial, e isso aparece na tabela comparativa dos slides 4 e 5 da aula ${'x'.repeat(60)}`,
        verdict: n % 2 ? 'NOT_SUPPORTED' : 'NOT_EVALUABLE',
        trecho: `fonte ${n}: SATA III limita a cerca de 550 MB/s; NVMe PCIe 3.0 x4 chega a ~3.500 MB/s ${'y'.repeat(60)}`,
    });
    loop.handleGroundingBlock(goal, step, 1, Date.now(), { state: 'REJECTED', unconfirmedClaims: [1, 2, 3, 4, 5].map(afirmacao) });
    const nova = plano.find(s => s.id === 'step_3')?.description ?? '';
    assert(nova.startsWith(descricao), 'a intenção original continua inteira no começo');
    for (const n of [1, 2, 3, 4, 5]) assert(nova.includes(`fonte ${n}:`), `o trecho da fonte da afirmação ${n} está presente`);
    assert(nova.endsWith('mostrando o valor original.]'), 'a dica termina na frase final e fecha o colchete — nada partido no meio', nova.slice(-120));
    assert(nova.length > 1200, `a dica completa passa do antigo teto de 1.200 chars (${nova.length}) — e chega toda`);
}

console.log('\n=== S407-2 — [ATENÇÃO — …] leva o motivo inteiro do validador, sem cortar a descrição ===');
{
    const src = fs.readFileSync(path.join(__dirname, '../../loop/GoalExecutionLoop.ts'), 'utf-8');
    const linha = src.split('\n').find(l => l.includes('const mismatchHint = ')) ?? '';
    assert(/\$\{semanticValidation\.reason \?\? 'mismatch'\}/.test(linha) && !/reason[^}]*\.slice\(/.test(linha), 'o motivo do validador entra inteiro na dica', linha.trim());
    assert(/description: s\.description \+ mismatchHint \}/.test(src), 'descrição + dica sem corte (antes: .slice(0, 500), que podia apagar a dica inteira)');
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S407 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
process.exit(failed > 0 ? 1 : 0);
