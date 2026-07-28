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
 * EXTENSÃO (2026-07-27, RFC-003 Sprint C — Research,
 * `docs/decisoes/RFC-003_AQUISICAO_CONHECIMENTO_OPERACIONAL.md`): casos 9-13 abaixo provam a
 * segunda fonte de resolução — quando KNOWN_DEPS (Distribuído) não tem entrada, GoalEvaluator
 * consulta OperationalKnowledge.getTacticalCommand() (Aprendido, Sprint A) antes de desistir.
 * Ordem "Reutilização" da RFC (1. Distribuído, 2. Aprendido) é testada explicitamente (caso 12).
 *
 * EXTENSÃO (2026-07-27, mesma RFC, Sprint C parte 2 — Pesquisa): casos 14-17 provam que, quando
 * NENHUMA das duas fontes resolve, o sistema deixa de cair direto no blocked/failed genérico —
 * gated por `permissionRegistry.can('install_dependencies')` (SAFE: comportamento idêntico a
 * antes desta Sprint), o blocker passa a sugerir pesquisa via web_search/web_navigate
 * (blocker.description/suggestedActions, o mesmo texto que buildReplanPrompt() já injeta no
 * prompt de replan — nenhuma tool nova, nenhum prompt novo, só uma evidência melhor).
 *
 * AJUSTE (2026-07-28, achado de teste real em ambiente isolado com LLM real — ver
 * `docs/decisoes/RFC-003_AQUISICAO_CONHECIMENTO_OPERACIONAL.md`): "KNOWN_DEPS tem entrada" e
 * "existe comando executável para ESTA plataforma" não eram a mesma coisa — a maioria do
 * catálogo (~24 de 26 entradas) só tem `installCmd` legado/Linux, sem `installByPlatform`, então
 * `resolveInstallCommand()` já resolvia `undefined` pra Windows/macOS mesmo com `dep` existindo.
 * Antes deste ajuste, isso caía direto em `needs_dependency` (via `if (dep)`) e NUNCA chegava ao
 * ramo de Pesquisa acima, mesmo tendo permissão e orçamento — confirmado ao vivo com `ffmpeg`
 * (KNOWN_DEPS tem entrada, mas sem installByPlatform.windows). Casos 17 (com comando resolvido,
 * puppeteer) / 17b (sem comando, DEVELOPER) / 17c (sem comando, SAFE) / 17d (sem comando, sem
 * replanBudget) provam a matriz completa dessa distinção.
 *
 * Execução: npx ts-node src/__tests__/regression/S141_KnownDeps_PuppeteerTesseractSelfHealing.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { GoalEvaluator } from '../../loop/GoalEvaluator';
import { Goal, PlanStep } from '../../loop/GoalTypes';
import { ToolResult } from '../../loop/agentLoopTypes';
import { resolveInstallCommand } from '../../loop/planning/resolveInstallCommand';
import { OperationalKnowledge, currentPlatform } from '../../memory/OperationalKnowledge';
import { permissionRegistry } from '../../core/PermissionRegistry';
import { OperationalMode } from '../../core/CapabilityMode';

