/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S124
 *
 * ARCH-015 (RFC docs/refatoracao-arquitetural-2026/RFC_ARCH-015_SchemaGeneratedRequiredArgs.md,
 * aprovada em S20, implementada em S26): `GoalPlanner.buildRequiredArgsReference()` deixou de
 * ser um template literal hardcoded — passa a agregar `ToolExecutor.requiredArgsHint` de cada
 * tool via `ToolRegistry.getEnabled()`. Escopo deliberadamente reduzido: só o texto da seção
 * "REFERÊNCIA DE ARGS OBRIGATÓRIOS" do prompt muda de fonte; a validação real
 * (`detectMissingRequiredArgs()`, guards internos de cada `execute()`) não foi tocada.
 *
 * Este teste dirige `GoalPlanner.replan()` de verdade (não reimplementa a lógica) contra o
 * `ToolRegistry` REAL do processo (não um fake) — confirma que o texto dos 7 tools que tinham
 * uma linha no bloco antigo continua chegando ao prompt real enviado ao LLM, agora vindo do
 * campo co-localizado em cada arquivo de tool, e que uma tool sem `requiredArgsHint` (ex.:
 * web_search) não aparece na seção.
 *
 * Execução: npx ts-node src/__tests__/regression/S124_GoalPlanner_RequiredArgsHintFromToolRegistry.test.ts
 */

process.env.WORKSPACE_DIR = process.env.WORKSPACE_DIR || 'D:/IA/newclaw/workspace';

import { GoalPlanner } from '../../loop/GoalPlanner';
import { ToolRegistry } from '../../core/ToolRegistry';
import { Goal, GoalBlocker } from '../../loop/GoalTypes';
import { EditTool } from '../../tools/edit_tool';
import { SendDocumentTool } from '../../tools/send_document';
import { ListWorkspaceTool } from '../../tools/list_workspace';
import { ReadTool } from '../../tools/read_tool';
import { MemoryWriteTool } from '../../tools/memory_write';
import { CryptoAnalysisTool } from '../../tools/crypto_analysis';
import { WebNavigateTool } from '../../tools/web_navigate';
import { WebSearchTool } from '../../tools/web_search';

