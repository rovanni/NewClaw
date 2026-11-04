/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S475 (ADR-026, etapa 1: o shell é declarado por quem escreve o comando)
 *
 * Origem: produção Windows, 01–21/10/2026 — 363 execuções, 84 falhas, ~17 por desencontro de shell (`grep` no PowerShell,
 * `$h` no cmd, `ls -la` → `Get-ChildItem -la`). O exec_command adivinhava a linguagem por regex e traduzia o texto. A ADR
 * (aprovada em 04/11/2026, etapa 1) acrescenta o parâmetro `shell`: declarado, o comando roda exatamente nele, sem tradução;
 * sem ele, o comportamento antigo continua.
 *
 * O que é real aqui: o `ExecCommandTool` rodando comandos de verdade nos shells desta máquina, as sondas do ambiente
 * (`medirSondas`) e a lista de shells que sai delas. No Windows: cmd e PowerShell; no Linux/macOS: sh e bash (quando medido).
 *
 * Execução: npx ts-node src/__tests__/regression/S475_ShellDeclarado.test.ts
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 's475-'));
process.env.WORKSPACE_DIR = WS;

/* eslint-disable @typescript-eslint/no-var-requires */
const amb = require('../../shared/ambienteDeExecucao') as typeof import('../../shared/ambienteDeExecucao');
const exec = require('../../tools/exec_command') as typeof import('../../tools/exec_command');
/* eslint-enable @typescript-eslint/no-var-requires */

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

