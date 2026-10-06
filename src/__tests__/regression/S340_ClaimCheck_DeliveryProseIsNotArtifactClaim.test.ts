/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S340 (issue 061)
 *
 * `checkClaimsAgainstEvidence` passava regex na prosa do validador: "foi enviado/entregue" → exigia send_document.
 * O validador escreve "a resposta foi entregue" sobre TEXTO; a regex lia como envio de ARQUIVO e derrubava a
 * aprovação. Produção (newclaw-audit.log): 5 overrides em goals que não pediam arquivo — q7r69 expirou, a0mxc falhou
 * após 12 ciclos, yifr9 gerou e enviou um .md não pedido —, 0 verdadeiros; ao vivo em 06/10: p5ood e o2k8y.
 * A regra foi removida: entrega prevista pelo plano é cobrada por critério estrutural.
 *
 * REGRESSÃO SE: prosa "foi entregue/enviado" voltar a derrubar uma aprovação sem arquivo pedido; OU um plano com
 * send_document não entregue passar a fechar achieved=true (a cobertura estrutural deixar de valer).
 *
 * Execução: npx ts-node src/__tests__/regression/S340_ClaimCheck_DeliveryProseIsNotArtifactClaim.test.ts
 */
import Database from 'better-sqlite3';
import { GoalExecutionLoop } from '../../loop/GoalExecutionLoop';
import { GoalStore } from '../../loop/GoalStore';
import { ToolRegistry } from '../../core/ToolRegistry';
import { Goal } from '../../loop/GoalTypes';
import { ensureDeliverySuccessCriteria } from '../../loop/planning/ensureDeliverySuccessCriteria';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}
const emptyState = () => ({ cognitiveContext: { failedStrategies: [], discoveries: [] }, progressModel: null });
function makeLoop(summary: string): { loop: GoalExecutionLoop; store: GoalStore; llmCalls: () => number } {
    let calls = 0;
    const db = new (Database as any)(':memory:');
    const store = new GoalStore(db);
    const pf = { chatWithFallback: async () => { calls++; return { status: 'success', content: JSON.stringify({ achieved: true, summary }) }; } } as any;
    const loop = new GoalExecutionLoop({} as any, store, {} as any, {} as any, ToolRegistry, pf, { getDatabase: () => db } as any, {} as any);
    return { loop, store, llmCalls: () => calls };
}
function makeGoal(store: GoalStore, o: Partial<Goal>): Goal {
    return store.create({
        sessionKey: 'test:s340', conversationId: 'conv-s340', userIntent: 'Quantos itens tem a lista do anexo?',
        objective: 'Contar itens', status: 'executing', currentPlan: [], attempts: [], blockers: [], toolsTried: [],
        strategiesTried: [], successCriteria: [], sentArtifacts: [], retryBudget: 3, replanBudget: 5, confidence: 0.9,
        requiresAuth: false, authorizationScope: [], expiresAt: Date.now() + 3_600_000, ...o,
    } as Omit<Goal, 'id' | 'createdAt' | 'updatedAt'>);
}
const agentAnswer = { id: 'a1', planStepId: 'step_2', toolName: 'agentloop', args: {}, result: 'success', output: '3', durationMs: 5, executedAt: Date.now() } as any;

async function main(): Promise<void> {
    console.log('\n=== S340-1 — prosa de entrega de TEXTO não derruba a aprovação (frases reais do validador) ===');
    for (const summary of [
        'Foi entregue uma explicação clara e detalhada sobre o conceito de scaffolding.',   // 4tvad
        'O número de itens (3) foi contado e a resposta foi enviada ao usuário.',            // p5ood / o2k8y
        'A cotação foi obtida e o valor convertido foi entregue ao usuário.',               // yifr9
    ]) {
        const { loop, store } = makeLoop(summary);
        const goal = makeGoal(store, { attempts: [agentAnswer] });
        const r = await (loop as any).validateGoalCompletion(goal, undefined, emptyState());
        assert(r.achieved === true, `"${summary.slice(0, 60)}…" → achieved=true mantido`, r);
    }

    console.log('\n=== S340-2 — cobertura estrutural da entrega prevista continua valendo ===');
    {
        const plan = [{ id: 's1', description: 'gerar', status: 'completed', toolName: 'write' }, { id: 's2', description: 'enviar', status: 'completed', toolName: 'send_document' }] as any[];
        const criteria = ensureDeliverySuccessCriteria(plan, []);
        assert(criteria.some(c => c.check === 'tool_succeeded' && c.tool === 'send_document'), 'plano com send_document → critério tool_succeeded(send_document) injetado');
        const { loop, store } = makeLoop('O relatório foi gerado e enviado ao usuário.');
        const goal = makeGoal(store, { userIntent: 'Gere o relatório em PDF e me envie', currentPlan: plan, successCriteria: criteria, attempts: [agentAnswer] });
        const r = await (loop as any).validateGoalCompletion(goal, undefined, emptyState());
        assert(r.achieved === false, 'send_document previsto e nunca executado → achieved=false mesmo com o validador dizendo "enviado"', r);
    }

    console.log('\n=== S340-3 — as outras regras de alegação não foram tocadas ===');
    {
        const src = require('fs').readFileSync(require('path').join(process.cwd(), 'src', 'loop', 'GoalExecutionLoop.ts'), 'utf-8') as string;
        for (const label of ['apresentação/listagem de dados reais', 'exportação ou conversão', 'organização de arquivos', 'criação ou geração de artefato']) {
            assert(src.includes(`label: '${label}'`), `regra "${label}" continua presente`);
        }
        assert(!src.includes(`label: 'envio de artefato'`), 'regra "envio de artefato" removida');
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S340 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    if (failed > 0) process.exitCode = 1;
}
main().catch((err) => { console.error('S340 erro inesperado:', err); process.exitCode = 1; });
