/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S12
 * RiskAnalyzer.analyze() usa sanitizePlanSteps() (mesma função que GoalPlanner.parsePlanResponse)
 * para sanitizar o plano ajustado pelo LLM de risco.
 *
 * PROBLEMA CORRIGIDO (consolidação do pipeline de planejamento, 01-02/07/2026):
 * GoalPlanner.parsePlanResponse() e RiskAnalyzer.analyze() reconstruíam PlanStep[] de forma
 * independente, quase idêntica — mas com uma divergência real: RiskAnalyzer NÃO resolvia
 * TOOL_ALIASES (ex: 'ls' → list_workspace). Um alias inventado pelo LLM de risco era
 * descartado como "tool inexistente" em vez de resolvido.
 *
 * Consolidação: ambos agora chamam sanitizePlanSteps() (src/loop/planning/sanitizePlanSteps.ts).
 * RiskAnalyzer preserva por cima da função compartilhada 2 comportamentos que só ele tem:
 *   - inferência de file_path de send_document a partir de um write anterior no mesmo plano;
 *   - rejeição do plano inteiro quando uma tool crítica (edit/exec_command) perde args
 *     obrigatórios, em vez de silenciosamente virar agentloop.
 *
 * Este teste chama RiskAnalyzer.analyze() de ponta a ponta (com um ProviderFactory fake
 * controlando a resposta do "LLM de risco"), sem GoalPlanner no caminho — prova que a
 * sanitização funciona igual quando acionada pelo lado do RiskAnalyzer.
 *
 * Execução: npx ts-node src/__tests__/regression/S12_RiskAnalyzer_SanitizePlanSteps.test.ts
 */

process.env.WORKSPACE_DIR = process.env.WORKSPACE_DIR || 'D:/IA/newclaw/workspace';

import { RiskAnalyzer } from '../../loop/RiskAnalyzer';
import { CONTENT_STUB_PATTERNS } from '../../shared/contentStubPatterns';
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

// Registro mínimo de tools reais — o mesmo que AgentController.ts faz na inicialização.
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

/** ProviderFactory fake — devolve o JSON configurado em `nextResponse` como resposta do LLM de risco. */
function makeFakeProviderFactory(getResponse: () => string) {
    return {
        getProviderWithModel: () => ({
            chat: async () => ({ content: getResponse() }),
        }),
    } as unknown as import('../../core/ProviderFactory').ProviderFactory;
}

// Mock atualizado na S4: RiskAnalyzer.analyze() migrou (S3a) de buildConstraints/buildContextHint
// para findHardConstraints/findToolFailures — o mock precisa espelhar a API real chamada em
// RiskAnalyzer.ts:137/178, senão qualquer teste que chegue lá quebra com TypeError silencioso.
const fakeReflectionMemory = {
    findHardConstraints: () => [],
    findToolFailures: () => '',
} as unknown as import('../../memory/ReflectionMemory').ReflectionMemory;

// classifyContentStub (09/07/2026) substituiu o parâmetro de regex em sanitizePlanSteps() por
// um classificador LLM real — RiskAnalyzer agora chama esse classificador internamente para
// detectar content-stub. Injeta explicitamente um mock regex-backed em vez de deixar
// RiskAnalyzer construir o classificador real a partir de makeFakeProviderFactory() acima: o
// fake provider devolve sempre `nextResponse` (a resposta do "LLM de risco", ex:
// '{"risks":[],"plan":[...]}"'), que não é um JSON {isStub,reason} válido — se o classificador
// real reusasse esse mesmo fake, o teste 3 (content-stub) e o teste 4 (conteúdo legítimo)
// dependeriam do valor de nextResponse no momento errado da execução, e não do texto sendo
// classificado de verdade.
const mockClassifyContentStub = async (content: string) =>
    ({ isStub: CONTENT_STUB_PATTERNS.some(p => p.test(content)), reason: 'mock (regex-backed)' });

