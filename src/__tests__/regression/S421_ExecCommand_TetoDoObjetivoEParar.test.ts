/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S421 (reescrito pela ADR-027)
 * exec_command: um comando que TRABALHA não tem teto de duração (antes: o que restava ao objetivo, ou 30 min) — só o "Parar"
 * do usuário, a tolerância sem atividade (travado) ou um `timeout` pedido pelo agente o encerram. O "Parar" encerra o
 * comando na hora, com a árvore (ADR-023 parte 3).
 *
 * REGRESSÃO SE: um comando trabalhando voltar a ser cortado por um prazo que ninguém pediu (do objetivo ou fixo); o "Parar"
 * não alcançar um comando em execução; o objetivo voltar a passar um prazo final para o que ele executa.
 *
 * Execução: npx ts-node src/__tests__/regression/S421_ExecCommand_TetoDoObjetivoEParar.test.ts
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-s421-'));
process.env.WORKSPACE_DIR = pasta;

import { ExecCommandTool } from '../../tools/exec_command';
import { executarNoTurno } from '../../shared/turnCancellation';
import * as turno from '../../shared/turnCancellation';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}

async function main(): Promise<void> {
    const ocupado = path.join(pasta, 'ocupado.js');
    // Trabalha sem parar (escreve a cada 200 ms): nunca fica "parado" — só o teto ou o "Parar" podem encerrá-lo.
    fs.writeFileSync(ocupado, `setInterval(()=>console.log('trabalhando '+Date.now()),200)`);

    console.log('\n=== S421-1 — sem timeout pedido, um comando trabalhando segue até o "Parar" (sem teto de duração) ===');
    const parar = new AbortController();
    let t0 = Date.now();
    setTimeout(() => parar.abort(), 6000);
    const r = await executarNoTurno(parar.signal, () => new ExecCommandTool().execute({ command: `node "${ocupado}"` }));
    let ms = Date.now() - t0;
    assert(r.success === false && ms >= 5900, `seguiu trabalhando até o "Parar" (${ms} ms) — nenhum prazo o cortou antes`, (r.output || '').slice(0, 160));
    assert(/^\[interrompido pelo NewClaw: o usuário cancelou o pedido/.test(r.output || ''), 'quem encerrou foi o usuário, não um relógio', (r.output || '').slice(0, 160));
    assert(/trabalhando \d+/.test(r.output || ''), 'a saída até ali vem junto');

    console.log('\n=== S421-2 — "Parar" do usuário encerra o comando na hora ===');
    const ctrl = new AbortController();
    t0 = Date.now();
    setTimeout(() => ctrl.abort(), 1500);
    const c = await executarNoTurno(ctrl.signal, () => new ExecCommandTool().execute({ command: `node "${ocupado}"` }));
    ms = Date.now() - t0;
    assert(c.success === false && ms < 1500 + 6000, `encerrado logo depois do "Parar" (${ms} ms)`, (c.output || '').slice(0, 160));
    assert(/^\[interrompido pelo NewClaw: o usuário cancelou o pedido \("Parar"\)/.test(c.output || ''), 'o fato diz que foi o usuário', (c.output || '').slice(0, 160));

    console.log('\n=== S421-3 — "Parar" já dado antes: nem segue rodando ===');
    const ja = new AbortController(); ja.abort();
    t0 = Date.now();
    const j = await executarNoTurno(ja.signal, () => new ExecCommandTool().execute({ command: `node "${ocupado}"` }));
    assert(j.success === false && Date.now() - t0 < 7000 && /cancelou o pedido/.test(j.output || ''), `encerrado logo (${Date.now() - t0} ms)`, (j.output || '').slice(0, 120));

    console.log('\n=== S421-4 — não existe mais "prazo final do objetivo" para herdar ===');
    assert(!('executarComPrazo' in turno) && !('prazoDoTurno' in turno), 'o módulo do turno não oferece prazo final (só o sinal do "Parar")');

    console.log('\n=== S421-5 — o goal não passa prazo adiante; o comando não procura um ===');
    const loopSrc = fs.readFileSync(path.join(process.cwd(), 'src', 'loop', 'GoalExecutionLoop.ts'), 'utf-8');
    const execSrc = fs.readFileSync(path.join(process.cwd(), 'src', 'tools', 'exec_command.ts'), 'utf-8');
    assert(!/executarComPrazo\(/.test(loopSrc), 'runLoop não roda o objetivo dentro de um prazo final');
    assert(!/prazoDoTurno\(|PRAZO_PADRAO_MS|GOAL_LIMITS/.test(execSrc), 'exec_command não tem teto padrão nem herda o do objetivo');

    try { fs.rmSync(pasta, { recursive: true, force: true }); } catch { /* temporário */ }
    console.log(`\n=== S421: ${passed} passaram, ${failed} falharam ===`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
