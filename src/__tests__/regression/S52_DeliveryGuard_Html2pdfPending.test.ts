/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S52
 * Investigação de log real (05/07/2026, Telegram, goal_1783280104082_rfbgp,
 * arquivo capacidades_newclaw.html) rastreada em 4 microauditorias sucessivas:
 *
 *   1. DELIVERY-GUARD ([AgentLoop.ts]) descobre candidatos só via `cycleHistory` (write
 *      bem-sucedido + extensão em DELIVERABLE_EXTENSIONS) — sem qualquer consulta a skills.
 *   2. `.html` está em DELIVERABLE_EXTENSIONS de propósito (é formato dual: pode ser produto
 *      final OU insumo de conversão) — confirmado por um segundo caso real legítimo
 *      (aula_excel.html, 03/07/2026, entregue como HTML cru sem problema).
 *   3. No incidente, `bash scripts/html2pdf.sh tmp/capacidades_newclaw.html` falhou (WSL
 *      ausente no Windows), SAFETY-GUARD travou novas tentativas de exec_command, e o
 *      DELIVERY-GUARD então instruiu o agente a enviar o `.html` cru diretamente — violando a
 *      Regra nº2 da skill html-pdf-converter ("NUNCA envie .html via send_document").
 *   4. Prova de que o sinal causal já existe em `cycleHistory` sem precisar de metadata nova:
 *      o mesmo array já guarda `tool`, `input` (comando completo) e `status` de cada
 *      exec_command — dado suficiente para provar "write X → html2pdf.sh(X) falhou → sem
 *      sucesso posterior" usando só o que já é coletado (mesmo padrão já usado por
 *      `executedScriptPaths` para distinguir scripts executados de não executados).
 *
 * Correção: `writtenPaths` agora exclui um `.html` cuja última tentativa de exec_command
 * referenciando `html2pdf` + o path exato terminou em erro, sem sucesso posterior para o
 * mesmo path. Escopo estrito: só `html2pdf.sh` (não generaliza para outros conversores), só
 * dispara quando há evidência real de tentativa (não bloqueia HTML sem tentativa alguma).
 *
 * Escopo tocado: loop/AgentLoop.ts (bloco DELIVERY-GUARD, filtro de `writtenPaths`).
 *
 * Execução: npx ts-node src/__tests__/regression/S52_DeliveryGuard_Html2pdfPending.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`); failed++; }
}

const agentLoopPath = path.join(process.cwd(), 'src', 'loop', 'AgentLoop.ts');
const agentLoopSource = fs.readFileSync(agentLoopPath, 'utf-8');
// ARCH-026 (17/07/2026): DELIVERABLE_EXTENSIONS foi movido de AgentLoop.ts para
// planning/inferExpectedExtensions.ts (fonte única, ao lado de SOURCE_SCRIPT_EXTENSIONS) —
// a asserção sobre o array literal agora lê este arquivo, não mais AgentLoop.ts.
const inferExpectedExtensionsPath = path.join(process.cwd(), 'src', 'loop', 'planning', 'inferExpectedExtensions.ts');
const inferExpectedExtensionsSource = fs.readFileSync(inferExpectedExtensionsPath, 'utf-8');

// ── Reprodução standalone do mecanismo real (mesma lógica de AgentLoop.ts) ──
type HistEntry = { step: number; tool: string; input: string; status: string };

function htmlConversionPending(cycleHistory: HistEntry[], htmlPath: string): boolean {
    const isHtml2pdfAttempt = (h: { tool: string; input: string }) =>
        h.tool === 'exec_command' && h.input.includes(htmlPath) && h.input.toLowerCase().includes('html2pdf');
    let lastFailureIdx = -1;
    for (let i = 0; i < cycleHistory.length; i++) {
        if (isHtml2pdfAttempt(cycleHistory[i]) && cycleHistory[i].status === 'error') lastFailureIdx = i;
    }
    if (lastFailureIdx === -1) return false;
    return !cycleHistory.some((h, idx) => idx > lastFailureIdx && isHtml2pdfAttempt(h) && h.status === 'success');
}

function computeWrittenPaths(cycleHistory: HistEntry[], allPaths: string[]): string[] {
    const DELIVERABLE_EXTENSIONS = ['.html', '.pdf', '.md', '.txt', '.js', '.ts', '.csv', '.json', '.docx', '.xlsx'];
    return allPaths
        .filter(p => DELIVERABLE_EXTENSIONS.some(ext => p.toLowerCase().endsWith(ext)))
        .filter(p => !(p.toLowerCase().endsWith('.html') && htmlConversionPending(cycleHistory, p)));
}

async function main(): Promise<void> {

console.log('\n=== S52-1 — mecanismo implementado em AgentLoop.ts (via cycleHistory, sem metadata nova) ===');
{
    assert(
        /htmlConversionPending/.test(agentLoopSource),
        'AgentLoop.ts define o predicado htmlConversionPending',
    );
    assert(
        /h\.tool === 'exec_command' && h\.input\.includes\(htmlPath\) && h\.input\.toLowerCase\(\)\.includes\('html2pdf'\)/.test(agentLoopSource),
        'predicado usa apenas cycleHistory existente (tool/input/status) — sem novo campo',
    );
    assert(
        /\.filter\(p => !\(p\.toLowerCase\(\)\.endsWith\('\.html'\) && htmlConversionPending\(p\)\)\)/.test(agentLoopSource),
        'writtenPaths filtra .html com conversão pendente — DELIVERABLE_EXTENSIONS em si não foi alterado',
    );
    assert(
        !/DELIVERABLE_EXTENSIONS[^=]*= \[.*'\.html'.*\]/.test(inferExpectedExtensionsSource) === false,
        'DELIVERABLE_EXTENSIONS (planning/inferExpectedExtensions.ts) ainda contém .html (não foi removido da allowlist)',
    );
}

console.log('\n=== S52-2 — reprodução do INCIDENTE REAL: capacidades_newclaw.html não é mais promovido ===');
{
    const cycleHistory: HistEntry[] = [
        { step: 1, tool: 'write', input: JSON.stringify({ path: 'tmp/capacidades_newclaw.html' }), status: 'success' },
        { step: 2, tool: 'exec_command', input: JSON.stringify({ command: 'bash scripts/html2pdf.sh tmp/capacidades_newclaw.html' }), status: 'error' },
        { step: 3, tool: 'exec_command', input: JSON.stringify({ command: 'pandoc -o tmp/out.docx' }), status: 'error' },
    ];
    const writtenPaths = computeWrittenPaths(cycleHistory, ['tmp/capacidades_newclaw.html']);
    assert(writtenPaths.length === 0, 'tmp/capacidades_newclaw.html excluído de writtenPaths (conversão falhou, sem sucesso posterior)');
}

console.log('\n=== S52-3 — PRESERVAÇÃO: aula_excel.html (HTML terminal legítimo, sem tentativa) continua elegível ===');
{
    const cycleHistory: HistEntry[] = [
        { step: 1, tool: 'write', input: JSON.stringify({ path: 'tmp/aula_excel.html' }), status: 'success' },
        { step: 2, tool: 'write', input: JSON.stringify({ path: 'tmp/aula_excel.html' }), status: 'success' },
        { step: 3, tool: 'read', input: JSON.stringify({ path: 'tmp/aula_excel.html' }), status: 'success' },
    ];
    const writtenPaths = computeWrittenPaths(cycleHistory, ['tmp/aula_excel.html']);
    assert(writtenPaths.includes('tmp/aula_excel.html'), 'tmp/aula_excel.html continua elegível (nenhuma tentativa html2pdf.sh no histórico)');
}

console.log('\n=== S52-4 — TESTE SINTÉTICO: falha seguida de sucesso posterior NÃO permanece bloqueada ===');
{
    // Sem caso real em produção (nunca houve um "PDF_GERADO:" nos logs) — este é dedução de
    // código (script html2pdf.sh só sai com exit 0 após confirmar o PDF gerado), não evidência
    // observada. Documentado explicitamente para não ser confundido com um caso real.
    const cycleHistory: HistEntry[] = [
        { step: 1, tool: 'write', input: JSON.stringify({ path: 'tmp/retry_demo.html' }), status: 'success' },
        { step: 2, tool: 'exec_command', input: JSON.stringify({ command: 'bash scripts/html2pdf.sh tmp/retry_demo.html' }), status: 'error' },
        { step: 3, tool: 'exec_command', input: JSON.stringify({ command: 'bash scripts/html2pdf.sh tmp/retry_demo.html' }), status: 'success' },
    ];
    const writtenPaths = computeWrittenPaths(cycleHistory, ['tmp/retry_demo.html']);
    assert(writtenPaths.includes('tmp/retry_demo.html'), 'retry com sucesso posterior desbloqueia — não trata como conversão pendente (dedução de código, sem evidência observada em produção)');
}

console.log('\n=== S52-5 — falha, sucesso, NOVA falha: o estado mais recente (falha) prevalece ===');
{
    const cycleHistory: HistEntry[] = [
        { step: 1, tool: 'write', input: JSON.stringify({ path: 'tmp/flaky.html' }), status: 'success' },
        { step: 2, tool: 'exec_command', input: JSON.stringify({ command: 'bash scripts/html2pdf.sh tmp/flaky.html' }), status: 'error' },
        { step: 3, tool: 'exec_command', input: JSON.stringify({ command: 'bash scripts/html2pdf.sh tmp/flaky.html' }), status: 'success' },
        { step: 4, tool: 'exec_command', input: JSON.stringify({ command: 'bash scripts/html2pdf.sh tmp/flaky.html' }), status: 'error' },
    ];
    const writtenPaths = computeWrittenPaths(cycleHistory, ['tmp/flaky.html']);
    assert(!writtenPaths.includes('tmp/flaky.html'), 'última falha (após um sucesso anterior) ainda bloqueia — estado mais recente decide, não "qualquer sucesso já visto"');
}

console.log('\n=== S52-6 — escopo estrito: falha de um comando NÃO relacionado a html2pdf não bloqueia ===');
{
    const cycleHistory: HistEntry[] = [
        { step: 1, tool: 'write', input: JSON.stringify({ path: 'tmp/outro.html' }), status: 'success' },
        { step: 2, tool: 'exec_command', input: JSON.stringify({ command: 'python3 script_nao_relacionado.py tmp/outro.html' }), status: 'error' },
    ];
    const writtenPaths = computeWrittenPaths(cycleHistory, ['tmp/outro.html']);
    assert(writtenPaths.includes('tmp/outro.html'), 'falha de comando que não invoca html2pdf não bloqueia — escopo não generalizado além de html2pdf.sh');
}

console.log('\n=== S52-7 — matching por path completo evita colisão de basename entre arquivos distintos ===');
{
    // Dois .html com mesmo basename em diretórios diferentes no mesmo ciclo — só o que teve
    // tentativa de conversão referenciando SEU path completo deve ser bloqueado.
    const cycleHistory: HistEntry[] = [
        { step: 1, tool: 'write', input: JSON.stringify({ path: 'tmp/a/report.html' }), status: 'success' },
        { step: 2, tool: 'write', input: JSON.stringify({ path: 'tmp/b/report.html' }), status: 'success' },
        { step: 3, tool: 'exec_command', input: JSON.stringify({ command: 'bash scripts/html2pdf.sh tmp/a/report.html' }), status: 'error' },
    ];
    const writtenPaths = computeWrittenPaths(cycleHistory, ['tmp/a/report.html', 'tmp/b/report.html']);
    assert(!writtenPaths.includes('tmp/a/report.html'), 'tmp/a/report.html bloqueado (tentativa referencia seu path completo)');
    assert(writtenPaths.includes('tmp/b/report.html'), 'tmp/b/report.html NÃO bloqueado — matching por path completo, não por basename, evita colisão');
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S52 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;

}

main().catch((err) => {
    console.error('S52 erro inesperado:', err);
    process.exitCode = 1;
});
