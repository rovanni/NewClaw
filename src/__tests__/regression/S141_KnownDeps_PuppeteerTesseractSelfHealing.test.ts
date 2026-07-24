/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S141 (Milestone M1: Self-Healing de Dependências)
 *
 * Prova o fluxo ponta a ponta mapeado na auditoria desta Sprint:
 *   erro do exec_command → GoalEvaluator.classify() → blocker.kind → KNOWN_DEPS →
 *   depInfo devolvido em CycleResult.
 *
 * Contexto do achado que motivou esta mudança: `scripts/html2pdf.sh` nunca deixava o erro
 * cru do SO vazar — sempre terminava com uma mensagem própria ("FALHA: Nenhuma ferramenta...
 * disponível. Instale puppeteer-core + google-chrome-stable.") que não continha nenhum
 * substring reconhecido pelo padrão `missing_tool` de GoalEvaluator.ts (ERROR_PATTERNS,
 * linha ~95: precisa de "command not found"/"not found"/"cannot find"/etc). Resultado:
 * a falha caía em `blocker.kind='tool_error'` genérico, perdendo tanto o atalho determinístico
 * (KNOWN_DEPS) quanto a diretriz de replan específica de GoalPlanner.ts:491 — mesmo que
 * KNOWN_DEPS tivesse uma entrada para puppeteer, nada disso engatava.
 *
 * Esta Sprint corrigiu as duas pontas juntas, e o teste prova a combinação:
 *   1. A nova mensagem do html2pdf.sh ("cannot find puppeteer — ...") bate no padrão
 *      missing_tool E permite que extractMissingExecutable() extraia "puppeteer" (não
 *      "puppeteer-core" nem outra variação) como nome da ferramenta ausente.
 *   2. KNOWN_DEPS['puppeteer'] existe e resolve via installByPlatform (cross-platform:
 *      npm install puppeteer funciona igual em Windows/Linux/macOS — evita tanto o
 *      fallback "só Linux" quanto o problema conhecido de `apt install chromium`
 *      redirecionar para pacote snap no Ubuntu moderno).
 *   3. KNOWN_DEPS['tesseract'] existe (usado por read_document.ts, extractOcr/pdfOcr) —
 *      esse caminho já classificava corretamente sem nenhuma mudança de mensagem (erro real
 *      de shell/cmd.exe já bate nos padrões existentes); só faltava a entrada no catálogo.
 *   4. Nenhuma decisão nova foi introduzida: os dois casos abaixo passam pelo MESMO
 *      GoalEvaluator.evaluate()/KNOWN_DEPS/resolveInstallCommand() já existentes — sem
 *      mudança de filosofia do GoalPlanner, sem CaseMemory, sem memória nova.
 *
 * Execução: npx ts-node src/__tests__/regression/S141_KnownDeps_PuppeteerTesseractSelfHealing.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { GoalEvaluator } from '../../loop/GoalEvaluator';
import { Goal, PlanStep } from '../../loop/GoalTypes';
import { ToolResult } from '../../loop/agentLoopTypes';
import { resolveInstallCommand } from '../../loop/planning/resolveInstallCommand';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  OK ${message}`); passed++; }
    else { console.error(`  FALHOU: ${message}`, detail ?? ''); failed++; }
}

function makeGoal(): Goal {
    const now = Date.now();
    return {
        id: 'goal_s141',
        sessionKey: 'telegram:1',
        conversationId: '1',
        userIntent: 'revisar visualmente um HTML gerado',
        objective: 'revisar visualmente um HTML gerado',
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
    } as Goal;
}

function makeStep(toolName: string): PlanStep {
    return {
        id: 'step_s141',
        description: 'step de teste',
        toolName,
        toolArgs: {},
        fallbackSteps: [],
        status: 'executing',
    };
}

function makeFailure(error: string): ToolResult {
    return { success: false, output: '', error };
}

function main(): void {
    console.log('\n=== S141 — Self-Healing de Dependências: puppeteer + tesseract via KNOWN_DEPS ===');
    const evaluator = new GoalEvaluator();

    // 1. Mensagem NOVA do html2pdf.sh (modo screenshot) → classificada como missing_tool,
    //    dependência resolvida como 'puppeteer', outcome=needs_dependency.
    {
        const goal = makeGoal();
        const step = makeStep('exec_command');
        const result = makeFailure(
            'FALHA: cannot find puppeteer — nenhuma ferramenta de screenshot disponível. Instale com: npm install puppeteer'
        );
        const cycle = evaluator.evaluate(goal, step, result);
        assert(cycle.outcome === 'needs_dependency', `modo screenshot: outcome é needs_dependency (veio: ${cycle.outcome})`, cycle);
        assert(cycle.blocker?.kind === 'missing_tool', `modo screenshot: blocker.kind é missing_tool (veio: ${cycle.blocker?.kind})`, cycle.blocker);
        assert(cycle.depInfo?.name === 'puppeteer', `modo screenshot: depInfo.name é 'puppeteer' (veio: ${cycle.depInfo?.name})`, cycle.depInfo);
    }

    // 2. Mensagem NOVA do html2pdf.sh (modo PDF) — mesma correção, outro branch do script.
    {
        const goal = makeGoal();
        const step = makeStep('exec_command');
        const result = makeFailure(
            'FALHA: cannot find puppeteer — nenhuma ferramenta PDF disponível. Instale com: npm install puppeteer (ou wkhtmltopdf).'
        );
        const cycle = evaluator.evaluate(goal, step, result);
        assert(cycle.outcome === 'needs_dependency', `modo PDF: outcome é needs_dependency (veio: ${cycle.outcome})`, cycle);
        assert(cycle.depInfo?.name === 'puppeteer', `modo PDF: depInfo.name é 'puppeteer' (veio: ${cycle.depInfo?.name})`, cycle.depInfo);
    }

    // 3. tesseract ausente (Linux) — erro real de shell, já batia no padrão antes desta
    //    mudança; só a entrada em KNOWN_DEPS estava faltando.
    {
        const goal = makeGoal();
        const step = makeStep('read_document');
        const result = makeFailure("Command failed: tesseract \"foo.png\" stdout -l por+eng\n/bin/sh: 1: tesseract: not found");
        const cycle = evaluator.evaluate(goal, step, result);
        assert(cycle.outcome === 'needs_dependency', `tesseract (Linux): outcome é needs_dependency (veio: ${cycle.outcome})`, cycle);
        assert(cycle.depInfo?.name === 'tesseract-ocr', `tesseract (Linux): depInfo.name é 'tesseract-ocr' (veio: ${cycle.depInfo?.name})`, cycle.depInfo);
    }

    // 4. tesseract ausente (Windows) — mesmo teste, formato de erro do cmd.exe.
    {
        const goal = makeGoal();
        const step = makeStep('read_document');
        const result = makeFailure("'tesseract' is not recognized as an internal or external command,\noperable program or batch file.");
        const cycle = evaluator.evaluate(goal, step, result);
        assert(cycle.outcome === 'needs_dependency', `tesseract (Windows): outcome é needs_dependency (veio: ${cycle.outcome})`, cycle);
        assert(cycle.depInfo?.name === 'tesseract-ocr', `tesseract (Windows): depInfo.name é 'tesseract-ocr' (veio: ${cycle.depInfo?.name})`, cycle.depInfo);
    }

    // 5. resolveInstallCommand: puppeteer resolve em TODAS as plataformas (installByPlatform,
    //    igual ao padrão já usado por 'marp') — nunca cai no fallback "só Linux".
    {
        const goal = makeGoal();
        const step = makeStep('exec_command');
        const result = makeFailure('FALHA: cannot find puppeteer — nenhuma ferramenta de screenshot disponível.');
        const cycle = evaluator.evaluate(goal, step, result);
        const dep = cycle.depInfo!;
        assert(
            resolveInstallCommand(dep, { platform: 'windows' }) === 'npm install puppeteer',
            'puppeteer resolve em Windows via installByPlatform',
            resolveInstallCommand(dep, { platform: 'windows' })
        );
        assert(
            resolveInstallCommand(dep, { platform: 'linux' }) === 'npm install puppeteer',
            'puppeteer resolve em Linux via installByPlatform',
            resolveInstallCommand(dep, { platform: 'linux' })
        );
        assert(
            resolveInstallCommand(dep, { platform: 'macos' }) === 'npm install puppeteer',
            'puppeteer resolve em macOS via installByPlatform',
            resolveInstallCommand(dep, { platform: 'macos' })
        );
    }

    // 6. resolveInstallCommand: tesseract é apt-only por desenho (mesmo padrão de 90% das
    //    outras entradas) — sem comando Windows/macOS inventado, resolveInstallCommand devolve
    //    undefined fora do Linux (nunca assume, nunca arrisca — ver docstring da função).
    {
        const goal = makeGoal();
        const step = makeStep('read_document');
        const result = makeFailure("/bin/sh: 1: tesseract: not found");
        const cycle = evaluator.evaluate(goal, step, result);
        const dep = cycle.depInfo!;
        assert(
            resolveInstallCommand(dep, { platform: 'linux' }) === 'sudo apt install tesseract-ocr tesseract-ocr-por -y',
            'tesseract resolve em Linux',
            resolveInstallCommand(dep, { platform: 'linux' })
        );
        assert(
            resolveInstallCommand(dep, { platform: 'windows' }) === undefined,
            'tesseract NÃO resolve em Windows — sem comando inventado, cai no caminho manual/LLM',
            resolveInstallCommand(dep, { platform: 'windows' })
        );
    }

    // 7. Regressão estrutural: a mensagem antiga do html2pdf.sh (sem "cannot find") NÃO
    //    deveria mais existir no script — prova que a correção realmente foi aplicada, não
    //    só documentada. Lê o arquivo real, não uma cópia.
    {
        const scriptPath = path.join(process.cwd(), 'scripts', 'html2pdf.sh');
        const src = fs.readFileSync(scriptPath, 'utf-8');
        assert(src.includes('cannot find puppeteer'), 'html2pdf.sh contém a mensagem corrigida ("cannot find puppeteer")', scriptPath);
        assert(
            !/Nenhuma ferramenta de screenshot disponível\. Instale puppeteer-core \+ google-chrome-stable\./.test(src),
            'html2pdf.sh NÃO contém mais a mensagem antiga (sem substring reconhecível)',
            scriptPath
        );
    }

    // 8. Não regressão: dependências pré-existentes continuam funcionando exatamente igual
    //    (nenhuma mudança de comportamento fora de puppeteer/tesseract).
    {
        const goal = makeGoal();
        const step = makeStep('exec_command');
        const result = makeFailure('bash: pandoc: command not found');
        const cycle = evaluator.evaluate(goal, step, result);
        assert(cycle.outcome === 'needs_dependency', 'pandoc continua funcionando sem regressão', cycle);
        assert(cycle.depInfo?.name === 'pandoc', 'pandoc continua resolvendo para o depInfo correto', cycle.depInfo);
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S141 RESULTADO: ${passed} passou | ${failed} falhou`);
    if (failed > 0) process.exit(1);
    process.exit(0);
}

main();
