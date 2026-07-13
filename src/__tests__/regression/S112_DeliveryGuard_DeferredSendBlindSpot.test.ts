/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S112 (FIX E de docs/INVESTIGACAO_TOOL_DEDUP_2026-07-13.md)
 *
 * Achado da investigação do loop TOOL-DEDUP (13/07/2026, análise de código + 2 execuções
 * reais): depois de um `write` + `send_document` (diferido para pós-validação) bem-sucedidos
 * dentro de um step `agentloop`, o branch de defer em AgentLoop.ts (~linha 1802-1828) NUNCA
 * escrevia em `cycleHistory` — os 3 únicos call sites de `cycleHistory.push()` no arquivo
 * inteiro ficavam todos no caminho de execução normal de tool, nenhum no de defer.
 *
 * Consequência (achado secundário, verificado por leitura de código — não confirmado ao vivo
 * com certeza nas duas execuções observadas, mas real e independente disso): o DELIVERY-GUARD,
 * que roda uma vez, incondicionalmente, no fim do loop principal, calcula
 * `sentFile = cycleHistory.some(h => tool in [send_document,...] && status==='success')`.
 * Como o defer nunca aparecia em `cycleHistory`, `sentFile` ficava `false` mesmo após um defer
 * corretamente registrado — se o guard chegasse a rodar depois de um abort de dedup causado
 * por `send_document`, ele recalcularia `wroteFile && !sentFile` como verdadeiro e reinjetaria
 * "[ENTREGA PENDENTE] ... USE send_document para entregar AGORA" por cima de um arquivo que já
 * ia ser entregue — reabrindo o mesmo padrão de loop por um caminho diferente.
 *
 * FIX: o branch de defer agora empurra uma entrada em `cycleHistory` com
 * `status: 'deferred'` (não 'success', para não se passar por um envio confirmado de
 * verdade), e o `sentFile` do DELIVERY-GUARD passa a tratar `status==='deferred'` como já
 * tratado — alinhando `cycleHistory` com o que `channelContext.isDeferredArtifact` já sabia,
 * sem introduzir uma terceira fonte de verdade (channelContext e cycleHistory concordam agora).
 *
 * Escopo tocado: apenas o branch de defer de `send_document` e o cálculo de `sentFile` do
 * DELIVERY-GUARD em AgentLoop.ts. FIX C (transição semântica de FSM) foi deliberadamente NÃO
 * implementado nesta mudança — a própria investigação concluiu que precisa de um ciclo de
 * análise próprio (distinguir turno-com-mais-trabalho-pendente de turno-satisfeito).
 *
 * Execução: npx ts-node src/__tests__/regression/S112_DeliveryGuard_DeferredSendBlindSpot.test.ts
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

// ── Reprodução standalone do cálculo real de sentFile/wroteFile (mesma lógica de AgentLoop.ts) ──
type HistEntry = { step: number; tool: string; input: string; status: string };

function computeGuardSignals(cycleHistory: HistEntry[]) {
    const wroteFile = cycleHistory.some(h => h.tool === 'write' && h.status === 'success');
    const sentFile = cycleHistory.some(h => (h.tool === 'send_document' || h.tool === 'send_audio' || h.tool === 'send_image') && (h.status === 'success' || h.status === 'deferred'));
    return { wroteFile, sentFile, wouldFireGuard: wroteFile && !sentFile };
}

// Comportamento PRÉ-fix, preservado aqui só para provar a regressão por contraste — nunca usado
// em produção. Ilustra exatamente o bug: sentFile não reconhece 'deferred'.
function computeGuardSignalsPreFix(cycleHistory: HistEntry[]) {
    const wroteFile = cycleHistory.some(h => h.tool === 'write' && h.status === 'success');
    const sentFile = cycleHistory.some(h => (h.tool === 'send_document' || h.tool === 'send_audio' || h.tool === 'send_image') && h.status === 'success');
    return { wroteFile, sentFile, wouldFireGuard: wroteFile && !sentFile };
}

