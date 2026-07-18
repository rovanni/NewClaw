/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S8
 * GoalExecutionLoop: writes do AgentLoop devem ser visíveis em goal.attempts
 *
 * PROBLEMA CORRIGIDO: Quando o AgentLoop executava um step, os writes internos
 * (feitos dentro do AgentLoop) eram invisíveis para goal.attempts. Apenas o
 * step "agentloop" aparecia como attempt, sem as writes individuais.
 * Resultado: checkClaimsAgainstEvidence derrubava achieved=true com [UNVERIFIED-CLAIM]
 * mesmo quando o arquivo foi criado (8355 chars) e o DELIVERY-GUARD já tinha enviado.
 *
 * FIX: Após executar um step AgentLoop com deferredSends, injeta pseudo-write attempts
 * em goal.attempts para cada file_path nos deferredSendArgs.
 * toolName='send_document', result='success', output='[AGENTLOOP-WRITE] ...'
 *
 * ATUALIZADO 16/07/2026 (validação da invariante de captura única): o pseudo-attempt
 * gravava toolName='write', mas deferredSendArgs só é populado por deferSendDocument()
 * (interceptação de send_document dentro do AgentLoop) — nunca representa uma escrita.
 * Isso mascarava a entrega de um consumidor que filtre goal.attempts por
 * toolName==='send_document' (ex.: a regra de claim "foi enviado/entregue" em
 * checkClaimsAgainstEvidence, que exige exatamente esse toolName). A claim de "criação"
 * (toolName IN ['write','exec_command']) não perde cobertura com a correção: ela já tem
 * um fallback independente via goal.sentArtifacts (hasRegisteredDelivery), populado
 * quando o send diferido é de fato despachado — não depende do toolName deste pseudo-attempt.
 *
 * REGRESSÃO SE: Loop de injeção de pseudo-writes for removido de executeStep().
 *
 * Execução: npx ts-node src/__tests__/regression/S8_AgentLoopWrites_GoalAttempts.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`); failed++; }
}

// ── Teste 1: Inspeção do source confirma o fix ──────────────────────────────

console.log('\n=== S8 — Inspeção do source GoalExecutionLoop.ts ===');

const loopPath = path.join(process.cwd(), 'src', 'loop', 'GoalExecutionLoop.ts');
const loopSource = fs.readFileSync(loopPath, 'utf-8');

assert(
    /\[AGENTLOOP-WRITE\]/.test(loopSource),
    '[AGENTLOOP-WRITE] marker presente no GoalExecutionLoop.ts'
);

assert(
    /toolName:\s*'send_document'/.test(loopSource),
    "pseudo-attempt usa toolName: 'send_document' (não 'write' — deferredSendArgs vem de deferSendDocument, nunca de uma escrita)"
);

assert(
    /result:\s*'success'/.test(loopSource),
    "pseudo-attempt usa result: 'success'"
);

// O loop itera sobre deferredSendArgs
assert(
    /for\s*\(\s*const sendArgs of deferredSendArgs\)/.test(loopSource),
    'Loop for...of deferredSendArgs presente (injeta um attempt por artefato)'
);

// Extrai file_path do sendArgs
assert(
    /sendArgs\['file_path'\]\s*\?\?\s*sendArgs\['path'\]/.test(loopSource),
    "Extração de path: sendArgs['file_path'] ?? sendArgs['path']"
);

// goalStore.addAttempt é chamado dentro do loop S8
assert(
    /goalStore\.addAttempt\(goal\.id/.test(loopSource),
    'goalStore.addAttempt(goal.id, ...) chamado para registrar pseudo-write'
);

// ── Teste 2: Simulação inline da lógica de injeção ──────────────────────────

console.log('\n=== S8 — Simulação: injeção de pseudo-writes em goal.attempts ===');

interface MockAttempt {
    id: string;
    toolName: string;
    args: Record<string, string>;
    result: string;
    output: string;
    durationMs: number;
}

const addedAttempts: MockAttempt[] = [];
const mockGoalStore = {
    addAttempt: (_goalId: string, attempt: MockAttempt) => addedAttempts.push(attempt),
};

// Simula deferredSendArgs retornados pelo AgentLoop
const deferredSendArgs: Array<Record<string, unknown>> = [
    { file_path: '/workspace/aula_scrum_slides.html' },
    { path:      '/workspace/scrum_parte2.html'      },
    {                                                 }, // sem path — deve ser ignorado
    { file_path: '/workspace/scrum_parte3.html'      },
];

// Réplica exata da lógica de GoalExecutionLoop.ts (bloco de injeção de pseudo-attempts
// dentro de executeStep(), logo após this.evaluator.evaluate())
for (const sendArgs of deferredSendArgs) {
    const fp = String(sendArgs['file_path'] ?? sendArgs['path'] ?? '');
    if (!fp) continue;
    mockGoalStore.addAttempt('goal_test_123', {
        id: `att_agentloop_write_${Date.now()}_abc`,
        toolName: 'send_document',
        args: { file_path: fp },
        result: 'success',
        output: '[AGENTLOOP-WRITE] Arquivo gravado e entregue pelo AgentLoop',
        durationMs: 0,
    });
}

console.log(`  → deferredSendArgs: ${deferredSendArgs.length} (inclui 1 sem path)`);
console.log(`  → Pseudo-writes injetados: ${addedAttempts.length}`);

assert(
    addedAttempts.length === 3,
    `3 pseudo-writes injetados (o deferredSend sem path é ignorado) — obtido: ${addedAttempts.length}`
);

assert(
    addedAttempts.every(a => a.toolName === 'send_document'),
    "Todos os pseudo-attempts têm toolName='send_document' (não 'write')"
);

assert(
    addedAttempts.every(a => a.result === 'success'),
    "Todos os pseudo-attempts têm result='success'"
);

assert(
    addedAttempts.every(a => a.output.includes('[AGENTLOOP-WRITE]')),
    "Todos os pseudo-attempts têm output com '[AGENTLOOP-WRITE]'"
);

assert(
    addedAttempts[0].args.file_path === '/workspace/aula_scrum_slides.html',
    'Primeiro pseudo-attempt: file_path correto via file_path'
);

assert(
    addedAttempts[1].args.file_path === '/workspace/scrum_parte2.html',
    'Segundo pseudo-attempt: file_path correto via path alias'
);

assert(
    addedAttempts[2].args.file_path === '/workspace/scrum_parte3.html',
    'Terceiro pseudo-attempt: file_path correto via file_path'
);

// ── Teste 3: checkClaimsAgainstEvidence encontraria a evidência de envio ────

console.log('\n=== S8 — Simulação: checkClaimsAgainstEvidence encontra evidência ===');

// Simula a regra de claim "foi enviado/entregue" (requiredTools: ['send_document','send_audio']),
// que é a que este pseudo-attempt corretamente satisfaz agora — a regra de "criação"
// (requiredTools: ['write','exec_command']) não depende deste pseudo-attempt: tem seu
// próprio fallback via goal.sentArtifacts (hasRegisteredDelivery), populado quando o
// send diferido é de fato despachado.
const mockGoalAttempts = [...addedAttempts];
const sendAttempts = mockGoalAttempts.filter(a => a.toolName === 'send_document' && a.args.file_path);

assert(
    sendAttempts.length === 3,
    `checkClaimsAgainstEvidence encontraria ${sendAttempts.length} send_document attempts com file_path`
);

// Simula a verificação de "envio de artefato"
const hasArtifactEvidence = sendAttempts.some(
    a => a.args.file_path?.endsWith('.html')
);
assert(
    hasArtifactEvidence,
    'Evidência de envio de .html encontrada → [UNVERIFIED-CLAIM] NÃO derrubaria achieved=true'
);

// ── Resultado ────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(60)}`);
console.log(`S8 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
console.log(`\nCOBERTURA:`);
console.log(`  [AGENTLOOP-WRITE] marker no source: testado`);
console.log(`  Lógica de injeção com 4 deferredSendArgs (1 sem path): testado`);
console.log(`  toolName='send_document', result='success': testado`);
console.log(`  checkClaimsAgainstEvidence encontra evidência: simulado`);
if (failed > 0) process.exit(1);