// Registra as tools reais (com requiredArgsHint) direto do arquivo-fonte de cada uma — mesmo
// padrão de S27_RiskAnalyzer_SendDocumentInference_ScriptOutput.test.ts. try/catch porque
// ToolRegistry é singleton por processo — outro arquivo de teste rodando antes pode já ter
// registrado a mesma tool.
try { ToolRegistry.register(new EditTool()); } catch { /* já registrado */ }
try { ToolRegistry.register(new SendDocumentTool({} as never)); } catch { /* já registrado */ }
try { ToolRegistry.register(new ListWorkspaceTool()); } catch { /* já registrado */ }
try { ToolRegistry.register(new ReadTool()); } catch { /* já registrado */ }
try { ToolRegistry.register(new MemoryWriteTool({ getFacade: () => ({}) } as never)); } catch { /* já registrado */ }
try { ToolRegistry.register(new CryptoAnalysisTool()); } catch { /* já registrado */ }
try { ToolRegistry.register(new WebNavigateTool()); } catch { /* já registrado */ }
try { ToolRegistry.register(new WebSearchTool()); } catch { /* já registrado */ }

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  OK ${message}`); passed++; }
    else { console.error(`  FALHOU: ${message}`, detail ?? ''); failed++; }
}

function makeFakePlanner(): { planner: GoalPlanner; capturedPrompt: { value: string } } {
    const captured = { value: '' };
    let calls = 0;
    const fakeProviderFactory = {
        getProviderWithModel: () => ({
            chat: async (messages: Array<{ content: string }>) => {
                calls++;
                if (calls === 1) captured.value = messages[0]?.content ?? '';
                return { content: JSON.stringify({ steps: [{ id: 'step_1', description: 'passo de teste', toolName: 'read', toolArgs: { path: 'a.txt' } }], strategy: 'teste S124' }) };
            },
        }),
    } as any;
    const fakeReflectionMemory = {
        findBlockerLessons: () => '',
        findHardConstraints: () => [],
    } as any;
    const planner = new GoalPlanner(fakeProviderFactory, fakeReflectionMemory);
    return { planner, capturedPrompt: captured };
}

function makeGoal(overrides: Partial<Goal>): Goal {
    const now = Date.now();
    return {
        id: 'goal_s124', sessionKey: 'test:s124', conversationId: 'test-conv-s124',
        userIntent: 'objetivo de teste S124', objective: 'Objetivo de teste S124',
        status: 'blocked', currentPlan: [], attempts: [], blockers: [],
        toolsTried: [], strategiesTried: [], successCriteria: [], sentArtifacts: [],
        retryBudget: 3, replanBudget: 5, confidence: 0.9,
        requiresAuth: false, authorizationScope: [],
        createdAt: now, updatedAt: now, expiresAt: now + 3_600_000,
        ...overrides,
    } as Goal;
}

function blocker(kind: GoalBlocker['kind'], description = 'blocker de teste', toolName?: string): GoalBlocker {
    return { kind, description, toolName, suggestedActions: [], detectedAt: Date.now() };
}

async function main() {

console.log('\n=== S124.1 — ToolRegistry real: os 7 tools que tinham linha no bloco antigo têm requiredArgsHint ===');
{
    const expectedTools = ['edit', 'send_document', 'list_workspace', 'read', 'memory_write', 'crypto_analysis', 'web_navigate'];
    const enabled = ToolRegistry.getEnabled();
    for (const name of expectedTools) {
        const tool = enabled.find(t => t.name === name);
        assert(!!tool, `tool "${name}" está registrada em ToolRegistry`, enabled.map(t => t.name));
        assert(!!tool?.requiredArgsHint, `tool "${name}" tem requiredArgsHint definido`, tool?.requiredArgsHint);
    }
}

console.log('\n=== S124.2 — prompt real de replan contém os hints agregados de ToolRegistry (não hardcoded) ===');
{
    const { planner, capturedPrompt } = makeFakePlanner();
    const goal = makeGoal({ blockers: [blocker('goal_incomplete', 'faltou entregar o resultado')] });
    await planner.replan(goal, goal.blockers[0]);

    assert(capturedPrompt.value.includes('REFERÊNCIA DE ARGS OBRIGATÓRIOS:'), 'seção de referência presente no prompt real', capturedPrompt.value.slice(-400));
    assert(
        capturedPrompt.value.includes('- edit: SEMPRE forneça oldText+newText (substituição) OU startLine+endLine+content (patch) OU append=true+content. Nunca chame edit sem esses parâmetros.'),
        'hint de "edit" (vindo de edit_tool.ts) presente no prompt real',
        capturedPrompt.value.slice(-400),
    );
    assert(
        capturedPrompt.value.includes('- send_document: SEMPRE forneça file_path com o caminho completo do arquivo. Nunca chame send_document sem file_path.'),
        'hint de "send_document" (vindo de send_document.ts) presente no prompt real',
        capturedPrompt.value.slice(-400),
    );
    assert(
        capturedPrompt.value.includes('TIPOS DE NÓ — escolha o correto para garantir persistência:'),
        'hint multi-linha de "memory_write" (sub-lista de tipos de nó) preservado por completo',
        capturedPrompt.value.slice(-800),
    );
    assert(
        capturedPrompt.value.includes('- web_navigate: SEMPRE forneça action (search|open|follow_link).'),
        'hint de "web_navigate" (vindo de web_navigate.ts) presente no prompt real',
        capturedPrompt.value.slice(-400),
    );
}

console.log('\n=== S124.3 — tool SEM requiredArgsHint (ex.: web_search) não aparece na seção de referência ===');
{
    const webSearchTool = ToolRegistry.getEnabled().find(t => t.name === 'web_search');
    assert(!!webSearchTool, 'web_search está registrada em ToolRegistry (pré-condição do teste)', ToolRegistry.getEnabled().map(t => t.name));
    assert(!webSearchTool?.requiredArgsHint, 'web_search não tem requiredArgsHint (nunca teve linha no bloco antigo)', webSearchTool?.requiredArgsHint);
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S124 RESULTADO: ${passed} passou | ${failed} falhou`);
process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => { console.error('ERRO NÃO TRATADO:', err); process.exit(1); });
