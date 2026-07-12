/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S22 (Sprint S5.5b do roadmap de aprendizado orientado a objetivos)
 *
 * Case Quality Gate — mede objetivamente, com testes adversariais A-E, se
 * `findSimilarShadow(plan)` (que reaproveita `StrategyDiversityGuard.fingerprint()`)
 * responde à pergunta "já resolvi um problema PARECIDO antes?" ou apenas
 * "já executei um plano ESTRUTURALMENTE parecido com o que acabei de escolher?".
 *
 * Semântica real de StrategyDiversityGuard.fingerprint(steps), confirmada por leitura
 * direta do código (src/loop/StrategyDiversityGuard.ts:45-47):
 *   fingerprint(steps) = steps.map(s => s.toolName ?? 'agentloop').join('→')
 *
 * Entra: SÓ toolName, na ORDEM do array.
 * NÃO entra: toolArgs, description, goal.objective, goal.userIntent, contexto, domínio.
 *
 * Consequência (provada abaixo, não assumida): é uma assinatura de PLANO/ESTRATÉGIA,
 * não de PROBLEMA. Dois objetivos totalmente diferentes resolvidos com o mesmo pipeline
 * de tools colidem (falso positivo); o mesmo objetivo resolvido por pipelines diferentes
 * não colide (falso negativo / não-recuperação).
 *
 * NÃO ativa comportamento nenhum — CaseMemory continua em modo sombra (ver S20/S5).
 *
 * Execução: npx ts-node src/__tests__/regression/S22_CaseQualityGate_RetrievalSemantics.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { CaseMemory } from '../../memory/CaseMemory';
