/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S144 (RFC-002: Ativação Plena do CaseMemory, sub-etapa final da S5)
 *
 * Prova o ciclo completo da ativação: buildCaseEvidenceHint() (Evidence Provider, novo) →
 * GoalPlanner.plan() consulta de verdade → prompt real enviado ao LLM contém o bloco de
 * evidência — e prova o gate de segurança que a auditoria adversarial S26 já exigia antes de
 * qualquer consumidor real existir: operationalCompatibility===true SOZINHO não basta, precisa
 * também de score semântico suficiente (MIN_SEMANTIC_SCORE_FOR_EVIDENCE).
 *
 * Não reabre nem duplica S20 (captura), S22/S23 (retrieval), S25/S26 (Applicability Gate) — só
 * testa o que é novo: o consumidor real (buildCaseEvidenceHint) e o wiring em GoalPlanner.plan().
 *
 * Execução: npx ts-node src/__tests__/regression/S144_CaseMemory_FullActivation.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { CaseMemory } from '../../memory/CaseMemory';
import { EmbeddingService } from '../../memory/EmbeddingService';
import { GoalPlanner } from '../../loop/GoalPlanner';
import { ReflectionMemory } from '../../memory/ReflectionMemory';
import { Goal, SuccessCriterion } from '../../loop/GoalTypes';
import type { ProviderFactory, LLMMessage } from '../../core/ProviderFactory';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  OK ${message}`); passed++; }
    else { console.error(`  FALHOU: ${message}`, detail ?? ''); failed++; }
}
function readSource(relPath: string): string {
    return fs.readFileSync(path.join(process.cwd(), 'src', relPath), 'utf-8');
}

/** Vetores 2D fixos, chaveados pelo texto COMPLETO do objetivo (o verbo importa — precisa ser
 *  reconhecível por classifyOperation() para controlar operationalCompatibility, e o texto
 *  completo precisa mapear para um vetor conhecido para controlar o score). Dão cosine
 *  similarity EXATA e conhecida com o vetor de consulta [1,0] — evita depender de bag-of-words/
 *  concept-overlap para controlar o score precisamente no limiar de 0.7
 *  (MIN_SEMANTIC_SCORE_FOR_EVIDENCE). Matemática de cosseno usada é a REAL
 *  (EmbeddingService.prototype.cosineSimilarity, não reimplementada aqui). */
const HIGH = [0.95, Math.sqrt(1 - 0.95 ** 2)]; // cosine ≈ 0.95 com [1,0] — acima do limiar
const LOW = [0.5, Math.sqrt(1 - 0.5 ** 2)];    // cosine = 0.5 com [1,0] — abaixo do limiar
const VECTORS: Record<string, number[]> = {
    'criar objetivo de consulta': [1, 0],                       // query de referência (verbo: criar)
    'criar candidato alta similaridade': HIGH,                  // compatível (criar), score alto
    'criar candidato baixa similaridade': LOW,                  // compatível (criar), score baixo
    'remover candidato alta similaridade': HIGH,                // INCOMPATÍVEL (remover), score alto
};

function makeFakeEmbeddingService(): EmbeddingService {
    const svc = Object.create(EmbeddingService.prototype) as EmbeddingService;
    (svc as unknown as { embed: (t: string) => Promise<number[] | null> }).embed = async (text: string) => {
        return VECTORS[text] ?? null;
    };
    return svc; // cosineSimilarity real é herdada do protótipo, não sobrescrita
}

function freshCaseMemory(): CaseMemory {
    const db = new (Database as any)(':memory:');
    const fakeMemory = { getDatabase: () => db, getEmbeddingService: () => makeFakeEmbeddingService() };
    return new CaseMemory(fakeMemory as any);
}

function freshReflectionMemory(): ReflectionMemory {
    const db = new (Database as any)(':memory:');
    return new ReflectionMemory({ getDatabase: () => db } as any);
}

let goalCounter = 0;
function makeGoal(objective: string, overrides: Partial<Goal> = {}): Goal {
    goalCounter++;
    const now = Date.now();
    return {
        id: `goal_s144_${goalCounter}`,
        sessionKey: 'test:user',
        conversationId: 'test-conv',
        userIntent: objective,
        objective,
        status: 'completed',
        currentPlan: [],
        attempts: [],
        blockers: [],
        toolsTried: ['write', 'send_document'],
        strategiesTried: [],
        successCriteria: [] as SuccessCriterion[],
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

/** Espera o embedding fire-and-forget de captureIfEligible() terminar antes de consultar —
 *  mesmo padrão já usado em S23_CaseRetrieval_ProblemSimilarity.test.ts. */
async function flush(): Promise<void> {
    await new Promise((r) => setTimeout(r, 10));
}

function metCriterion(id: string): SuccessCriterion {
    return { id, description: `critério ${id}`, check: 'tool_succeeded', status: 'met', metAt: Date.now(), evidence: 'evidência real' };
}

function makeCapturingProviderFactory(responseJson: object): { factory: ProviderFactory; capturedMessages: LLMMessage[][] } {
    const capturedMessages: LLMMessage[][] = [];
    const factory = {
        getProviderWithModel: () => ({
            chat: async (messages: LLMMessage[]) => {
                capturedMessages.push(messages);
                return { content: JSON.stringify(responseJson) };
            },
        }),
    } as unknown as ProviderFactory;
    return { factory, capturedMessages };
}

async function main() {
    console.log('\n=== S144 — CaseMemory: ativação plena (RFC-002) ===');

    // 1. buildCaseEvidenceHint — sem candidato nenhum → silêncio
    {
        const cm = freshCaseMemory();
        const hint = await cm.buildCaseEvidenceHint('criar objetivo de consulta');
        assert(hint === '', 'sem nenhum Caso capturado, buildCaseEvidenceHint devolve vazio (silêncio é saída válida)', hint);
    }

    // 2. buildCaseEvidenceHint — candidato compatível E acima do limiar de score → aparece
    {
        const cm = freshCaseMemory();
        const captured = cm.captureIfEligible(makeGoal('criar candidato alta similaridade', {
            successCriteria: [metCriterion('c1')],
        }));
        assert(captured.captured, 'goal com evidência real é capturado como Caso', captured);
        await flush();

        const hint = await cm.buildCaseEvidenceHint('criar objetivo de consulta');
        assert(hint.length > 0, 'candidato compatível (criar/criar) + score alto (0.95 >= 0.7) aparece na evidência', hint);
        assert(hint.includes('write, send_document'), 'evidência inclui as ferramentas usadas no Caso', hint);
        assert(hint.includes('critério cumprido'), 'evidência identifica o tier correto (deterministic_criteria)', hint);
    }

    // 3. buildCaseEvidenceHint — GATE S26: compatível mas score ABAIXO do limiar → excluído
    {
        const cm = freshCaseMemory();
        const captured = cm.captureIfEligible(makeGoal('criar candidato baixa similaridade', {
            successCriteria: [metCriterion('c1')],
        }));
        assert(captured.captured, 'goal capturado (setup do teste)', captured);
        await flush();

        const hint = await cm.buildCaseEvidenceHint('criar objetivo de consulta');
        assert(hint === '', 'candidato operacionalmente compatível (criar/criar) mas com score baixo (0.5 < 0.7) é EXCLUÍDO — achado S26: compatibilidade sozinha não basta', hint);
    }

    // 4. buildCaseEvidenceHint — operação INCOMPATÍVEL, mesmo com score alto → excluído
    {
        const cm = freshCaseMemory();
        const captured = cm.captureIfEligible(makeGoal('remover candidato alta similaridade', {
            successCriteria: [metCriterion('c1')],
        }));
        assert(captured.captured, 'goal capturado (setup do teste)', captured);
        await flush();

        const hint = await cm.buildCaseEvidenceHint('criar objetivo de consulta');
        assert(hint === '', 'candidato com score alto (0.95) mas operação incompatível (remover vs criar) é EXCLUÍDO — Applicability Gate (S6.5/S7)', hint);
    }

    // 5. Wiring estrutural — GoalPlanner.plan() consulta buildCaseEvidenceHint, GoalOrchestrator injeta
    {
        const plannerSrc = readSource('loop/GoalPlanner.ts');
        const orchestratorSrc = readSource('loop/GoalOrchestrator.ts');
        assert(/this\.caseMemory\?\.buildCaseEvidenceHint\(goal\.objective\)/.test(plannerSrc), 'GoalPlanner.plan() consulta caseMemory.buildCaseEvidenceHint(goal.objective)');
        assert(/new GoalPlanner\([^)]*caseMemory\)/.test(orchestratorSrc.replace(/\s+/g, ' ')), 'GoalOrchestrator injeta caseMemory no construtor de GoalPlanner');
        assert(!/void this\.caseMemory\.findApplicableCasesShadow/.test(readSource('loop/GoalExecutionLoop.ts')), 'GoalExecutionLoop não tem mais a chamada fire-and-forget redundante (RFC-002)');
    }

    // 6. Injeção real no prompt de GoalPlanner.plan() — não simulação, o método real
    {
        const cm = freshCaseMemory();
        cm.captureIfEligible(makeGoal('criar candidato alta similaridade', {
            successCriteria: [metCriterion('c1')],
        }));
        await flush();

        const reflectionMemory = freshReflectionMemory();
        const { factory, capturedMessages } = makeCapturingProviderFactory({
            steps: [{ id: 'step_1', description: 'passo qualquer', toolName: 'write', toolArgs: {}, fallbackSteps: [] }],
            strategy: 'estratégia qualquer',
        });
        const planner = new GoalPlanner(factory, reflectionMemory, undefined, undefined, cm);

        const goal = makeGoal('criar objetivo de consulta');
        await planner.plan(goal);

        assert(capturedMessages.length === 1, 'plan() chamou o LLM exatamente 1 vez', capturedMessages.length);
        const promptSent = String(capturedMessages[0]?.[0]?.content ?? '');
        assert(promptSent.includes('Casos anteriores com objetivo e operação semelhantes'), 'o prompt REAL enviado ao LLM contém o bloco de evidência de Casos', promptSent.slice(0, 200));
        assert(promptSent.includes('write, send_document'), 'o prompt REAL contém as ferramentas do Caso recuperado', promptSent.slice(0, 200));

        const evidenceText = await cm.buildCaseEvidenceHint('criar objetivo de consulta');
        assert(promptSent.includes(evidenceText), 'o texto no prompt é EXATAMENTE o que buildCaseEvidenceHint() produziu — nada reescreve como instrução no caminho até o LLM', evidenceText);
    }

    // 7. Sem Caso relevante — bloco não aparece no prompt real (silêncio válido)
    {
        const cm = freshCaseMemory(); // nada capturado

        const reflectionMemory = freshReflectionMemory();
        const { factory, capturedMessages } = makeCapturingProviderFactory({
            steps: [{ id: 'step_1', description: 'passo qualquer', toolName: 'write', toolArgs: {}, fallbackSteps: [] }],
            strategy: 'estratégia qualquer',
        });
        const planner = new GoalPlanner(factory, reflectionMemory, undefined, undefined, cm);

        await planner.plan(makeGoal('criar objetivo de consulta'));

        const promptSent = String(capturedMessages[0]?.[0]?.content ?? '');
        assert(!promptSent.includes('Casos anteriores com objetivo e operação semelhantes'), 'sem Caso relevante, o bloco simplesmente não aparece no prompt (Evidence Provider: silêncio é saída válida)');
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S144 RESULTADO: ${passed} passou | ${failed} falhou`);
    if (failed > 0) process.exit(1);
    process.exit(0);
}

main().catch(err => { console.error('Erro no teste S144:', err); process.exit(1); });
