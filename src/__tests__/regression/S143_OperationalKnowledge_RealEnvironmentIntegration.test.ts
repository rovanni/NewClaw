/// <reference types="node" />
/**
 * TESTE DE INTEGRAÇÃO — S143 (Milestone M2, validação em ambiente real)
 *
 * Complementa o S142 (unitário, banco :memory:, wiring por leitura de código-fonte) com dois
 * cenários que o S142 não cobre:
 *
 *   1. Persistência REAL em arquivo SQLite — grava com uma instância de OperationalKnowledge,
 *      DESCARTA a instância (simula reinício de processo) e lê de novo com uma instância nova
 *      apontando pro MESMO arquivo. :memory: não prova isso — o dado nunca sai do processo.
 *   2. Injeção real no prompt que GoalPlanner.replan() de fato monta — não uma asserção sobre
 *      o texto-fonte do arquivo (S142), e sim o prompt que chegaria à chamada de LLM de verdade,
 *      capturado via ProviderFactory fake (mesmo padrão já usado por outros testes desta suíte,
 *      ex: S109). Prova o ciclo completo: aprendeu → persistiu → outro goal recupera → aparece
 *      no texto que o LLM veria, como bloco de evidência separado, nunca como instrução.
 *
 * Não expande a responsabilidade do componente, não adiciona atalho determinístico, não
 * promove nada para KNOWN_DEPS — só valida o que já foi implementado.
 *
 * Execução: npx ts-node src/__tests__/regression/S143_OperationalKnowledge_RealEnvironmentIntegration.test.ts
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import { OperationalKnowledge } from '../../memory/OperationalKnowledge';
import { GoalPlanner } from '../../loop/GoalPlanner';
import { ReflectionMemory } from '../../memory/ReflectionMemory';
import { Goal, GoalAttempt, GoalBlocker } from '../../loop/GoalTypes';
import type { ProviderFactory, LLMMessage } from '../../core/ProviderFactory';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  OK ${message}`); passed++; }
    else { console.error(`  FALHOU: ${message}`, detail ?? ''); failed++; }
}

function freshReflectionMemory(): ReflectionMemory {
    const db = new (Database as any)(':memory:');
    return new ReflectionMemory({ getDatabase: () => db } as any);
}

function makeGoal(over: Partial<Goal>): Goal {
    const now = Date.now();
    return {
        id: 'goal_s143',
        sessionKey: 'telegram:1',
        conversationId: '1',
        userIntent: 'teste S143',
        objective: 'teste S143',
        status: 'executing',
        currentPlan: [],
        attempts: [],
        blockers: [],
        toolsTried: [],
        strategiesTried: [],
        successCriteria: [],
        retryBudget: 3,
        replanBudget: 3,
        confidence: 0.9,
        requiresAuth: false,
        authorizationScope: [],
        createdAt: now,
        updatedAt: now,
        expiresAt: now + 3600_000,
        ...over,
    } as Goal;
}

/**
 * Shape real de produção: toolName é a TOOL que falhou (ex: 'exec_command'), missingDependency é
 * o binário extraído (ex: 'puppeteer') — nunca o mesmo valor. Ver S142 para o histórico do bug
 * que um GoalBlocker sintético com toolName=nome-da-dependência mascarava.
 */
function makeBlocker(over: Partial<GoalBlocker>): GoalBlocker {
    return {
        kind: 'missing_tool',
        toolName: 'exec_command',
        missingDependency: 'puppeteer',
        description: "Binário 'puppeteer' não encontrado no sistema (chamado via 'exec_command')",
        suggestedActions: [],
        detectedAt: Date.now(),
        ...over,
    };
}

function makeAttempt(over: Partial<GoalAttempt>): GoalAttempt {
    return {
        id: `att_${Math.random().toString(36).slice(2, 7)}`,
        planStepId: 'step1',
        toolName: 'exec_command',
        args: {},
        result: 'success',
        durationMs: 100,
        executedAt: Date.now(),
        ...over,
    };
}

