/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S20 (Sprint S5 do roadmap de aprendizado orientado a objetivos)
 *
 * Prova que CaseMemory (src/memory/CaseMemory.ts) captura, em modo sombra, apenas
 * trajetórias de goal com evidência REAL de nível de goal (successCriteria met OU
 * sentArtifacts confirmado) — nunca tool success / step success / validation success /
 * commit success isolados, nunca goal.status='completed' por si só (que pode vir do
 * fallback "validação de LLM falhou → assume achieved=true", sem nenhuma evidência) —
 * e que a captura/consulta não influencia GoalPlanner, RiskAnalyzer ou execução.
 *
 * Execução: npx ts-node src/__tests__/regression/S20_CaseMemory_ShadowMode.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { CaseMemory } from '../../memory/CaseMemory';
import { Goal, GoalAttempt, GoalBlocker, PlanStep, SuccessCriterion } from '../../loop/GoalTypes';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`); failed++; }
}
function readSource(relPath: string): string {
    return fs.readFileSync(path.join(process.cwd(), 'src', relPath), 'utf-8');
}
function freshCaseMemory(): CaseMemory {
    const db = new (Database as any)(':memory:');
    // S6: CaseMemory agora também exige getEmbeddingService() — fake fail-open (embed=>null)
    // é suficiente aqui, já que este arquivo testa captura/evidência, não similaridade semântica
    // (isso é coberto por S23_CaseRetrieval_ProblemSimilarity.test.ts).
    const fakeEmbeddingService = { embed: async () => null, cosineSimilarity: () => 0 };
    return new CaseMemory({ getDatabase: () => db, getEmbeddingService: () => fakeEmbeddingService } as any);
}

let goalCounter = 0;
function makeGoal(overrides: Partial<Goal> = {}): Goal {
    goalCounter++;
    const now = Date.now();
    return {
        id: `goal_s20_${goalCounter}`,
        sessionKey: 'test:user',
        conversationId: 'test-conv',
        userIntent: 'objetivo de teste',
        objective: 'Objetivo de teste S20',
        status: 'completed',
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
        createdAt: now,
        updatedAt: now,
        expiresAt: now + 3_600_000,
        ...overrides,
    } as Goal;
}

function metCriterion(id: string, evidence: string): SuccessCriterion {
    return { id, description: `critério ${id}`, check: 'tool_succeeded', status: 'met', metAt: Date.now(), evidence };
}

function plan(...toolNames: string[]): PlanStep[] {
    return toolNames.map((t, i) => ({ id: `step_${i}`, description: t, toolName: t, status: 'completed' as const }));
}

function attempt(toolName: string, result: GoalAttempt['result']): GoalAttempt {
    return { id: `att_${toolName}_${result}`, planStepId: 'step_0', toolName, args: {}, result, durationMs: 10, executedAt: Date.now() };
}

function blocker(kind: GoalBlocker['kind']): GoalBlocker {
    return { kind, description: `blocker ${kind}`, suggestedActions: [], detectedAt: Date.now() };
}

async function main() {
    const gelSrc = readSource('loop/GoalExecutionLoop.ts');
    const plannerSrc = readSource('loop/GoalPlanner.ts');
    const riskSrc = readSource('loop/RiskAnalyzer.ts');
    const caseMemorySrc = readSource('memory/CaseMemory.ts');

    // ══════════ 1. Sucesso confiável → gera Caso ══════════
    console.log('\n=== S20.1 — Trajetória com evidência determinística (successCriteria met) gera Caso ===');
    {
        const cm = freshCaseMemory();
        const goal = makeGoal({
            currentPlan: plan('read', 'write'),
            toolsTried: ['read', 'write'],
            successCriteria: [metCriterion('c1', 'arquivo criado com conteúdo real')],
        });
        const result = cm.captureIfEligible(goal);
        assert(result.captured === true, 'captureIfEligible retorna captured=true com successCriteria met');
        assert(result.tier === 'deterministic_criteria', 'tier reportado é deterministic_criteria');
    }

    // ══════════ 2. Tool success isolado NÃO gera Caso ══════════
    console.log('\n=== S20.2 — Tool success isolado (attempt.result=success) NÃO gera Caso sem evidência de goal ===');
    {
        const cm = freshCaseMemory();
        const goal = makeGoal({
            attempts: [attempt('exec_command', 'success')],
            toolsTried: ['exec_command'],
            // successCriteria e sentArtifacts vazios — só há sucesso de TOOL, não de GOAL
        });
        const result = cm.captureIfEligible(goal);
        assert(result.captured === false, 'tool success isolado NÃO gera Caso — determineEvidenceTier ignora attempts diretamente');
        assert(result.reason === 'no_evidence', 'motivo do skip é no_evidence');
    }

    // ══════════ 3. Step success isolado NÃO gera Caso ══════════
    console.log('\n=== S20.3 — Step success isolado (PlanStep.status=completed) NÃO gera Caso sem evidência de goal ===');
    {
        const cm = freshCaseMemory();
        const goal = makeGoal({
            currentPlan: plan('read'), // status='completed' nos steps, mas sem successCriteria/sentArtifacts
        });
        const result = cm.captureIfEligible(goal);
        assert(result.captured === false, 'step concluído isolado NÃO gera Caso — determineEvidenceTier não olha currentPlan[].status');
    }

    // ══════════ 4. Commit aprovado isolado — fora do escopo de CaseMemory ══════════
    console.log('\n=== S20.4 — CaseMemory não tem NENHUMA referência a commit/ResponseCommit/ObserverValidator ===');
    assert(
        !/ResponseCommit|ObserverValidator|commit\.valid/.test(caseMemorySrc),
        'CaseMemory.ts não referencia ResponseCommit/ObserverValidator/commit.valid — commit aprovado isolado não pode, nem por acidente, virar Caso'
    );

    // ══════════ 5. Falha NÃO vira Caso positivo ══════════
    console.log('\n=== S20.5 — Goal com apenas falhas NÃO vira Caso ===');
    {
        const cm = freshCaseMemory();
        const goal = makeGoal({
            status: 'failed',
            attempts: [attempt('exec_command', 'failure'), attempt('exec_command', 'failure')],
            blockers: [blocker('tool_error')],
        });
        const result = cm.captureIfEligible(goal);
        assert(result.captured === false, 'goal só com falhas não gera Caso');
    }

    // ══════════ 6. Partial NÃO vira sucesso global automaticamente ══════════
    console.log('\n=== S20.6 — Attempt result=partial isolado NÃO vira Caso ===');
    {
        const cm = freshCaseMemory();
        const goal = makeGoal({
            attempts: [attempt('write', 'partial')],
        });
        const result = cm.captureIfEligible(goal);
        assert(result.captured === false, 'attempt parcial isolado não gera Caso — partial não é promovido a sucesso de goal');
    }

    // ══════════ 7. Recuperação preservada quando há evidência real ══════════
    console.log('\n=== S20.7 — Trajetória com falha inicial + recovery + sucesso preserva blockers/hadRecovery ===');
    {
        const cm = freshCaseMemory();
        const goal = makeGoal({
            currentPlan: plan('exec_command', 'write', 'send_document'),
            toolsTried: ['pandoc', 'exec_command', 'write', 'send_document'], // pandoc tentado e abandonado
            blockers: [blocker('dependency_missing')],
            sentArtifacts: ['relatorio.pdf'],
        });
        const result = cm.captureIfEligible(goal);
        assert(result.captured === true, 'goal com recovery + entrega confirmada gera Caso');
        assert(result.tier === 'confirmed_delivery', 'tier reportado é confirmed_delivery (sem successCriteria, mas com sentArtifacts real)');

        const candidates = cm.findSimilarShadow(plan('exec_command', 'write', 'send_document'));
        assert(candidates.length === 1, 'Caso capturado é recuperável pela mesma fingerprint de plano');
        assert(candidates[0].hadRecovery === true, 'hadRecovery=true preservado no Caso');
        assert(
            candidates[0].blockerKinds.includes('dependency_missing'),
            `blockerKinds preserva o blocker real superado (obtido: ${candidates[0].blockerKinds.join(',')})`
        );
        assert(
            candidates[0].toolsUsed.includes('pandoc'),
            'toolsUsed preserva a ferramenta abandonada (pandoc) — trajetória completa, não só o caminho limpo'
        );
    }

    // ══════════ 8. Modo sombra: zero influência em Planner/RiskAnalyzer/execução ══════════
    console.log('\n=== S20.8 — Modo sombra: GoalPlanner e RiskAnalyzer não referenciam CaseMemory ===');
    assert(!plannerSrc.includes('CaseMemory'), 'GoalPlanner.ts não importa nem referencia CaseMemory');
    assert(!riskSrc.includes('CaseMemory'), 'RiskAnalyzer.ts não importa nem referencia CaseMemory');
    assert(
        !/planResult\.steps\s*=.*findSimilarShadow|enrichedContext.*findSimilarShadow/.test(gelSrc),
        'GoalExecutionLoop não atribui o retorno de findSimilarShadow a planResult.steps nem a enrichedContext — puramente observacional'
    );
    {
        const shadowCallIndex = gelSrc.indexOf('this.caseMemory.findSimilarShadow(');
        const planCallIndex = gelSrc.indexOf('this.planner.plan(goal, q1Context');
        assert(shadowCallIndex > planCallIndex && planCallIndex !== -1, 'findSimilarShadow só é chamado DEPOIS que o prompt do planner já foi montado e enviado — não pode influenciá-lo');
    }

    // ══════════ 9. Ausência de evidência não inventa Caso ══════════
    console.log('\n=== S20.9 — Goal completed sem nenhuma evidência de nível de goal NÃO gera Caso (fallback LLM "assumindo achieved") ===');
    {
        const cm = freshCaseMemory();
        const goal = makeGoal({
            status: 'completed', // simula o fallback "LLM validation failed — assuming achieved" (sem criteria/sem delivery)
        });
        const result = cm.captureIfEligible(goal);
        assert(result.captured === false, 'status=completed sozinho, sem successCriteria/sentArtifacts, NÃO gera Caso');
        assert(result.reason === 'no_evidence', 'motivo correto: no_evidence — protege contra o fallback LLM sem evidência');
    }

    // ══════════ 10. Compatibilidade estrutural: pontos de captura corretos ══════════
    console.log('\n=== S20.10 — Captura ocorre exatamente nos 2 pontos de setStatus(id, \'completed\') ===');
    {
        const setStatusCompletedCount = (gelSrc.match(/setStatus\([^)]*'completed'\)/g) ?? []).length;
        const captureCallCount = (gelSrc.match(/this\.caseMemory\.captureIfEligible\(/g) ?? []).length;
        assert(setStatusCompletedCount === 2, `existem exatamente 2 call sites de setStatus(...,'completed') (obtido: ${setStatusCompletedCount})`);
        assert(captureCallCount === 2, `captureIfEligible é chamado exatamente 2 vezes, uma por call site (obtido: ${captureCallCount})`);
    }

    // ══════════ Teste comportamental central ══════════
    console.log('\n=== S20.CENTRAL — goal bem-sucedido → Caso persistido → novo goal → sombra encontra candidato → sem influência ===');
    {
        const cm = freshCaseMemory();
        const successGoal = makeGoal({
            currentPlan: plan('web_search', 'write', 'send_document'),
            toolsTried: ['web_search', 'write', 'send_document'],
            successCriteria: [metCriterion('c1', 'documento enviado com dados reais')],
        });
        const captureResult = cm.captureIfEligible(successGoal);
        assert(captureResult.captured === true, 'goal com evidência real é capturado como Caso');

        const newGoalPlan = plan('web_search', 'write', 'send_document');
        const shadowResult = cm.findSimilarShadow(newGoalPlan);
        assert(shadowResult.length === 1, 'consulta sombra para um novo objetivo com plano de mesma fingerprint encontra o Caso anterior');

        // "tool local teve success, goal não possui evidência de sucesso, nenhum Caso positivo global é criado"
        const isolatedToolGoal = makeGoal({
            attempts: [attempt('web_search', 'success')],
            toolsTried: ['web_search'],
        });
        const isolatedResult = cm.captureIfEligible(isolatedToolGoal);
        assert(isolatedResult.captured === false, 'tool success isolado em outro goal, sem evidência de goal, não vira Caso');

        const stats = cm.getStats();
        assert(stats.total === 1, `getStats() reflete só o Caso realmente elegível (obtido total=${stats.total})`);
    }

    // ══════════ Dedup: já capturado não duplica ══════════
    console.log('\n=== S20.11 — Mesmo goal.id não é capturado duas vezes ===');
    {
        const cm = freshCaseMemory();
        const goal = makeGoal({ successCriteria: [metCriterion('c1', 'ev')] });
        const first = cm.captureIfEligible(goal);
        const second = cm.captureIfEligible(goal);
        assert(first.captured === true, 'primeira captura funciona');
        assert(second.captured === false && second.reason === 'already_captured', 'segunda captura do mesmo goal.id é rejeitada como already_captured');
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S20 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    if (failed > 0) process.exit(1);
}

main().catch(err => { console.error('ERRO NÃO TRATADO:', err); process.exit(1); });
