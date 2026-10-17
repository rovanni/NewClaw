/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S432
 * "Not found" num resultado NÃO é, por si só, "ferramenta/comando ausente": o avaliador só conclui comando ausente quando o
 * sinal diz isso (exit 127, nome extraível do binário, ou a frase "command not found"). Fora disso, vale o TEXTO REAL.
 *
 * INCIDENTE REAL (Windows, 16/10/2026, 3º teste "instalar o GenOffice"):
 *  - api_request no registro do npm devolveu 404 → blocker "Ferramenta 'api_request' não encontrada no sistema" (missing_tool);
 *  - "npm error code E404 … 404 Not Found - GET https://registry.npmjs.org/genoffice" → "Caminho não encontrado".
 * O planejador nunca soube que o PACOTE não existia no npm e insistiu na rota — replanejamentos desperdiçados.
 *
 * REGRESSÃO SE: algum desses voltar a virar missing_tool / "caminho"; o texto real não chegar ao blocker; ou os sinais
 * verdadeiros de comando ausente deixarem de virar missing_tool.
 *
 * Execução: npx ts-node src/__tests__/regression/S432_NotFoundNaoViraFerramentaAusente.test.ts
 */
import { GoalEvaluator } from '../../loop/GoalEvaluator';
import { Goal, PlanStep } from '../../loop/GoalTypes';
import type { ToolResult } from '../../loop/agentLoopTypes';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}
const goal = (): Goal => {
    const now = Date.now();
    return { id: 'g', sessionKey: 't:u', conversationId: 'c', userIntent: 'instalar', objective: 'instalar', status: 'executing',
        currentPlan: [], attempts: [], blockers: [], toolsTried: [], strategiesTried: [], successCriteria: [], retryBudget: 3,
        replanBudget: 5, confidence: 0.9, requiresAuth: false, authorizationScope: [], createdAt: now, updatedAt: now, expiresAt: now + 3_600_000 } as Goal;
};
const passo = (toolName: string): PlanStep => ({ id: 's', description: 'passo', toolName, toolArgs: {}, fallbackSteps: [], status: 'pending' });
const falha = (error: string, exitCode?: number): ToolResult => ({ success: false, output: '', error, ...(exitCode !== undefined ? { exitCode } : {}) });
const avaliar = (tool: string, r: ToolResult) => new GoalEvaluator().evaluate(goal(), passo(tool), r);

console.log('\n=== S432-1 — o caso real: 404 do registro do npm via api_request ===');
{
    const r = avaliar('api_request', falha('HTTP 404 Not Found — GET https://registry.npmjs.org/genoffice: {"error":"Not found"}'));
    assert(r.blocker?.kind !== 'missing_tool', 'NÃO é "ferramenta não encontrada"', r.blocker);
    assert(/registry\.npmjs\.org\/genoffice/.test(r.blocker?.description ?? '') && /404/.test(r.blocker?.description ?? ''), 'o blocker leva o fato real (404 no registro, para aquele pacote)', r.blocker?.description);
}

console.log('\n=== S432-2 — o caso real: npm E404 via exec_command ===');
{
    const r = avaliar('exec_command', falha('npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/genoffice - Not found\nnpm error 404\n[exit code: 1]', 1));
    assert(r.blocker?.kind !== 'missing_tool', 'NÃO é comando ausente', r.blocker);
    assert(!/Caminho não encontrado/.test(r.blocker?.description ?? ''), 'NÃO é rotulado como "caminho não encontrado"', r.blocker?.description);
    assert(/E404/.test(r.blocker?.description ?? '') && /registry\.npmjs\.org\/genoffice/.test(r.blocker?.description ?? ''), 'o blocker leva o texto real do npm', r.blocker?.description);
}

console.log('\n=== S432-3 — os sinais verdadeiros de comando ausente continuam valendo ===');
{
    assert(avaliar('exec_command', falha('bash: ffmpeg: command not found')).blocker?.kind === 'missing_tool', '"command not found" → missing_tool');
    assert(avaliar('exec_command', falha('algo deu errado', 127)).blocker?.kind === 'missing_tool', 'exit 127 → missing_tool');
    assert(avaliar('exec_command', falha("'edge-tts' não é reconhecido como um comando interno\nou externo, um programa operável ou um arquivo em lotes.")).blocker?.kind === 'missing_tool', 'cmd.exe pt-BR "não é reconhecido" → missing_tool');
}

console.log('\n=== S432-4 — arquivo inexistente é fato de arquivo, não ferramenta ausente ===');
{
    const r = avaliar('exec_command', falha("cat: relatorio.txt: No such file or directory\n[exit code: 1]", 1));
    assert(r.blocker?.kind !== 'missing_tool' && /relatorio\.txt/.test(r.blocker?.description ?? ''), 'nem missing_tool nem chute: o texto com o arquivo chega ao planejador', r.blocker);
}

console.log(`\n=== S432: ${passed} passaram, ${failed} falharam ===`);
process.exit(failed > 0 ? 1 : 0);
