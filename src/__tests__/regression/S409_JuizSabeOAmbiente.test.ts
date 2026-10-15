/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S409
 * Todo juiz sabe em que sistema operacional e em que shell os comandos do agente rodam DE VERDADE.
 *
 * ORIGEM (Telegram, 15/10/2026): o juiz de risco aprovou um plano com `py -3 -m pip install … 2>$null; py -3 script.py` (sintaxe
 * de PowerShell) num Windows em que o exec_command roda esse comando no cmd.exe — o passo falhou e o goal replanejou. O juiz não
 * tinha como saber: nenhum prompt de juiz dizia o sistema nem o shell. Pedido da usuária: "Isso deve ser passado ao juiz! Qual
 * sistema operacional! Facilitaria bastante!"
 *
 * REGRESSÃO SE: o bloco "CONTEXTO DO SISTEMA" deixar de trazer o ambiente; ou o roteamento do exec_command mudar (cmd.exe ×
 * powershell.exe) sem a descrição que os juízes leem mudar junto.
 *
 * Execução: npx ts-node src/__tests__/regression/S409_JuizSabeOAmbiente.test.ts
 */
import { descreverAmbienteDeExecucao } from '../../shared/ambienteDeExecucao';
import { needsPowerShellWrap } from '../../tools/exec_command';
import { ValidationEngine } from '../../validation/ValidationEngine';
import { descritorRiscoDoPlano } from '../../validation/tipos/demaisTipos';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}

console.log('\n=== S409-1 — a descrição do ambiente bate com o roteamento REAL do exec_command no Windows ===');
{
    const win = descreverAmbienteDeExecucao('win32');
    assert(/Windows/.test(win) && /cmd\.exe/.test(win) && /powershell\.exe/.test(win), 'Windows: diz cmd.exe e quando vai para o powershell.exe', win);
    // O que a descrição afirma, conferido contra a função que decide de verdade:
    assert(!needsPowerShellWrap('py -3 -m pip install pdfplumber 2>$null; py -3 tmp/extrair.py'), 'comando sem cmdlet (o do incidente) roda no cmd.exe — como a descrição diz');
    assert(needsPowerShellWrap('Get-ChildItem -Path .'), 'cmdlet Verbo-Substantivo vai para o powershell.exe — como a descrição diz');
    assert(needsPowerShellWrap('ls -la tmp'), 'comando típico de Linux (ls) vai para o powershell.exe — como a descrição diz');
    assert(/";" não separa comandos/.test(win) && /apt-get/.test(win), 'avisa as duas armadilhas vistas ao vivo: ";"/2>$null no cmd.exe e apt-get no Windows');
    // A versão só entra pela CONSEQUÊNCIA que muda o que é válido: o exec_command chama `powershell` (sempre o 5.1 no Windows).
    assert(/PowerShell 5\.1, que não aceita "&&" nem "\|\|"/.test(win), 'PowerShell 5.1 com a consequência: sem "&&" nem "||"');
    assert(/Linux/.test(descreverAmbienteDeExecucao('linux')) && /\/bin\/sh/.test(descreverAmbienteDeExecucao('linux')), 'Linux: /bin/sh');
    assert(/macOS/.test(descreverAmbienteDeExecucao('darwin')), 'macOS reconhecido');
}

console.log('\n=== S409-2 — o ambiente entra no prompt de TODO juiz, no contexto do sistema (não é evidência) ===');
{
    const motor = new ValidationEngine({} as never, undefined, undefined, undefined, undefined, () => 'Sistema operacional: Windows. AMBIENTE-DE-TESTE.');
    const p = motor.montarPrompt(descritorRiscoDoPlano as never, { pedido: 'ler o pdf', plano: '1. [exec_command] py -3 x.py' }, new Date('2026-10-15T19:51:00-03:00'));
    const bloco = p.slice(p.indexOf('CONTEXTO DO SISTEMA (não é evidência):'), p.indexOf('CHECKLIST'));
    assert(/Data e hora atuais/.test(bloco) && /AMBIENTE-DE-TESTE/.test(bloco), 'o ambiente vem junto da data, no bloco do sistema', bloco);
    assert(/comandos, caminhos e instruções servem a esta máquina/.test(bloco), 'e diz para que serve');
    const padrao = new ValidationEngine({} as never).montarPrompt(descritorRiscoDoPlano as never, { pedido: 'x', plano: 'y' }, new Date());
    assert(padrao.includes(descreverAmbienteDeExecucao()), 'sem injeção, o motor usa o ambiente desta máquina');
    const versao = new ValidationEngine({} as never).montarPrompt(descritorRiscoDoPlano as never, { pedido: 'x', plano: 'y' });
    assert(!/Sistema operacional/.test(versao), 'o prompt usado para a VERSÃO (sem data) continua sem o bloco do sistema — a versão não muda');
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S409 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
process.exit(failed > 0 ? 1 : 0);