async function main() {
    let nextResponse = '{"risks": [], "plan": null}';
    const riskAnalyzer = new RiskAnalyzer(
        makeFakeProviderFactory(() => nextResponse),
        ToolRegistry,
        fakeReflectionMemory,
        mockClassifyContentStub,
    );

    // Plano inicial "trivial" só pra passar do early-return de plan.length===0.
    const seedPlan: PlanStep[] = [
        { id: 'step_1', description: 'seed', toolName: 'read', toolArgs: { path: 'x' }, fallbackSteps: [], status: 'pending' },
    ];

    // ── 1. Alias resolvido no plano ajustado pelo LLM de risco ──────────────────
    console.log('\n=== S12 — RiskAnalyzer resolve alias no plano ajustado (bug original) ===');
    nextResponse = JSON.stringify({
        risks: [],
        plan: [{ id: 'step_1', description: 'listar workspace', toolName: 'ls', toolArgs: {} }],
    });
    {
        const report = await riskAnalyzer.analyze(makeGoal('listar arquivos'), seedPlan, []);
        assert(!report.blocked, 'plano não bloqueado', report);
        assert(
            report.adjustedPlan[0]?.toolName === 'list_workspace',
            `alias 'ls' resolvido para 'list_workspace' (obtido: ${report.adjustedPlan[0]?.toolName})`,
            report.adjustedPlan,
        );
    }

    // ── 2. Placeholder detectado → convertido para AgentLoop ────────────────────
    console.log('\n=== S12 — RiskAnalyzer detecta placeholder no plano ajustado ===');
    nextResponse = JSON.stringify({
        risks: [],
        plan: [{ id: 'step_1', description: 'ler arquivo', toolName: 'read', toolArgs: { path: '{output_step_1}' } }],
    });
    {
        const report = await riskAnalyzer.analyze(makeGoal('ler arquivo'), seedPlan, []);
        assert(!report.blocked, 'plano não bloqueado', report);
        assert(
            report.adjustedPlan[0]?.toolName === undefined,
            `placeholder converte step para AgentLoop (toolName obtido: ${report.adjustedPlan[0]?.toolName})`,
            report.adjustedPlan,
        );
    }

    // ── 3. Content-stub detectado → convertido para AgentLoop ───────────────────
    console.log('\n=== S12 — RiskAnalyzer detecta content-stub no plano ajustado ===');
    nextResponse = JSON.stringify({
        risks: [],
        plan: [{ id: 'step_1', description: 'escrever resumo', toolName: 'write', toolArgs: { path: 'x.md', content: '[Conteúdo do resumo gerado a partir do texto lido no step_1]' } }],
    });
    {
        const report = await riskAnalyzer.analyze(makeGoal('resumir'), seedPlan, []);
        assert(!report.blocked, 'plano não bloqueado', report);
        assert(
            report.adjustedPlan[0]?.toolName === undefined,
            `content-stub converte step para AgentLoop (toolName obtido: ${report.adjustedPlan[0]?.toolName})`,
            report.adjustedPlan,
        );
    }

    // ── 4. send_document sem file_path infere do write anterior no mesmo plano ──
    console.log('\n=== S12 — RiskAnalyzer infere file_path de send_document a partir de write anterior ===');
    nextResponse = JSON.stringify({
        risks: [],
        plan: [
            { id: 'step_1', description: 'escrever relatorio', toolName: 'write', toolArgs: { path: 'relatorio.txt', content: 'conteudo real, nao e stub' } },
            { id: 'step_2', description: 'enviar relatorio', toolName: 'send_document', toolArgs: {} },
        ],
    });
    {
        const report = await riskAnalyzer.analyze(makeGoal('gerar e enviar relatorio'), seedPlan, []);
        assert(!report.blocked, 'plano não bloqueado', report);
        assert(
            report.adjustedPlan[1]?.toolName === 'send_document',
            `send_document permanece (não vira agentloop) após inferência (obtido: ${report.adjustedPlan[1]?.toolName})`,
            report.adjustedPlan,
        );
        assert(
            report.adjustedPlan[1]?.toolArgs?.file_path === 'relatorio.txt',
            `file_path inferido corretamente do write anterior (obtido: ${JSON.stringify(report.adjustedPlan[1]?.toolArgs)})`,
        );
    }

    // ── 5. send_document sem file_path E sem write anterior → AgentLoop ─────────
    console.log('\n=== S12 — RiskAnalyzer converte send_document para AgentLoop quando não há write anterior ===');
    nextResponse = JSON.stringify({
        risks: [],
        plan: [
            { id: 'step_1', description: 'ler arquivo existente', toolName: 'read', toolArgs: { path: 'existente.txt' } },
            { id: 'step_2', description: 'enviar documento', toolName: 'send_document', toolArgs: {} },
        ],
    });
    {
        const report = await riskAnalyzer.analyze(makeGoal('enviar documento'), seedPlan, []);
        assert(!report.blocked, 'plano não bloqueado', report);
        assert(
            report.adjustedPlan[1]?.toolName === undefined,
            `send_document sem write anterior converte para AgentLoop (obtido: ${report.adjustedPlan[1]?.toolName})`,
            report.adjustedPlan,
        );
    }

    // ── 6. Tool crítica (edit) sem args obrigatórios → planRejected propagado (CR#4) ──
    // fix(risk): propagate planRejected from analyzer — 02/07/2026.
    // reviewPlanWithLLM() (privado) sempre computou corretamente `planRejected: true` +
    // `rejectionReason` nesse caso, mas analyze() (método público, chamado por
    // GoalExecutionLoop) só lia `llmResult.risks/.planAdjusted/.adjustedPlan` de volta —
    // nunca `llmResult.planRejected`/`.rejectionReason`. Bug pré-existente confirmado via
    // `git show HEAD` (não introduzido por esta sessão), documentado em
    // project_session_bugs_jul2026_f/h.md. Fix mínimo: só propagação do estado já calculado,
    // nenhuma regra de decisão nova — RiskAnalyzer continua computando a rejeição do mesmo
    // jeito, só que agora o resultado chega até quem chama analyze() de verdade.
    console.log('\n=== S12 — RiskAnalyzer propaga planRejected por tool crítica (CR#4) ===');
    nextResponse = JSON.stringify({
        risks: [],
        plan: [
            { id: 'step_1', description: 'ler arquivo', toolName: 'read', toolArgs: { path: 'x.ts' } },
            { id: 'step_2', description: 'editar arquivo', toolName: 'edit', toolArgs: {} },
        ],
    });
    {
        const report = await riskAnalyzer.analyze(makeGoal('editar arquivo'), seedPlan, []);
        assert(
            report.risks.some(r => /crítico/i.test(r)),
            'texto de rejeição por tool crítica aparece em risks[] (via reviewPlanWithLLM)',
            report.risks,
        );
        assert(
            report.planRejected === true,
            'analyze() PROPAGA planRejected=true (fix aplicado)',
            report,
        );
        assert(
            /crítico/i.test(report.rejectionReason ?? ''),
            `rejectionReason propagado e menciona step crítico (obtido: "${report.rejectionReason}")`,
        );
        assert(
            report.blocked === false,
            'blocked continua false — planRejected é um sinal distinto (não aborta o goal, força replan)',
            report,
        );
        assert(
            report.adjustedPlan === seedPlan || JSON.stringify(report.adjustedPlan) === JSON.stringify(seedPlan),
            'adjustedPlan volta ao plano original (seedPlan) quando rejeitado — não usa o plano ruim da LLM de risco',
            report.adjustedPlan,
        );
    }

    // ── 7. Maioria dos tool-steps sem args obrigatórios → planRejected propagado (CR#3) ──
    // Segundo gatilho de rejeição (caminho de código diferente do teste 6 — CR#3 é um check
    // de RATIO no início de reviewPlanWithLLM, antes até de tentar sanitizePlanSteps; CR#4 é
    // pós-sanitização, por tool crítica específica). Cobre os 2 pontos que setam
    // planRejected em reviewPlanWithLLM.
    console.log('\n=== S12 — RiskAnalyzer propaga planRejected por maioria de args inválidos (CR#3) ===');
    nextResponse = JSON.stringify({
        risks: [],
        plan: [
            { id: 'step_1', description: 'ler sem path', toolName: 'read', toolArgs: {} },
            { id: 'step_2', description: 'enviar sem file_path', toolName: 'send_document', toolArgs: {} },
        ],
    });
    {
        const report = await riskAnalyzer.analyze(makeGoal('fazer algo mal especificado'), seedPlan, []);
        assert(report.planRejected === true, 'analyze() propaga planRejected=true (CR#3)', report);
        assert(
            /rejeitado/i.test(report.rejectionReason ?? ''),
            `rejectionReason propagado (obtido: "${report.rejectionReason}")`,
        );
        assert(report.blocked === false, 'blocked continua false (CR#3 também não aborta o goal)', report);
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S12 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    if (failed > 0) process.exit(1);
}

main().catch(err => { console.error('ERRO NÃO TRATADO:', err); process.exit(1); });
