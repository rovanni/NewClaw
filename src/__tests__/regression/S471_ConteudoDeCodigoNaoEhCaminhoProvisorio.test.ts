/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S471
 * O padrão de CAMINHO provisório (`PLACEHOLDER_ARG_PATTERN`: `<nome_do_arquivo>`, `{arquivo}`, `/path/to/`) não julga o
 * CONTEÚDO de um arquivo. Código tem `{nome}` (f-string, .format) e `<a:t>` (XML do PowerPoint) por natureza.
 *
 * CASO REAL (Windows, Telegram, 04/11/2026, goal_1793815413711_qejk6): "Vamos dividir esses slides em vários módulos".
 * O planejador escreveu `write(dividir_deck_senac.py, <script Python completo>)` + `exec_command(py ...\dividir_deck_senac.py)`.
 * O `write` foi rebaixado a AgentLoop por "placeholder" no conteúdo; o agente gravou em `scripts\`; o passo seguinte não
 * achou o arquivo. Seis vezes no mesmo goal; o pedido terminou em falha com os 14 módulos prontos no disco.
 * Medido no log do Windows: 58 de 62 rebaixamentos "placeholder" de `content` eram código ou HTML reais.
 *
 * REGRESSÃO SE: código real voltar a ser rebaixado pelo padrão de caminho, ou se um caminho/comando provisório de
 * verdade deixar de ser pego.
 *
 * Execução: npx ts-node src/__tests__/regression/S471_ConteudoDeCodigoNaoEhCaminhoProvisorio.test.ts
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
const noMissingArgs = () => null;

// Trecho no formato do script do caso real: f-strings e XML de slide.
const SCRIPT = [
    '# -*- coding: utf-8 -*-',
    'import zipfile, re',
    'def titulo(xml):',
    "    m = re.search(r'<a:t>([^<]+)</a:t>', xml)",
    "    return m.group(1) if m else ''",
    "for n, aula in enumerate(['Aula 02', 'Aula 03'], 1):",
    "    print(f'Modulo {n:02d}: {aula}')",
].join('\n');

async function main(): Promise<void> {
    console.log('\n=== S471.1 — o plano real: write do script + exec do mesmo caminho ===');
    {
        const r = await sanitizePlanSteps(
            [
                { id: 'step_1', description: 'Gravar o script', toolName: 'write', toolArgs: { path: 'dividir_deck_s471.py', content: SCRIPT } },
                { id: 'step_2', description: 'Rodar o script', toolName: 'exec_command', toolArgs: { command: 'py -3 -X utf8 dividir_deck_s471.py' } },
            ],
            ToolRegistry, '[S471]', noMissingArgs, neverStub,
        );
        assert(r.steps[0].toolName === 'write', 'o write do script continua write (o plano fica com o caminho)', r.steps[0]);
        assert((r.steps[0].toolArgs as Record<string, unknown>)?.path === 'dividir_deck_s471.py', 'o caminho do plano é mantido', r.steps[0].toolArgs);
        assert(!r.mutations.some(m => m.reason === 'placeholder'), 'nenhum rebaixamento por "placeholder"', r.mutations);
        assert(r.steps[1].toolName === 'exec_command', 'o passo de rodar continua como planejado', r.steps[1]);
    }

    console.log('\n=== S471.2 — HTML com atributos e chaves de CSS também é conteúdo ===');
    {
        const html = '<!doctype html><html><head><style>body {margin:0}</style></head><body><input placeholder="Nome"></body></html>';
        const r = await sanitizePlanSteps(
            [{ id: 'step_1', description: 'Gravar a página', toolName: 'write', toolArgs: { path: 'aula_s471.html', content: html } }],
            ToolRegistry, '[S471]', noMissingArgs, neverStub,
        );
        assert(r.steps[0].toolName === 'write', 'HTML real segue como write', r.mutations);
    }

    console.log('\n=== S471.3 — controles: caminho e comando provisórios continuam sendo pegos ===');
    {
        const r = await sanitizePlanSteps(
            [{ id: 'step_1', description: 'Gravar', toolName: 'write', toolArgs: { path: '<nome_do_arquivo>.py', content: 'print(1)' } }],
            ToolRegistry, '[S471]', noMissingArgs, neverStub,
        );
        assert(r.steps[0].toolName === undefined && r.mutations.some(m => m.reason === 'placeholder'), 'caminho provisório no path rebaixa', r.mutations);
    }
    {
        // Caso real do log: comando montado com dado que só sai num passo posterior.
        const r = await sanitizePlanSteps(
            [{ id: 'step_1', description: 'Instalar', toolName: 'exec_command', toolArgs: { command: 'winget install -e --id <ID_confirmado_no_step_4>' } }],
            ToolRegistry, '[S471]', noMissingArgs, neverStub,
        );
        assert(r.steps[0].toolName === undefined && r.mutations.some(m => m.reason === 'placeholder'), 'comando com valor provisório rebaixa', r.mutations);
    }

    console.log('\n=== S471.4 — conteúdo-molde de verdade continua com o dono dele (content-stub) ===');
    {
        const alwaysStub = async () => ({ isStub: true, reason: 'test: molde' });
        const r = await sanitizePlanSteps(
            [{ id: 'step_1', description: 'Gravar', toolName: 'write', toolArgs: { path: 'nota_s471.md', content: '{conteudo_gerado_no_passo_anterior}' } }],
            ToolRegistry, '[S471]', noMissingArgs, alwaysStub,
        );
        assert(r.steps[0].toolName === undefined && r.mutations.some(m => m.reason === 'content_stub'), 'molde no conteúdo é rebaixado pelo content-stub', r.mutations);
        assert(r.steps[0].description.includes("'nota_s471.md'"), 'e o caminho planejado vai junto (S296)', r.steps[0].description);
    }

    console.log(`\nS471 RESULTADO: ${passed} passou | ${failed} falhou`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => { console.error('S471 erro inesperado:', err); process.exit(1); });
