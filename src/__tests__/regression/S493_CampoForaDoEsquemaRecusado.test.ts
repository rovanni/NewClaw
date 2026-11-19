/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S493 (19/11/2026)
 *
 * Campo que a ferramenta não declara recusa a chamada inteira, em TODAS as ferramentas e nos três despachos.
 * Generaliza o S489 (o `schedule` recebia `frequency: "weekly"`/`day: "monday"`, ignorava e gravava uma tarefa diária).
 * Decisão da operadora (19/11/2026): "generalizar já". Antes só o ProactiveRecovery validava o esquema, e só campo
 * obrigatório e enum; o atalho do AgentLoop e a ação aprovada do WorkflowEngine chamavam a ferramenta direto.
 *
 * REGRESSÃO SE: um campo desconhecido chegar à ferramenta sem aviso; um esquema sem `properties` ou com
 * `additionalProperties` passar a recusar; ou algum dos três despachos deixar de validar.
 *
 * Execução: npx ts-node src/__tests__/regression/S493_CampoForaDoEsquemaRecusado.test.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { validateToolArgs } from '../../core/ToolRegistry';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}

const comEsquema = { parameters: { type: 'object', properties: { url: {}, method: { enum: ['GET', 'POST'] } }, required: ['url'] } };

console.log('\n🧪 S493 — campo fora do esquema é recusado\n');

console.log('Regra');
assert(validateToolArgs(comEsquema, { url: 'http://x' }) === null, 'só campos do esquema: passa');
const e1 = validateToolArgs(comEsquema, { url: 'http://x', endpoint: '/a', timeout: 5 });
assert(!!e1 && /endpoint/.test(e1) && /timeout/.test(e1) && /Campos aceitos: url, method/.test(e1) && /Nada foi feito/.test(e1),
    'campo desconhecido: recusa, nomeia os desconhecidos e lista os aceitos', e1);
assert(validateToolArgs(comEsquema, {}) !== null && /obrigatório "url"/.test(validateToolArgs(comEsquema, {})!), 'obrigatório ausente continua recusado (S289)');
assert(/inválido para "method"/.test(validateToolArgs(comEsquema, { url: 'x', method: 'PUT' }) ?? ''), 'enum fora da lista continua recusado (S289)');
const semCampos = { parameters: { type: 'object', properties: {}, required: [] } };
assert(/Ela não recebe campo nenhum/.test(validateToolArgs(semCampos, { dry_run: true }) ?? ''), 'esquema sem campos: qualquer campo é recusado (organize_workspace e dry_run)');
assert(validateToolArgs(semCampos, {}) === null, 'esquema sem campos e chamada sem campos: passa');
assert(validateToolArgs({ parameters: { type: 'object' } }, { qualquer: 1 }) === null, 'esquema sem `properties`: não há como saber o desconhecido, não julga');
assert(validateToolArgs({ parameters: { type: 'object', properties: { a: {} }, additionalProperties: true } }, { a: 1, b: 2 }) === null, '`additionalProperties: true`: aceita campo extra');
assert(validateToolArgs({}, { a: 1 }) === null, 'ferramenta sem esquema: não julga');

console.log('\nAs ferramentas reais');
{
    const { ScheduleTool } = require('../../tools/schedule_tool');
    const { ApiRequestTool } = require('../../tools/api_request');
    const schedule = new ScheduleTool({} as any);
    assert(/frequency/.test(validateToolArgs(schedule, { action: 'create', time: '09:00', frequency: 'weekly' }) ?? ''), 'schedule: frequency recusado');
    const api = new ApiRequestTool();
    assert(/endpoint/.test(validateToolArgs(api, { endpoint: 'http://x' }) ?? ''), 'api_request: o apelido endpoint (não declarado) é recusado');
}

console.log('\nOs três despachos validam');
{
    const ler = (p: string) => fs.readFileSync(path.join(process.cwd(), 'src', p), 'utf-8');
    assert(/validateToolArgs\(tool as unknown as \{ parameters\?: unknown \}, args\)/.test(ler('loop/ProactiveRecovery.ts')), 'ProactiveRecovery (laço do AgentLoop e objetivo)');
    const al = ler('loop/AgentLoop.ts');
    const iVal = al.indexOf('const erroDosArgumentos = validateToolArgs(tool as unknown as { parameters?: unknown }, toolArgs);');
    const iExec = al.indexOf('const toolResult = await tool.execute(toolArgs);');
    assert(iVal > -1 && iExec > iVal, 'atalho do AgentLoop valida antes de executar');
    const wf = ler('loop/WorkflowEngine.ts');
    assert(/const erroDosArgumentos = validateToolArgs\(tool as unknown as \{ parameters\?: unknown \}, txn\.params/.test(wf) && /erroDosArgumentos\s*\?\s*\{ success: false/.test(wf),
        'WorkflowEngine valida a ação aprovada antes de executar');
    assert(!/Campos que esta ferramenta não tem/.test(ler('tools/schedule_tool.ts')), 'o schedule não tem mais a cópia local da regra');
}

console.log(`\n${passed} passaram, ${failed} falharam\n`);
if (failed > 0) process.exit(1);
