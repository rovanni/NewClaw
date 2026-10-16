/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S421
 * exec_command: o teto é o tempo que RESTA ao objetivo (nenhum número próprio) e o "Parar" do usuário encerra o comando na
 * hora, com a árvore (ADR-023 parte 3).
 *
 * REGRESSÃO SE: um comando que trabalha sem parar ultrapassar o prazo do objetivo que o pediu; o "Parar" não alcançar um
 * comando em execução (antes só as chamadas ao modelo ouviam o sinal do turno); o goal deixar de passar o prazo adiante.
 *
 * Execução: npx ts-node src/__tests__/regression/S421_ExecCommand_TetoDoObjetivoEParar.test.ts
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-s421-'));
process.env.WORKSPACE_DIR = pasta;

import { ExecCommandTool } from '../../tools/exec_command';
import { executarComPrazo, executarNoTurno } from '../../shared/turnCancellation';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}

async function main(): Promise<void> {
    const ocupado = path.join(pasta, 'ocupado.js');
    // Trabalha sem parar (escreve a cada 200 ms): nunca fica "parado" — só o teto ou o "Parar" podem encerrá-lo.
    fs.writeFileSync(ocupado, `setInterval(()=>console.log('trabalhando '+Date.now()),200)`);

    console.log('\n=== S421-1 — dentro de um objetivo, o teto é o tempo que resta a ele ===');
    let t0 = Date.now();
    const r = await executarComPrazo(Date.now() + 6000, () => new ExecCommandTool().execute({ command: `node "${ocupado}"` }));
    let ms = Date.now() - t0;
    assert(r.success === false && ms >= 5000 && ms < 6000 + 7000, `encerrado no fim do prazo do objetivo (${ms} ms; o mínimo é 5 s)`, (r.output || '').slice(0, 160));
    assert(/^\[interrompido pelo NewClaw: o comando chegou ao fim do tempo que restava ao objetivo/.test(r.output || ''), 'o fato diz que foi o prazo do OBJETIVO', (r.output || '').slice(0, 160));
    assert(/o comando NÃO terminou/.test(r.output || ''), 'e que o comando NÃO terminou');

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

    console.log('\n=== S421-4 — o prazo do turno não se perde ao entrar no objetivo (e vice-versa) ===');
    const s2 = new AbortController();
    const visto = await executarNoTurno(s2.signal, () => executarComPrazo(123, async () => {
        const { sinalDoTurno, prazoDoTurno } = await import('../../shared/turnCancellation');
        return { sinal: sinalDoTurno() === s2.signal, prazo: prazoDoTurno() };
    }));
    assert(visto.sinal && visto.prazo === 123, 'dentro do objetivo, o sinal do turno continua valendo e o prazo aparece', visto);

    console.log('\n=== S421-5 — o goal passa o prazo adiante ===');
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'loop', 'GoalExecutionLoop.ts'), 'utf-8');
    assert(/return executarComPrazo\(\(\) => this\.goalStore\.getById\(goal\.id\)\?\.expiresAt \?\? goal\.expiresAt, \(\) => this\.runLoopNoPrazo\(/.test(src), 'runLoop roda o objetivo dentro de executarComPrazo(prazo ATUAL do objetivo — acompanha a prorrogação, S426)');

    try { fs.rmSync(pasta, { recursive: true, force: true }); } catch { /* temporário */ }
    console.log(`\n=== S421: ${passed} passaram, ${failed} falharam ===`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
