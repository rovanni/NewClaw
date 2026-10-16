/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S420
 * exec_command: o comando continua ENQUANTO TRABALHA (saída, CPU ou disco/rede) e só é encerrado depois de ficar parado, sem
 * nenhum sinal, pela tolerância (ADR-023). Nada de prazo fixo como regra do dia a dia.
 *
 * ORIGEM: teste real 16/10/2026 — o npm install foi cortado aos 60 s fixos, no meio do trabalho. Medição nos dois sistemas:
 * quem trabalha calado (npm, pip, git, cálculo, disco) nunca ficou mais de 2 s sem sinal; quem travou ficou sem nada.
 *
 * REGRESSÃO SE: trabalho calado (CPU ou disco) for cortado; um comando parado NÃO for cortado pela tolerância; o resultado não
 * disser o fato (parado, quanto tempo, que o comando NÃO terminou, e o parâmetro que muda isso).
 * Roda no Windows e no Linux (CI) — cada um com o seu amostrador.
 *
 * Execução: npx ts-node src/__tests__/regression/S420_ExecCommand_ContinuaEnquantoTrabalha.test.ts
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-s420-'));
process.env.WORKSPACE_DIR = pasta;

import { ExecCommandTool, TOLERANCIA_PADRAO_S } from '../../tools/exec_command';
import { amostradorDaPlataforma } from '../../tools/atividadeDoProcesso';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}
const script = (nome: string, codigo: string) => { const f = path.join(pasta, nome); fs.writeFileSync(f, codigo); return `node "${f}"`; };

async function main(): Promise<void> {
    const amostrador = amostradorDaPlataforma();
    const medeAtividade = process.platform === 'win32' || process.platform === 'linux';
    console.log(`(amostrador: ${amostrador.fonte})`);
    const TOL = 3;

    if (medeAtividade) {
        console.log('\n=== S420-1 — cálculo calado (só CPU) por 8 s, tolerância 3 s: NÃO é cortado ===');
        const cpu = await new ExecCommandTool().execute({ tolerancia_sem_atividade: TOL,
            command: script('cpu.js', `const t=Date.now();let x=0;while(Date.now()-t<8000)x++;console.log('fim do calculo')`) });
        assert(cpu.success === true && /fim do calculo/.test(cpu.output || ''), 'terminou sozinho, com sucesso', (cpu.output || '').slice(0, 200));

        console.log('\n=== S420-2 — só disco, sem saída, por 8 s: NÃO é cortado ===');
        const arq = path.join(pasta, 'disco.bin');
        const disco = await new ExecCommandTool().execute({ tolerancia_sem_atividade: TOL,
            command: script('disco.js', `const fs=require('fs');const b=Buffer.alloc(512*1024,7);const t=Date.now();while(Date.now()-t<8000){fs.writeFileSync(${JSON.stringify(arq)},b);fs.readFileSync(${JSON.stringify(arq)});const t2=Date.now();while(Date.now()-t2<20){}}console.log('fim do disco')`) });
        assert(disco.success === true && /fim do disco/.test(disco.output || ''), 'terminou sozinho, com sucesso', (disco.output || '').slice(0, 200));
    } else {
        console.log(`\n(${process.platform}: sem amostrador — S420-1/2 não se aplicam; só a saída conta)`);
    }

    console.log('\n=== S420-3 — só escreve de vez em quando (1 linha/s, CPU parada) por 6 s: NÃO é cortado ===');
    const fala = await new ExecCommandTool().execute({ tolerancia_sem_atividade: TOL,
        command: script('fala.js', `let i=0;const t=setInterval(()=>{console.log('passo '+(++i));if(i>=6){clearInterval(t)}},1000)`) });
    assert(fala.success === true && /passo 6/.test(fala.output || ''), 'terminou sozinho, com sucesso', (fala.output || '').slice(0, 200));

    console.log('\n=== S420-4 — parado (nem saída, nem CPU, nem disco): cortado pela tolerância, com o fato ===');
    const t0 = Date.now();
    const parado = await new ExecCommandTool().execute({ tolerancia_sem_atividade: TOL, command: script('parado.js', `setInterval(()=>{},1000)`) });
    const ms = Date.now() - t0;
    assert(parado.success === false, 'é encerrado (falha)', parado);
    assert(ms >= TOL * 1000 && ms < TOL * 1000 + 9000, `perto da tolerância (${ms} ms para ${TOL} s)`);
    assert(/^\[interrompido pelo NewClaw: o comando ficou 3 s SEM NENHUM sinal de atividade/.test(parado.output || ''), 'o texto começa pelo fato: parado, sem nenhum sinal, por quanto tempo', (parado.output || '').slice(0, 220));
    assert(/o comando NÃO terminou/.test(parado.output || '') && /"tolerancia_sem_atividade"/.test(parado.output || ''), 'diz que NÃO terminou e qual parâmetro muda isso');

    console.log('\n=== S420-5 — o padrão e o schema ===');
    const props = (new ExecCommandTool() as any).parameters.properties;
    assert(TOLERANCIA_PADRAO_S === 30, 'tolerância padrão = 30 s (escolha da operadora, ADR-023)');
    assert(String(props.tolerancia_sem_atividade?.description).includes('30'), 'o schema anuncia a tolerância e o padrão', props.tolerancia_sem_atividade);

    try { fs.rmSync(pasta, { recursive: true, force: true }); } catch { /* temporário */ }
    console.log(`\n=== S420: ${passed} passaram, ${failed} falharam ===`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
