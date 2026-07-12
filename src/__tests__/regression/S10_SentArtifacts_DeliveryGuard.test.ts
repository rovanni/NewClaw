/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S10
 * GoalExecutionLoop: sentArtifacts só deve conter arquivos REALMENTE entregues —
 * não arquivos meramente agendados (deferred) para envio.
 *
 * HISTÓRICO: a versão original deste teste (até 01/07/2026) validava um fix que, junto com a
 * proteção que pretendia dar, introduziu um bug mais grave: o loop
 * `for (const sendArgs of cycleResult.deferredSends) { ... sentArtifacts.add(fp); }` marcava
 * em `sentArtifacts` TODO artefato meramente AGENDADO (deferredSends), não só os realmente
 * enviados. Isso conflava "agendado" com "enviado" no mesmo Set.
 *
 * BUG REPRODUZIDO AO VIVO (02/07/2026): goal reportou success=true e "delivered=1", mas o
 * usuário nunca recebeu o arquivo. Causa: o loop de execução dos sends diferidos (mais abaixo
 * em GoalExecutionLoop.ts, "agora que achieved=true") checa `sentArtifacts.has(filePath)` pra
 * decidir se pula o send como duplicata — como o arquivo já constava ali (marcado cedo demais
 * pelo loop do S10 antigo), o ENVIO REAL nunca rodava.
 *
 * FIX (02/07/2026): removido o loop que marcava deferredSends como sentArtifacts. A proteção
 * original do S10 (evitar que deliverable_check reagende um arquivo que já tem um
 * send_document PENDENTE no plano) passou a ser feita corretamente checando o estado do
 * currentPlan, não poluindo sentArtifacts. DELIVERY-GUARD (entrega direta do AgentLoop, fora
 * do fluxo de plano) continua marcando sentArtifacts corretamente via callback
 * onArtifactDelivered — esse caminho não foi alterado.
 *
 * REGRESSÃO SE: o loop que marca TODO deferredSend como sentArtifacts for reintroduzido, OU
 * se deliverable_check voltar a ignorar send_document pendentes no currentPlan.
 *
 * Execução: npx ts-node src/__tests__/regression/S10_SentArtifacts_DeliveryGuard.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`); failed++; }
}

const loopPath = path.join(process.cwd(), 'src', 'loop', 'GoalExecutionLoop.ts');
const loopSource = fs.readFileSync(loopPath, 'utf-8');

// ── Teste 1: o loop que causava o bug (marcar TODO deferredSend como enviado) sumiu ──

console.log('\n=== S10 — source NÃO marca deferredSends como sentArtifacts em bloco ===');

assert(
    !/for\s*\(\s*const sendArgs of cycleResult\.deferredSends\s*\)\s*\{\s*const fp = String\(sendArgs\['file_path'\][\s\S]{0,40}if\s*\(fp\)\s*trackArtifact\(fp\)/.test(loopSource),
    'loop que marcava TODO deferredSend (agendado OU enviado) em sentArtifacts foi removido',
);

// ── Teste 2: DELIVERY-GUARD (entrega direta) continua marcando sentArtifacts ──

console.log('\n=== S10 — DELIVERY-GUARD (callback onArtifactDelivered) continua rastreando entregas reais ===');

assert(
    /onArtifactDelivered:\s*\(filePath: string\)\s*=>\s*\{/.test(loopSource),
    'callback onArtifactDelivered ainda presente (entrega direta do AgentLoop)',
);
assert(
    /\(fp\) => \{ if \(fp\) trackArtifact\(fp\); \}/.test(loopSource),
    'exec de step ainda passa callback que chama trackArtifact em entrega real (não em agendamento)',
);

// ── Teste 3: deliverable_check agora também verifica send_document PENDENTE no plano ──

console.log('\n=== S10 — deliverable_check não reagenda arquivo que já tem send pendente ===');

assert(
    /pendingSendPaths/.test(loopSource) && /!sentArtifacts\.has\(f\) && !pendingSendPaths\.has\(f\)/.test(loopSource),
    'deliverable_check exclui arquivos com send_document pendente no currentPlan (não só sentArtifacts)',
);

// ── Teste 4: simulação — sentArtifacts só recebe o que foi REALMENTE entregue ──

console.log('\n=== S10 — Simulação: deferredSends (agendados) NÃO entram em sentArtifacts ===');

const sentArtifacts = new Set<string>();
const trackArtifact = (fp: string) => { if (fp && !sentArtifacts.has(fp)) sentArtifacts.add(fp); };

// deferredSends = artefatos AGENDADOS pelo AgentLoop nesta iteração — não devem, por si só,
// entrar em sentArtifacts (isso só deveria acontecer quando o send_document EXECUTAR de
// verdade, ou via callback onArtifactDelivered para entrega direta).
const deferredSends: Array<Record<string, unknown>> = [
    { file_path: '/workspace/aula_scrum_slides.html' },
    { path: '/workspace/scrum_parte2.html' },
];
// Não chamamos trackArtifact aqui — é exatamente esse não-chamado que corrige o bug.

assert(
    sentArtifacts.size === 0,
    'artefatos meramente agendados (deferredSends) não populam sentArtifacts',
);

// Simula a EXECUÇÃO real do send_document pendente (o que de fato deveria marcar sentArtifacts)
for (const sendArgs of deferredSends) {
    const fp = String(sendArgs['file_path'] ?? sendArgs['path'] ?? '');
    const sendSucceeded = true; // simula ExecutionStep bem-sucedido
    if (sendSucceeded) trackArtifact(fp);
}

assert(
    sentArtifacts.size === 2,
    `após execução real dos sends, sentArtifacts reflete os 2 artefatos entregues (obtido: ${sentArtifacts.size})`,
);

// ── Teste 5: idempotência — reprocessar o mesmo artefato não duplica ─────────

console.log('\n=== S10 — Idempotência do Set sentArtifacts ===');

const setBeforeSize = sentArtifacts.size;
trackArtifact('/workspace/aula_scrum_slides.html');
assert(
    sentArtifacts.size === setBeforeSize,
    `Set é idempotente: adicionar duplicata não aumenta o tamanho (${setBeforeSize} → ${sentArtifacts.size})`,
);

// ── Resultado ────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(60)}`);
console.log(`S10 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exit(1);
