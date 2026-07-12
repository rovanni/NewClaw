/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S73
 *
 * Investigação (08/07/2026, log real — segunda parte da mesma sessão do S72):
 * usuário pediu áudio sobre cripto (funcionou, ver S72), e dois minutos depois pediu
 * "Consegue me enviar o texto que gerou o áudio para eu analisar?". O goal falhou
 * após 4 tentativas (memory_search, exec_command, read, exec_command, memory_search)
 * e a resposta final entregue no Telegram (2319 caracteres) foi:
 *
 *   "Não consegui completar: [...] Tentei: memory_search: Buscar na memória o
 *   contexto da última geração de áudio para identificar o texto — Step 'Buscar na
 *   memória o contexto da última geração de áudio para identificar o, Buscar na
 *   memória o contexto [...] [ATENÇÃO — tentativa anterior com memory_search
 *   retornou output irrelevante: O output descreve a arquitetura [...] Último
 *   bloqueio: Step 'Buscar na memória o conteúdo exato do texto utilizado na
 *   última geração de áudio via send_audio. [AT' retornou output irrelevante [...]"
 *
 * Causa raiz: GoalEvaluator.buildFailureExplanation() (linha ~402) montava o trecho
 * "Tentei: ..." juntando goal.strategiesTried — um campo INTERNO (GoalTypes.ts:155,
 * "descrições de estratégias tentadas") alimentado por
 * GoalExecutionLoop.recordFailedStrategy(), que por sua vez usa
 * pendingStep.description já enriquecida com o mismatchHint de replanning
 * (GoalExecutionLoop.ts ~1007: "[ATENÇÃO — tentativa anterior com X retornou output
 * irrelevante: ... Use abordagem diferente que retorne especificamente o que o
 * objetivo pede.]") — texto escrito para o PRÓXIMO ciclo do LLM replanejador
 * consumir, nunca para o usuário final ler. Cada entrada de strategiesTried é uma
 * descrição de step truncada a 200 chars carregando esse jargão interno; juntá-las
 * com goal.strategiesTried.join(', ') despejava tudo isso, cru, na resposta final.
 *
 * goal.toolsTried (GoalTypes.ts:154) já existe e é exatamente o dado certo pra esse
 * uso: um array deduplicado de nomes de ferramenta simples (GoalStore.addToolTried),
 * sem nenhuma descrição, sem hints de replanning.
 *
 * Fix: buildFailureExplanation() troca goal.strategiesTried → goal.toolsTried no
 * trecho "Tentei: ...". Não foi criada nenhuma sanitização/regex nova — apenas
 * reuso do campo que já continha exatamente os dados certos, já existente e já
 * preenchido em paralelo por todo goal.
 *
 * Escopo tocado: loop/GoalEvaluator.ts (1 linha).
 *
 * Execução: npx ts-node src/__tests__/regression/S73_GoalEvaluator_StrategiesTriedLeak.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { GoalEvaluator } from '../../loop/GoalEvaluator';
import { Goal } from '../../loop/GoalTypes';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

/** Reproduz o goal real do incidente (campos reduzidos ao necessário para o teste). */
function makeIncidentGoal(): Goal {
    const now = Date.now();
    return {
        id: 'goal_1783564226291_eul84',
        sessionKey: 'telegram:8071707790',
        conversationId: '8071707790',
        userIntent: 'Consegue me enviar o texto que gerou o áudio para eu analisar?',
        objective: 'Recuperar e enviar ao usuário o texto usado na última geração de áudio.',
        status: 'failed',
        currentPlan: [],
        attempts: [],
        blockers: [{
            kind: 'semantic_mismatch',
            toolName: 'memory_search',
            // Reproduz o que GoalExecutionLoop.ts (~linha 1036) monta hoje, JÁ COM o fix
            // (split(' [ATENÇÃO —')[0] antes do slice) — a base é o step description real do
            // incidente, sem o hint de replanning embutido, então o corte em 100 chars não cai
            // no meio do marcador "[ATENÇÃO —" (bug corrigido nesta mesma sessão).
            description:
                "Step 'Buscar na memória o conteúdo exato do texto utilizado na última geração de áudio via send_audio.' " +
                "retornou output irrelevante após 2 tentativas: O output retornou preferências de formatação e lembretes de reuniões, " +
                "não fornecendo o texto utilizado na última geração de áudio.",
            suggestedActions: [],
            detectedAt: now,
        }],
        toolsTried: ['memory_search', 'exec_command', 'read'],
        // Reproduz literalmente o formato real de recordFailedStrategy() + mismatchHint —
        // cada entrada é "tool: descrição_do_step — motivo", com o hint de replanning
        // embutido dentro da descrição do step nas tentativas subsequentes ao mesmo step.
        strategiesTried: [
            "memory_search: Buscar na memória o contexto da última geração de áudio para identificar o texto " +
                "— Step 'Buscar na memória o contexto da última geração de áudio para identificar o, Buscar na " +
                "memória o contexto da última geração de áudio para identificar o texto utilizado [ATENÇÃO — " +
                "tentativa anterior com memory_search retornou output irrelevante: O output descreve a arquitetura",
            "exec_command: Buscar e exibir o conteúdo dos arquivos de texto (.txt, .md) mais recentes no wo " +
                "— Step 'Buscar e exibir o conteúdo dos arquivos de texto (.txt, .md) mais recentes, Buscar e " +
                "exibir o conteúdo dos arquivos de texto (.txt, .md) mais recentes no workspace, que provavelmente " +
                "contêm o texto da última geração de áudio [ATENÇÃO — tentativa anterior com exec_command reto",
        ],
        successCriteria: [],
        retryBudget: 0,
        replanBudget: 0,
        confidence: 0.2,
        requiresAuth: false,
        authorizationScope: [],
        createdAt: now,
        updatedAt: now,
        expiresAt: now + 3600_000,
    };
}

async function main(): Promise<void> {

console.log('\n=== S73-1 [runtime — reprodução do incidente real] — buildFailureExplanation NÃO vaza jargão interno de replanning ===');
{
    const evaluator = new GoalEvaluator();
    const goal = makeIncidentGoal();
    const explanation = evaluator.buildFailureExplanation(goal);

    assert(!explanation.includes('[ATENÇÃO —'), 'resposta ao usuário não contém o marcador interno "[ATENÇÃO —" (hint de replanning)', explanation);
    assert(!explanation.includes('Use abordagem diferente'), 'resposta ao usuário não contém a instrução de replanning voltada ao LLM', explanation);
    assert(explanation.length < 700, `resposta é curta e direta (antes do fix: 2319 chars no incidente real; agora: ${explanation.length} chars)`, explanation);
}

console.log('\n=== S73-1b [estrutural] — GoalExecutionLoop remove o mismatchHint da descrição do step ANTES de truncar (não corta mais no meio do marcador) ===');
{
    // Reproduz exatamente o bug real: quando alreadyHinted=true, pendingStep.description já
    // contém "<base> [ATENÇÃO — ...]" de um ciclo anterior. Sem o fix, slice(0,100) direto
    // nessa string cortava no meio do marcador (ex: "...via send_audio. [AT'"). O fix separa
    // a base do hint (mesma sub-string '[ATENÇÃO —' já usada para alreadyHinted) antes do slice.
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'loop', 'GoalExecutionLoop.ts'), 'utf-8');
    assert(src.includes("cleanStepDesc = pendingStep.description.split(' [ATENÇÃO —')[0]"),
        'GoalExecutionLoop.ts separa a descrição base do hint de replanning antes de qualquer truncamento', null);
    assert(/description: `Step '\$\{cleanStepDesc\.slice\(0, 100\)\}'/.test(src),
        'o blocker.description usa cleanStepDesc (sem o hint), não pendingStep.description bruto, no slice de 100 chars', null);

    // Reproduz a string real do incidente e prova que a extração produz o resultado esperado.
    const rawDescriptionWithHint =
        'Buscar na memória o conteúdo exato do texto utilizado na última geração de áudio via send_audio.' +
        ' [ATENÇÃO — tentativa anterior com memory_search retornou output irrelevante: O output da ferramenta ret. Use abordagem diferente que retorne especificamente o que o objetivo pede.]';
    const cleanStepDesc = rawDescriptionWithHint.split(' [ATENÇÃO —')[0];
    assert(!cleanStepDesc.includes('[ATENÇÃO'), 'a extração remove o hint completo da string de incidente real', cleanStepDesc);
    assert(cleanStepDesc.slice(0, 100) === cleanStepDesc, 'a descrição base real (sem hint) cabe inteira em 100 chars — o slice não corta mais em nenhum lugar', cleanStepDesc);
}

console.log('\n=== S73-2 [runtime] — buildFailureExplanation AINDA informa quais ferramentas foram tentadas (via toolsTried, não strategiesTried) ===');
{
    const evaluator = new GoalEvaluator();
    const goal = makeIncidentGoal();
    const explanation = evaluator.buildFailureExplanation(goal);

    assert(explanation.includes('memory_search') && explanation.includes('exec_command') && explanation.includes('read'),
        'os 3 nomes de ferramenta de goal.toolsTried aparecem na explicação — transparência preservada, só o jargão interno foi removido', explanation);
    assert(explanation.includes(goal.userIntent.slice(0, 50)), 'a intenção original do usuário continua presente na explicação', explanation);
}

console.log('\n=== S73-3 [runtime] — goal sem toolsTried (nenhuma ferramenta chegou a rodar) não quebra e não imprime "Tentei:" vazio ===');
{
    const evaluator = new GoalEvaluator();
    const goal = makeIncidentGoal();
    goal.toolsTried = [];
    const explanation = evaluator.buildFailureExplanation(goal);
    assert(!explanation.includes('Tentei: .'), 'sem toolsTried, o bloco "Tentei:" é omitido em vez de aparecer vazio', explanation);
    assert(explanation.length > 0, 'explicação ainda é gerada normalmente sem toolsTried', explanation);
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S73 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;

}

main().catch((err) => {
    console.error('S73 erro inesperado:', err);
    process.exitCode = 1;
});
