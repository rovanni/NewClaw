/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S33
 * Unificação do classificador de executável ausente (extractMissingExecutable, pura, em
 * src/loop/planning/extractMissingExecutable.ts).
 *
 * ACHADO REAL (auditoria desta sessão, sem código): a mesma pergunta — "este erro indica um
 * executável ausente?" — era respondida por 3 implementações divergentes:
 *   1. GoalEvaluator.extractMissingToolName() (método privado)
 *   2. GoalEvaluator.classifyError(): const local `isCommandMissing`, no branch
 *      toolName==='exec_command' — regex própria e mais estreita que (1)/ERROR_PATTERNS,
 *      SEM o texto do cmd.exe no Windows ("is not recognized...") nem "spawn ENOENT" — a
 *      ausência do 2º é estruturalmente correta (exec_command roda via shell, nunca produz
 *      "spawn X ENOENT" para o comando invocado), mas a ausência do 1º era um bug real: um
 *      binário realmente ausente no Windows via exec_command virava "tool_error" (caminho não
 *      encontrado) em vez de "missing_tool".
 *   3. AgentLoop.resumeFromWorkflow(): const local `isCommandNotFound`, com `ENOENT` bare —
 *      mesmo falso-positivo de ENOENT de arquivo/diretório (ex: input ausente) que já tinha
 *      sido corrigido em GoalEvaluator.ts nesta sessão, mas nunca replicado aqui.
 *   NÃO existe (nem nunca existiu) um classificador equivalente em exec_command.ts — confirmado
 *   por busca global antes da extração.
 *
 * FIX: as 3 implementações foram substituídas por uma única função pura
 * (extractMissingExecutable), consumida por GoalEvaluator.ts e AgentLoop.ts.
 *
 * Cobre os 18 casos pedidos: 1-13 função pura, 14-15 GoalEvaluator (exec_command), 16-17
 * AgentLoop (via chamada real à função compartilhada, mesma expressão usada em produção,
 * sem reimplementar regex), 18 regressão KNOWN_DEPS (ffmpeg/pandoc/marp).
 *
 * Execução: npx ts-node src/__tests__/regression/S33_UnifiedMissingExecutableClassifier.test.ts
 */

process.env.WORKSPACE_DIR = process.env.WORKSPACE_DIR || 'D:/IA/newclaw/workspace';

import * as fs from 'fs';
import * as path from 'path';
import { extractMissingExecutable } from '../../loop/planning/extractMissingExecutable';
import { GoalEvaluator } from '../../loop/GoalEvaluator';
import { ExecCommandTool } from '../../tools/exec_command';
import { Goal, PlanStep } from '../../loop/GoalTypes';
import { ToolResult } from '../../loop/agentLoopTypes';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

// ── 1-13: função pura extractMissingExecutable() ────────────────────────────

console.log('\n=== S33-1 — "spawn edge-tts ENOENT" → "edge-tts" ===');
assert(extractMissingExecutable('spawn edge-tts ENOENT') === 'edge-tts', 'extraído', extractMissingExecutable('spawn edge-tts ENOENT'));

console.log('\n=== S33-2 — "spawn ffmpeg ENOENT" → "ffmpeg" ===');
assert(extractMissingExecutable('spawn ffmpeg ENOENT') === 'ffmpeg', 'extraído', extractMissingExecutable('spawn ffmpeg ENOENT'));

console.log('\n=== S33-3 — "spawnSync edge-tts ENOENT" → "edge-tts" ===');
assert(extractMissingExecutable('spawnSync edge-tts ENOENT') === 'edge-tts', 'extraído', extractMissingExecutable('spawnSync edge-tts ENOENT'));

console.log('\n=== S33-4 — "\'edge-tts\' is not recognized..." → "edge-tts" ===');
{
    const msg = "'edge-tts' is not recognized as an internal or external command,\r\noperable program or batch file.";
    assert(extractMissingExecutable(msg) === 'edge-tts', 'extraído', extractMissingExecutable(msg));
}

console.log('\n=== S33-4b — "\'yq\' não é reconhecido..." (Windows pt-BR) → "yq" ===');
{
    const msg = "'yq' não é reconhecido como um comando interno ou externo,\r\num programa operável ou um arquivo em lotes.";
    assert(extractMissingExecutable(msg) === 'yq', 'extraído', extractMissingExecutable(msg));
}

console.log('\n=== S33-4c — "\'yq\' n\\uFFFDo \\uFFFD reconhecido..." (Windows pt-BR, mojibake real) → "yq" ===');
{
    // Achado real (validação E2E, 24/07, 2ª rodada): o cmd.exe emite "não é" num codepage que
    // o child_process do Node não decodifica como UTF-8 — os acentos viram U+FFFD de verdade em
    // produção, nunca chegam intactos. Casar com o texto "correto" (S33-4b) não bastava.
    const msg = "'yq' n�o � reconhecido como um comando interno ou externo,\r\num programa oper�vel ou um arquivo em lotes.";
    assert(extractMissingExecutable(msg) === 'yq', 'extraído mesmo com mojibake de codepage', extractMissingExecutable(msg));
}

