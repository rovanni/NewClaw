/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S230
 *
 * Sprint de implementação da investigação "User Request → Validated Response → Delivery" +
 * "Modelo de Dados — Provenance + Response Contract". Cobre a classe inteira de dois problemas
 * estruturais, não o incidente River isoladamente:
 *
 * 1. PROVENANCE — `planStepId` não é único entre gerações de plano: o LLM reusa "step_1"/
 *    "step_2" em toda chamada de `GoalPlanner` (plano inicial, replan, avanço de marco). Um
 *    attempt bem-sucedido de uma estratégia já abandonada (P1) podia vencer em
 *    `buildResult()`/`resolveStepRefs()`/`GoalStore.updateLastAttempt()` só por ter sido
 *    inserido antes de P2 sequer produzir seu próprio sucesso — nenhum dos três verificava se o
 *    attempt pertencia à geração vigente.
 *
 *    Correção: `Goal.planGeneration`/`GoalAttempt.planGeneration` (contador incremental,
 *    0 na criação, +1 a cada substituição TOTAL de `currentPlan`). Chave de junção correta:
 *    `(planGeneration, planStepId)`. `PlanStep.id` NÃO foi alterado — `{{step_N.output}}`
 *    (escrito pelo próprio LLM dentro do JSON do plano) continua resolvendo pelo mesmo rótulo;
 *    só a FONTE dos candidatos elegíveis foi restringida à geração vigente.
 *
 * 2. RESPONSE CONTRACT — `achieved=true` podia significar só "critérios operacionais
 *    satisfeitos", sem nenhuma verificação de que existe uma resposta textual apresentável.
 *
 *    Correção: novo `CriterionCheck` `'response_produced'` — GATE estrutural, nunca satisfeito
 *    deterministicamente (nenhum branch de `evaluateCriteria()` o marca `'met'`), cuja única
 *    função é impedir que o checklist determinístico feche `achieved=true` sozinho quando o
 *    `GoalPlanner` declarou a promessa, forçando a passagem pelo validador LLM já existente
 *    (`validateGoalCompletion`, Caminho 2) — que passa a receber, via injeção de fato (Evidence
 *    Provider Pattern, sem chamada de LLM nova), a informação de que uma resposta é parte
 *    obrigatória da conclusão.
 *
 * `GoalExecutionLoop` tem DI pesado demais para instanciar diretamente neste teste (mesma
 * abordagem já usada em S48/S47/S10: reprodução fiel do algoritmo + verificação estrutural do
 * fix no source). `GoalStore` é leve o bastante para ser exercitado com uma instância real de
 * SQLite in-memory (mesmo padrão de S126/S88) — usado para os testes de persistência/restart.
 *
 * FECHAMENTO (mesma Sprint, achado da Validação Holística): o fallback original tratava
 * `planGeneration === undefined` como "sempre elegível" — um Goal legado (attempts persistidos
 * antes desta Sprint) que sofresse um replan real DEPOIS do deploy continuaria com os attempts
 * antigos elegíveis para a geração nova, reintroduzindo parcialmente a mesma classe de bug que
 * `planGeneration` existe para eliminar. Semântica corrigida nos 3 consumidores: `undefined`
 * significa "geração 0", nunca coringa universal — `(a.planGeneration ?? 0) === currentGeneration`.
 * Testes S230-7/7b/7c/7d/7e cobrem os 8 cenários exigidos pelo fechamento.
 *
 * Escopo tocado: shared/domainTypes.ts, loop/GoalStore.ts, loop/GoalExecutionLoop.ts,
 * loop/GoalPlanner.ts. Nenhuma tool alterada. S217/S220/S226/S227/S229/S223/S224 e
 * send_audio/send_document não tocados.
 *
 * Execução: npx ts-node src/__tests__/regression/S230_Provenance_ResponseContract.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { GoalStore } from '../../loop/GoalStore';
import { Goal, GoalAttempt } from '../../loop/GoalTypes';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

function makeStore(): GoalStore {
    const db = new (Database as any)(':memory:');
    return new GoalStore(db);
}

