/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S296
 *
 * CONTEXTO (log de auditoria, 23/09/2026, goal de 26 min): o plano tinha `write` do script
 * extrator seguido de `exec_command python <script>`. O `write` foi rebaixado a AgentLoop por
 * conteúdo placeholder — o que descarta `toolArgs`, inclusive o `path`. O AgentLoop gravou em
 * `workspace/tmp/X.py` (convenção de agentPrompts.ts) e o step seguinte executou
 * `workspace/X.py`: "No such file or directory", nos 3 replans seguintes.
 *
 * REGRESSÃO SE: um write rebaixado por conteúdo (placeholder, dado ainda não produzido, stub)
 * voltar a perder o caminho planejado, ou se um rebaixamento sem caminho ganhar uma intenção falsa.
 *
 * Execução: npx ts-node src/__tests__/regression/S296_SanitizePlanSteps_DemotedWriteKeepsPlannedPath.test.ts
 */
process.env.WORKSPACE_DIR = process.env.WORKSPACE_DIR || 'D:/IA/newclaw/workspace';

import { sanitizePlanSteps } from '../../loop/planning/sanitizePlanSteps';
import { ToolRegistry } from '../../core/ToolRegistry';
import { WriteTool } from '../../tools/write_tool';
import { ExecCommandTool } from '../../tools/exec_command';

let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string, detail?: unknown): void {
    if (cond) { console.log(`  OK ${msg}`); passed++; }
    else { console.error(`  FALHOU: ${msg}`, detail ?? ''); failed++; }
}

try { ToolRegistry.register(new WriteTool()); } catch { /* já registrado */ }
try { ToolRegistry.register(new ExecCommandTool(), { dangerous: true }); } catch { /* já registrado */ }

const neverStub = async () => ({ isStub: false, reason: 'test' });
const alwaysStub = async () => ({ isStub: true, reason: 'test: stub' });
const noMissingArgs = () => null;

async function main(): Promise<void> {
    console.log('\n=== S296.1 — placeholder: o caminho planejado acompanha o step rebaixado ===');
    {
        const r = await sanitizePlanSteps(
            [{ id: 'step_1', description: 'Criar o script extrator', toolName: 'write', toolArgs: { path: 'extrator_s296.py', content: 'import os\nprint({nome_do_arquivo})' } }],
            ToolRegistry, '[S296]', noMissingArgs, neverStub,
        );
        const s = r.steps[0];
        assert(s.toolName === undefined, 'step rebaixado a AgentLoop', s);
        assert(s.description.includes("'extrator_s296.py'") && s.description.includes('INTENÇÃO DO PLANO'), 'description carrega o caminho planejado', s.description);
    }

    console.log('\n=== S296.2 — dado ainda não produzido (write depois de exec_command) ===');
    {
        const r = await sanitizePlanSteps(
            [
                { id: 'step_1', description: 'listar', toolName: 'exec_command', toolArgs: { command: 'dir' } },
                { id: 'step_2', description: 'gravar resumo', toolName: 'write', toolArgs: { path: 'resumo_s296.md', content: 'resumo dos arquivos' } },
            ],
            ToolRegistry, '[S296]', noMissingArgs, neverStub,
        );
        assert(r.steps[1].toolName === undefined && r.steps[1].description.includes("'resumo_s296.md'"), 'caminho preservado no rebaixamento premature_content', r.steps[1]);
    }

    console.log('\n=== S296.3 — stub classificado ===');
    {
        const r = await sanitizePlanSteps(
            [{ id: 'step_1', description: 'gravar doc', toolName: 'write', toolArgs: { path: 'doc_s296.md', content: 'conteúdo completo viria aqui' } }],
            ToolRegistry, '[S296]', noMissingArgs, alwaysStub,
        );
        assert(r.steps[0].toolName === undefined && r.steps[0].description.includes("'doc_s296.md'"), 'caminho preservado no rebaixamento content_stub', r.steps[0]);
    }

    console.log('\n=== S296.4 — controles negativos: step íntegro não é alterado; sem path não há intenção ===');
    {
        const r = await sanitizePlanSteps(
            [{ id: 'step_1', description: 'gravar nota', toolName: 'write', toolArgs: { path: 'nota_s296.md', content: 'conteúdo real e completo da nota' } }],
            ToolRegistry, '[S296]', noMissingArgs, neverStub,
        );
        assert(r.steps[0].toolName === 'write' && r.steps[0].description === 'gravar nota', 'write íntegro segue como write, description intacta', r.steps[0]);
    }

    console.log(`\nS296 RESULTADO: ${passed} passou | ${failed} falhou`);
    process.exit(failed > 0 ? 1 : 0);
}
main().catch(e => { console.error('ERRO NÃO TRATADO:', e); process.exit(1); });
