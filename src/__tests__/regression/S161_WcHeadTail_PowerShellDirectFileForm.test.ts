/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S161
 * exec_command: `wc -l` sem tradução nenhuma para PowerShell + `head`/`tail` com forma de
 * arquivo direto (sem pipe) silenciosamente quebrada
 *
 * INCIDENTE REAL #1 (newclaw-audit.log, 2026-07-29 23:20:44-45, goal_1785377727278_guufa):
 * `ls -la arquivo.html 2>/dev/null && wc -l arquivo.html` foi encaminhado ao PowerShell —
 * `ls`/`2>/dev/null` traduzidos corretamente, mas `wc` não tinha NENHUMA tradução (diferente
 * de head/tail, que já tinham translateHeadTailForPowerShell). PowerShell 5.1 não tem alias
 * pra `wc` — resultado: "wc : O termo 'wc' não é reconhecido..." (CommandNotFoundException),
 * um passo do goal perdido. Confirmado ao vivo nesta máquina (30/07/2026): `wc -l arquivo`
 * funciona aqui só porque este ambiente tem os utilitários GNU do Git for Windows no PATH —
 * a máquina de produção real (rodando via Tarefa Agendada) NÃO tem, daí o
 * CommandNotFoundException real. Sem tradução nativa, o comportamento depende de sorte de
 * ambiente, exatamente a mesma classe de problema do PATH-divergence do S160 (ENOENT).
 *
 * INCIDENTE REAL #2 (achado ao investigar o #1, reproduzido ao vivo nesta máquina em
 * 30/07/2026, NÃO estava nos logs): a tradução existente de head/tail
 * (`Select-Object -First/-Last N`) só funciona quando os dados vêm de um pipe anterior.
 * Quando head/tail recebe um arquivo direto como argumento (`head -2 arquivo.txt`, sem
 * pipe — uso legítimo e comum), a tradução vira `Select-Object -First 2 arquivo.txt`, que
 * RODA COM SUCESSO (exit code 0) mas NÃO LÊ O ARQUIVO — retorna output vazio, sem nenhum
 * erro. Pior que o CommandNotFoundException do wc: uma falha completamente silenciosa que
 * nem o LLM nem o validador teriam como perceber olhando só pro exit code.
 *
 * FIX:
 *   1. translateWcForPowerShell() — traduz `wc -l <arquivo>` para
 *      `(Get-Content <arquivo> | Measure-Object -Line).Lines`, e `<cmd> | wc -l` (forma via
 *      pipe) para `Measure-Object -Line | Select-Object -ExpandProperty Lines`. 100% nativo
 *      do PowerShell — não depende de nenhum .exe externo resolvido via PATH.
 *   2. translateHeadTailForPowerShell() — passa a detectar a forma com arquivo direto
 *      (captura o path e envolve em `Get-Content <path> | Select-Object -First/-Last N`)
 *      ANTES de aplicar a forma "nua" (só quando não há arquivo, isto é, dados vêm de pipe).
 *
 * REGRESSÃO SE: `wc -l` deixar de ser traduzido, ou head/tail com arquivo direto voltar a
 * produzir output vazio, ou a forma via pipe (já funcionando) parar de funcionar.
 *
 * Execução: npx ts-node src/__tests__/regression/S161_WcHeadTail_PowerShellDirectFileForm.test.ts
 */

process.env.WORKSPACE_DIR = process.env.WORKSPACE_DIR || 'D:/IA/newclaw/workspace';

import * as fs from 'fs';
import * as path from 'path';
import {
    translateWcForPowerShell,
    translateHeadTailForPowerShell,
    ExecCommandTool,
} from '../../tools/exec_command';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

