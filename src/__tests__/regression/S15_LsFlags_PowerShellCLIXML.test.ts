/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S15
 * exec_command: `ls -la`/`ls -lh` encaminhados pro alias `ls` do PowerShell (Get-ChildItem)
 * devem ter as flags POSIX removidas — Get-ChildItem não aceita essas flags e o erro de
 * parâmetro vem serializado como CLIXML ilegível, não como mensagem de texto.
 *
 * PROBLEMA CORRIGIDO (02/07/2026): reproduzido ao vivo em log de auditoria real —
 * `ls -la <workspace>\aula_marp.pptx` (step de verificação pós-conversão
 * do skill pptx-generator) bloqueou um goal com "Erro em 'exec_command': #< CLIXML" como saída
 * inteira do erro, forçando um replan não planejado (GoalStore → blocked → replanning).
 * needsPowerShellWrap() já encaminhava 'ls' pro PowerShell (fix anterior, S11-adjacente), mas
 * não traduzia as flags — o comando chegava intacto como "ls -la <path>" e Get-ChildItem
 * rejeitava o parâmetro "-la".
 *
 * FIX: translateLsFlagsForPowerShell() remove flags POSIX combinadas (-l/-a/-h e combinações)
 * de invocações `ls`, mapeando para `Get-ChildItem <path>` sem flags — suficiente pro caso de
 * uso real (checar existência/tamanho de arquivo), que é o único uso de `ls` neste projeto
 * (inclusive na própria skill pptx-generator, Passo 4: "ls -lh apresentacao.pptx").
 *
 * REGRESSÃO SE: wrapForWindowsPowerShell() parar de chamar translateLsFlagsForPowerShell(),
 * ou se o comando final ainda contiver "-la"/"-lh" após a tradução.
 *
 * EXTENSÃO (27/07/2026): mesma função (wrapForWindowsPowerShell) também ganhou um fix de
 * encoding — reproduzido ao vivo em log de auditoria real do mesmo dia: um exec_command de
 * diagnóstico que imprimia "ffmpeg não encontrado" voltou mangled ("ffmpeg n?o encontrado"),
 * porque powershell.exe -NonInteractive escreve stdout redirecionado na code page legada do
 * sistema, não em UTF-8, enquanto child_process.exec() decodifica como UTF-8. Fix: forçar
 * [Console]::OutputEncoding/$OutputEncoding = UTF8 dentro do comando encaminhado, antes do
 * comando real. Casos abaixo cobrem essa extensão além do escopo original (flags de `ls`).
 *
 * Execução: npx ts-node src/__tests__/regression/S15_LsFlags_PowerShellCLIXML.test.ts
 */

import { translateLsFlagsForPowerShell, wrapForWindowsPowerShell, ExecCommandTool } from '../../tools/exec_command';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`); failed++; }
}

async function main() {
    console.log('\n=== S15 — translateLsFlagsForPowerShell: remove flags POSIX de `ls` ===');

    const original = 'ls -la C:\\Users\\SeuUsuario\\NewClaw\\workspace\\aula_marp.pptx';
    const translated = translateLsFlagsForPowerShell(original);
    assert(!/-la\b/.test(translated), `"-la" removido do comando (resultado: "${translated}")`);
    assert(/Get-ChildItem/.test(translated), 'ls foi mapeado para Get-ChildItem');
    assert(translated.includes('aula_marp.pptx'), 'o path do arquivo foi preservado');

    const lhCase = translateLsFlagsForPowerShell('ls -lh apresentacao.pptx');
    assert(!/-lh\b/.test(lhCase), `"-lh" removido do comando (resultado: "${lhCase}")`);
    assert(lhCase.includes('apresentacao.pptx'), 'path preservado no caso -lh');

    // Não deve mexer em comandos sem 'ls -<flags>' — ex: 'ls' sozinho, ou 'ls' como substring
    // de outra palavra (ex: 'files' não deve virar 'fileGet-ChildItem').
    const noFlags = translateLsFlagsForPowerShell('ls apresentacao.pptx');
    assert(noFlags === 'ls apresentacao.pptx', '`ls` sem flags não é alterado (Get-ChildItem sem flags já funciona via alias)');

    const unrelated = translateLsFlagsForPowerShell('files -la something');
    assert(unrelated === 'files -la something', 'não confunde outras palavras terminadas em "ls"');

    console.log('\n=== S15 — wrapForWindowsPowerShell: chama translateLsFlagsForPowerShell() ===');
    const wrapped = wrapForWindowsPowerShell('ls -la out.pptx');
    // wrapForWindowsPowerShell codifica o comando final em Base64 (UTF-16LE) — decodifica pra
    // inspecionar o texto que de fato seria executado no PowerShell.
    const encodedMatch = wrapped.match(/-EncodedCommand (\S+)/);
    assert(encodedMatch !== null, 'comando encapsulado contém -EncodedCommand');
    if (encodedMatch) {
        const decoded = Buffer.from(encodedMatch[1], 'base64').toString('utf16le');
        assert(!/-la\b/.test(decoded), `comando decodificado não contém "-la" (decoded: "${decoded}")`);
        assert(/Get-ChildItem/.test(decoded), 'comando decodificado usa Get-ChildItem');
    }

    if (process.platform === 'win32') {
        console.log('\n=== S15 — Reprodução ao vivo: ls -la em arquivo real via ExecCommandTool ===');
        const tool = new ExecCommandTool();
        const result = await tool.execute({ command: `ls -la "${process.execPath}"` });
        assert(result.success === true, `ls -la em arquivo real funciona sem CLIXML (output: "${(result.output || result.error || '').slice(0, 200)}")`);
        assert(!/CLIXML/i.test(result.output || '') && !/CLIXML/i.test(result.error || ''), 'saída não contém erro CLIXML');

        console.log('\n=== S15 — wrapForWindowsPowerShell: comando decodificado força UTF-8 na saída ===');
        const wrappedUtf8 = wrapForWindowsPowerShell('Write-Output "teste"');
        const encodedUtf8Match = wrappedUtf8.match(/-EncodedCommand (\S+)/);
        if (encodedUtf8Match) {
            const decodedUtf8 = Buffer.from(encodedUtf8Match[1], 'base64').toString('utf16le');
            assert(/\[Console\]::OutputEncoding = \[System\.Text\.Encoding\]::UTF8/.test(decodedUtf8), 'comando decodificado seta [Console]::OutputEncoding = UTF8');
        }

        console.log('\n=== S15 — Reprodução ao vivo: acento pt-BR sobrevive via ExecCommandTool (bug real 27/07/2026) ===');
        const accentResult = await tool.execute({ command: 'Write-Output "ffmpeg não encontrado"' });
        assert(accentResult.success === true, `comando com acento executa com sucesso (output: "${(accentResult.output || accentResult.error || '').slice(0, 200)}")`);
        assert((accentResult.output || '').includes('não encontrado'), `"não encontrado" preservado sem mangling (output real: "${(accentResult.output || '').slice(0, 200)}")`);
    } else {
        console.log('\n  ⏭️  pulado (não é Windows) — needsPowerShellWrap não ativa fora do win32');
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S15 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    if (failed > 0) process.exit(1);
}

main().catch(err => { console.error('ERRO NÃO TRATADO:', err); process.exit(1); });