async function main(): Promise<void> {

console.log('\n=== S112-1 — AgentLoop.ts: branch de defer registra cycleHistory com status "deferred" ===');
{
    assert(
        /cycleHistory\.push\(\{ step: stepCount, tool: 'send_document', input: JSON\.stringify\(toolCall\.arguments \?\? \{\}\), status: 'deferred' \}\);/.test(agentLoopSource),
        'branch de defer (send_document) empurra entrada em cycleHistory com status "deferred"',
    );
}

console.log('\n=== S112-2 — AgentLoop.ts: sentFile do DELIVERY-GUARD reconhece "deferred" como já tratado ===');
{
    assert(
        /h\.status === 'success' \|\| h\.status === 'deferred'/.test(agentLoopSource),
        'sentFile aceita status "deferred" além de "success"',
    );
}

console.log('\n=== S112-3 — REPRODUÇÃO DO BUG (comportamento pré-fix): defer não registrado → guard dispararia indevidamente ===');
{
    // Estado real observado nas duas execuções: write bem-sucedido, send_document nunca chega
    // a aparecer em cycleHistory porque o branch de defer não escrevia nada (bug).
    const cycleHistoryPreFix: HistEntry[] = [
        { step: 1, tool: 'write', input: JSON.stringify({ path: 'tmp/relatorio.pdf' }), status: 'success' },
    ];
    const { wouldFireGuard } = computeGuardSignalsPreFix(cycleHistoryPreFix);
    assert(wouldFireGuard === true, 'sem registro do defer, DELIVERY-GUARD reinjetaria "[ENTREGA PENDENTE]" mesmo já tendo sido diferido (bug reproduzido)');
}

console.log('\n=== S112-4 — FIX: com o defer registrado (status "deferred"), o guard NÃO dispara mais ===');
{
    const cycleHistoryFixed: HistEntry[] = [
        { step: 1, tool: 'write', input: JSON.stringify({ path: 'tmp/relatorio.pdf' }), status: 'success' },
        { step: 2, tool: 'send_document', input: JSON.stringify({ file_path: 'tmp/relatorio.pdf' }), status: 'deferred' },
    ];
    const { wroteFile, sentFile, wouldFireGuard } = computeGuardSignals(cycleHistoryFixed);
    assert(wroteFile === true, 'wroteFile continua true (write real aconteceu)');
    assert(sentFile === true, 'sentFile agora true — defer conta como já tratado');
    assert(wouldFireGuard === false, 'DELIVERY-GUARD não reinjeta "[ENTREGA PENDENTE]" para um arquivo já diferido');
}

console.log('\n=== S112-5 — PRESERVAÇÃO: write sem NENHUM send_document (nem success, nem deferred) ainda dispara o guard ===');
{
    // Caso legítimo que o guard existe para resolver — não pode virar falso-negativo.
    const cycleHistory: HistEntry[] = [
        { step: 1, tool: 'write', input: JSON.stringify({ path: 'tmp/esquecido.pdf' }), status: 'success' },
    ];
    const { wouldFireGuard } = computeGuardSignals(cycleHistory);
    assert(wouldFireGuard === true, 'arquivo escrito e nunca enviado (nem diferido) continua disparando o guard normalmente');
}

console.log('\n=== S112-6 — PRESERVAÇÃO: envio confirmado (status "success") continua reconhecido normalmente ===');
{
    const cycleHistory: HistEntry[] = [
        { step: 1, tool: 'write', input: JSON.stringify({ path: 'tmp/relatorio.pdf' }), status: 'success' },
        { step: 2, tool: 'send_document', input: JSON.stringify({ file_path: 'tmp/relatorio.pdf' }), status: 'success' },
    ];
    const { wouldFireGuard } = computeGuardSignals(cycleHistory);
    assert(wouldFireGuard === false, 'envio confirmado (status success, não deferred) continua não disparando o guard — comportamento pré-existente preservado');
}

console.log('\n=== S112-7 — PRESERVAÇÃO: send_document com falha (status "error") NÃO conta como tratado ===');
{
    const cycleHistory: HistEntry[] = [
        { step: 1, tool: 'write', input: JSON.stringify({ path: 'tmp/relatorio.pdf' }), status: 'success' },
        { step: 2, tool: 'send_document', input: JSON.stringify({ file_path: 'tmp/relatorio.pdf' }), status: 'error' },
    ];
    const { wouldFireGuard } = computeGuardSignals(cycleHistory);
    assert(wouldFireGuard === true, 'send_document que falhou de verdade (status error) ainda dispara o guard — só "deferred" e "success" contam como tratado');
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S112 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;

}

main().catch((err) => {
    console.error('S112 erro inesperado:', err);
    process.exitCode = 1;
});