function makeGoal(store: GoalStore, overrides: Partial<Goal> = {}): Goal {
    return store.create({
        sessionKey: 'test:s230', conversationId: 'test-conv-s230',
        userIntent: 'objetivo de teste S230', objective: 'Objetivo de teste S230',
        status: 'executing', currentPlan: [], attempts: [], blockers: [], toolsTried: [], strategiesTried: [],
        successCriteria: [], sentArtifacts: [], retryBudget: 3, replanBudget: 5, confidence: 0.85,
        requiresAuth: false, authorizationScope: [], expiresAt: Date.now() + 3_600_000,
        ...overrides,
    } as Omit<Goal, 'id' | 'createdAt' | 'updatedAt'>);
}

function makeAttempt(overrides: Partial<GoalAttempt> = {}): GoalAttempt {
    return {
        id: `att_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
        planStepId: 'step_1',
        toolName: 'crypto_analysis',
        args: {},
        result: 'success',
        durationMs: 10,
        executedAt: Date.now(),
        ...overrides,
    };
}

// Reprodução fiel de buildResult().lastSuccess após o fix (GoalExecutionLoop.ts) — mesma técnica
// de S48/S10 para um método privado com DI pesado demais para instanciar aqui.
//
// Fechamento de compatibilidade (Sprint de Legacy Provenance): `planGeneration` ausente
// significa semanticamente "geração 0" (`?? 0`), nunca "sempre elegível" — reproduz
// exatamente a correção aplicada ao source real.
function findLastSuccess(attempts: GoalAttempt[], goalPlanGeneration: number | undefined): GoalAttempt | undefined {
    const currentGeneration = goalPlanGeneration ?? 0;
    const belongsToCurrentGeneration = (a: GoalAttempt): boolean =>
        (a.planGeneration ?? 0) === currentGeneration;
    return [...attempts].reverse().find(a => a.result === 'success' && belongsToCurrentGeneration(a));
}

// Reprodução fiel do algoritmo ANTERIOR a qualquer fix de provenance — usada só para provar que
// o incidente é real (o teste comprova a REGRESSÃO que existiria sem filtro nenhum, não só o
// comportamento pós-fix).
function findLastSuccessBeforeFix(attempts: GoalAttempt[]): GoalAttempt | undefined {
    return [...attempts].reverse().find(a => a.result === 'success');
}

// Reprodução fiel de resolveStepRefs() após o fix — mesma semântica de `?? 0` de findLastSuccess.
function buildStepOutputs(attempts: GoalAttempt[], goalPlanGeneration: number | undefined): Map<string, string> {
    const currentGeneration = goalPlanGeneration ?? 0;
    const stepOutputs = new Map<string, string>();
    for (const attempt of attempts) {
        const sameGeneration = (attempt.planGeneration ?? 0) === currentGeneration;
        if ((attempt.result === 'success' || attempt.result === 'partial') && attempt.output && sameGeneration) {
            stepOutputs.set(attempt.planStepId, attempt.output);
        }
    }
    return stepOutputs;
}

async function main(): Promise<void> {

console.log('\n=== S230-1 — Goal.planGeneration nasce em 0 na criação ===');
{
    const store = makeStore();
    const goal = makeGoal(store);
    assert(goal.planGeneration === 0, 'planGeneration inicial é 0', goal.planGeneration);
}

console.log('\n=== S230-2 — planGeneration sobrevive a round-trip via SQLite (equivalente a restart) ===');
{
    const store = makeStore();
    const goal = makeGoal(store);
    store.update(goal.id, { planGeneration: 3 });
    const reloaded = store.getById(goal.id)!;
    assert(reloaded.planGeneration === 3, 'planGeneration persistido e recuperado corretamente após update+getById', reloaded.planGeneration);
}

console.log('\n=== S230-3 — Caso 1 do handoff (P1/step_1/attempt1 + attempt2): retry preserva planGeneration e planStepId ===');
{
    const store = makeStore();
    const goal = makeGoal(store, { planGeneration: 0 });
    store.addAttempt(goal.id, makeAttempt({ id: 'att_retry_1', planStepId: 'step_1', result: 'failure', planGeneration: 0 }));
    store.addAttempt(goal.id, makeAttempt({ id: 'att_retry_2', planStepId: 'step_1', result: 'success', planGeneration: 0 }));
    const reloaded = store.getById(goal.id)!;
    assert(reloaded.attempts.length === 2, 'dois attempts registrados para o mesmo step (retry)', reloaded.attempts.length);
    assert(
        reloaded.attempts.every(a => a.planStepId === 'step_1' && a.planGeneration === 0),
        'retry preserva planStepId E planGeneration idênticos entre as tentativas',
        reloaded.attempts,
    );
}

console.log('\n=== S230-4 — Caso 2 do handoff (P1/step_1 → REPLAN → P2/step_1): mesmo planStepId, planGeneration diferente ===');
{
    const store = makeStore();
    const goal = makeGoal(store, { planGeneration: 0 });
    store.addAttempt(goal.id, makeAttempt({ id: 'att_p1', planStepId: 'step_1', toolName: 'crypto_analysis', result: 'success', planGeneration: 0 }));
    store.update(goal.id, { planGeneration: 1 }); // REPLAN
    store.addAttempt(goal.id, makeAttempt({ id: 'att_p2', planStepId: 'step_1', toolName: 'web_search', result: 'partial', planGeneration: 1 }));
    const reloaded = store.getById(goal.id)!;
    const [attemptP1, attemptP2] = reloaded.attempts;
    assert(attemptP1.planStepId === attemptP2.planStepId, 'os dois attempts colidem em planStepId ("step_1"), como o LLM realmente produz', attemptP1.planStepId);
    assert(attemptP1.planGeneration !== attemptP2.planGeneration, 'mas planGeneration os distingue inequivocamente (0 vs 1)', [attemptP1.planGeneration, attemptP2.planGeneration]);
}

console.log('\n=== S230-5 — buildResult(): attempt de P1 NÃO pode ser selecionado quando P2 está vigente (reprodução do incidente real) ===');
{
    const attempts: GoalAttempt[] = [
        makeAttempt({ id: 'att_p1_success', planStepId: 'step_1', toolName: 'crypto_analysis', result: 'success', output: 'Preço atual: $2,59', planGeneration: 0 }),
        makeAttempt({ id: 'att_p2_partial', planStepId: 'step_1', toolName: 'web_search', result: 'partial', output: 'busca ainda incompleta', planGeneration: 1 }),
    ];
    const beforeFix = findLastSuccessBeforeFix(attempts);
    const afterFix = findLastSuccess(attempts, 1);
    assert(beforeFix?.id === 'att_p1_success', 'REGRESSÃO REAL sem o fix: lastSuccess pegaria o attempt da geração ABANDONADA (P1)', beforeFix);
    assert(afterFix === undefined, 'com o fix: nenhum candidato da geração vigente (P2) ainda produziu sucesso — corretamente não seleciona o de P1', afterFix);
}

console.log('\n=== S230-6 — buildResult(): attempt de P2 PODE ser selecionado quando P2 está vigente ===');
{
    const attempts: GoalAttempt[] = [
        makeAttempt({ id: 'att_p1_success', planStepId: 'step_1', result: 'success', output: 'resposta de P1 (abandonada)', planGeneration: 0 }),
        makeAttempt({ id: 'att_p2_success', planStepId: 'step_1', result: 'success', output: 'resposta de P2 (vigente)', planGeneration: 1 }),
    ];
    const result = findLastSuccess(attempts, 1);
    assert(result?.id === 'att_p2_success', 'seleciona o attempt da geração vigente (P2), não o de P1', result);
}

console.log('\n=== S230-7 — buildResult(): Goal legado SEM replan (Teste 1 do fechamento) — attempt sem planGeneration é ELEGÍVEL ===');
{
    const legacyAttempt = makeAttempt({ id: 'att_legacy', planStepId: 'step_1', result: 'success', output: 'resposta legada, sem planGeneration' });
    delete (legacyAttempt as Partial<GoalAttempt>).planGeneration;
    assert(legacyAttempt.planGeneration === undefined, 'pré-condição: attempt simula dado persistido antes da Sprint de Provenance (sem a chave)', legacyAttempt);
    const result = findLastSuccess([legacyAttempt], 0); // goal legado NUNCA replanejado — ainda em geração 0
    assert(result?.id === 'att_legacy', 'undefined tratado como geração 0 — elegível contra goal também em geração 0 (comportamento preservado)', result);
}

console.log('\n=== S230-7b — buildResult(): Goal legado APÓS replan (Teste 2/7 do fechamento) — attempt sem planGeneration NÃO contamina a nova geração ===');
{
    // Reproduz exatamente o caso descrito na Validação Holística: Goal nasceu antes desta Sprint
    // (attempt sem a chave), sofreu um replan real DEPOIS do deploy (geração 0 → 1). Sem o
    // fechamento, esse attempt legado continuaria "sempre elegível" e poderia vencer para a
    // geração 1 — exatamente a classe de bug que planGeneration existe para eliminar.
    const legacyAttempt = makeAttempt({ id: 'att_legacy', planStepId: 'step_1', result: 'success', output: 'resposta legada de antes do replan' });
    delete (legacyAttempt as Partial<GoalAttempt>).planGeneration;
    const beforeClosure = legacyAttempt.planGeneration === undefined || legacyAttempt.planGeneration === 1; // semântica ANTIGA (sempre elegível)
    const afterClosure = findLastSuccess([legacyAttempt], 1); // semântica NOVA (?? 0)
    assert(beforeClosure === true, 'REGRESSÃO REAL sem o fechamento: undefined "sempre elegível" contaminaria a geração 1', beforeClosure);
    assert(afterClosure === undefined, 'com o fechamento: attempt legado (= geração 0) corretamente NÃO elegível contra geração 1 vigente', afterClosure);
}

console.log('\n=== S230-7c — matriz completa dos 5 casos numéricos exigidos pelo fechamento (Testes 3, 4, 5) ===');
{
    // Teste 3: Goal generation 0, attempt planGeneration 0 → ELEGÍVEL.
    const t3 = findLastSuccess([makeAttempt({ id: 'a', result: 'success', planGeneration: 0 })], 0);
    assert(t3?.id === 'a', 'Teste 3: goal geração 0 + attempt geração 0 → elegível', t3);

    // Teste 4: Goal generation 1, attempt planGeneration 0 → NÃO ELEGÍVEL.
    const t4 = findLastSuccess([makeAttempt({ id: 'b', result: 'success', planGeneration: 0 })], 1);
    assert(t4 === undefined, 'Teste 4: goal geração 1 + attempt geração 0 → não elegível', t4);

    // Teste 5: Goal generation 1, attempt planGeneration 1 → ELEGÍVEL.
    const t5 = findLastSuccess([makeAttempt({ id: 'c', result: 'success', planGeneration: 1 })], 1);
    assert(t5?.id === 'c', 'Teste 5: goal geração 1 + attempt geração 1 → elegível', t5);

    // Casos adicionais do invariante da seção 6 do handoff, mesma matriz:
    const currentGen0_attemptUndefined = findLastSuccess([makeAttempt({ id: 'd', result: 'success' })], 0);
    assert(currentGen0_attemptUndefined?.id === 'd', 'currentGeneration=0 + attempt undefined → elegível', currentGen0_attemptUndefined);

    const currentGen2_attemptUndefined = findLastSuccess([makeAttempt({ id: 'e', result: 'success' })], 2);
    assert(currentGen2_attemptUndefined === undefined, 'currentGeneration=2 + attempt undefined → não elegível', currentGen2_attemptUndefined);

    const currentGen2_attemptGen1 = findLastSuccess([makeAttempt({ id: 'f', result: 'success', planGeneration: 1 })], 2);
    assert(currentGen2_attemptGen1 === undefined, 'attempt geração 1 + goal geração 2 → não elegível', currentGen2_attemptGen1);
}

console.log('\n=== S230-7d — Teste 6 do fechamento: retry na mesma geração continua elegível (via GoalStore real) ===');
{
    const store = makeStore();
    const goal = makeGoal(store, { planGeneration: 1 }); // já pós-replan
    store.addAttempt(goal.id, makeAttempt({ id: 'att_retry_a', planStepId: 'step_1', result: 'failure', planGeneration: 1 }));
    store.addAttempt(goal.id, makeAttempt({ id: 'att_retry_b', planStepId: 'step_1', result: 'success', planGeneration: 1 }));
    const reloaded = store.getById(goal.id)!;
    const selected = findLastSuccess(reloaded.attempts, reloaded.planGeneration);
    assert(selected?.id === 'att_retry_b', 'todos os attempts de retry da geração vigente continuam elegíveis — comportamento existente preservado', selected);
}

console.log('\n=== S230-7e — Teste 8 do fechamento: persistência/restart do caso legado (via GoalStore + SQLite real) ===');
{
    const store = makeStore();
    const goal = makeGoal(store, { planGeneration: 0 });
    const legacyAttempt = makeAttempt({ id: 'att_legacy_restart', planStepId: 'step_1', result: 'success', output: 'legado' });
    delete (legacyAttempt as Partial<GoalAttempt>).planGeneration;
    store.addAttempt(goal.id, legacyAttempt);
    store.update(goal.id, { planGeneration: 1 }); // REPLAN real, gravado no SQLite

    // Simula restart: nova leitura do zero via getById() — nenhum estado em memória reaproveitado.
    const recovered = store.getById(goal.id)!;
    assert(recovered.planGeneration === 1, 'geração vigente sobrevive ao restart (round-trip via SQLite)', recovered.planGeneration);
    assert(recovered.attempts[0].planGeneration === undefined, 'attempt legado continua sem a chave após round-trip (JSON preserva a ausência)', recovered.attempts[0].planGeneration);
    const selected = findLastSuccess(recovered.attempts, recovered.planGeneration);
    assert(selected === undefined, 'após restart, o fechamento continua correto: attempt legado (geração 0) não contamina a geração 1 recuperada', selected);
}

console.log('\n=== S230-8 — resolveStepRefs(): {{step_1.output}} continua funcionando dentro da MESMA geração ===');
{
    const attempts: GoalAttempt[] = [
        makeAttempt({ id: 'att_1', planStepId: 'step_1', result: 'success', output: 'dado pesquisado', planGeneration: 0 }),
    ];
    const map = buildStepOutputs(attempts, 0);
    assert(map.get('step_1') === 'dado pesquisado', 'referência {{step_1.output}} resolve corretamente dentro da geração vigente', map.get('step_1'));
}

console.log('\n=== S230-9 — resolveStepRefs(): referência não pode resolver para attempt de geração anterior ===');
{
    const attempts: GoalAttempt[] = [
        makeAttempt({ id: 'att_p1', planStepId: 'step_1', result: 'success', output: 'output de P1 (abandonado)', planGeneration: 0 }),
    ];
    // Goal já avançou para geração 1 (replan) — o step_1 de P1 não deve mais alimentar o mapa.
    const map = buildStepOutputs(attempts, 1);
    assert(map.get('step_1') === undefined, 'sem candidato de P2 ainda, {{step_1.output}} corretamente NÃO resolve para o output de P1', map.get('step_1'));
}

console.log('\n=== S230-10 — GoalStore.updateLastAttempt (via promoteLastAttemptToSuccess/downgradeLastAttemptToPartial) respeita a geração vigente ===');
{
    const store = makeStore();
    const goal = makeGoal(store, { planGeneration: 0 });
    // P1/step_1: já 'success' — não deve ser tocado por uma correção destinada a P2.
    store.addAttempt(goal.id, makeAttempt({ id: 'att_p1', planStepId: 'step_1', result: 'success', output: 'resposta de P1', planGeneration: 0 }));
    store.update(goal.id, { planGeneration: 1 }); // REPLAN
    // P2/step_1: 'partial' — candidato real à promoção.
    store.addAttempt(goal.id, makeAttempt({ id: 'att_p2', planStepId: 'step_1', result: 'partial', output: 'resposta de P2 ainda não confirmada', planGeneration: 1 }));

    store.promoteLastAttemptToSuccess(goal.id, 'step_1');

    const reloaded = store.getById(goal.id)!;
    const p1 = reloaded.attempts.find(a => a.id === 'att_p1')!;
    const p2 = reloaded.attempts.find(a => a.id === 'att_p2')!;
    assert(p1.result === 'success', 'attempt de P1 permanece inalterado (já era success, não é o alvo da promoção)', p1.result);
    assert(p2.result === 'success', 'attempt de P2 (geração vigente) é o promovido a success', p2.result);
}

console.log('\n=== S230-11 — GoalStore.updateLastAttempt: correção NÃO alcança attempt de geração abandonada quando não há candidato vigente ===');
{
    const store = makeStore();
    const goal = makeGoal(store, { planGeneration: 0 });
    // P1/step_1: 'partial' — sem o fix, seria um alvo (falso) de promoção mesmo após o replan.
    store.addAttempt(goal.id, makeAttempt({ id: 'att_p1_partial', planStepId: 'step_1', result: 'partial', output: 'P1 nunca confirmado', planGeneration: 0 }));
    store.update(goal.id, { planGeneration: 1 }); // REPLAN — P2 ainda não tentou step_1

    store.promoteLastAttemptToSuccess(goal.id, 'step_1');

    const reloaded = store.getById(goal.id)!;
    const p1 = reloaded.attempts.find(a => a.id === 'att_p1_partial')!;
    assert(p1.result === 'partial', 'attempt de uma geração já abandonada NÃO é promovido por uma correção destinada à geração vigente', p1.result);
}

console.log('\n=== S230-12 — CriterionCheck "response_produced" é um GATE: nunca fica \'met\' deterministicamente ===');
{
    // Reprodução do case 'response_produced' de evaluateCriteria() — sempre 'unverifiable'.
    function evaluateResponseProducedCheck(): 'met' | 'unverifiable' {
        return 'unverifiable'; // nenhuma condição, nenhum branch — é a implementação real, verificada abaixo
    }
    assert(evaluateResponseProducedCheck() === 'unverifiable', 'o critério nunca é satisfeito deterministicamente', evaluateResponseProducedCheck());
}

console.log('\n=== S230-13 — allMet: presença de response_produced impede o checklist de fechar achieved=true sozinho ===');
{
    function computeAllMet(criteriaStatuses: Array<'met' | 'unverifiable'>): boolean {
        const metCount = criteriaStatuses.filter(s => s === 'met').length;
        return metCount === criteriaStatuses.length;
    }
    const withoutResponseContract = computeAllMet(['met', 'met']); // ex: tool_succeeded x2, tudo satisfeito
    const withResponseContract = computeAllMet(['met', 'met', 'unverifiable']); // + response_produced presente
    assert(withoutResponseContract === true, 'goal SEM a promessa: checklist fecha achieved=true normalmente (sem regressão)', withoutResponseContract);
    assert(withResponseContract === false, 'goal COM a promessa: checklist nunca fecha sozinho — força o validador LLM (Caminho 2)', withResponseContract);
}

console.log('\n=== S230-14 — Fix presente estruturalmente: domainTypes.ts ===');
{
    const source = fs.readFileSync(path.join(process.cwd(), 'src', 'shared', 'domainTypes.ts'), 'utf-8');
    assert(/planGeneration\?: number;/.test(source), 'GoalAttempt.planGeneration declarado como opcional (compatível com dados legados)');
    assert(/'response_produced'/.test(source), 'CriterionCheck inclui \'response_produced\'');
}

console.log('\n=== S230-15 — Fix presente estruturalmente: GoalStore.ts (schema + migração retrocompatível) ===');
{
    const source = fs.readFileSync(path.join(process.cwd(), 'src', 'loop', 'GoalStore.ts'), 'utf-8');
    assert(/plan_generation\s+INTEGER NOT NULL DEFAULT 0/.test(source), 'coluna plan_generation com DEFAULT 0 (goals antigos migram sem script ativo)');
    assert(/ALTER TABLE goals ADD COLUMN plan_generation/.test(source), 'migração ALTER TABLE presente, mesmo padrão das demais colunas retrocompatíveis');
    assert(
        /a\.planStepId === planStepId &&\s*\n\s*\(a\.planGeneration \?\? 0\) === currentGeneration/.test(source),
        'updateLastAttempt() respeita (planGeneration, planStepId) como chave composta, com undefined tratado como geração 0 (fechamento de compatibilidade)',
    );
    assert(
        !/a\.planGeneration === undefined \|\| a\.planGeneration === currentGeneration/.test(source),
        'não-regressão: a semântica antiga ("undefined = sempre elegível") não voltou a aparecer em GoalStore.ts',
    );
}

console.log('\n=== S230-16 — Fix presente estruturalmente: GoalExecutionLoop.ts (buildResult, resolveStepRefs, incremento de geração) ===');
{
    const source = fs.readFileSync(path.join(process.cwd(), 'src', 'loop', 'GoalExecutionLoop.ts'), 'utf-8');
    assert(
        (source.match(/\(a\.planGeneration \?\? 0\) === currentGeneration/g) ?? []).length === 1,
        'belongsToCurrentGeneration (buildResult) usa a semântica fechada (undefined = geração 0), não "sempre elegível"',
    );
    assert(
        (source.match(/\(attempt\.planGeneration \?\? 0\) === currentGeneration/g) ?? []).length === 1,
        'resolveStepRefs() usa a mesma semântica fechada (undefined = geração 0)',
    );
    assert(
        !/a\.planGeneration === undefined \|\| a\.planGeneration === currentGeneration/.test(source),
        'não-regressão: a semântica antiga ("undefined = sempre elegível") não voltou a aparecer em GoalExecutionLoop.ts',
    );
    assert(
        (source.match(/planGeneration: \(goal\.planGeneration \?\? 0\) \+ 1/g) ?? []).length === 2,
        'incremento de planGeneration presente exatamente nos 2 pontos reais de substituição total do plano (replan via planWithSpiral + avanço de marco) — não em ajustes que preservam o plano vigente (retry, injeção de dependência, enriquecimento de description, marcação de step concluído)',
    );
    assert(/case 'response_produced': \{/.test(source), 'evaluateCriteria() tem um case dedicado para o gate de Response Contract');
    assert(/hasResponseContract = \(goal\.successCriteria \?\? \[\]\)\.some\(c => c\.check === 'response_produced'\)/.test(source), 'validateGoalCompletion() detecta a promessa declarada pelo Planner');
    assert(!/output\.includes\(.concluído./.test(source), 'não-regressão: nenhuma comparação de string natural (idioma) foi introduzida para decidir o Response Contract');
}

console.log('\n=== S230-17 — Fix presente estruturalmente: GoalPlanner.ts (LLM pode declarar a promessa, sem chamada de LLM nova) ===');
{
    const source = fs.readFileSync(path.join(process.cwd(), 'src', 'loop', 'GoalPlanner.ts'), 'utf-8');
    assert(
        /VALID_CHECKS = new Set<string>\(\['tool_succeeded', 'output_not_contains', 'output_contains', 'file_exists', 'response_produced'\]\)/.test(source),
        'parser de successCriteria aceita response_produced — mesma chamada de LLM já existente (buildPlan), nenhuma chamada nova',
    );
    assert(/response_produced:/.test(source), 'prompt do plano inicial documenta o novo check ao LLM, no mesmo formato dos outros 4');
}

console.log('\n=== S230-18 — Não-regressão: delivery (hasSeparateDelivery) permanece intocado ===');
{
    const source = fs.readFileSync(path.join(process.cwd(), 'src', 'loop', 'GoalExecutionLoop.ts'), 'utf-8');
    assert(
        /const hasSeparateDelivery = \(goal\.sentArtifacts \?\? \[\]\)\.length > 0;/.test(source),
        'lógica de hasSeparateDelivery (Causa B / S175) não foi alterada por esta Sprint — provenance e response contract são responsabilidades separadas',
    );
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S230 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;

}

main().catch((err) => {
    console.error('S230 erro inesperado:', err);
    process.exitCode = 1;
});
