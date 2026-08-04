/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S142 (Milestone M2, primeira fatia — docs/decisoes/RFC-001_APRENDIZADO_OPERACIONAL.md)
 *
 * Prova o ciclo completo da primeira fatia de Aprendizado Operacional:
 *   captureFromGoal() (goal validado, blocker missing_tool + fix causal) →
 *   recordAttempt() (persistência, chave ferramenta×plataforma) →
 *   buildEvidenceHint() (Evidence Provider — texto, nunca decisão).
 *
 * Escopo original desta fatia (ver docstring de OperationalKnowledge.ts): só o caminho
 * informativo (buildEvidenceHint).
 *
 * EXTENSÃO (2026-07-27, RFC-003 Sprint A — Infraestrutura,
 * `docs/decisoes/RFC-003_AQUISICAO_CONHECIMENTO_OPERACIONAL.md`): getTacticalCommand() — consulta
 * de elegibilidade ao atalho determinístico (RFC-001 §2: ≥2 sucessos confirmados, sem falha
 * registrada), casos 11-15 abaixo. Wiring em GoalEvaluator/GoalExecutionLoop (Sprint C —
 * Research) permanece fora do escopo desta Sprint — não testado aqui porque não existe ainda.
 *
 * EXTENSÃO (2026-07-28, mesma RFC, Sprint D — Validação): captureFromGoal() passou a exigir
 * evidência de um step de verificação bem-sucedido (planStepId prefixado 'verify_', injetado por
 * GoalExecutionLoop.handleNeedsDependencyOutcome() quando DependencyInfo.verifyCmd está
 * declarado) — não basta mais "algum exec_command deu certo depois do blocker". O caso 5
 * (positivo) foi atualizado para incluir essa evidência; os casos 19-20 provam explicitamente
 * que SEM verificação (ou com verificação que falhou), a captura é recusada — mesmo com um
 * fixAttempt real presente.
 *
 * EXTENSÃO (2026-07-29, RFC-003 Sprint E — Modelo de Confiança): `computeConfidenceLevel()`
 * exportado como função pura ('none'|'weak'|'degraded'|'validated', ver OperationalKnowledge.ts)
 * substitui os limiares crus que já existiam. Casos 21-25 abaixo cobrem: conhecimento novo inicia
 * 'weak' (não 'validated'); confirmações sucessivas elevam a 'validated'; uma falha subsequente
 * degrada mesmo com histórico de sucessos (getTacticalCommand para de reutilizar); RECUPERAÇÃO —
 * um sucesso novo depois de uma falha volta a tornar elegível (comportamento que o schema antigo,
 * baseado em failure_count>0, não permitia); buildEvidenceHint nomeia o nível de confiança no
 * texto (Evidence Provider — só enriquece o texto, não decide).
 *
 * Execução: npx ts-node src/__tests__/regression/S142_OperationalKnowledge_M2FirstSlice.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { OperationalKnowledge, currentPlatform, computeConfidenceLevel } from '../../memory/OperationalKnowledge';
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

    // 5. captureFromGoal — caminho causal correto: fix ocorre DEPOIS do blocker, E existe um
    //    step de verificação bem-sucedido depois do fix (RFC-003 Sprint D — sem essa evidência,
    //    ver casos 19-20, a captura é recusada).
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
        const verifyAttempt = makeAttempt({
            planStepId: 'verify_123_abc',
            toolName: 'exec_command',
            result: 'success',
            args: { command: 'puppeteer -version' },
            executedAt: t0 + 2000,
        });
        const goal = makeGoal([blocker], [fixAttempt, verifyAttempt]);

        const result = ok.captureFromGoal(goal);
        assert(result.captured === 1, 'captureFromGoal captura 1 quando há fix causal E verificação bem-sucedida depois', result);
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

    // 11. getTacticalCommand — abaixo do limiar (1 sucesso) não é elegível
    {
        const ok = freshOperationalKnowledge();
        ok.recordAttempt('ffmpeg', 'winget install Gyan.FFmpeg', true);
        assert(ok.getTacticalCommand('ffmpeg') === null, '1 sucesso confirmado ainda não é elegível ao atalho tático (limiar é 2)');
    }

    // 12. getTacticalCommand — no limiar (2 sucessos, 0 falhas) é elegível e devolve o comando
    {
        const ok = freshOperationalKnowledge();
        ok.recordAttempt('ffmpeg', 'winget install Gyan.FFmpeg', true);
        ok.recordAttempt('ffmpeg', 'winget install Gyan.FFmpeg', true);
        assert(ok.getTacticalCommand('ffmpeg') === 'winget install Gyan.FFmpeg', '2 sucessos confirmados, sem falha: elegível, devolve o comando exato');
    }

    // 13. getTacticalCommand — qualquer falha já registrada bloqueia o atalho, mesmo com sucessos suficientes
    {
        const ok = freshOperationalKnowledge();
        ok.recordAttempt('ffmpeg', 'winget install Gyan.FFmpeg', true);
        ok.recordAttempt('ffmpeg', 'winget install Gyan.FFmpeg', true);
        ok.recordAttempt('ffmpeg', 'winget install Gyan.FFmpeg', false);
        assert(ok.getTacticalCommand('ffmpeg') === null, 'falha já registrada (mesmo após 2 sucessos) impede o atalho — RFC-001 §2 "sem falha recente", forma conservadora que o schema atual sustenta');
    }

    // 14. getTacticalCommand — sem nenhum registro, devolve null (Nunca Adivinhar: silêncio, não suposição)
    {
        const ok = freshOperationalKnowledge();
        assert(ok.getTacticalCommand('inexistente') === null, 'ferramenta nunca registrada: null, nunca um palpite');
    }

    // 15. getTacticalCommand — entre múltiplos comandos elegíveis para a mesma ferramenta, escolhe o de maior success_count
    {
        const ok = freshOperationalKnowledge();
        ok.recordAttempt('ffmpeg', 'choco install ffmpeg', true);
        ok.recordAttempt('ffmpeg', 'choco install ffmpeg', true);
        ok.recordAttempt('ffmpeg', 'winget install Gyan.FFmpeg', true);
        ok.recordAttempt('ffmpeg', 'winget install Gyan.FFmpeg', true);
        ok.recordAttempt('ffmpeg', 'winget install Gyan.FFmpeg', true);
        assert(ok.getTacticalCommand('ffmpeg') === 'winget install Gyan.FFmpeg', 'com 2 comandos elegíveis, escolhe o de maior success_count (3 > 2)');
    }

    // 19. captureFromGoal — RFC-003 Sprint D: fixAttempt real presente, mas SEM nenhum step de
    //     verificação depois — a captura é recusada (comportamento novo, mais rigoroso que a
    //     heurística antiga, que capturava só com o fixAttempt).
    {
        const ok = freshOperationalKnowledge();
        const t0 = Date.now();
        const blocker = makeBlocker({ detectedAt: t0, missingDependency: 'graphviz' });
        const fixAttempt = makeAttempt({
            toolName: 'exec_command',
            result: 'success',
            args: { command: 'winget install Graphviz.Graphviz' },
            executedAt: t0 + 1000,
        });
        const goal = makeGoal([blocker], [fixAttempt]); // nenhum attempt com planStepId 'verify_*'

        const result = ok.captureFromGoal(goal);
        assert(result.captured === 0, 'sem step de verificação, captureFromGoal NÃO captura (mesmo com fixAttempt real)', result);
        assert(ok.buildEvidenceHint('graphviz') === '', 'nada foi aprendido — buildEvidenceHint continua vazio');
    }

    // 20. captureFromGoal — step de verificação existe, mas FALHOU: também não captura.
    {
        const ok = freshOperationalKnowledge();
        const t0 = Date.now();
        const blocker = makeBlocker({ detectedAt: t0, missingDependency: 'graphviz' });
        const fixAttempt = makeAttempt({
            toolName: 'exec_command',
            result: 'success',
            args: { command: 'winget install Graphviz.Graphviz' },
            executedAt: t0 + 1000,
        });
        const failedVerify = makeAttempt({
            planStepId: 'verify_456_def',
            toolName: 'exec_command',
            result: 'failure',
            args: { command: 'graphviz -V' },
            executedAt: t0 + 2000,
        });
        const goal = makeGoal([blocker], [fixAttempt, failedVerify]);

        const result = ok.captureFromGoal(goal);
        assert(result.captured === 0, 'step de verificação que FALHOU também não credita a captura', result);
    }

    // 21. computeConfidenceLevel — conhecimento novo (1 sucesso, sem falha) inicia 'weak', nunca
    //     direto em 'validated' (limiar de confirmações repetidas ainda não atingido).
    {
        const level = computeConfidenceLevel({ success_count: 1, last_event: 'success' });
        assert(level === 'weak', `conhecimento novo (1 sucesso) inicia com confiança 'weak', não 'validated' (veio: ${level})`);
    }

    // 22. computeConfidenceLevel — sem nenhum sucesso ainda, nível é 'none'
    {
        const level = computeConfidenceLevel({ success_count: 0, last_event: null });
        assert(level === 'none', `sem sucesso registrado, confiança é 'none' (veio: ${level})`);
    }

    // 23. computeConfidenceLevel — confirmações sucessivas (>=2 sucessos, evento mais recente =
    //     sucesso) elevam a confiança a 'validated'
    {
        const level = computeConfidenceLevel({ success_count: 2, last_event: 'success' });
        assert(level === 'validated', `2 confirmações sucessivas elevam a confiança a 'validated' (veio: ${level})`);
    }

    // 24. computeConfidenceLevel — falha posterior degrada a confiança mesmo com histórico de
    //     sucessos suficiente pro limiar de 'validated'
    {
        const level = computeConfidenceLevel({ success_count: 3, last_event: 'failure' });
        assert(level === 'degraded', `falha como evento mais recente degrada a confiança mesmo com 3 sucessos no histórico (veio: ${level})`);
    }

    // 25. getTacticalCommand — RECUPERAÇÃO end-to-end: 2 sucessos (validated) → 1 falha
    //     (degrada, deixa de ser reutilizado) → 1 sucesso novo (volta a ser elegível). O schema
    //     antigo (failure_count>0 bloqueava pra sempre) não permitia essa recuperação.
    {
        const ok = freshOperationalKnowledge();
        ok.recordAttempt('graphviz', 'winget install Graphviz.Graphviz', true);
        ok.recordAttempt('graphviz', 'winget install Graphviz.Graphviz', true);
        assert(ok.getTacticalCommand('graphviz') === 'winget install Graphviz.Graphviz', 'graphviz: 2 sucessos, elegível ao atalho tático');

        ok.recordAttempt('graphviz', 'winget install Graphviz.Graphviz', false);
        assert(ok.getTacticalCommand('graphviz') === null, 'graphviz: após falha, degrada e deixa de ser reutilizado pelo atalho tático');

        ok.recordAttempt('graphviz', 'winget install Graphviz.Graphviz', true);
        assert(ok.getTacticalCommand('graphviz') === 'winget install Graphviz.Graphviz', 'graphviz: novo sucesso após a falha recupera a elegibilidade (comportamento novo da Sprint E)');
    }

    // 26. buildEvidenceHint — o texto nomeia o nível de confiança (Evidence Provider: só
    //     enriquece o texto que o Planner pondera, nunca decide por ele)
    {
        const ok = freshOperationalKnowledge();
        ok.recordAttempt('graphviz', 'winget install Graphviz.Graphviz', true);
        const weakHint = ok.buildEvidenceHint('graphviz');
        assert(weakHint.includes('recém-aprendido'), 'buildEvidenceHint nomeia conhecimento recém-aprendido (weak) explicitamente', weakHint);

        ok.recordAttempt('graphviz', 'winget install Graphviz.Graphviz', true);
        const validatedHint = ok.buildEvidenceHint('graphviz');
        assert(validatedHint.includes('validado'), 'buildEvidenceHint nomeia conhecimento validado explicitamente', validatedHint);

        ok.recordAttempt('graphviz', 'winget install Graphviz.Graphviz', false);
        const degradedHint = ok.buildEvidenceHint('graphviz');
        assert(degradedHint.includes('degradado'), 'buildEvidenceHint nomeia conhecimento degradado explicitamente após falha', degradedHint);
    }

    // ── ADR-004 — um probe não pode ser eleito "comando que resolveu" ────────────────────────
    // Regressão do defeito observado em EXECUÇÃO REAL (Sprint G, 03/08/2026): o LLM rodou
    // `where sprintg-tool3 || echo "NOT FOUND"` antes do comando que de fato criou o binário, e a
    // heurística "primeiro exec_command bem-sucedido depois do blocker" gravou o `where` como
    // conhecimento operacional. Verificar não é instalar.
    {
        const ok = freshOperationalKnowledge();
        const t0 = Date.now();
        const blocker = makeBlocker({ detectedAt: t0, missingDependency: 'sprintg-tool3' });
        const probeAttempt = makeAttempt({
            toolName: 'exec_command', result: 'success',
            args: { command: 'where sprintg-tool3 || echo "NOT FOUND"' },
            executedAt: t0 + 1000,
        });
        const realFix = makeAttempt({
            toolName: 'exec_command', result: 'success',
            args: { command: 'echo @echo sprint-g3-ok > C:\\bin\\sprintg-tool3.cmd' },
            executedAt: t0 + 2000,
        });
        const goal = makeGoal([blocker], [probeAttempt, realFix]);

        const result = ok.captureFromGoal(goal, () => true);
        assert(result.captured === 1, 'ADR-004: captura acontece — o probe é pulado, não invalida o goal inteiro', result);
        const hint = ok.buildEvidenceHint('sprintg-tool3');
        assert(!hint.includes('where sprintg-tool3'), 'ADR-004: o comando de diagnóstico NÃO é o conhecimento aprendido', hint);
        assert(hint.includes('sprintg-tool3.cmd'), 'ADR-004: o comando aprendido é o que veio depois do probe', hint);
    }

    // Só probe, nenhum outro sucesso: silêncio, nunca gravar o diagnóstico como se fosse a solução.
    {
        const ok = freshOperationalKnowledge();
        const t0 = Date.now();
        const blocker = makeBlocker({ detectedAt: t0, missingDependency: 'yq' });
        const onlyProbe = makeAttempt({
            toolName: 'exec_command', result: 'success',
            args: { command: 'command -v yq' },
            executedAt: t0 + 1000,
        });
        const goal = makeGoal([blocker], [onlyProbe]);

        const result = ok.captureFromGoal(goal, () => true);
        assert(result.captured === 0, 'ADR-004: com apenas um probe como candidato, não captura nada (silêncio)', result);
    }

    // O reconhecedor não pode ser guloso: um comando que INSTALA e depois confere continua sendo
    // uma instalação — o que decide é o que a linha começa fazendo.
    {
        const ok = freshOperationalKnowledge();
        const t0 = Date.now();
        const blocker = makeBlocker({ detectedAt: t0, missingDependency: 'yq' });
        const installThenCheck = makeAttempt({
            toolName: 'exec_command', result: 'success',
            args: { command: 'winget install yq && where yq' },
            executedAt: t0 + 1000,
        });
        const goal = makeGoal([blocker], [installThenCheck]);

        const result = ok.captureFromGoal(goal, () => true);
        assert(result.captured === 1, 'ADR-004: "instalar && verificar" continua elegível — não é um probe', result);
        assert(ok.buildEvidenceHint('yq').includes('winget install yq'), 'ADR-004: comando de instalação preservado inteiro', ok.buildEvidenceHint('yq'));
    }

    // Probe de OUTRA dependência não bloqueia a captura da dependência sob análise.
    {
        const ok = freshOperationalKnowledge();
        const t0 = Date.now();
        const blocker = makeBlocker({ detectedAt: t0, missingDependency: 'yq' });
        const otherProbe = makeAttempt({
            toolName: 'exec_command', result: 'success',
            args: { command: 'where jq' },
            executedAt: t0 + 1000,
        });
        const goal = makeGoal([blocker], [otherProbe]);

        const result = ok.captureFromGoal(goal, () => true);
        assert(result.captured === 1, 'ADR-004: `where jq` não é probe de `yq` — segue candidato normal', result);
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S142 RESULTADO: ${passed} passou | ${failed} falhou`);
    if (failed > 0) process.exit(1);
    process.exit(0);
}

main().catch(err => { console.error('Erro no teste S142:', err); process.exit(1); });
