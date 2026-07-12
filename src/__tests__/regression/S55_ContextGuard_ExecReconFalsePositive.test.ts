/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S55
 * Investigação de log real (05/07/2026, 20:43, Telegram, mesmo goal "máximo 10 linhas por
 * slide" — já com o fix S54 aplicado e rodando):
 *
 *   Step 1: o modelo chamou exec_command 3x só para localizar o arquivo certo
 *     (`Get-ChildItem -Recurse -Filter "*.md"`, `"*.pptx"`, `"*excel*"` — puro listing,
 *     nenhuma escrita). Step 2: chamou `read` 2x (excel_class.md + um script de uma sessão
 *     anterior). O SAFETY-GUARD de context_growth disparou (ratio=3.37) logo em seguida —
 *     igual ao incidente do S54. Mas desta vez a extensão do S54 NÃO disparou, porque
 *     `writeToolsUsedThisTurn` (cycleHistory.some tool===write||edit||exec_command) contava
 *     os 3 `Get-ChildItem` como "edição já feita", fazendo `needsWriteNow` avaliar false.
 *     Resultado: guard escolheu a mensagem genérica ("responda com o que já tem") em vez de
 *     "OBRIGATÓRIO use exec_command", e a extensão do S54 nunca teve chance de agir —
 *     o turno terminou descrevendo um plano ("Vou ajustar o gerador de slides... Deixa eu
 *     primeiro ver o arquivo completo...") em vez de executar a edição.
 *
 * Causa raiz: exec_command é usado tanto para leitura/reconhecimento (listar arquivos) quanto
 * para edição real (rodar script Python que reescreve o arquivo) — contar QUALQUER chamada
 * como "edição já feita" é impreciso. O DELIVERY-GUARD (mais abaixo no mesmo arquivo) já usa
 * uma definição mais estrita para a mesma pergunta ("um arquivo foi de fato produzido?"):
 * `wroteFile = cycleHistory.some(h => h.tool === 'write' ...)` — só 'write', nem 'edit'.
 *
 * Fix: `writeToolsUsedThisTurn` agora considera só 'write'/'edit' (ferramentas que só podem
 * ser mutação, nunca reconhecimento). 'exec_command' foi removido do critério — o custo de
 * reincidir na mensagem "use exec_command" quando exec_command já tinha feito a edição de
 * verdade (caso raro: write-then-verify-read) é bem mais barato que o custo observado (turno
 * inteiro terminando em plano em vez de execução).
 *
 * Escopo tocado: loop/AgentLoop.ts (mesmo guard de context_growth do S54).
 *
 * Execução: npx ts-node src/__tests__/regression/S55_ContextGuard_ExecReconFalsePositive.test.ts
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

async function main(): Promise<void> {

console.log('\n=== S55-1 — AgentLoop.ts: writeToolsUsedThisTurn não conta mais exec_command ===');
{
    assert(
        /const writeToolsUsedThisTurn = cycleHistory\.some\(h => h\.tool === 'write' \|\| h\.tool === 'edit'\);/.test(agentLoopSource),
        "writeToolsUsedThisTurn considera só 'write'/'edit' — tools que são sempre mutação, nunca reconhecimento",
    );
    assert(
        !/writeToolsUsedThisTurn = cycleHistory\.some\(h => h\.tool === 'write' \|\| h\.tool === 'edit' \|\| h\.tool === 'exec_command'\)/.test(agentLoopSource),
        "exec_command não entra mais nesse critério (removia a distinção entre listing e edição real)",
    );
}

console.log('\n=== S55-2 — reprodução isolada: recon via exec_command (Get-ChildItem) não conta como edição ===');
{
    type Cycle = { tool: string; status: 'success' | 'error' };

    function writeToolsUsedThisTurn(cycleHistory: Cycle[]): boolean {
        return cycleHistory.some(h => h.tool === 'write' || h.tool === 'edit');
    }

    // Reproduz exatamente a sequência do incidente: 3x exec_command (listing), 2x read.
    const cycleHistory: Cycle[] = [
        { tool: 'exec_command', status: 'success' }, // Get-ChildItem *.md
        { tool: 'exec_command', status: 'success' }, // Get-ChildItem *.pptx
        { tool: 'exec_command', status: 'success' }, // Get-ChildItem *excel*
        { tool: 'read', status: 'success' },          // excel_class.md
        { tool: 'read', status: 'success' },          // gen_excel_pptx.py (sessão anterior)
    ];

    assert(
        writeToolsUsedThisTurn(cycleHistory) === false,
        'recon via exec_command (listing) + read não é contado como "edição já feita"',
    );

    const lastToolInCycle = cycleHistory[cycleHistory.length - 1].tool;
    const isAnalysisAbort = false; // pedido de edição, não de análise
    const needsWriteNow = lastToolInCycle === 'read' && !writeToolsUsedThisTurn(cycleHistory) && !isAnalysisAbort;
    assert(needsWriteNow === true, 'needsWriteNow agora avalia true neste cenário — engata a extensão do S54 corretamente');
}

console.log('\n=== S55-3 — exec_command não vira "invisível": edit/write reais continuam contando ===');
{
    type Cycle = { tool: string; status: 'success' | 'error' };
    function writeToolsUsedThisTurn(cycleHistory: Cycle[]): boolean {
        return cycleHistory.some(h => h.tool === 'write' || h.tool === 'edit');
    }

    const cycleHistoryWithRealEdit: Cycle[] = [
        { tool: 'read', status: 'success' },
        { tool: 'edit', status: 'success' },   // edição real no meio do turno
        { tool: 'read', status: 'success' },   // reread pra confirmar
    ];
    assert(
        writeToolsUsedThisTurn(cycleHistoryWithRealEdit) === true,
        'edit real continua sendo reconhecido como "edição já feita" (sem regressão para o caminho normal)',
    );

    const cycleHistoryWithRealWrite: Cycle[] = [
        { tool: 'write', status: 'success' },
        { tool: 'read', status: 'success' },
    ];
    assert(
        writeToolsUsedThisTurn(cycleHistoryWithRealWrite) === true,
        'write real continua sendo reconhecido como "edição já feita" (sem regressão)',
    );
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S55 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;

}

main().catch((err) => {
    console.error('S55 erro inesperado:', err);
    process.exitCode = 1;
});
