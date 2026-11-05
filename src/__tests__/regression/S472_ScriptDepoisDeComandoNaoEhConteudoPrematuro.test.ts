/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S472
 * Um SCRIPT gravado depois de um passo que produz dado (exec_command, web_search…) não é "conteúdo prematuro": o
 * programa busca o dado quando roda, não o carrega. A regra estrutural do `premature_content` (sawDataProducingTool)
 * vale para texto/dado (um resumo, um relatório), não para código-fonte (SOURCE_SCRIPT_EXTENSIONS).
 *
 * CASO REAL (Windows, 04/11/2026, goal_1793815413711_qejk6): plano [exec_command (inventário), write(dividir_deck.py),
 * exec_command(py dividir_deck.py)]. O write foi rebaixado a AgentLoop por premature_content, o caminho do plano se
 * perdeu e o passo seguinte não achou o script — mesma classe do S471, outra porta.
 *
 * REGRESSÃO SE: script depois de comando voltar a ser rebaixado pela ordem, ou se texto/dado depois de comando deixar
 * de ser (S296.2, S60).
 *
 * Execução: npx ts-node src/__tests__/regression/S472_ScriptDepoisDeComandoNaoEhConteudoPrematuro.test.ts
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
const alwaysStub = async () => ({ isStub: true, reason: 'test: molde' });
const noMissingArgs = () => null;

const inventario = { id: 'step_1', description: 'Inventariar a pasta', toolName: 'exec_command', toolArgs: { command: 'dir' } };

async function main(): Promise<void> {
    console.log('\n=== S472.1 — o plano real: script depois do inventário segue como write ===');
    for (const nome of ['dividir_deck_s472.py', 'coletar_s472.sh', 'instalar_s472.ps1', 'rodar_s472.BAT']) {
        const r = await sanitizePlanSteps(
            [inventario,
             { id: 'step_2', description: 'Gravar o script', toolName: 'write', toolArgs: { path: nome, content: "import os\nprint(os.listdir('.'))" } },
             { id: 'step_3', description: 'Rodar', toolName: 'exec_command', toolArgs: { command: `py -3 ${nome}` } }],
            ToolRegistry, '[S472]', noMissingArgs, neverStub,
        );
        assert(r.steps[1].toolName === 'write' && (r.steps[1].toolArgs as Record<string, unknown>)?.path === nome,
            `${nome}: continua write, com o caminho do plano`, r.mutations);
        assert(!r.mutations.some(m => m.reason === 'premature_content'), `${nome}: sem rebaixamento premature_content`, r.mutations);
    }

    console.log('\n=== S472.2 — controles: texto depois de comando continua prematuro; script-molde continua com o content-stub ===');
    {
        const r = await sanitizePlanSteps(
            [inventario, { id: 'step_2', description: 'Gravar resumo', toolName: 'write', toolArgs: { path: 'resumo_s472.md', content: 'a pasta tem 3 arquivos' } }],
            ToolRegistry, '[S472]', noMissingArgs, neverStub,
        );
        assert(r.steps[1].toolName === undefined && r.mutations.some(m => m.reason === 'premature_content'), 'resumo .md depois do comando é rebaixado (dado que ainda não existe)', r.mutations);
    }
    {
        const r = await sanitizePlanSteps(
            [inventario, { id: 'step_2', description: 'Gravar script', toolName: 'write', toolArgs: { path: 'molde_s472.py', content: '# o código completo vai aqui' } }],
            ToolRegistry, '[S472]', noMissingArgs, alwaysStub,
        );
        assert(r.steps[1].toolName === undefined && r.mutations.some(m => m.reason === 'content_stub'), 'script-molde é rebaixado pelo content-stub, o dono do julgamento', r.mutations);
    }

    console.log(`\nS472 RESULTADO: ${passed} passou | ${failed} falhou`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => { console.error('S472 erro inesperado:', err); process.exit(1); });