/** Mesmo padrão de fake ProviderFactory já usado em outros testes desta suíte (ex: S109) —
 *  captura as mensagens realmente montadas em vez de checar texto-fonte do arquivo. */
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
    console.log('\n=== S143 — OperationalKnowledge: validação de integração em ambiente real ===');

    // 1. Persistência REAL em arquivo — sobrevive à troca de instância (simula reinício)
    {
        const tmpPath = path.join(os.tmpdir(), `s143_opknow_${Date.now()}.db`);
        try {
            // Instância A: "processo 1" — aprende e persiste.
            const dbA = new (Database as any)(tmpPath);
            const okA = new OperationalKnowledge({ getDatabase: () => dbA } as any);
            okA.recordAttempt('puppeteer', 'npm install puppeteer', true);
            dbA.close();

            // Instância B: "processo 2", mesmo arquivo — nenhuma referência à instância A.
            const dbB = new (Database as any)(tmpPath);
            const okB = new OperationalKnowledge({ getDatabase: () => dbB } as any);
            const hint = okB.buildEvidenceHint('puppeteer');
            assert(hint.includes('npm install puppeteer'), 'conhecimento gravado por uma instância é lido por outra apontando pro mesmo arquivo (persistência real, não :memory:)', hint);
            dbB.close();
        } finally {
            fs.rmSync(tmpPath, { force: true });
        }
    }

    // 2. Ciclo completo: goal 1 aprende → goal 2 (diferente, mesmo tool) recupera
    {
        const db = new (Database as any)(':memory:');
        const ok = new OperationalKnowledge({ getDatabase: () => db } as any);

        const t0 = Date.now();
        const goal1 = makeGoal({
            id: 'goal_1_dashboard_review',
            objective: 'revisar visualmente o dashboard.html',
            blockers: [makeBlocker({ detectedAt: t0, missingDependency: 'puppeteer' })],
            attempts: [makeAttempt({ args: { command: 'npm install puppeteer' }, executedAt: t0 + 500 })],
        });
        const captureResult = ok.captureFromGoal(goal1);
        assert(captureResult.captured === 1, 'goal 1 (objetivo A) captura o fix de puppeteer', captureResult);

        // goal 2: objetivo completamente diferente, sem relação semântica com goal 1 — só o
        // MESMO problema de ambiente. Prova o ponto central do M2/RFC-001: recuperação por
        // (ferramenta, plataforma), não por similaridade de objetivo (CaseMemory não serviria).
        const hintForGoal2 = ok.buildEvidenceHint('puppeteer');
        assert(hintForGoal2.includes('npm install puppeteer'), 'goal 2 (objetivo B, sem relação com o goal 1) recupera o mesmo conhecimento — eixo é ferramenta×plataforma, não objetivo', hintForGoal2);
    }

    // 3. Injeção real no prompt de GoalPlanner.replan() — não simulação, o método real
    {
        const db = new (Database as any)(':memory:');
        const ok = new OperationalKnowledge({ getDatabase: () => db } as any);
        ok.recordAttempt('puppeteer', 'npm install puppeteer', true);
        ok.recordAttempt('puppeteer', 'npm install puppeteer', true); // 2ª confirmação

        const reflectionMemory = freshReflectionMemory();
        const { factory, capturedMessages } = makeCapturingProviderFactory({
            steps: [{ id: 'step_1', description: 'instalar puppeteer', toolName: 'exec_command', toolArgs: { command: 'npm install puppeteer' }, fallbackSteps: [] }],
            strategy: 'instalar dependência e retry',
        });
        const planner = new GoalPlanner(factory, reflectionMemory, undefined, ok);

        const goal = makeGoal({ objective: 'gerar PDF do relatório mensal' }); // objetivo sem NENHUMA relação com "puppeteer"
        const blocker = makeBlocker({ missingDependency: 'puppeteer', kind: 'missing_tool' });

        await planner.replan(goal, blocker);

        assert(capturedMessages.length === 1, 'replan() chamou o LLM exatamente 1 vez', capturedMessages.length);
        const promptSent = String(capturedMessages[0]?.[0]?.content ?? '');
        assert(promptSent.includes('CONHECIMENTO OPERACIONAL APRENDIDO'), 'o prompt REAL enviado à chamada de LLM contém o cabeçalho do bloco de conhecimento operacional', promptSent.slice(0, 50));
        assert(promptSent.includes('npm install puppeteer'), 'o prompt REAL contém o comando aprendido', promptSent.slice(0, 50));
        assert(promptSent.includes('2x'), 'o prompt REAL reflete a contagem de confirmações (2x)', promptSent.slice(0, 50));

        // Confirma que é EVIDÊNCIA, não ORDEM: nenhuma linguagem imperativa própria deste
        // bloco (o texto vem de buildEvidenceHint, que já foi testado no S142 por não conter
        // "use", "deve", "obrigatório" — aqui confirmamos que ele chega ao prompt tal como é).
        const evidenceBlockText = ok.buildEvidenceHint('puppeteer');
        assert(promptSent.includes(evidenceBlockText), 'o texto no prompt é EXATAMENTE o que buildEvidenceHint() produziu — nada reescreve como instrução no caminho até o LLM', evidenceBlockText);
    }

    // 4. Blocker de ferramenta SEM conhecimento aprendido — bloco não aparece (silêncio válido)
    {
        const db = new (Database as any)(':memory:');
        const ok = new OperationalKnowledge({ getDatabase: () => db } as any);
        // nada gravado para 'ferramenta-nunca-vista'

        const reflectionMemory = freshReflectionMemory();
        const { factory, capturedMessages } = makeCapturingProviderFactory({
            steps: [{ id: 'step_1', description: 'instalar puppeteer', toolName: 'exec_command', toolArgs: { command: 'npm install puppeteer' }, fallbackSteps: [] }],
            strategy: 'instalar dependência e retry',
        });
        const planner = new GoalPlanner(factory, reflectionMemory, undefined, ok);

        const goal = makeGoal({});
        const blocker = makeBlocker({ missingDependency: 'ferramenta-nunca-vista', kind: 'missing_tool' });
        await planner.replan(goal, blocker);

        const promptSent = String(capturedMessages[0]?.[0]?.content ?? '');
        assert(!promptSent.includes('CONHECIMENTO OPERACIONAL APRENDIDO'), 'sem conhecimento aprendido pra essa ferramenta, o bloco simplesmente não aparece no prompt (Evidence Provider: silêncio é saída válida)');
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S143 RESULTADO: ${passed} passou | ${failed} falhou`);
    if (failed > 0) process.exit(1);
    process.exit(0);
}

main().catch(err => { console.error('Erro no teste S143:', err); process.exit(1); });
