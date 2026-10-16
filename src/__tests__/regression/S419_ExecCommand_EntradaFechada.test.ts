/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S419
 * exec_command: a entrada do comando é FECHADA — quem pergunta algo termina na hora, em vez de esperar para sempre (ADR-023).
 *
 * MEDIÇÃO (16/10/2026, Windows e Linux): com a entrada aberta e vazia, perguntas interativas (node, python, `set /p`,
 * `Read-Host`, `read`) ficavam sem nenhum sinal de atividade até o corte; fechada, terminavam em 0–2 s. O exec_command não
 * tem como digitar nada — a entrada aberta só produzia travamento.
 *
 * REGRESSÃO SE: um programa que espera o teclado voltar a prender o exec_command até o limite de tempo.
 *
 * Execução: npx ts-node src/__tests__/regression/S419_ExecCommand_EntradaFechada.test.ts
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-s419-'));
process.env.WORKSPACE_DIR = pasta;

import { ExecCommandTool } from '../../tools/exec_command';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}

async function main(): Promise<void> {
    const pergunta = path.join(pasta, 'pergunta.js');
    fs.writeFileSync(pergunta, `process.stdout.write('Continuar? [s/N] ');
process.stdin.once('data', d => { console.log('resposta:', String(d).trim()); process.exit(0); });
process.stdin.once('end', () => { console.log('(entrada fechada: sem resposta)'); process.exit(2); });`);

    console.log('\n=== S419-1 — programa que pergunta: termina na hora, com o que aconteceu ===');
    const t0 = Date.now();
    const r = await new ExecCommandTool().execute({ command: `node "${pergunta}"`, timeout: 20000 });
    const ms = Date.now() - t0;
    assert(ms < 8000, `termina logo (${ms} ms), não espera até o limite de 20 s`);
    assert(r.success === false && r.exitCode === 2, 'o programa recebeu "fim da entrada" e saiu com o próprio código', r);
    assert(/entrada fechada: sem resposta/.test(r.output || ''), 'a saída mostra o que o programa fez sem resposta', r.output);

    console.log('\n=== S419-2 — o shell do sistema também não espera ===');
    const shell = process.platform === 'win32' ? 'set /p X=Continuar? ' : 'read -r X; echo "lido=[$X]"';
    const t1 = Date.now();
    const s = await new ExecCommandTool().execute({ command: shell, timeout: 20000 });
    assert(Date.now() - t1 < 8000, `pergunta do shell (${process.platform === 'win32' ? 'set /p' : 'read'}) termina logo (${Date.now() - t1} ms)`, s);

    console.log('\n=== S419-3 — fonte: a entrada é fechada no spawn ===');
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'tools', 'exec_command.ts'), 'utf-8');
    assert(/spawn\(command, \{[^}]*stdio: \['ignore', 'pipe', 'pipe'\]/.test(src), "stdio: ['ignore', 'pipe', 'pipe']");

    try { fs.rmSync(pasta, { recursive: true, force: true }); } catch { /* temporário */ }
    console.log(`\n=== S419: ${passed} passaram, ${failed} falharam ===`);
    if (failed > 0) process.exit(1);
}

main().catch(err => { console.error(err); process.exit(1); });
