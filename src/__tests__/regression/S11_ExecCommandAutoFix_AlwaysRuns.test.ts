/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S11
 * exec_command: auto-fixes de comando (marp/pandoc/--no-stdin, cmdlet PowerShell) devem
 * rodar SEMPRE, incondicionalmente — não só quando o RiskAnalyzer é acionado.
 *
 * PROBLEMA CORRIGIDO (01/07/2026): essas correções viviam em RiskAnalyzer.ts, mas
 * GoalExecutionLoop.isComplexPlan() só aciona o RiskAnalyzer.analyze() (Q2) quando o plano
 * tem 3+ steps, ou exec_command+write/send_document/edit no mesmo plano. Um plano de 1 step
 * só com "exec_command: marp arquivo.md" ou "exec_command: Get-ChildItem" — o caso mais
 * comum — pulava o Q2 inteiro, e as correções nunca eram aplicadas. Reproduzido ao vivo: o
 * mesmo comando Get-ChildItem funcionou uma vez (quando por acaso um goal anterior deixou o
 * plano "complexo") e falhou de novo minutos depois com plano de 1 step.
 *
 * FIX: as correções foram movidas para dentro de ExecCommandTool.execute(), que roda
 * incondicionalmente para toda chamada — sem depender de RiskAnalyzer, isComplexPlan(),
 * nem de nenhum estado de plano.
 *
 * REGRESSÃO SE: alguém mover essas checagens de volta para RiskAnalyzer.ts (ou qualquer
 * lugar condicionado a isComplexPlan), ou se ExecCommandTool.execute() parar de aplicá-las.
 *
 * Este teste chama ExecCommandTool.execute() DIRETAMENTE, sem GoalPlanner/RiskAnalyzer/
 * GoalExecutionLoop no caminho — é a prova mais forte possível de que a correção não
 * depende de nenhuma decisão de complexidade de plano.
 *
 * Execução: npx ts-node src/__tests__/regression/S11_ExecCommandAutoFix_AlwaysRuns.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { ExecCommandTool } from '../../tools/exec_command';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`); failed++; }
}

async function main() {
    const tool = new ExecCommandTool();

    // ── Marp/pandoc: fail-fast sem arquivo de entrada ──────────────────────────
    console.log('\n=== S11 — marp/pandoc sem arquivo: fail-fast (sem plano complexo, sem RiskAnalyzer) ===');

    const t0 = Date.now();
    const marpResult = await tool.execute({ command: 'marp --no-stdin -o out.html' });
    const marpElapsed = Date.now() - t0;
    assert(marpResult.success === false, 'marp sem arquivo de entrada é rejeitado (success=false)');
    assert(/arquivo .md de entrada/i.test(marpResult.error ?? ''), 'mensagem de erro explica o problema real');
    assert(marpElapsed < 2000, `rejeição é rápida (fail-fast), não espera timeout (elapsed=${marpElapsed}ms)`);

    const pandocResult = await tool.execute({ command: 'pandoc -o out.html' });
    assert(pandocResult.success === false, 'pandoc sem arquivo de entrada é rejeitado (success=false)');
    assert(/arquivo de entrada/i.test(pandocResult.error ?? ''), 'mensagem de erro do pandoc explica o problema real');

    // ── PowerShell: cmdlet só é encaminhado no Windows ──────────────────────────
    console.log('\n=== S11 — cmdlet PowerShell: encaminhado só quando process.platform === "win32" ===');

    if (process.platform === 'win32') {
        const psResult = await tool.execute({ command: 'Get-ChildItem' });
        assert(psResult.success === true, 'Get-ChildItem funciona via exec_command no Windows (chamada direta, sem plano)');
    } else {
        console.log('  ⏭️  pulado (não é Windows) — needsPowerShellWrap não deve ativar fora do win32');
    }

    // ── Prova estrutural: as checagens vivem em exec_command.ts, não atrás de gate ──
    console.log('\n=== S11 — Localização: checagens vivem em exec_command.ts, não em código condicionado ao Q2 ===');

    const execCommandSource = fs.readFileSync(path.join(process.cwd(), 'src', 'tools', 'exec_command.ts'), 'utf-8');
    const executeBody = execCommandSource.slice(execCommandSource.indexOf('async execute('));

    for (const fn of ['isMarpWithoutInputFile', 'isPandocWithoutInputFile', 'needsPowerShellWrap']) {
        assert(executeBody.includes(fn + '('), `execute() chama ${fn}() incondicionalmente`);
    }

    const goalExecutionLoopSource = fs.readFileSync(path.join(process.cwd(), 'src', 'loop', 'GoalExecutionLoop.ts'), 'utf-8');
    assert(
        /private isComplexPlan/.test(goalExecutionLoopSource),
        'isComplexPlan() ainda existe em GoalExecutionLoop (gate continua válido pro RiskAnalyzer — só não deve gatekeepar auto-fix de comando)'
    );

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S11 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    if (failed > 0) process.exit(1);
}

main().catch(err => { console.error('ERRO NÃO TRATADO:', err); process.exit(1); });
