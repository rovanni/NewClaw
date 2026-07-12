/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S21 (Sprint S5.5a do roadmap de aprendizado orientado a objetivos)
 *
 * Prova que GoalExecutionLoop.validateGoalCompletion() não confunde falha TÉCNICA de
 * validação (timeout, exceção, parse inválido) com evidência de que o objetivo do usuário
 * foi atingido. Antes da S5.5a, 2 dos 6 caminhos de retorno faziam `return {achieved:true}`
 * sem nenhuma evidência real, só porque a CHAMADA ao validador falhou — indistinguível de
 * um sucesso genuíno do ponto de vista de goal.status.
 *
 * Caminhos classificados (ver relatório S5.5a):
 *   1. successCriteria all_met, metCount>0        → success COM evidência (inalterado)
 *   2. llmResult.status !== 'success'              → ERA fallback otimista, agora conservador
 *   3. checkClaimsAgainstEvidence rejeita claim     → failure COM evidência (inalterado)
 *   4. parsed.achieved (true/false) via JSON válido → success/failure COM evidência (inalterado)
 *   5. SyntaxError + conteúdo longo (texto livre)   → fallback conservador (já era, precedente)
 *   6. catch-all de exceção não tratada             → ERA fallback otimista, agora conservador
 *
 * validateGoalCompletion é privado — invocado via (loop as any) para testar o código REAL,
 * não uma reimplementação paralela. Dependências pesadas (AgentLoop, GoalPlanner,
 * ReflectionMemory, CaseMemory) não são tocadas por este método — fakes são seguros aqui
 * (confirmado por leitura do código: só usa goalStore/progressModel/providerFactory/fs).
 *
 * Execução: npx ts-node src/__tests__/regression/S21_OutcomeIntegrity_ValidationFallbacks.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { GoalExecutionLoop } from '../../loop/GoalExecutionLoop';
import { GoalStore } from '../../loop/GoalStore';
import { ToolRegistry } from '../../core/ToolRegistry';
import { Goal, SuccessCriterion } from '../../loop/GoalTypes';

// Sprint 0.6, Front A: validateGoalCompletion() passou a receber o GoalExecutionState
// explicitamente (antes era um campo de instância `this.progressModel`). O tipo não é
// exportado por GoalExecutionLoop.ts (de propósito — não é API pública), então o teste
// só precisa do shape em runtime (chamada via `as any`, sem checagem de tipo).
function emptyState(): { cognitiveContext: unknown; progressModel: null } {
    return { cognitiveContext: { failedStrategies: [], discoveries: [] }, progressModel: null };
}

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}
function readSource(relPath: string): string {
    return fs.readFileSync(path.join(process.cwd(), 'src', relPath), 'utf-8');
}

function makeFakeProviderFactory(chatImpl: (...args: unknown[]) => Promise<unknown>) {
    return { chatWithFallback: chatImpl } as unknown as import('../../core/ProviderFactory').ProviderFactory;
}

/** Constrói um GoalExecutionLoop real, mas com dependências não usadas por
 * validateGoalCompletion() substituídas por fakes mínimos (ver docstring do arquivo). */
function makeLoop(providerFactory: import('../../core/ProviderFactory').ProviderFactory): GoalExecutionLoop {
    const db = new (Database as any)(':memory:');
    const goalStore = new GoalStore(db);
    const fakeMemory = { getDatabase: () => db } as any;
    return new GoalExecutionLoop(
        {} as any,        // agentLoop — não usado por validateGoalCompletion
        goalStore,
        {} as any,        // planner — não usado por validateGoalCompletion
        {} as any,        // reflectionMemory — não usado por validateGoalCompletion
        ToolRegistry,
        providerFactory,
        fakeMemory,
        {} as any,        // caseMemory — não usado por validateGoalCompletion
    );
}