console.log('\n=== S33-5 — "edge-tts: command not found" → "edge-tts" ===');
assert(extractMissingExecutable('edge-tts: command not found') === 'edge-tts', 'extraído', extractMissingExecutable('edge-tts: command not found'));

console.log('\n=== S33-6 — "which: no ffmpeg in (...)" → "ffmpeg" ===');
assert(extractMissingExecutable('which: no ffmpeg in (/usr/bin)') === 'ffmpeg', 'extraído', extractMissingExecutable('which: no ffmpeg in (/usr/bin)'));

console.log('\n=== S33-7 — "ENOENT: no such file or directory, open \'input.mp3\'" → null ===');
assert(extractMissingExecutable("ENOENT: no such file or directory, open 'input.mp3'") === null, 'null (arquivo, não executável)');

console.log('\n=== S33-8 — "ENOENT: no such file or directory, scandir \'temp\'" → null ===');
assert(extractMissingExecutable("ENOENT: no such file or directory, scandir 'temp'") === null, 'null (diretório, não executável)');

console.log('\n=== S33-9 — "ENOENT: no such file or directory, stat \'x\'" → null ===');
assert(extractMissingExecutable("ENOENT: no such file or directory, stat 'x'") === null, 'null (stat, não executável)');

console.log('\n=== S33-10 — spawn com path absoluto Windows + .exe → "edge-tts" ===');
{
    const msg = 'spawn C:\\Python\\Scripts\\edge-tts.exe ENOENT';
    assert(extractMissingExecutable(msg) === 'edge-tts', 'basename + strip .exe', extractMissingExecutable(msg));
}

console.log('\n=== S33-11 — executável .cmd → normalização correta ===');
assert(extractMissingExecutable('spawn ffmpeg.cmd ENOENT') === 'ffmpeg', 'strip .cmd', extractMissingExecutable('spawn ffmpeg.cmd ENOENT'));

console.log('\n=== S33-12 — executável .bat → normalização correta ===');
assert(extractMissingExecutable('spawn marp.bat ENOENT') === 'marp', 'strip .bat', extractMissingExecutable('spawn marp.bat ENOENT'));

console.log('\n=== S33-13 — extensão arbitrária → não remover cegamente ===');
assert(extractMissingExecutable('spawn script.py ENOENT') === 'script.py', 'extensão .py preservada', extractMissingExecutable('spawn script.py ENOENT'));

// ── 14-15, 18: GoalEvaluator (consumidor real) ──────────────────────────────

function makeGoal(overrides: Partial<Goal> = {}): Goal {
    const now = Date.now();
    return {
        id: 'goal_test', sessionKey: 'test:user', conversationId: 'conv',
        userIntent: '', objective: '', status: 'executing',
        currentPlan: [], attempts: [], blockers: [], toolsTried: [], strategiesTried: [],
        successCriteria: [], retryBudget: 3, replanBudget: 5, confidence: 0.9,
        requiresAuth: false, authorizationScope: [],
        createdAt: now, updatedAt: now, expiresAt: now + 3_600_000,
        ...overrides,
    } as Goal;
}

function step(id: string, toolName?: string): PlanStep {
    return { id, description: id, toolName, toolArgs: {}, fallbackSteps: [], status: 'pending' };
}

function failResult(error: string, exitCode?: number): ToolResult {
    return { success: false, output: '', error, ...(exitCode !== undefined ? { exitCode } : {}) };
}

const evaluator = new GoalEvaluator();

console.log('\n=== S33-14 — GoalEvaluator + exec_command + Windows "not recognized" (EN) → missing_tool ===');
{
    const g = makeGoal();
    const msg = "'edge-tts' is not recognized as an internal or external command,\r\noperable program or batch file.\n[exit code: 1]";
    const r = evaluator.evaluate(g, step('s1', 'exec_command'), failResult(msg));
    assert(r.blocker?.kind === 'missing_tool', `kind === missing_tool (obtido: ${r.blocker?.kind}) — divergência Windows corrigida`, r.blocker);
    assert(r.blocker?.missingDependency === 'edge-tts', `blocker.missingDependency === 'edge-tts' (obtido: ${r.blocker?.missingDependency})`, r.blocker);
    assert(r.blocker?.toolName === 'exec_command', `blocker.toolName continua sendo a tool que falhou, 'exec_command' — NUNCA a dependência (obtido: ${r.blocker?.toolName})`, r.blocker);
    assert(r.outcome === 'needs_dependency' && r.depInfo?.name === 'edge-tts', 'vira needs_dependency com depInfo edge-tts', r);
}

