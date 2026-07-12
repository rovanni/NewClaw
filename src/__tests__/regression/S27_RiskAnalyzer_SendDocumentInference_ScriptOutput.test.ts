/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S27
 * RiskAnalyzer.analyze() NÃO deve inferir file_path de send_document a partir de um 'write'
 * anterior quando existe um exec_command (ou agentloop) entre o write e o send_document.
 *
 * BUG REAL (conversa 03/07/2026, 22:37-22:46, log_conversa_newclaw.txt + newclaw-audit.log):
 * Usuário pediu slides de Excel. Plano após replan: [agentloop, exec_command, send_document].
 * O LLM de risco reescreveu o step 1 como write(path="gerar_slides.py", content=script), o
 * step 2 como exec_command (roda o script, que gera "aula_excel.pptx" via python-pptx), e o
 * step 3 como send_document SEM file_path. A heurística de inferência (RiskAnalyzer.ts) pegou
 * o 'write' do step 1 como "último write" e setou file_path="gerar_slides.py" — mesmo a
 * description do próprio step 3 dizendo "Enviar o arquivo aula_excel.pptx gerado ao usuário".
 * Resultado real: o bot enviou o SCRIPT PYTHON ao usuário via Telegram em vez do .pptx, e
 * declarou sucesso (CaseMemory chegou a capturar tier=confirmed_delivery para o arquivo errado).
 * aula_excel.pptx existia de verdade em disco (64KB) — só nunca foi o arquivo enviado.
 *
 * FIX: a busca por 'write' anterior agora para (sem inferir nada) assim que encontra um
 * exec_command ou agentloop no caminho de volta, porque esses steps podem gerar um artefato
 * diferente do que foi escrito antes deles. Sem write anterior confiável, sanitizePlanSteps()
 * converte o send_document para AgentLoop — que resolve o file_path certo via tool-calling com
 * contexto real (mesmo caminho que funcionou corretamente na 2ª mensagem da mesma conversa).
 *
 * Não altera o caso já coberto por S12 (write → send_document direto, sem exec_command no
 * meio) — esse caso continua inferindo normalmente.
 *
 * Execução: npx ts-node src/__tests__/regression/S27_RiskAnalyzer_SendDocumentInference_ScriptOutput.test.ts
 */

process.env.WORKSPACE_DIR = process.env.WORKSPACE_DIR || 'D:/IA/newclaw/workspace';

import { RiskAnalyzer } from '../../loop/RiskAnalyzer';
import { ToolRegistry } from '../../core/ToolRegistry';
import { ReadTool } from '../../tools/read_tool';
import { WriteTool } from '../../tools/write_tool';
import { EditTool } from '../../tools/edit_tool';
import { ExecCommandTool } from '../../tools/exec_command';
import { ListWorkspaceTool } from '../../tools/list_workspace';
import { SendDocumentTool } from '../../tools/send_document';
import { Goal, PlanStep } from '../../loop/GoalTypes';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

try { ToolRegistry.register(new ReadTool()); } catch { /* já registrado */ }
try { ToolRegistry.register(new WriteTool()); } catch { /* já registrado */ }
try { ToolRegistry.register(new EditTool()); } catch { /* já registrado */ }
try { ToolRegistry.register(new ExecCommandTool(), { dangerous: true }); } catch { /* já registrado */ }
try { ToolRegistry.register(new ListWorkspaceTool()); } catch { /* já registrado */ }
try { ToolRegistry.register(new SendDocumentTool({} as never)); } catch { /* já registrado */ }

function makeGoal(objective: string): Goal {
    const now = Date.now();
    return {
        id: `goal_test_${now}`,
        sessionKey: 'test:user',
        conversationId: 'test-conv',
        userIntent: objective,
        objective,
        status: 'planning',
        currentPlan: [],
        attempts: [],
        blockers: [],
        toolsTried: [],
        strategiesTried: [],
        successCriteria: [],
        retryBudget: 3,
        replanBudget: 5,
        confidence: 0.9,
        requiresAuth: false,
        authorizationScope: [],
        createdAt: now,
        updatedAt: now,
        expiresAt: now + 3_600_000,
    } as unknown as Goal;
}