async function main() {
    // ── 1. translateWcForPowerShell — unidade ───────────────────────────────────
    console.log('\n=== S161 — translateWcForPowerShell: forma com arquivo direto ===');
    {
        const out = translateWcForPowerShell('wc -l arquivo.txt');
        assert(!/\bwc\b/i.test(out), `"wc" removido do comando (resultado: "${out}")`);
        assert(/Get-Content arquivo\.txt/.test(out), 'envolve em Get-Content com o path correto');
        assert(/Measure-Object -Line/.test(out), 'usa Measure-Object -Line');
    }

    console.log('\n=== S161 — translateWcForPowerShell: forma via pipe ===');
    {
        const out = translateWcForPowerShell('type arquivo.txt | wc -l');
        assert(!/\bwc\b/i.test(out), `"wc" removido do comando via pipe (resultado: "${out}")`);
        assert(/Measure-Object -Line \| Select-Object -ExpandProperty Lines/.test(out), 'traduz para Measure-Object + Select-Object -ExpandProperty Lines');
    }

    // ── 2. translateHeadTailForPowerShell — unidade ─────────────────────────────
    console.log('\n=== S161 — translateHeadTailForPowerShell: forma com arquivo direto (bug #2) ===');
    {
        const out = translateHeadTailForPowerShell('head -2 arquivo.txt');
        assert(/Get-Content arquivo\.txt/.test(out), `envolve em Get-Content (resultado: "${out}")`);
        assert(/Select-Object -First 2/.test(out), 'preserva -First N');
    }
    {
        const out = translateHeadTailForPowerShell('tail -5 arquivo.txt');
        assert(/Get-Content arquivo\.txt/.test(out), `tail também envolve em Get-Content (resultado: "${out}")`);
        assert(/Select-Object -Last 5/.test(out), 'preserva -Last N');
    }

    console.log('\n=== S161 — translateHeadTailForPowerShell: forma via pipe não regride ===');
    {
        const out = translateHeadTailForPowerShell('cmd 2>&1 | tail -20');
        assert(!/Get-Content/.test(out), `forma via pipe NÃO usa Get-Content (resultado: "${out}")`);
        assert(/Select-Object -Last 20/.test(out), 'forma via pipe continua traduzindo para Select-Object nu');
    }

    // ── 3. Smoke test real: os dois bugs, resolvidos, nesta máquina Windows ─────
    if (process.platform === 'win32') {
        console.log('\n=== S161 — Smoke test real (subprocess de verdade nesta máquina Windows) ===');
        const tool = new ExecCommandTool();
        const testFile = path.join(process.env.WORKSPACE_DIR!, 'probe_s161_regression.txt');
        fs.writeFileSync(testFile, 'linha1\nlinha2\nlinha3\n');
        try {
            const wcResult = await tool.execute({ command: 'wc -l probe_s161_regression.txt' });
            assert(wcResult.success === true && (wcResult.output ?? '').trim() === '3', `wc -l real conta linhas corretamente — obtido: ${JSON.stringify(wcResult)}`);

            const headResult = await tool.execute({ command: 'head -2 probe_s161_regression.txt' });
            assert(headResult.success === true && (headResult.output ?? '').trim().length > 0, `head -2 real NÃO retorna vazio — obtido: ${JSON.stringify(headResult)}`);
            assert((headResult.output ?? '').includes('linha1') && (headResult.output ?? '').includes('linha2'), 'head -2 real contém as 2 primeiras linhas');

            const chainResult = await tool.execute({ command: 'ls -la probe_s161_regression.txt 2>/dev/null && wc -l probe_s161_regression.txt && head -30 probe_s161_regression.txt' });
            assert(chainResult.success === true, `cadeia exata do incidente real (ls && wc -l && head -30) funciona — obtido: ${JSON.stringify(chainResult).slice(0, 200)}`);
        } finally {
            fs.unlinkSync(testFile);
        }
    } else {
        console.log('\n=== S161 — Smoke test real pulado (não é Windows) ===');
    }

    // ── Resultado ────────────────────────────────────────────────────────────────
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S161 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    console.log(`\nCOBERTURA:`);
    console.log(`  translateWcForPowerShell (arquivo direto + pipe): testado`);
    console.log(`  translateHeadTailForPowerShell (arquivo direto + pipe, sem regressão): testado`);
    console.log(`  Smoke test real: ${process.platform === 'win32' ? 'testado (live)' : 'pulado (não-Windows)'}`);
    if (failed > 0) process.exit(1);
}

main();
