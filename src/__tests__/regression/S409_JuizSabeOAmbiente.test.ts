/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S409
 * Agente e juízes recebem o ambiente MEDIDO (sistema, versão, shell real do exec_command, respostas das consultas de
 * sondasDoAmbiente.json) — nunca regra escrita no código.
 *
 * ORIGEM (Telegram, 15/10/2026): o juiz de risco aprovou `py -3 -m pip install … 2>$null; py -3 script.py` (sintaxe de PowerShell)
 * num Windows em que o exec_command roda esse comando no cmd.exe; e o agente ouvia "shell: powershell" — valor fixo no código.
 * Diretriz da usuária: "Não quero nada fixo direto no código… comandos para buscar… que daí ele vai se ajustar ao ambiente".
 * O código só sabe PERGUNTAR (lista de consultas em JSON, executor genérico, sem LLM); a resposta vem do sistema.
 *
 * REGRESSÃO SE: o shell informado voltar a ser escrito à mão; o texto voltar a ter regra sobre versão/shell; as consultas saírem
 * do arquivo de dados; o executor travar ou lançar numa consulta que falha; ou o roteamento do exec_command mudar sem a frase que o
 * descreve mudar junto.
 *
 * Execução: npx ts-node src/__tests__/regression/S409_JuizSabeOAmbiente.test.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { descreverAmbienteDeExecucao, fatosBasicos, medirSondas, sondasPara, type FatosDoAmbiente } from '../../shared/ambienteDeExecucao';
import { needsPowerShellWrap } from '../../tools/exec_command';
import { ValidationEngine } from '../../validation/ValidationEngine';
import { descritorRiscoDoPlano } from '../../validation/tipos/demaisTipos';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}

async function main(): Promise<void> {
    console.log('\n=== S409-1 — as consultas são DADOS, e o executor é genérico (sem LLM, nunca lança) ===');
    {
        for (const p of ['win32', 'linux', 'darwin'] as const) {
            assert(sondasPara(p).length > 0 && sondasPara(p).every(s => s.fato && s.comando && Array.isArray(s.argumentos)), `há consultas para ${p} no arquivo de dados`);
        }
        assert(sondasPara('win32').some(s => s.fato === 'powershell' && s.argumentos.join(' ').includes('$PSVersionTable')), 'Windows: a versão do PowerShell é PERGUNTADA ao próprio PowerShell');
        const r = await medirSondas([
            { fato: 'node', comando: process.execPath, argumentos: ['-e', 'console.log(process.versions.node)'] },
            { fato: 'inexistente', comando: 'comando-que-nao-existe-s409', argumentos: [] },
        ]);
        assert(r.node === process.versions.node, 'uma consulta que funciona devolve a primeira linha da resposta', r);
        assert(r.inexistente === 'não disponível', 'uma consulta que falha vira "não disponível" — sem lançar, sem travar', r);
    }

    console.log('\n=== S409-2 — o texto tem fatos, não regras; o shell é o do child_process ===');
    {
        const f: FatosDoAmbiente = { plataforma: 'win32', versao: 'Windows 11 Pro 10.0.26200', arquitetura: 'x64', shell: 'C:\\WINDOWS\\system32\\cmd.exe', medidos: { powershell: '5.1.26100.6584', python: 'Python 3.12.10' }, gerenciadorDePacotes: 'winget' };
        const t = descreverAmbienteDeExecucao(f);
        assert(/Windows 11 Pro 10\.0\.26200/.test(t) && /cmd\.exe/.test(t) && /powershell: 5\.1\.26100\.6584/.test(t) && /python: Python 3\.12\.10/.test(t) && /winget/.test(t), 'leva sistema, versão, shell, medições e gerenciador', t);
        assert(!/&&|não aceita|não separa|apt-get|não existe/.test(t), 'nenhuma regra escrita sobre o que cada shell/versão aceita — o modelo deduz dos fatos', t);
        assert(fatosBasicos('win32').shell === (process.env.ComSpec || 'cmd.exe') && fatosBasicos('linux').shell === '/bin/sh', 'shell = o do child_process (ComSpec no Windows, /bin/sh no Unix), não um nome escrito à mão');
        const reg = fs.readFileSync(path.join(__dirname, '../../core/CapabilityRegistry.ts'), 'utf-8');
        assert(!/shell = 'powershell'/.test(reg) && !/PSVersionTable/.test(reg), 'CapabilityRegistry não escreve o shell nem a consulta do PowerShell no código (antes: shell = \'powershell\')');
        assert(/medirSondas\(\)/.test(reg) && /registrarAmbiente\(/.test(reg), 'CapabilityRegistry mede pelas sondas e registra a medição para agente e juízes');
    }

    console.log('\n=== S409-3 — a única frase sobre a ferramenta bate com o roteamento REAL do exec_command ===');
    {
        const t = descreverAmbienteDeExecucao({ ...fatosBasicos('win32') });
        assert(/cmdlet do PowerShell ou utilitário Unix são encaminhados pelo exec_command ao powershell\.exe/.test(t), 'a frase descreve o encaminhamento');
        assert(!needsPowerShellWrap('py -3 -m pip install pdfplumber 2>$null; py -3 tmp/extrair.py'), 'sem cmdlet (o comando do incidente) → fica no shell padrão (cmd.exe)');
        assert(needsPowerShellWrap('Get-ChildItem -Path .') && needsPowerShellWrap('ls -la tmp'), 'cmdlet ou utilitário Unix → powershell.exe');
    }

    console.log('\n=== S409-4 — o ambiente entra no prompt de TODO juiz, no contexto do sistema (não é evidência) ===');
    {
        const motor = new ValidationEngine({} as never, undefined, undefined, undefined, undefined, () => 'Sistema operacional: Windows. AMBIENTE-DE-TESTE.');
        const p = motor.montarPrompt(descritorRiscoDoPlano as never, { pedido: 'ler o pdf', plano: '1. [exec_command] py -3 x.py' }, new Date('2026-10-15T19:51:00-03:00'));
        const bloco = p.slice(p.indexOf('CONTEXTO DO SISTEMA (não é evidência):'), p.indexOf('CHECKLIST'));
        assert(/Data e hora atuais/.test(bloco) && /AMBIENTE-DE-TESTE/.test(bloco), 'o ambiente vem junto da data, no bloco do sistema', bloco);
        const versao = new ValidationEngine({} as never).montarPrompt(descritorRiscoDoPlano as never, { pedido: 'x', plano: 'y' });
        assert(!/Sistema operacional/.test(versao), 'o prompt usado para a VERSÃO (sem data) continua sem o bloco do sistema');
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S409 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    process.exit(failed > 0 ? 1 : 0);
}
main().catch(err => { console.error('S409 erro inesperado:', err); process.exit(1); });