console.log('\n=== S33-14b — GoalEvaluator + exec_command + Windows "não é reconhecido" (PT-BR) → missing_tool ===');
{
    // Achado real da validação E2E (24/07, docs/DIRETRIZ_ARQUITETURA_2026-07-13.md): cmd.exe em
    // uma instalação Windows configurada em português nunca batia no regex (só inglês) — o
    // blocker nunca virava missing_tool, a dependência nunca era aprendida.
    const g = makeGoal();
    const msg = "'yq' não é reconhecido como um comando interno ou externo,\r\num programa operável ou um arquivo em lotes.\n[exit code: 1]";
    const r = evaluator.evaluate(g, step('s1', 'exec_command'), failResult(msg));
    assert(r.blocker?.kind === 'missing_tool', `kind === missing_tool para mensagem pt-BR (obtido: ${r.blocker?.kind})`, r.blocker);
    assert(r.blocker?.missingDependency === 'yq', `blocker.missingDependency === 'yq' (obtido: ${r.blocker?.missingDependency})`, r.blocker);
    assert(r.blocker?.toolName === 'exec_command', `blocker.toolName === 'exec_command' (a tool, não a dependência)`, r.blocker);
}

console.log('\n=== S33-15 — GoalEvaluator + exec_command + ENOENT de arquivo → NÃO missing_tool ===');
{
    const g = makeGoal();
    const r = evaluator.evaluate(g, step('s1', 'exec_command'), failResult("ENOENT: no such file or directory, open 'input.mp3'"));
    assert(r.blocker?.kind !== 'missing_tool', `kind NÃO é missing_tool (obtido: ${r.blocker?.kind})`, r.blocker);
    assert(r.outcome !== 'needs_dependency', 'não vira needs_dependency', r);
}

console.log('\n=== S33-18 — regressão KNOWN_DEPS: ffmpeg/pandoc/marp preservados ===');
{
    assert(extractMissingExecutable('bash: pandoc: command not found') === 'pandoc', 'pandoc preservado');
    assert(extractMissingExecutable('which: no ffmpeg in (/usr/bin)') === 'ffmpeg', 'ffmpeg preservado');
    assert(extractMissingExecutable("cannot find 'marp'") === 'marp', 'marp preservado');

    const g = makeGoal();
    const r = evaluator.evaluate(g, step('s1', 'exec_command'), failResult('bash: ffmpeg: command not found'));
    assert(r.outcome === 'needs_dependency' && r.depInfo?.name === 'ffmpeg', 'ffmpeg via exec_command ainda vira needs_dependency', r);
    assert(r.blocker?.missingDependency === 'ffmpeg', `blocker.missingDependency === 'ffmpeg' (obtido: ${r.blocker?.missingDependency})`, r.blocker);

    const g2 = makeGoal();
    const r2 = evaluator.evaluate(g2, step('s2', 'send_audio'), failResult('Erro ao gerar áudio: spawn edge-tts ENOENT'));
    assert(r2.outcome === 'needs_dependency' && r2.depInfo?.name === 'edge-tts', 'edge-tts via send_audio ainda vira needs_dependency', r2);
    assert(r2.blocker?.missingDependency === 'edge-tts', `blocker.missingDependency === 'edge-tts' mesmo fora de exec_command (obtido: ${r2.blocker?.missingDependency})`, r2.blocker);
    assert(r2.blocker?.toolName === 'send_audio', `blocker.toolName === 'send_audio' (a tool que falhou, não a dependência)`, r2.blocker);
}

// ── 16-17: AgentLoop (consumidor real, via chamada à mesma função compartilhada) ─────────

console.log('\n=== S33-16 — AgentLoop: executable missing real → instrução de ferramenta ausente ===');
{
    // Mesma expressão usada em AgentLoop.resumeFromWorkflow(): concatena error+output e testa
    // !== null — chamando a função REAL exportada, não uma cópia da regex.
    const resultError = 'spawn edge-tts ENOENT';
    const resultOutput = '';
    const isCommandNotFound = extractMissingExecutable(resultError + resultOutput) !== null;
    assert(isCommandNotFound === true, 'isCommandNotFound=true para executável realmente ausente');
}

console.log('\n=== S33-17 — AgentLoop: ENOENT de arquivo/diretório → NÃO instrução de ferramenta ausente ===');
{
    const resultError = "ENOENT: no such file or directory, open 'input.mp3'";
    const resultOutput = '';
    const isCommandNotFound = extractMissingExecutable(resultError + resultOutput) !== null;
    assert(isCommandNotFound === false, 'isCommandNotFound=false para ENOENT de arquivo (antes seria true — falso positivo)');
}

