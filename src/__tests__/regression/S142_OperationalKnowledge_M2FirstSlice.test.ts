/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S142 (Milestone M2, primeira fatia — docs/RFC-001_APRENDIZADO_OPERACIONAL.md)
 *
 * Prova o ciclo completo da primeira fatia de Aprendizado Operacional:
 *   captureFromGoal() (goal validado, blocker missing_tool + fix causal) →
 *   recordAttempt() (persistência, chave ferramenta×plataforma) →
 *   buildEvidenceHint() (Evidence Provider — texto, nunca decisão).
 *
 * Escopo desta fatia (ver docstring de OperationalKnowledge.ts): só o caminho informativo.
 * A extensão tática (needs_dependency-style, condicionada a permissionRegistry) fica para
 * incremento futuro — não testada aqui porque não existe ainda.
 *
 * Execução: npx ts-node src/__tests__/regression/S142_OperationalKnowledge_M2FirstSlice.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { OperationalKnowledge, currentPlatform } from '../../memory/OperationalKnowledge';
import { Goal, GoalAttempt, GoalBlocker } from '../../loop/GoalTypes';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  OK ${message}`); passed++; }
    else { console.error(`  FALHOU: ${message}`, detail ?? ''); failed++; }
}
function readSource(relPath: string): string {
    return fs.readFileSync(path.join(process.cwd(), 'src', relPath), 'utf-8');
}

function freshOperationalKnowledge(): OperationalKnowledge {
    const db = new (Database as any)(':memory:');
    const mockMemoryManager = { getDatabase: () => db } as any;
    return new OperationalKnowledge(mockMemoryManager);
}

function makeGoal(blockers: GoalBlocker[], attempts: GoalAttempt[]): Goal {
    const now = Date.now();
    return {
        id: 'goal_s142',
        sessionKey: 'telegram:1',
        conversationId: '1',
        userIntent: 'teste S142',
        objective: 'teste S142',
        status: 'executing',
        currentPlan: [],
        attempts,
        blockers,
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
    } as Goal;
}

/**
 * Shape real de produção (GoalEvaluator.classifyError()): toolName é a TOOL que falhou
 * (ex: 'exec_command'), missingDependency é o binário extraído (ex: 'puppeteer') — os dois
 * campos NUNCA compartilham valor. Um GoalBlocker sintético com toolName='puppeteer' (shape
 * antigo deste teste) mascarou por meses o bug real onde GoalEvaluator só populava toolName
 * com a tool chamadora — descoberto na validação E2E de 24/07 (docs/DIRETRIZ_ARQUITETURA).
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

async function main() {
    console.log('\n=== S142 — OperationalKnowledge: captura → persistência → Evidence Provider ===');

    // 1. recordAttempt + buildEvidenceHint — caminho básico
    {
        const ok = freshOperationalKnowledge();
        assert(ok.buildEvidenceHint('puppeteer') === '', 'sem registro nenhum, buildEvidenceHint devolve vazio (silêncio é saída válida)');

        ok.recordAttempt('puppeteer', 'npm install puppeteer', true);
        const hint = ok.buildEvidenceHint('puppeteer');
        assert(hint.length > 0, 'após 1 sucesso, buildEvidenceHint devolve texto', hint);
        assert(hint.includes('npm install puppeteer'), 'texto inclui o comando que funcionou', hint);
        assert(hint.includes('puppeteer'), 'texto inclui o nome da ferramenta', hint);
    }

    // 2. Upsert por (tool, platform, command) — reforça contagem, não duplica linha
    {
        const ok = freshOperationalKnowledge();
        ok.recordAttempt('puppeteer', 'npm install puppeteer', true);
        ok.recordAttempt('puppeteer', 'npm install puppeteer', true);
        ok.recordAttempt('puppeteer', 'npm install puppeteer', true);
        const hint = ok.buildEvidenceHint('puppeteer');
        assert(hint.includes('3x'), 'mesmo comando reforçado 3x aparece com contagem 3, não 3 linhas', hint);
        assert(ok.getStats().total === 1, 'upsert: 3 chamadas com mesma (tool,platform,command) viram 1 única linha', ok.getStats());
    }

    // 3. Comandos diferentes para a mesma ferramenta são fatos distintos (RFC-001 pergunta 1)
    {
        const ok = freshOperationalKnowledge();
        ok.recordAttempt('puppeteer', 'npm install puppeteer', true);
        ok.recordAttempt('puppeteer', 'npm install puppeteer-core', true);
        assert(ok.getStats().total === 2, 'comandos diferentes para a mesma ferramenta viram registros distintos', ok.getStats());
    }

    // 4. Falha registrada não vira evidência positiva
    {
        const ok = freshOperationalKnowledge();
        ok.recordAttempt('tesseract', 'apt install tesseract-ocr-xyz-invalido', false);
        assert(ok.buildEvidenceHint('tesseract') === '', 'comando registrado só como falha (success_count=0) não aparece como evidência positiva');
    }

    // 5. captureFromGoal — caminho causal correto: fix ocorre DEPOIS do blocker
    {
        const ok = freshOperationalKnowledge();
        const t0 = Date.now();
        const blocker = makeBlocker({ detectedAt: t0, missingDependency: 'puppeteer' });
        const fixAttempt = makeAttempt({
            toolName: 'exec_command',
            result: 'success',
            args: { command: 'npm install puppeteer' },
            executedAt: t0 + 1000,
        });
        const goal = makeGoal([blocker], [fixAttempt]);

        const result = ok.captureFromGoal(goal);
        assert(result.captured === 1, 'captureFromGoal captura 1 quando há fix causal (attempt após o blocker)', result);
        assert(ok.buildEvidenceHint('puppeteer').includes('npm install puppeteer'), 'comando capturado aparece na evidência subsequente');
    }

    // 6. captureFromGoal — NÃO captura attempt anterior ao blocker (não é causal)
    {
        const ok = freshOperationalKnowledge();
        const t0 = Date.now();
        const blocker = makeBlocker({ detectedAt: t0, missingDependency: 'puppeteer' });
        const priorAttempt = makeAttempt({
            toolName: 'exec_command',
            result: 'success',
            args: { command: 'npm install algo-nao-relacionado' },
            executedAt: t0 - 5000, // ANTES do blocker
        });
        const goal = makeGoal([blocker], [priorAttempt]);

        const result = ok.captureFromGoal(goal);
        assert(result.captured === 0, 'captureFromGoal NÃO captura attempt anterior ao blocker (sem relação causal)', result);
    }

    // 7. captureFromGoal — sem blocker missing_tool, nada é capturado
    {
        const ok = freshOperationalKnowledge();
        const goal = makeGoal([], [makeAttempt({ args: { command: 'echo oi' } })]);
        const result = ok.captureFromGoal(goal);
        assert(result.captured === 0, 'sem blocker missing_tool, captureFromGoal não captura nada', result);
    }

    // 7b. Regressão do bug real (validação E2E, 24/07): blocker com toolName='exec_command' mas
    //     SEM missingDependency (ex: classificação por [exit code: 127] sem nome extraível) não
    //     pode ser capturado usando toolName como se fosse a dependência — captureFromGoal() deve
    //     ignorar esse blocker, nunca gravar 'exec_command' como se fosse um binário aprendido.
    {
        const ok = freshOperationalKnowledge();
        const t0 = Date.now();
        const blockerSemDependencia: GoalBlocker = {
            kind: 'missing_tool',
            toolName: 'exec_command',
            description: "Caminho não encontrado ao executar 'exec_command'",
            suggestedActions: [],
            detectedAt: t0,
        };
        const fixAttempt = makeAttempt({ args: { command: 'echo qualquer-coisa' }, executedAt: t0 + 1000 });
        const goal = makeGoal([blockerSemDependencia], [fixAttempt]);

        const result = ok.captureFromGoal(goal);
        assert(result.captured === 0, 'blocker missing_tool sem missingDependency não é capturado (nunca usa toolName como fallback de dependência)', result);
        assert(ok.getStats().total === 0, 'nada foi gravado sob a chave "exec_command"', ok.getStats());
    }

    // 8. currentPlatform() devolve um valor da união esperada
    {
        const p = currentPlatform();
        assert(['windows', 'linux', 'macos'].includes(p), `currentPlatform() devolve valor válido (veio: ${p})`);
    }

    // 9. Wiring estrutural — GoalPlanner consulta buildEvidenceHint no replan, como Evidence
    //    Provider próprio (bloco separado do reflectionBlock, nunca decide sozinho).
    {
        const goalPlannerSrc = readSource('loop/GoalPlanner.ts');
        assert(/this\.operationalKnowledge\?\.buildEvidenceHint\(blocker\.missingDependency\)/.test(goalPlannerSrc),
            'GoalPlanner.replan() consulta operationalKnowledge.buildEvidenceHint(blocker.missingDependency) — nunca blocker.toolName');
        assert(!/buildEvidenceHint\(blocker\.toolName\)/.test(goalPlannerSrc),
            'GoalPlanner.replan() NÃO usa mais blocker.toolName para consultar OperationalKnowledge (bug real corrigido)');
        assert(/operationalHint\)/.test(goalPlannerSrc) && /buildReplanPrompt\(.*operationalHint\)/.test(goalPlannerSrc),
            'operationalHint é propagado até buildReplanPrompt()');
    }

    // 10. Wiring estrutural — GoalExecutionLoop captura no mesmo gate de elegibilidade do CaseMemory
    {
        const loopSrc = readSource('loop/GoalExecutionLoop.ts');
        const captureSites = (loopSrc.match(/this\.operationalKnowledge\?\.captureFromGoal\(/g) ?? []).length;
        assert(captureSites === 2, `GoalExecutionLoop chama captureFromGoal nos 2 mesmos pontos onde CaseMemory.captureIfEligible já é chamado (encontrados: ${captureSites})`, captureSites);
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S142 RESULTADO: ${passed} passou | ${failed} falhou`);
    if (failed > 0) process.exit(1);
    process.exit(0);
}

main().catch(err => { console.error('Erro no teste S142:', err); process.exit(1); });
