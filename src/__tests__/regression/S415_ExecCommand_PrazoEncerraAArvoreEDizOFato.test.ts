/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S415
 * exec_command: ao passar do limite de tempo, (1) a árvore inteira de processos é encerrada e (2) o resultado diz o fato.
 *
 * INCIDENTE REAL (Windows, 16/10/2026 02:32, goal_1792128547107_ogo6t — "Consegue instalar no meu Pc"): o `npm install`
 * passou dos 60 s padrão. O `timeout` do exec do Node matou só o cmd.exe — o npm continuou rodando sem dono (medido:
 * um `ping` filho segue vivo depois do shell morto) — e o resultado foi só a saída do npm (avisos "deprecated") +
 * "[exit code: unknown]". Sem o fato "interrompido por tempo", o planejador concluiu "aviso de deprecação tomado por
 * erro" e replanejou por um caminho errado; a ReflectionMemory gravou a falha como do exec_command.
 *
 * LINUX (CI 16/10/2026, Node 22/24): o `exec` do Node NÃO repassa `detached` — o shell ficava no grupo do NewClaw, o sinal ao
 * grupo dava ESRCH e o neto seguia vivo. Por isso o exec_command usa `spawn` com shell (o que o `exec` faz por dentro).
 *
 * REGRESSÃO SE: o neto continuar escrevendo depois do retorno, ou o resultado não começar pelo fato da interrupção
 * (a saída é cortada em 16 mil caracteres — o fato não pode ser o pedaço que some), ou o schema voltar a anunciar
 * um padrão diferente do usado.
 *
 * Execução: npx ts-node src/__tests__/regression/S415_ExecCommand_PrazoEncerraAArvoreEDizOFato.test.ts
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-s415-'));
process.env.WORKSPACE_DIR = pasta;

import { ExecCommandTool, PRAZO_PADRAO_MS } from '../../tools/exec_command';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}
const esperar = (ms: number) => new Promise(r => setTimeout(r, ms));

async function main() {
    const marca = path.join(pasta, 'marca.txt');
    const script = path.join(pasta, 'escreve.js');
    // Escreve na marca a cada 100 ms, para sempre. Gera saída grande no começo para provar que o fato não é cortado.
    // O caminho vai pelo ambiente (o exec_command repassa process.env ao filho), não embutido no código gerado — alerta CodeQL
    // js/bad-code-sanitization #119.
    process.env.S415_MARCA = marca;
    fs.writeFileSync(script, `const fs=require('fs');process.stdout.write('aviso\\n'.repeat(4000));setInterval(()=>fs.appendFileSync(process.env.S415_MARCA,'x'),100);`);
    // `&& echo fim` obriga o shell a ficar como pai (não troca de processo) — o node é NETO do NewClaw, como o npm era.
    const comando = `node "${script}" && echo fim`;

    console.log('\n=== S415-1 — prazo estourado: árvore encerrada ===');
    const t0 = Date.now();
    const r = await new ExecCommandTool().execute({ command: comando, timeout: 1500 });
    const ms = Date.now() - t0;
    assert(r.success === false, 'resultado é falha', r);
    // Folga para máquina carregada: na suíte completa (16/10/2026) o taskkill do Windows sob carga levou o retorno a 8,7 s.
    // O que importa é não ficar preso esperando o comando (que nunca termina sozinho).
    assert(ms < 1500 + 15000, `retorna logo depois do prazo (${ms} ms)`);
    await esperar(600);
    const tamanho1 = fs.existsSync(marca) ? fs.statSync(marca).size : 0;
    await esperar(1500);
    const tamanho2 = fs.existsSync(marca) ? fs.statSync(marca).size : 0;
    assert(tamanho1 > 0, 'o neto chegou a rodar antes do prazo', { tamanho1 });
    assert(tamanho2 === tamanho1, 'depois do retorno, o neto NÃO continua escrevendo (nada ficou rodando sem dono)', { tamanho1, tamanho2 });

    console.log('\n=== S415-2 — o resultado diz o fato, antes da saída ===');
    const texto = r.output || '';
    assert(/^\[interrompido pelo NewClaw: o comando passou do limite de 1500 ms do exec_command/.test(texto), 'o texto COMEÇA pelo fato da interrupção por tempo', texto.slice(0, 200));
    assert(/o comando NÃO terminou/.test(texto), 'diz que o comando não terminou');
    assert(/parâmetro "timeout" do exec_command/.test(texto), 'aponta só para a ferramenta do próprio NewClaw (o parâmetro timeout)');
    assert(/aviso/.test(texto), 'a saída até a interrupção vem junto (final dela)');
    assert(!/\[exit code: unknown\]/.test(texto), 'não aparece mais o "[exit code: unknown]" sem explicação');

    console.log('\n=== S415-3 — comando normal não é afetado ===');
    const ok = await new ExecCommandTool().execute({ command: 'echo pronto', timeout: 10000 });
    assert(ok.success === true && /pronto/.test(ok.output || ''), 'comando rápido continua com sucesso', ok);
    const falha = await new ExecCommandTool().execute({ command: 'node -e "process.exit(3)"', timeout: 10000 });
    assert(falha.success === false && falha.exitCode === 3 && /\[exit code: 3\]/.test(falha.output || ''), 'saída com código ≠ 0 continua como antes (código real)', falha);

    console.log('\n=== S415-3b — saída acima do teto (1 MB): encerrado, com o fato ===');
    const grande = await new ExecCommandTool().execute({ command: `node -e "process.stdout.write('x'.repeat(3*1024*1024));setInterval(()=>{},1000)"`, timeout: 20000 });
    assert(grande.success === false && /^\[interrompido pelo NewClaw: a saída do comando passou de \d+ bytes/.test(grande.output || ''), 'saída gigante: falha começando pelo fato do teto (antes o exec cortava com um erro genérico)', (grande.output || '').slice(0, 200));

    console.log('\n=== S415-4 — o schema anuncia o padrão usado ===');
    const desc = (new ExecCommandTool() as any).parameters?.properties?.timeout?.description ?? (new ExecCommandTool() as any).schema?.properties?.timeout?.description ?? '';
    assert(desc.includes(String(PRAZO_PADRAO_MS)), `descrição do timeout cita ${PRAZO_PADRAO_MS}`, desc);

    try { fs.rmSync(pasta, { recursive: true, force: true }); } catch { /* arquivo preso: o SO limpa a pasta temporária */ }
    console.log(`\n=== S415: ${passed} passaram, ${failed} falharam ===`);
    if (failed > 0) process.exit(1);
}

main().catch(err => { console.error(err); process.exit(1); });