function makeGoal(store: GoalStore, overrides: Partial<Goal> = {}): Goal {
    return store.create({
        sessionKey: 'test:user',
        conversationId: 'test-conv',
        userIntent: 'objetivo de teste S21',
        objective: 'Objetivo de teste S21',
        status: 'executing',
        currentPlan: [],
        attempts: [],
        blockers: [],
        toolsTried: [],
        strategiesTried: [],
        successCriteria: [],
        sentArtifacts: [],
        retryBudget: 3,
        replanBudget: 5,
        confidence: 0.9,
        requiresAuth: false,
        authorizationScope: [],
        expiresAt: Date.now() + 3_600_000,
        ...overrides,
    } as Omit<Goal, 'id' | 'createdAt' | 'updatedAt'>);
}

function metCriterion(id: string): SuccessCriterion {
    return { id, description: `critério ${id}`, check: 'tool_succeeded', status: 'met', metAt: Date.now(), evidence: 'evidência real' };
}

async function main() {
    const gelSrc = readSource('loop/GoalExecutionLoop.ts');
    const validateBody = gelSrc.slice(
        gelSrc.indexOf('private async validateGoalCompletion('),
        gelSrc.indexOf('private checkClaimsAgainstEvidence(')
    );

    // ══════════ 1. Critério determinístico atendido → sucesso (sem chamar LLM) ══════════
    console.log('\n=== S21.1 — successCriteria met → achieved=true SEM chamar o LLM de validação ===');
    {
        let llmCalled = false;
        const loop = makeLoop(makeFakeProviderFactory(async () => { llmCalled = true; throw new Error('não deveria ser chamado'); }));
        const store = (loop as any).goalStore as GoalStore;
        const goal = makeGoal(store, { successCriteria: [metCriterion('c1')] });
        const result = await (loop as any).validateGoalCompletion(goal, undefined, emptyState());
        assert(result.achieved === true, 'achieved=true via checklist determinístico');
        assert(llmCalled === false, 'LLM de validação NÃO foi chamado — fast path determinístico evita chamada desnecessária');
    }

    // ══════════ 2/3. LLM confirma com evidência → comportamento preservado ══════════
    console.log('\n=== S21.2/3 — LLM retorna achieved=true válido, sem claim detectável → preservado ===');
    {
        const loop = makeLoop(makeFakeProviderFactory(async () => ({
            status: 'success',
            content: JSON.stringify({ achieved: true, summary: 'Tarefa concluída conforme solicitado.' }),
        })));
        const store = (loop as any).goalStore as GoalStore;
        const goal = makeGoal(store, {});
        const result = await (loop as any).validateGoalCompletion(goal, undefined, emptyState());
        assert(result.achieved === true, 'LLM com JSON válido e sem claim que exija evidência adicional → achieved=true preservado');
    }
    console.log('\n=== S21.2b — LLM confirma claim com evidência operacional real → achieved=true preservado ===');
    {
        const loop = makeLoop(makeFakeProviderFactory(async () => ({
            status: 'success',
            content: JSON.stringify({ achieved: true, summary: 'O arquivo foi enviado ao usuário com sucesso.' }),
        })));
        const store = (loop as any).goalStore as GoalStore;
        const goal = makeGoal(store, {
            attempts: [{ id: 'a1', planStepId: 's1', toolName: 'send_document', args: {}, result: 'success', durationMs: 5, executedAt: Date.now() }],
        });
        const result = await (loop as any).validateGoalCompletion(goal, undefined, emptyState());
        assert(result.achieved === true, 'claim "foi enviado" com attempt real de send_document → evidência satisfeita, achieved=true preservado (checkClaimsAgainstEvidence inalterado)');
    }

    // ══════════ 4. LLM timeout/status!=success → NÃO vira sucesso ══════════
    console.log('\n=== S21.4 — llmResult.status !== \'success\' (timeout) → achieved=false, NÃO achieved=true ===');
    {
        const loop = makeLoop(makeFakeProviderFactory(async () => ({ status: 'timeout', content: '' })));
        const store = (loop as any).goalStore as GoalStore;
        const goal = makeGoal(store, {});
        const result = await (loop as any).validateGoalCompletion(goal, undefined, emptyState());
        assert(result.achieved === false, 'timeout na chamada de validação → achieved=false (ANTES desta Sprint: achieved=true)');
        assert(/[Vv]alidação técnica indisponível/.test(result.reason ?? ''), `reason distingue falha técnica (obtido: "${result.reason}")`);
    }

    // ══════════ 5. LLM exception → NÃO vira sucesso ══════════
    console.log('\n=== S21.5 — chatWithFallback lança exceção → achieved=false, NÃO achieved=true ===');
    {
        const loop = makeLoop(makeFakeProviderFactory(async () => { throw new Error('network exploded'); }));
        const store = (loop as any).goalStore as GoalStore;
        const goal = makeGoal(store, {});
        const result = await (loop as any).validateGoalCompletion(goal, undefined, emptyState());
        assert(result.achieved === false, 'exceção não tratada durante validação → achieved=false (ANTES desta Sprint: achieved=true)');
        assert(/[Ee]rro técnico durante/.test(result.reason ?? ''), `reason distingue erro técnico (obtido: "${result.reason}")`);
    }

    // ══════════ 6. Parse inválido → já era conservador (precedente, confirma inalterado) ══════════
    console.log('\n=== S21.6 — LLM retorna texto livre não-JSON → achieved=false (precedente pré-existente, confirma preservado) ===');
    {
        const freeText = 'Analisando cuidadosamente o objetivo e todos os passos executados, concluo que ainda falta uma etapa importante antes de finalizar.';
        const loop = makeLoop(makeFakeProviderFactory(async () => ({ status: 'success', content: freeText })));
        const store = (loop as any).goalStore as GoalStore;
        const goal = makeGoal(store, {});
        const result = await (loop as any).validateGoalCompletion(goal, undefined, emptyState());
        assert(result.achieved === false, 'resposta em texto livre (não-JSON) → achieved=false — comportamento pré-existente preservado');
        assert(/JSON válido/.test(result.reason ?? ''), `reason menciona parse inválido (obtido: "${result.reason}")`);
    }

    // ══════════ 7. Ausência de evidência não vira sucesso por fallback técnico (estrutural) ══════════
    console.log('\n=== S21.7 — Nenhum fallback técnico retorna achieved:true literal fora do checklist determinístico ===');
    {
        // Único "return { achieved: true" que deve sobrar é o do checklist determinístico (S21.1).
        const achievedTrueLiterals = (validateBody.match(/return\s*\{\s*achieved:\s*true/g) ?? []).length;
        assert(achievedTrueLiterals === 1, `só 1 ocorrência de "return {achieved:true" no método (o checklist determinístico) — obtido: ${achievedTrueLiterals}`);
        assert(!/status !== 'success'\)\s*\{[^}]*achieved:\s*true/s.test(validateBody), 'caminho de status!=success não retorna mais achieved:true');
    }

    // ══════════ 8. Proteção contra loop/replan regressivo ══════════
    console.log('\n=== S21.8 — replanBudget finito continua protegendo contra loop infinito quando achieved=false ===');
    assert(/replanBudget\s*<=\s*0/.test(gelSrc), 'checagem de replanBudget<=0 (transição para failed) continua presente e inalterada');
    assert(/setStatus\(currentGoal\.id, 'failed'\)/.test(gelSrc), 'transição para status=failed quando budget esgota continua presente');
    assert(
        (gelSrc.match(/while\s*\(totalCycles < GOAL_LIMITS\.MAX_CYCLES\)/g) ?? []).length === 1,
        'nenhum novo loop foi introduzido — continua existindo exatamente 1 loop principal limitado por MAX_CYCLES'
    );

    // ══════════ 9. CaseMemory continua exigindo evidência Tier válida (não regressão) ══════════
    console.log('\n=== S21.9 — CaseMemory.determineEvidenceTier não foi alterado pela S5.5a ===');
    {
        const caseMemorySrc = readSource('memory/CaseMemory.ts');
        assert(caseMemorySrc.includes("c.status === 'met'"), 'CaseMemory ainda exige successCriteria.status===met (inalterado)');
        assert(caseMemorySrc.includes('sentArtifacts'), 'CaseMemory ainda considera sentArtifacts (inalterado)');
        assert(!caseMemorySrc.includes("goal.status === 'completed'"), 'CaseMemory continua NUNCA usando goal.status===completed isolado como evidência');
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S21 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    if (failed > 0) process.exit(1);
}

main().catch(err => { console.error('ERRO NÃO TRATADO:', err); process.exit(1); });