function makeFakeProviderFactory(getResponse: () => string) {
    return {
        getProviderWithModel: () => ({
            chat: async () => ({ content: getResponse() }),
        }),
    } as unknown as import('../../core/ProviderFactory').ProviderFactory;
}

const fakeReflectionMemory = {
    findHardConstraints: () => [],
    findToolFailures: () => '',
} as unknown as import('../../memory/ReflectionMemory').ReflectionMemory;

async function main() {
    let nextResponse = '{"risks": [], "plan": null}';
    const riskAnalyzer = new RiskAnalyzer(
        makeFakeProviderFactory(() => nextResponse),
        ToolRegistry,
        fakeReflectionMemory,
    );

    const seedPlan: PlanStep[] = [
        { id: 'step_1', description: 'seed', toolName: 'read', toolArgs: { path: 'x' }, fallbackSteps: [], status: 'pending' },
    ];

    // ── 1. write(script) → exec_command(roda o script) → send_document sem file_path:
    //       NÃO deve inferir o script como anexo — deve virar AgentLoop (bug real) ──
    console.log('\n=== S27 — send_document NÃO infere file_path de write cujo output foi transformado por exec_command ===');
    nextResponse = JSON.stringify({
        risks: [],
        plan: [
            { id: 'step_1', description: 'criar script gerador de slides', toolName: 'write', toolArgs: { path: 'gerar_slides.py', content: 'from pptx import Presentation\nPresentation().save("aula_excel.pptx")\n' } },
            { id: 'step_2', description: 'executar script gerador de slides', toolName: 'exec_command', toolArgs: { command: 'python gerar_slides.py' } },
            { id: 'step_3', description: 'Enviar o arquivo aula_excel.pptx gerado ao usuário', toolName: 'send_document', toolArgs: {} },
        ],
    });
    {
        const report = await riskAnalyzer.analyze(makeGoal('gerar e enviar slides de excel'), seedPlan, []);
        assert(!report.blocked, 'plano não bloqueado', report);
        assert(
            report.adjustedPlan[2]?.toolName === undefined,
            `send_document vira AgentLoop quando o write anterior foi consumido por exec_command (obtido: ${report.adjustedPlan[2]?.toolName})`,
            report.adjustedPlan,
        );
        assert(
            (report.adjustedPlan[2]?.toolArgs as Record<string, unknown> | undefined)?.file_path !== 'gerar_slides.py',
            'file_path NUNCA é o script fonte (gerar_slides.py) — bug real corrigido',
            report.adjustedPlan[2],
        );
    }

    // ── 2. write(html) → send_document direto, sem exec_command: continua inferindo
    //       (caso já coberto por S12, reconfirmado aqui para não regredir) ──
    console.log('\n=== S27 — send_document CONTINUA inferindo file_path quando não há exec_command entre write e send ===');
    nextResponse = JSON.stringify({
        risks: [],
        plan: [
            { id: 'step_1', description: 'escrever slides html', toolName: 'write', toolArgs: { path: 'aula_excel.html', content: 'conteudo real dos slides, nao e stub' } },
            { id: 'step_2', description: 'enviar slides', toolName: 'send_document', toolArgs: {} },
        ],
    });
    {
        const report = await riskAnalyzer.analyze(makeGoal('gerar e enviar slides html'), seedPlan, []);
        assert(!report.blocked, 'plano não bloqueado', report);
        assert(
            report.adjustedPlan[1]?.toolName === 'send_document',
            `send_document permanece (write direto, sem exec_command no meio) (obtido: ${report.adjustedPlan[1]?.toolName})`,
            report.adjustedPlan,
        );
        assert(
            (report.adjustedPlan[1]?.toolArgs as Record<string, unknown> | undefined)?.file_path === 'aula_excel.html',
            `file_path inferido corretamente quando não há exec_command no caminho (obtido: ${JSON.stringify(report.adjustedPlan[1]?.toolArgs)})`,
        );
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S27 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    if (failed > 0) process.exit(1);
}

main().catch(err => { console.error('ERRO NÃO TRATADO:', err); process.exit(1); });
