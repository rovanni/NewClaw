/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S390 (Campanha 2 — Sprint J3)
 *
 * Incidente real (12/10/2026 07:46):
 * Quando o objetivo do usuário ("E meus e-mails alguma novidade?") expirou após 33 minutos,
 * a mensagem final de falha exibida foi:
 * "O que faltou: A resposta da etapa 'SKILL gmail-himalaya §0.4...' trazia afirmações que os dados coletados não confirmaram."
 *
 * Problema:
 * O estado que causou os repetidos bloqueios foi UNVALIDATED (timeout de 205s do juiz) e,
 * na tentativa final, NOT_EVALUABLE (o juiz não tinha como avaliar a semântica da flag '*'
 * porque a skill não a documentava).
 * Ao tratar NOT_EVALUABLE no mesmo saco de NOT_SUPPORTED, a mensagem afirmava categoricamente
 * que a resposta continha informações que os dados "não confirmaram", quando na verdade
 * as evidências coletadas não foram suficientes para avaliar as inferências da resposta.
 *
 * Correção J3:
 * O `GoalExecutionLoop` constrói o `userSummary` e as `suggestedActions` do blocker distinguindo:
 * 1. UNVALIDATED: Não foi possível verificar a tempo contra os dados coletados.
 * 2. NOT_EVALUABLE: Evidências coletadas não foram suficientes para confirmar os detalhes.
 * 3. NOT_SUPPORTED: Resposta trazia afirmações que os dados contradizem ou não sustentam.
 *
 * Execução: npx ts-node src/__tests__/regression/S390_GoalExecutionLoop_BlockerUserSummaryDifferentiatesUnvalidatedAndNotEvaluable.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

const goalLoopPath = path.join(process.cwd(), 'src', 'loop', 'GoalExecutionLoop.ts');
const goalLoopSource = fs.readFileSync(goalLoopPath, 'utf-8');

async function main(): Promise<void> {
    console.log('\n=== S390-1 — Distinção de NOT_EVALUABLE vs UNVALIDATED vs NOT_SUPPORTED no blocker ===');
    {
        const blockStart = goalLoopSource.indexOf("kind: 'grounding_blocked'");
        assert(blockStart > -1, 'GoalExecutionLoop constrói estrutura GoalBlocker para grounding_blocked');

        const blockSnippet = goalLoopSource.slice(blockStart, blockStart + 1500);

        assert(/userSummary:\s*block\.state === 'UNVALIDATED'/.test(blockSnippet),
            'userSummary possui ramo para UNVALIDATED');

        assert(/block\.state === 'NOT_EVALUABLE'/.test(blockSnippet),
            'userSummary possui ramo específico para NOT_EVALUABLE');

        assert(/não foram suficientes para confirmar os detalhes da resposta/.test(blockSnippet),
            'mensagem para NOT_EVALUABLE explica honestamente insuficiência de evidência sem acusar falsidade');

        assert(/suggestedActions:/.test(blockSnippet) &&
               /--json/.test(blockSnippet),
            'suggestedActions para NOT_EVALUABLE recomenda obter saída estruturada (--json) ou reduzir inferências');
    }

    console.log(`\nResultado: ${passed} passaram, ${failed} falharam.`);
    if (failed > 0) process.exit(1);
}

main().catch(err => {
    console.error('Erro inesperado no teste S390:', err);
    process.exit(1);
});
