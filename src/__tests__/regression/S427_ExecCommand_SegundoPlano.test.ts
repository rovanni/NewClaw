/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S427
 * ADR-025 (EXPERIMENTAL — EXEC_EM_SEGUNDO_PLANO=1): o comando que demora segue em SEGUNDO PLANO e o agente acompanha
 * (consultar / aguardar / encerrar) — o trabalho em andamento não é cortado nem perdido. Desligado: como sempre.
 *
 * ORIGEM: operadora, 16/10/2026 — "um pedreiro fazendo um muro: deu o tempo, pare e recomece do zero — não tem lógica".
 * Pesquisa: OpenClaw (10 s → segundo plano + process poll/log/kill + aviso ao terminar), Hermes Agent (background + process),
 * Claude Code (comando que passa do limite vai para segundo plano em vez de ser interrompido).
 *
 * REGRESSÃO SE: desligado mudar o comportamento; ligado, um comando rápido mudar; um longo for cortado em vez de seguir;
 * consultar/aguardar/encerrar não funcionarem; em segundo plano, "sem sinal" encerrar sozinho; um passo direto do objetivo
 * (sem modelo para acompanhar) não aguardar o fim.
 *
 * Execução: npx ts-node src/__tests__/regression/S427_ExecCommand_SegundoPlano.test.ts
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-s427-'));
process.env.WORKSPACE_DIR = pasta;
process.env.EXEC_SEGUNDO_PLANO_APOS_S = '2';

import { ExecCommandTool } from '../../tools/exec_command';
import { registroDeProcessos } from '../../tools/registroDeProcessos';
import { executarAguardandoComandos } from '../../shared/turnCancellation';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}
const esperar = (ms: number) => new Promise(r => setTimeout(r, ms));
const script = (nome: string, codigo: string) => { const f = path.join(pasta, nome); fs.writeFileSync(f, codigo); return `node "${f}"`; };

async function main(): Promise<void> {
    const t = new ExecCommandTool();
    const longo = script('longo.js', `let i=0;const t=setInterval(()=>{console.log('etapa '+(++i));if(i>=6){clearInterval(t);console.log('FIM DO LONGO')}},1000)`);

    console.log('\n=== S427-1 — desligado (padrão): aguarda o fim, como sempre ===');
    delete process.env.EXEC_EM_SEGUNDO_PLANO;
    const off = await t.execute({ command: longo });
    assert(off.success === true && /FIM DO LONGO/.test(off.output) && off.processoEmAndamento === undefined, 'esperou terminar e devolveu a saída inteira', off.output.slice(0, 120));
    assert(registroDeProcessos.rodando().length === 0, 'nada fica no registro');

    process.env.EXEC_EM_SEGUNDO_PLANO = '1';

    console.log('\n=== S427-2 — ligado: comando rápido não muda ===');
    const rapido = await t.execute({ command: 'echo pronto' });
    assert(rapido.success === true && /pronto/.test(rapido.output) && rapido.processoEmAndamento === undefined, 'resultado normal, sem "rodando"', rapido);

    console.log('\n=== S427-3 — ligado: comando longo segue em segundo plano; consultar e aguardar ===');
    const t0 = Date.now();
    const r = await t.execute({ command: longo });
    const ms = Date.now() - t0;
    assert(r.success === true && typeof r.processoEmAndamento === 'number' && ms < 4500, `devolveu em ~2 s com o número do comando (${ms} ms)`, r);
    assert(/O comando NÃO terminou ainda/.test(r.output) && /acompanhar=\d+/.test(r.output), 'o texto diz que NÃO terminou e como acompanhar', r.output.slice(0, 220));
    const n = r.processoEmAndamento!;
    const c = await t.execute({ acompanhar: n, acao: 'consultar' });
    assert(c.processoEmAndamento === n && /rodando há \d+ s/.test(c.output), 'consultar: ainda rodando, com o tempo e a saída até agora', c.output.slice(0, 160));
    const a = await t.execute({ acompanhar: n, acao: 'aguardar' });
    assert(a.success === true && /TERMINOU/.test(a.output) && /FIM DO LONGO/.test(a.output), 'aguardar: o comando terminou sozinho — nada foi cortado nem perdido', a.output.slice(0, 160));
    const depois = await t.execute({ acompanhar: n });
    assert(/TERMINOU/.test(depois.output), 'o resultado de quem terminou continua disponível');

    console.log('\n=== S427-4 — em segundo plano, "sem sinal" NÃO encerra sozinho; encerrar encerra (com a árvore) ===');
    const marca = path.join(pasta, 'marca.txt');
    // O caminho vai pelo ambiente (o exec_command repassa process.env ao filho), não embutido no código gerado — alerta CodeQL
    // js/bad-code-sanitization #120.
    process.env.S427_MARCA = marca;
    const quieto = script('quieto.js', "setTimeout(()=>{setInterval(()=>require('fs').appendFileSync(process.env.S427_MARCA,'x'),300)},6000)");
    const q = await t.execute({ command: quieto, tolerancia_sem_atividade: 2 });
    const nq = q.processoEmAndamento!;
    assert(typeof nq === 'number', 'foi para segundo plano', q);
    await esperar(7000);
    const cq = await t.execute({ acompanhar: nq, acao: 'consultar' });
    assert(cq.processoEmAndamento === nq, 'ficou parado mais que a tolerância (2 s) e continuou vivo — sem sinal é fato, não corte', cq.output.slice(0, 200));
    assert(fs.existsSync(marca), 'e voltou a trabalhar depois da pausa (a pausa era legítima)');
    const e = await t.execute({ acompanhar: nq, acao: 'encerrar' });
    assert(/ENCERRADO/.test(e.output) && /a pedido do agente/.test(e.output), 'encerrar: encerrado, com o fato', e.output.slice(0, 200));
    const tam = fs.statSync(marca).size; await esperar(1500);
    assert(fs.statSync(marca).size === tam, 'a árvore inteira caiu (o neto parou de escrever)');

    console.log('\n=== S427-5 — passo DIRETO do objetivo (sem modelo para acompanhar): aguarda o fim ===');
    const direto = await executarAguardandoComandos(() => t.execute({ command: longo }));
    assert(direto.success === true && /FIM DO LONGO/.test(direto.output) && direto.processoEmAndamento === undefined, 'aguardou até o fim, mesmo com o modo ligado', direto.output.slice(0, 120));

    console.log('\n=== S427-6 — número inexistente ===');
    const x = await t.execute({ acompanhar: 99999 });
    assert(x.success === false && /não há comando nº 99999/.test(x.output), 'diz que não existe (sem inventar estado)');

    delete process.env.EXEC_EM_SEGUNDO_PLANO;
    try { fs.rmSync(pasta, { recursive: true, force: true }); } catch { /* temporário */ }
    console.log(`\n=== S427: ${passed} passaram, ${failed} falharam ===`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