import { StrategyDiversityGuard } from '../../loop/StrategyDiversityGuard';
import { Goal, PlanStep, GoalBlocker } from '../../loop/GoalTypes';

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
    // é suficiente aqui, já que este arquivo testa a semântica do fingerprint estrutural
    // (similaridade de problema via embedding é coberta por S23_CaseRetrieval_ProblemSimilarity.test.ts).
    const fakeEmbeddingService = { embed: async () => null, cosineSimilarity: () => 0 };
    return new CaseMemory({ getDatabase: () => db, getEmbeddingService: () => fakeEmbeddingService } as any);
}
let goalCounter = 0;
function makeGoal(overrides: Partial<Goal> = {}): Goal {
    goalCounter++;
    const now = Date.now();
    return {
        id: `goal_s22_${goalCounter}`,
        sessionKey: 'test:user',
        conversationId: 'test-conv',
        userIntent: 'objetivo',
        objective: 'objetivo',
        status: 'completed',
        currentPlan: [],
        attempts: [],
        blockers: [],
        toolsTried: [],
        strategiesTried: [],
        successCriteria: [{ id: 'c1', description: 'evidência', check: 'tool_succeeded', status: 'met', metAt: now, evidence: 'ev' }],
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
function plan(...toolNames: string[]): PlanStep[] {
    return toolNames.map((t, i) => ({ id: `step_${i}`, description: t, toolName: t, status: 'completed' as const }));
}
function blocker(kind: GoalBlocker['kind']): GoalBlocker {
    return { kind, description: `blocker ${kind}`, suggestedActions: [], detectedAt: Date.now() };
}

async function main() {
    const guardSrc = readSource('loop/StrategyDiversityGuard.ts');

    // ══════════ Pergunta 1 — semântica real do fingerprint (auditoria, sem alterar) ══════════
    console.log('\n=== S22.P1 — Auditoria da implementação real de StrategyDiversityGuard.fingerprint() ===');
    assert(
        /fingerprint\(steps: PlanStep\[\]\): string \{\s*return steps\.map\(s => s\.toolName \?\? 'agentloop'\)\.join\('→'\)/.test(guardSrc),
        'fingerprint() = steps.map(toolName).join("→") — confirmado no código real, não assumido'
    );
    assert(!guardSrc.includes('toolArgs'), 'confirmado: toolArgs NÃO participa do fingerprint');
    assert(!/fingerprint[\s\S]{0,120}objective/.test(guardSrc), 'confirmado: goal.objective NÃO participa do fingerprint');
    {
        const fpAB = StrategyDiversityGuard.fingerprint(plan('read', 'write'));
        const fpBA = StrategyDiversityGuard.fingerprint(plan('write', 'read'));
        assert(fpAB !== fpBA, 'ordem importa: fingerprint(["read","write"]) !== fingerprint(["write","read"])');
    }
    {
        const step1: PlanStep = { id: 's1', description: 'x', toolName: 'write', toolArgs: { path: 'a.txt' }, status: 'completed' };
        const step2: PlanStep = { id: 's2', description: 'y', toolName: 'write', toolArgs: { path: 'b.txt', content: 'totalmente diferente' }, status: 'completed' };
        assert(
            StrategyDiversityGuard.fingerprint([step1]) === StrategyDiversityGuard.fingerprint([step2]),
            'argumentos NÃO importam: dois steps com mesmo toolName e args totalmente diferentes geram o MESMO fingerprint'
        );
    }

    // ══════════ Caso A — mesmo objetivo, planos diferentes → recuperação encontra experiência útil? ══════════
    console.log('\n=== S22.A — Mesmo objetivo, planos DIFERENTES → NÃO encontra (falso negativo confirmado) ===');
    {
        const cm = freshCaseMemory();
        cm.captureIfEligible(makeGoal({
            objective: 'Converter relatorio.docx para PDF',
            currentPlan: plan('exec_command', 'send_document'), // resolvido via LibreOffice/exec_command
        }));
        const candidates = cm.findSimilarShadow(plan('pandoc', 'send_document')); // MESMO objetivo, resolvido via pandoc
        assert(candidates.length === 0, 'mesmo objetivo (conversão de documento) resolvido por pipeline DIFERENTE não é encontrado — resposta é NÃO à pergunta "já resolvi problema parecido?"');
    }

    // ══════════ Caso B — objetivos diferentes, mesmo pipeline → falso positivo? ══════════
    console.log('\n=== S22.B — Objetivos DIFERENTES, mesmo pipeline de tools → FALSO POSITIVO confirmado ===');
    {
        const cm = freshCaseMemory();
        cm.captureIfEligible(makeGoal({
            objective: 'Pesquisar e resumir notícias sobre gatos',
            currentPlan: plan('web_search', 'write', 'send_document'),
        }));
        const candidates = cm.findSimilarShadow(plan('web_search', 'write', 'send_document')); // objetivo NÃO relacionado
        assert(
            candidates.length === 1 && candidates[0].objective.includes('gatos'),
            'objetivo sobre "cotação de bitcoin" recuperaria o Caso de "notícias sobre gatos" só por coincidência de pipeline — FALSO POSITIVO real, não hipotético'
        );
    }

    // ══════════ Caso C — objetivos semanticamente próximos, wording diferente ══════════
    console.log('\n=== S22.C — Objetivos semanticamente próximos (wording diferente) — mecanismo reconhece por SORTE de pipeline, não por semântica ===');
    {
        const cm = freshCaseMemory();
        cm.captureIfEligible(makeGoal({
            objective: 'Envie um resumo do documento anexado por e-mail... na verdade, envie por aqui mesmo',
            currentPlan: plan('read', 'write', 'send_document'),
        }));
        // Wording bem diferente, mesma intenção real, mesmo pipeline por coincidência
        const sameToolsCandidates = cm.findSimilarShadow(plan('read', 'write', 'send_document'));
        assert(sameToolsCandidates.length === 1, 'reconhece quando o pipeline por acaso coincide — mas não é reconhecimento semântico do objetivo, é coincidência de fingerprint');
        // Mesma intenção real, pipeline diferente (ex: usa exec_command para extrair texto em vez de read)
        const differentToolsCandidates = cm.findSimilarShadow(plan('exec_command', 'write', 'send_document'));
        assert(differentToolsCandidates.length === 0, 'mesma intenção semântica, pipeline ligeiramente diferente → NADA é reconhecido — confirma ausência de similaridade semântica real');
    }

    // ══════════ Caso D — mesmo objetivo, recuperação após falha: preserva estratégia final útil? ══════════
    console.log('\n=== S22.D — Recovery: Caso preserva a estratégia FINAL vencedora, não mistura com a trajetória fracassada ===');
    {
        const cm = freshCaseMemory();
        const goal = makeGoal({
            objective: 'Gerar relatório em PDF',
            currentPlan: plan('exec_command', 'send_document'), // plano FINAL, pós-recovery (pandoc foi abandonado)
            toolsTried: ['pandoc', 'exec_command', 'send_document'], // pandoc tentado e abandonado — preservado aqui, não no plano
            blockers: [blocker('dependency_missing')],
        });
        cm.captureIfEligible(goal);
        const candidates = cm.findSimilarShadow(plan('exec_command', 'send_document'));
        assert(candidates.length === 1, 'Caso é recuperável pela estratégia FINAL (exec_command→send_document)');
        assert(!candidates[0].planFingerprint.includes('pandoc'), 'planFingerprint NÃO mistura a tentativa fracassada (pandoc) — reflete só a estratégia final vencedora');
        assert(candidates[0].toolsUsed.includes('pandoc'), 'mas toolsUsed (campo separado) preserva que pandoc foi tentado — trajetória completa não é perdida, só não contamina a chave de recuperação');
        assert(candidates[0].hadRecovery === true, 'hadRecovery=true sinaliza que houve recuperação, mesmo com fingerprint "limpo"');
    }

    // ══════════ Caso E — mesmo conjunto de tools, ordem diferente ══════════
    console.log('\n=== S22.E — Mesmo conjunto de tools, ORDEM diferente → fingerprint diferencia corretamente ===');
    {
        const cm = freshCaseMemory();
        cm.captureIfEligible(makeGoal({
            objective: 'Buscar dado e escrever arquivo',
            currentPlan: plan('web_search', 'write'),
        }));
        const sameOrder = cm.findSimilarShadow(plan('web_search', 'write'));
        const reversedOrder = cm.findSimilarShadow(plan('write', 'web_search'));
        assert(sameOrder.length === 1, 'mesma ordem → recuperado');
        assert(reversedOrder.length === 0, 'ordem invertida → NÃO recuperado — fingerprint diferencia corretamente por ordem (não é um Set/bag-of-tools)');
    }

    // ══════════ Modo sombra preservado (não regressão) ══════════
    console.log('\n=== S22.SHADOW — findSimilarShadow continua sem influenciar GoalPlanner/RiskAnalyzer ===');
    const plannerSrc = readSource('loop/GoalPlanner.ts');
    const riskSrc = readSource('loop/RiskAnalyzer.ts');
    assert(!plannerSrc.includes('CaseMemory') && !plannerSrc.includes('findSimilarShadow'), 'GoalPlanner.ts continua sem qualquer referência a CaseMemory/findSimilarShadow');
    assert(!riskSrc.includes('CaseMemory') && !riskSrc.includes('findSimilarShadow'), 'RiskAnalyzer.ts continua sem qualquer referência a CaseMemory/findSimilarShadow');

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S22 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    if (failed > 0) process.exit(1);
}

main().catch(err => { console.error('ERRO NÃO TRATADO:', err); process.exit(1); });