async function main(): Promise<void> {
    console.log('\n=== S475-1 — shells disponíveis: só o medido ===');
    const win = { plataforma: 'win32' as const, arquitetura: 'x64', shell: 'C:\\Windows\\system32\\cmd.exe' };
    assert(JSON.stringify(amb.shellsDisponiveis(win)) === '["cmd"]', 'Windows antes da medição: só o shell padrão (cmd)', amb.shellsDisponiveis(win));
    assert(JSON.stringify(amb.shellsDisponiveis({ ...win, medidos: { powershell: '5.1.26100.1', pwsh: amb.NAO_DISPONIVEL, python: 'Python 3.12' } })) === '["cmd","powershell"]',
        'Windows medido: cmd + powershell; pwsh "não disponível" e python (não é shell) ficam de fora');
    const lin = { plataforma: 'linux' as const, arquitetura: 'x64', shell: '/bin/sh' };
    assert(JSON.stringify(amb.shellsDisponiveis({ ...lin, medidos: { bash: '5.2.21(1)-release' } })) === '["sh","bash"]', 'Linux medido: sh + bash');
    assert(JSON.stringify(amb.shellsDisponiveis({ ...lin, medidos: { bash: amb.NAO_DISPONIVEL } })) === '["sh"]', 'Linux sem bash: só sh');
    const descr = amb.descreverAmbienteDeExecucao({ ...win, medidos: { powershell: '5.1' } });
    assert(/parâmetro shell \(cmd, powershell\).*sem tradução/.test(descr), 'os juízes sabem que o shell declarado roda sem tradução', descr);

    console.log('\n=== S475-2 — preparo: declarado roda exatamente no shell, sem tradução ===');
    const ps = exec.preparoDoShell('powershell', 'ls -la; grep x');
    const decodificado = Buffer.from(ps.comando.split(' ').pop()!, 'base64').toString('utf16le');
    assert(ps.comando.startsWith('powershell -NoProfile -NonInteractive -EncodedCommand ') && decodificado.endsWith('; ls -la; grep x'),
        'powershell: o comando vai codificado e INTACTO (ls -la não vira Get-ChildItem)', decodificado);
    assert(!/Get-ChildItem|Select-String|if \(\$\?\)/.test(decodificado), 'nenhuma tradução aplicada');
    assert(exec.preparoDoShell('pwsh', 'x').comando.startsWith('pwsh '), 'pwsh usa o executável pwsh');
    assert(exec.preparoDoShell('cmd', 'dir && echo ok').comando === 'dir && echo ok', 'cmd: o texto não muda');
    assert(exec.preparoDoShell('bash', 'echo $BASH_VERSION').shellDoSpawn === 'bash', 'bash: o executável recebe o comando');
    assert(exec.wrapForWindowsPowerShell('ls -la').includes('-EncodedCommand') && Buffer.from(exec.wrapForWindowsPowerShell('ls -la').split(' ').pop()!, 'base64').toString('utf16le').includes('Get-ChildItem'),
        'sem declaração, o encaminhamento antigo continua traduzindo (transição da etapa 1)');

    console.log('\n=== S475-3 — execução real nos shells medidos desta máquina ===');
    amb.registrarAmbiente({ ...amb.fatosBasicos(), medidos: await amb.medirSondas() });
    const disponiveis = amb.shellsDisponiveis();
    console.log(`  (plataforma=${process.platform}; medidos: ${disponiveis.join(', ')})`);
    const tool = new exec.ExecCommandTool();
    const run = (args: Record<string, unknown>) => tool.execute(args);
    const props = (tool.parameters as { properties: Record<string, { description?: string }> }).properties;
    assert(typeof props.shell?.description === 'string' && disponiveis.every(sh => props.shell.description!.includes(sh)),
        'a descrição do parâmetro lista os shells medidos (lida depois da medição)', props.shell?.description);

    if (process.platform === 'win32') {
        assert(disponiveis.includes('cmd'), 'Windows: cmd medido');
        const cmd = await run({ command: 'echo %OS%', shell: 'cmd' });
        assert(cmd.success && /Windows_NT/.test(cmd.output), 'cmd declarado: variável %OS% expandida pelo cmd', cmd);
        const cmdComCmdlet = await run({ command: 'Get-Date -Format yyyy', shell: 'cmd' });
        assert(!cmdComCmdlet.success, 'cmd declarado com cmdlet: falha no cmd (não é encaminhado ao PowerShell)', cmdComCmdlet);
        if (disponiveis.includes('powershell')) {
            const p = await run({ command: '$x = 40 + 2; Write-Output "resultado=$x olá"', shell: 'powershell' });
            assert(p.success && /resultado=42 olá/.test(p.output), 'powershell declarado: variável e acento (UTF-8) corretos', p);
            const semTraducao = await run({ command: 'ls -la', shell: 'powershell' });
            assert(!semTraducao.success, 'powershell declarado com "ls -la": o erro do shell volta ao agente (sem tradução para Get-ChildItem)', semTraducao);
            const antigo = await run({ command: 'Get-ChildItem -Name' });
            assert(antigo.success, 'sem declaração, o cmdlet continua encaminhado ao PowerShell como antes', antigo);
        } else {
            assert(false, 'powershell deveria estar medido no Windows', disponiveis);
        }
        const bashNoWindows = await run({ command: 'echo oi', shell: 'zsh' });
        assert(!bashNoWindows.success && /não está entre os medidos nesta máquina \(.*cmd.*\)/.test(bashNoWindows.error ?? '') && /não foi executado/.test(bashNoWindows.error ?? ''),
            'shell não medido: recusa com a lista medida, sem rodar em outro', bashNoWindows.error);
    } else {
        assert(disponiveis.includes('sh'), 'Unix: sh sempre disponível');
        const sh = await run({ command: 'echo "a=$((40+2))"', shell: 'sh' });
        assert(sh.success && /a=42/.test(sh.output), 'sh declarado: aritmética do shell', sh);
        if (disponiveis.includes('bash')) {
            const b = await run({ command: '[[ 1 -eq 1 ]] && echo "bash=${BASH_VERSION%%.*}"', shell: 'bash' });
            assert(b.success && /bash=\d+/.test(b.output), 'bash declarado: sintaxe própria do bash ([[ ]], $BASH_VERSION)', b);
        }
        const cmdNoUnix = await run({ command: 'echo oi', shell: 'cmd' });
        assert(!cmdNoUnix.success && /não está entre os medidos/.test(cmdNoUnix.error ?? ''), 'cmd no Unix: recusado com a lista medida', cmdNoUnix.error);
    }

    console.log('\n=== S475-4 — limites ===');
    const ssh = await run({ command: 'ssh://host/ls', shell: disponiveis[0] });
    assert(!ssh.success && /máquina remota/.test(ssh.error ?? ''), 'shell com ssh:// é recusado (o shell é o da máquina remota)', ssh.error);
    const desconhecido = await run({ command: 'echo oi', shell: 'fish' });
    assert(!desconhecido.success && /"fish" não está entre os medidos/.test(desconhecido.error ?? ''), 'shell desconhecido: recusa, nunca escolhe outro', desconhecido.error);
    const maiusculo = await run({ command: 'echo oi', shell: disponiveis[0].toUpperCase() });
    assert(maiusculo.success, 'nome do shell sem diferença de maiúsculas', maiusculo);
    const fonte = fs.readFileSync(path.join(__dirname, '../../tools/exec_command.ts'), 'utf-8');
    assert(fonte.includes('[EXEC-SHELL] declarado=') && fonte.includes("condition: (command, ctx) => !ctx.isSsh && !ctx.shellDeclarado && process.platform === 'win32'"),
        'linha [EXEC-SHELL] no log e encaminhamento desligado quando há declaração');

    fs.rmSync(WS, { recursive: true, force: true });
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S475 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
    console.error('S475 erro inesperado:', err);
    process.exitCode = 1;
});