console.log('\n=== S33-extra — inspeção de source: AgentLoop consome a função compartilhada, sem regex duplicada ===');
{
    const agentLoopPath = path.join(process.cwd(), 'src', 'loop', 'AgentLoop.ts');
    const src = fs.readFileSync(agentLoopPath, 'utf-8');
    assert(/import\s*\{\s*extractMissingExecutable\s*\}\s*from\s*'\.\/planning\/extractMissingExecutable'/.test(src), 'AgentLoop.ts importa extractMissingExecutable do módulo compartilhado');
    assert(!/command not found\|not found\|exit code: 127\|which: no\|cannot find\|ENOENT/.test(src), 'regex antiga (ENOENT bare) removida de AgentLoop.ts');
}

console.log('\n=== S33-extra — inspeção de source: GoalEvaluator sem duplicação residual ===');
{
    const goalEvaluatorPath = path.join(process.cwd(), 'src', 'loop', 'GoalEvaluator.ts');
    const src = fs.readFileSync(goalEvaluatorPath, 'utf-8');
    assert(/import\s*\{\s*extractMissingExecutable\s*\}\s*from\s*'\.\/planning\/extractMissingExecutable'/.test(src), 'GoalEvaluator.ts importa extractMissingExecutable do módulo compartilhado');
    assert(!/private extractMissingToolName/.test(src), 'método privado extractMissingToolName removido (duplicação eliminada)');
    assert(!/const isCommandMissing = \/command not found/.test(src), 'const local isCommandMissing (regex estreita) removida');
    // Correção 24/07 (item 1 do checklist missing_tool): "[exit code: 127]" e "is not recognized
    // as an internal or external command" saem de ERROR_PATTERNS — o 1º porque virou checagem
    // estrutural de exitCode, o 2º porque já é coberto por extractMissingExecutable() (checado
    // antes de ERROR_PATTERNS em classifyError()). Manter os dois ali seria regex duplicada.
    assert(!/\\\[exit code: 127\\\]/.test(src), 'ERROR_PATTERNS não contém mais o texto "[exit code: 127]" (agora é ToolResult.exitCode estruturado)');
    assert(!/is not recognized as an internal or external command/.test(src), 'ERROR_PATTERNS não contém mais "is not recognized..." (duplicava extractMissingExecutable())');
}

console.log('\n=== S33-19 — GoalEvaluator + exitCode=127 estruturado, SEM nenhum texto reconhecível → missing_tool ===');
{
    // Prova que exitCode (dado estruturado, não regex sobre error/output) decide sozinho, mesmo
    // com uma mensagem de erro completamente opaca — nenhuma palavra em inglês nem português que
    // qualquer regex de missing_tool reconheceria.
    const g = makeGoal();
    const r = evaluator.evaluate(g, step('s1', 'exec_command'), failResult('xK9#zx_falha_opaca_sem_nenhum_padrao_conhecido', 127));
    assert(r.blocker?.kind === 'missing_tool', `kind === missing_tool só por exitCode=127, sem texto reconhecível (obtido: ${r.blocker?.kind})`, r.blocker);
    assert(r.blocker?.missingDependency === undefined, 'missingDependency fica undefined quando o nome não é extraível (exitCode não inventa nome)', r.blocker);
}

console.log('\n=== S33-20 — GoalEvaluator + exitCode=127 estruturado + nome extraível → missing_tool COM missingDependency ===');
{
    const g = makeGoal();
    const r = evaluator.evaluate(g, step('s1', 'exec_command'), failResult('bash: pandoc: command not found', 127));
    assert(r.blocker?.kind === 'missing_tool', 'kind === missing_tool', r.blocker);
    assert(r.blocker?.missingDependency === 'pandoc', `missingDependency ainda extraído normalmente quando disponível (obtido: ${r.blocker?.missingDependency})`, r.blocker);
}

(async () => {
    console.log('\n=== S33-21 — ExecCommandTool real: exitCode do processo propagado como ToolResult.exitCode ===');
    {
        // Processo real (node, sempre disponível neste ambiente de teste), saindo com um código
        // conhecido — cross-platform (cmd.exe e bash propagam o exit code de um processo filho
        // igual), sem depender de nenhuma mensagem de "comando não encontrado" em nenhum idioma.
        const tool = new ExecCommandTool();
        const r = await tool.execute({ command: 'node -e "process.exit(127)"' });
        assert(r.success === false, 'processo com exit code 127 é reportado como falha', r);
        assert(r.exitCode === 127, `ToolResult.exitCode reflete o exit code real do processo (obtido: ${r.exitCode})`, r);
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S33 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    if (failed > 0) process.exit(1);
})().catch(err => { console.error('Erro no teste S33 (bloco async):', err); process.exit(1); });
