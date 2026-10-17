/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S433
 * Caminho relativo começando por "workspace" (o modelo pensando a partir da raiz do NewClaw) NÃO pode virar
 * workspace\workspace\… — nem na pasta de trabalho do exec_command, nem em read/write (resolvePath), com barra normal ou
 * invertida.
 *
 * INCIDENTE REAL (Windows, 16/10/2026, 3º teste do GenOffice): "Get-ChildItem : Não é possível localizar o caminho
 * 'C:\Users\lucia\NewClaw\workspace\workspace\genoffice-app'" — workdir "workspace" resolvido DENTRO do workspace (e a pasta
 * workspace\workspace foi criada vazia pelo exec_command; existia desde 23/09, do mesmo engano).
 *
 * Execução: npx ts-node src/__tests__/regression/S433_WorkspaceNaoDuplica.test.ts
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-s433-'));
process.env.WORKSPACE_DIR = ws;

import { semPrefixoDoWorkspace, resolvePath } from '../../utils/crossPlatform';
import { ExecCommandTool } from '../../tools/exec_command';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}

async function main(): Promise<void> {
    console.log('\n=== S433-1 — a regra única ===');
    assert(semPrefixoDoWorkspace('workspace') === '', '"workspace" → raiz do workspace');
    assert(semPrefixoDoWorkspace('workspace/app') === 'app' && semPrefixoDoWorkspace('workspace\\app') === 'app', '"workspace/app" e "workspace\\app" → "app"');
    assert(semPrefixoDoWorkspace('workspaces/app') === 'workspaces/app' && semPrefixoDoWorkspace('meu-workspace/app') === 'meu-workspace/app', 'nomes parecidos não são tocados');
    assert(semPrefixoDoWorkspace(path.join(ws, 'app')) === path.join(ws, 'app'), 'caminho absoluto não é tocado');

    console.log('\n=== S433-2 — read/write (resolvePath) com o separador do sistema ===');
    // No Windows o modelo escreve "workspace\x\y"; no Linux a barra invertida faz parte do NOME (não separa pastas) — o caso
    // real usa o separador do sistema.
    const pedido = ['workspace', 'genoffice-app', 'README.md'].join(path.sep);
    assert(resolvePath(pedido).resolved === path.join(ws, 'genoffice-app', 'README.md'), `resolve dentro do workspace, sem duplicar (${pedido})`, resolvePath(pedido));
    assert(resolvePath('workspace/genoffice-app/README.md').resolved === path.join(ws, 'genoffice-app', 'README.md'), 'com barra normal também (em qualquer sistema)');

    console.log('\n=== S433-3 — exec_command com workdir "workspace" e "workspace\\app" ===');
    fs.mkdirSync(path.join(ws, 'genoffice-app'));
    fs.writeFileSync(path.join(ws, 'genoffice-app', 'marca.txt'), 'x');
    const t = new ExecCommandTool();
    const listar = process.platform === 'win32' ? 'dir /b' : 'ls';
    const r1 = await t.execute({ command: listar, workdir: 'workspace' });
    assert(r1.success === true && /genoffice-app/.test(r1.output), 'workdir "workspace" = a raiz do workspace (onde está genoffice-app)', r1.output);
    const r2 = await t.execute({ command: listar, workdir: process.platform === 'win32' ? 'workspace\\genoffice-app' : 'workspace/genoffice-app' });
    assert(r2.success === true && /marca\.txt/.test(r2.output), 'workdir "workspace\\genoffice-app" = a pasta certa', r2.output);
    assert(!fs.existsSync(path.join(ws, 'workspace')), 'nenhuma pasta workspace\\workspace foi criada');

    try { fs.rmSync(ws, { recursive: true, force: true }); } catch { /* temporário */ }
    console.log(`\n=== S433: ${passed} passaram, ${failed} falharam ===`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