function freshOperationalKnowledge(): OperationalKnowledge {
    const db = new (Database as any)(':memory:');
    const mockMemoryManager = { getDatabase: () => db } as any;
    return new OperationalKnowledge(mockMemoryManager);
}

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

    // 9. Sem entrada em KNOWN_DEPS, mas OperationalKnowledge tem comando elegível (>=2 sucessos,
    //    sem falha) para a mesma ferramenta+plataforma: outcome=needs_dependency, depInfo
    //    sintetizado com installByPlatform para o SO atual (mesmo formato de marp/puppeteer).
    {
        const ok = freshOperationalKnowledge();
        ok.recordAttempt('graphviz', 'winget install Graphviz.Graphviz', true);
        ok.recordAttempt('graphviz', 'winget install Graphviz.Graphviz', true);
        const evaluatorComOK = new GoalEvaluator(ok);
        const goal = makeGoal();
        const step = makeStep('exec_command');
        const result = makeFailure('bash: graphviz: command not found');
        const cycle = evaluatorComOK.evaluate(goal, step, result);
        assert(cycle.outcome === 'needs_dependency', `graphviz (aprendido): outcome é needs_dependency (veio: ${cycle.outcome})`, cycle);
        assert(cycle.depInfo?.name === 'graphviz', `graphviz (aprendido): depInfo.name correto (veio: ${cycle.depInfo?.name})`, cycle.depInfo);
        const platform = currentPlatform();
        assert(
            resolveInstallCommand(cycle.depInfo!, { platform }) === 'winget install Graphviz.Graphviz',
            'depInfo sintetizado resolve via resolveInstallCommand() sem nenhuma mudança na função',
            resolveInstallCommand(cycle.depInfo!, { platform })
        );
    }

    // 10. OperationalKnowledge existe mas NÃO é elegível (só 1 sucesso, abaixo do limiar) —
    //     não vira needs_dependency por este caminho (continua só evidência textual fraca,
    //     consumida em outro lugar via buildEvidenceHint(), nunca aqui).
    {
        const ok = freshOperationalKnowledge();
        ok.recordAttempt('sox', 'choco install sox.portable', true);
        const evaluatorComOK = new GoalEvaluator(ok);
        const goal = makeGoal();
        const step = makeStep('exec_command');
        const result = makeFailure('bash: sox: command not found');
        const cycle = evaluatorComOK.evaluate(goal, step, result);
        assert(cycle.outcome !== 'needs_dependency', `sox com 1 sucesso (abaixo do limiar): NÃO vira needs_dependency por este caminho (veio: ${cycle.outcome})`, cycle);
    }

    // 11. Sem OperationalKnowledge injetado (undefined) — comportamento idêntico ao anterior a
    //     esta Sprint, sem lançar exceção (fail-open, mesmo padrão de GoalExecutionLoop/GoalPlanner).
    {
        const evaluatorSemOK = new GoalEvaluator();
        const goal = makeGoal();
        const step = makeStep('exec_command');
        const result = makeFailure('bash: espeak: command not found');
        const cycle = evaluatorSemOK.evaluate(goal, step, result);
        assert(cycle.outcome !== 'needs_dependency', 'sem OperationalKnowledge injetado: dependência desconhecida não vira needs_dependency, sem exceção', cycle);
    }

    // 12. Ordem "Reutilização" da RFC-003: KNOWN_DEPS (Distribuído) tem prioridade sobre
    //     OperationalKnowledge (Aprendido) — mesmo que ambos tenham registro para a mesma
    //     ferramenta, o depInfo vem do catálogo distribuído, nunca do aprendido.
    {
        const ok = freshOperationalKnowledge();
        ok.recordAttempt('pandoc', 'comando-aprendido-que-nunca-deveria-vencer', true);
        ok.recordAttempt('pandoc', 'comando-aprendido-que-nunca-deveria-vencer', true);
        const evaluatorComOK = new GoalEvaluator(ok);
        const goal = makeGoal();
        const step = makeStep('exec_command');
        const result = makeFailure('bash: pandoc: command not found');
        const cycle = evaluatorComOK.evaluate(goal, step, result);
        assert(cycle.outcome === 'needs_dependency', 'pandoc: outcome é needs_dependency (via KNOWN_DEPS)', cycle);
        assert(
            cycle.depInfo?.installCmd === 'sudo apt install pandoc -y' || (cycle.depInfo?.manualInstructions?.includes('pandoc') ?? false),
            'pandoc: depInfo vem de KNOWN_DEPS (Distribuído), não do comando aprendido sintético',
            cycle.depInfo
        );
        assert(
            !cycle.depInfo?.manualInstructions?.includes('comando-aprendido-que-nunca-deveria-vencer'),
            'o comando aprendido NÃO vaza para o depInfo quando KNOWN_DEPS já resolve',
            cycle.depInfo
        );
    }

    // 13. Escalada "já tentamos instalar" funciona igual para dependência resolvida via
    //     OperationalKnowledge (mesmo comportamento já provado para KNOWN_DEPS no arquivo
    //     original de GoalEvaluator, S142 não cobre — aqui é o caminho aprendido específico).
    {
        const ok = freshOperationalKnowledge();
        ok.recordAttempt('sox', 'choco install sox.portable', true);
        ok.recordAttempt('sox', 'choco install sox.portable', true);
        const evaluatorComOK = new GoalEvaluator(ok);
        const goal = makeGoal();
        goal.strategiesTried = ['install_dep_sox'];
        const step = makeStep('exec_command');
        const result = makeFailure('bash: sox: command not found');
        const cycle = evaluatorComOK.evaluate(goal, step, result);
        assert(cycle.outcome === 'failed', `sox já tentado antes: escalada para failed (veio: ${cycle.outcome})`, cycle);
        assert(cycle.depInfo?.name === 'sox', 'depInfo ainda presente na escalada para failed', cycle.depInfo);
    }

    // 14. Dependência desconhecida (sem KNOWN_DEPS, sem OperationalKnowledge), modo DEVELOPER
    //     (permite aquisição) e replanBudget > 0: outcome=blocked, blocker sugere pesquisa via
    //     web_search/web_navigate — nunca decide a hipótese sozinho.
    {
        const modeBefore = permissionRegistry.getMode();
        permissionRegistry.setMode(OperationalMode.DEVELOPER, 'test-s141-14', true);
        try {
            const evaluatorSemOK = new GoalEvaluator();
            const goal = makeGoal();
            const step = makeStep('exec_command');
            const result = makeFailure('bash: graphviz-inexistente-xyz: command not found');
            const cycle = evaluatorSemOK.evaluate(goal, step, result);
            assert(cycle.outcome === 'blocked', `dependência desconhecida (DEVELOPER, budget>0): outcome é blocked (veio: ${cycle.outcome})`, cycle);
            assert(cycle.blocker?.kind === 'missing_tool', 'blocker.kind continua missing_tool (nenhum BlockerKind novo introduzido)', cycle.blocker);
            assert(/Pesquise|documentação oficial/i.test(cycle.blocker?.description ?? ''), 'blocker.description instrui pesquisar a documentação oficial', cycle.blocker);
            assert(
                (cycle.blocker?.suggestedActions ?? []).some(a => a.includes('web_search')) && (cycle.blocker?.suggestedActions ?? []).some(a => a.includes('web_navigate')),
                'suggestedActions menciona explicitamente web_search E web_navigate',
                cycle.blocker?.suggestedActions
            );
        } finally {
            permissionRegistry.setMode(modeBefore, 'test-s141-14-restore', true);
        }
    }

    // 15. Mesmo cenário em modo SAFE: NÃO sugere pesquisa — comportamento idêntico ao existente
    //     antes desta Sprint (blocked genérico ou failed, conforme replanBudget).
    {
        const modeBefore = permissionRegistry.getMode();
        permissionRegistry.setMode(OperationalMode.SAFE, 'test-s141-15');
        try {
            const evaluatorSemOK = new GoalEvaluator();
            const goal = makeGoal();
            const step = makeStep('exec_command');
            const result = makeFailure('bash: graphviz-inexistente-xyz: command not found');
            const cycle = evaluatorSemOK.evaluate(goal, step, result);
            assert(
                !(cycle.blocker?.suggestedActions ?? []).some(a => a.includes('web_search')),
                'em modo SAFE, suggestedActions NÃO menciona web_search — sem autonomia de pesquisa concedida',
                cycle.blocker?.suggestedActions
            );
        } finally {
            permissionRegistry.setMode(modeBefore, 'test-s141-15-restore', true);
        }
    }

    // 16. Mesmo cenário em modo DEVELOPER, mas SEM orçamento de replan: não sugere pesquisa
    //     (nenhum orçamento paralelo — respeita o mesmo replanBudget que já gate o blocked
    //     genérico, exatamente como pedido: "sem criar orçamento paralelo").
    {
        const modeBefore = permissionRegistry.getMode();
        permissionRegistry.setMode(OperationalMode.DEVELOPER, 'test-s141-16', true);
        try {
            const evaluatorSemOK = new GoalEvaluator();
            const goal = makeGoal();
            goal.replanBudget = 0;
            const step = makeStep('exec_command');
            const result = makeFailure('bash: graphviz-inexistente-xyz: command not found');
            const cycle = evaluatorSemOK.evaluate(goal, step, result);
            assert(
                !(cycle.blocker?.suggestedActions ?? []).some(a => a.includes('web_search')),
                'sem replanBudget restante, NÃO sugere pesquisa (mesmo orçamento do blocked genérico, não um paralelo)',
                cycle.blocker?.suggestedActions
            );
            assert(cycle.outcome === 'failed', 'sem nenhum orçamento, outcome é failed — igual ao comportamento anterior a esta Sprint', cycle);
        } finally {
            permissionRegistry.setMode(modeBefore, 'test-s141-16-restore', true);
        }
    }

    // 17. Dependência CONHECIDA **com comando resolvido pra esta plataforma** (puppeteer, tem
    //     installByPlatform pras 3 plataformas) continua needs_dependency em modo DEVELOPER —
    //     a sugestão de pesquisa nunca compete com uma resolução já determinística existente.
    {
        const modeBefore = permissionRegistry.getMode();
        permissionRegistry.setMode(OperationalMode.DEVELOPER, 'test-s141-17', true);
        try {
            const evaluatorSemOK = new GoalEvaluator();
            const goal = makeGoal();
            const step = makeStep('exec_command');
            const result = makeFailure('FALHA: cannot find puppeteer — nenhuma ferramenta de screenshot disponível.');
            const cycle = evaluatorSemOK.evaluate(goal, step, result);
            assert(cycle.outcome === 'needs_dependency', 'puppeteer (conhecido, com comando resolvido): continua needs_dependency em modo DEVELOPER', cycle);
            assert(cycle.depInfo?.name === 'puppeteer', 'depInfo continua vindo de KNOWN_DEPS, sugestão de pesquisa nunca compete com uma resolução real existente', cycle.depInfo);
        } finally {
            permissionRegistry.setMode(modeBefore, 'test-s141-17-restore', true);
        }
    }

    // 17b. RFC-003 Sprint C — Ajuste (2026-07-28, achado do teste real em ambiente isolado):
    //      dependência CONHECIDA em KNOWN_DEPS mas SEM comando resolvido pra esta plataforma
    //      (pandoc só tem installCmd legado/Linux, nada pra Windows) — em modo DEVELOPER, agora
    //      aciona o MESMO ramo de Pesquisa que uma dependência totalmente desconhecida usaria,
    //      em vez de cair direto no caminho manual sem nunca sugerir pesquisa.
    {
        const modeBefore = permissionRegistry.getMode();
        permissionRegistry.setMode(OperationalMode.DEVELOPER, 'test-s141-17b', true);
        try {
            const evaluatorSemOK = new GoalEvaluator();
            const goal = makeGoal();
            const step = makeStep('exec_command');
            const result = makeFailure('bash: pandoc: command not found');
            const cycle = evaluatorSemOK.evaluate(goal, step, result);
            assert(cycle.outcome === 'blocked', `pandoc (conhecido, SEM comando pra esta plataforma) em DEVELOPER: aciona Pesquisa, outcome=blocked (veio: ${cycle.outcome})`, cycle);
            assert(
                (cycle.blocker?.suggestedActions ?? []).some(a => a.includes('web_search')),
                'blocker sugere pesquisa via web_search, mesmo pandoc já tendo entrada em KNOWN_DEPS',
                cycle.blocker?.suggestedActions
            );
        } finally {
            permissionRegistry.setMode(modeBefore, 'test-s141-17b-restore', true);
        }
    }

    // 17c. Mesmo cenário (pandoc, sem comando pra esta plataforma), mas em modo SAFE: preserva
    //      EXATAMENTE o comportamento anterior a este ajuste — needs_dependency, nunca Pesquisa.
    {
        const modeBefore = permissionRegistry.getMode();
        permissionRegistry.setMode(OperationalMode.SAFE, 'test-s141-17c');
        try {
            const evaluatorSemOK = new GoalEvaluator();
            const goal = makeGoal();
            const step = makeStep('exec_command');
            const result = makeFailure('bash: pandoc: command not found');
            const cycle = evaluatorSemOK.evaluate(goal, step, result);
            assert(cycle.outcome === 'needs_dependency', `pandoc em modo SAFE: continua needs_dependency, comportamento anterior preservado (veio: ${cycle.outcome})`, cycle);
            assert(cycle.depInfo?.name === 'pandoc', 'depInfo continua vindo de KNOWN_DEPS em modo SAFE', cycle.depInfo);
        } finally {
            permissionRegistry.setMode(modeBefore, 'test-s141-17c-restore');
        }
    }

    // 17d. replanBudget respeitado também no caso "conhecido sem comando pra esta plataforma":
    //      sem orçamento restante, cai no caminho manual/legado de sempre, nunca sugere pesquisa.
    {
        const modeBefore = permissionRegistry.getMode();
        permissionRegistry.setMode(OperationalMode.DEVELOPER, 'test-s141-17d', true);
        try {
            const evaluatorSemOK = new GoalEvaluator();
            const goal = makeGoal();
            goal.replanBudget = 0;
            const step = makeStep('exec_command');
            const result = makeFailure('bash: pandoc: command not found');
            const cycle = evaluatorSemOK.evaluate(goal, step, result);
            assert(
                !(cycle.blocker?.suggestedActions ?? []).some(a => a.includes('web_search')),
                'pandoc (conhecido, sem comando), DEVELOPER, mas sem replanBudget: NÃO sugere pesquisa',
                cycle.blocker?.suggestedActions
            );
        } finally {
            permissionRegistry.setMode(modeBefore, 'test-s141-17d-restore', true);
        }
    }

    // 18. Ciclo real de esgotamento de orçamento: reproduz exatamente como
    //     GoalExecutionLoop decrementa replanBudget a cada 'blocked' → replan
    //     (`replanBudget: goal.replanBudget - 1`, GoalExecutionLoop.ts, ex.: linha 995) — prova
    //     que a sugestão de pesquisa se repete enquanto sobrar orçamento e desaparece
    //     exatamente quando o MESMO orçamento (nenhum contador paralelo) se esgota, não antes.
    {
        const modeBefore = permissionRegistry.getMode();
        permissionRegistry.setMode(OperationalMode.DEVELOPER, 'test-s141-18', true);
        try {
            const evaluatorSemOK = new GoalEvaluator();
            let goal = makeGoal();
            goal.replanBudget = 2;
            const step = makeStep('exec_command');
            const result = makeFailure('bash: graphviz-inexistente-xyz: command not found');

            // Rodada 1 — orçamento=2: sugere pesquisa.
            let cycle = evaluatorSemOK.evaluate(goal, step, result);
            assert(cycle.outcome === 'blocked', `rodada 1 (orçamento=2): outcome é blocked (veio: ${cycle.outcome})`, cycle);
            assert((cycle.blocker?.suggestedActions ?? []).some(a => a.includes('web_search')), 'rodada 1: sugere pesquisa', cycle.blocker);

            // GoalExecutionLoop decrementaria o orçamento aqui, exatamente como faz hoje ao
            // processar um outcome=blocked (mesmo campo, mesma aritmética, replicada no teste).
            goal = { ...goal, replanBudget: goal.replanBudget - 1 };
            assert(goal.replanBudget === 1, 'orçamento decrementado para 1 após a 1ª rodada (mesmo mecanismo já existente, nenhum contador novo)', goal.replanBudget);

            // Rodada 2 — orçamento=1: ainda sugere pesquisa (mesma hipótese pode ser
            // reformulada pelo Planner com nova evidência).
            cycle = evaluatorSemOK.evaluate(goal, step, result);
            assert(cycle.outcome === 'blocked', `rodada 2 (orçamento=1): outcome ainda é blocked (veio: ${cycle.outcome})`, cycle);
            assert((cycle.blocker?.suggestedActions ?? []).some(a => a.includes('web_search')), 'rodada 2: ainda sugere pesquisa', cycle.blocker);

            goal = { ...goal, replanBudget: goal.replanBudget - 1 };
            assert(goal.replanBudget === 0, 'orçamento decrementado para 0 após a 2ª rodada', goal.replanBudget);

            // Rodada 3 — orçamento=0: ciclo termina, cai no caminho manual/failed de sempre,
            // SEM mais sugerir pesquisa — o mesmo orçamento que já limitava qualquer replan
            // antes desta Sprint é o que também limita o ciclo de pesquisa, exatamente como
            // RFC-003 exige ("Condição de Parada do Ciclo": nenhum orçamento paralelo).
            cycle = evaluatorSemOK.evaluate(goal, step, result);
            assert(cycle.outcome === 'failed', `rodada 3 (orçamento=0): ciclo termina, outcome é failed (veio: ${cycle.outcome})`, cycle);
            assert(
                !(cycle.blocker?.suggestedActions ?? []).some(a => a.includes('web_search')),
                'rodada 3: NÃO sugere mais pesquisa — orçamento esgotado, mesmo mecanismo que já parava qualquer replan',
                cycle.blocker?.suggestedActions
            );
        } finally {
            permissionRegistry.setMode(modeBefore, 'test-s141-18-restore', true);
        }
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S141 RESULTADO: ${passed} passou | ${failed} falhou`);
    if (failed > 0) process.exit(1);
    process.exit(0);
}

main();
