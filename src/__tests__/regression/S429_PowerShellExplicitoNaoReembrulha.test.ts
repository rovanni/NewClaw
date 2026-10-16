/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S429
 * exec_command no Windows: um cmdlet DENTRO de uma chamada explícita de PowerShell (`… & powershell -Command "Get-PSDrive …"`)
 * não é motivo para embrulhar a linha inteira no PowerShell.
 *
 * INCIDENTE REAL (Windows, 16/10/2026, "instalar o VoiceStudio"): o agente escreveu
 *   python --version & git --version & powershell -NoProfile -Command "Get-PSDrive -PSProvider FileSystem | …"
 * O NewClaw viu o `Get-PSDrive`, embrulhou TUDO em powershell.exe — e o `&` do cmd não é operador no PowerShell 5.1: erro de
 * sintaxe "No linha:1 caractere:226", passo bloqueado, replanejamento.
 *
 * REGRESSÃO SE: o caso real voltar a ser embrulhado; ou cmdlets FORA de um PowerShell explícito deixarem de ser encaminhados
 * (o encaminhamento continua necessário para eles).
 *
 * Execução: npx ts-node src/__tests__/regression/S429_PowerShellExplicitoNaoReembrulha.test.ts
 */
import { needsPowerShellWrap } from '../../tools/exec_command';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}

console.log('\n=== S429 — quando embrulhar no PowerShell ===');
const casos: Array<[string, boolean, string]> = [
    ['python --version & git --version & powershell -NoProfile -Command "Get-PSDrive -PSProvider FileSystem | Format-Table Name,Free"', false, 'o caso real: cmdlet só dentro do powershell explícito → NÃO embrulha'],
    ["echo oi & pwsh -c 'Get-Date'", false, 'pwsh explícito com aspas simples → NÃO embrulha'],
    ['powershell -Command "Get-Process"', false, 'linha que já começa com powershell → NÃO embrulha (como antes)'],
    ['Get-ChildItem . | Select-Object Name', true, 'cmdlet solto → embrulha (como antes)'],
    ['dir & Get-Process node', true, 'cmdlet fora de qualquer powershell explícito → embrulha'],
    ['echo x & powershell -Command "Get-Date" & Get-Process node', true, 'um cmdlet dentro E outro fora → embrulha (o de fora precisa)'],
];
for (const [cmd, esperado, rotulo] of casos) assert(needsPowerShellWrap(cmd) === esperado, rotulo, cmd);

console.log(`\n=== S429: ${passed} passaram, ${failed} falharam ===`);
process.exit(failed > 0 ? 1 : 0);
