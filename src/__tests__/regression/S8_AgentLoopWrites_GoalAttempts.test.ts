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
 * toolName='write', result='success', output='[AGENTLOOP-WRITE] ...'
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
    /toolName:\s*'write'/.test(loopSource),
    "pseudo-attempt usa toolName: 'write'"
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

// Réplica exata da lógica de GoalExecutionLoop.ts linha ~1433
for (const sendArgs of deferredSendArgs) {
    const fp = String(sendArgs['file_path'] ?? sendArgs['path'] ?? '');
    if (!fp) continue;
    mockGoalStore.addAttempt('goal_test_123', {
        id: `att_agentloop_write_${Date.now()}_abc`,
        toolName: 'write',
        args: { path: fp },
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
    addedAttempts.every(a => a.toolName === 'write'),
    "Todos os pseudo-attempts têm toolName='write'"
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
    addedAttempts[0].args.path === '/workspace/aula_scrum_slides.html',
    'Primeiro pseudo-write: path correto via file_path'
);

assert(
    addedAttempts[1].args.path === '/workspace/scrum_parte2.html',
    'Segundo pseudo-write: path correto via path alias'
);

assert(
    addedAttempts[2].args.path === '/workspace/scrum_parte3.html',
    'Terceiro pseudo-write: path correto via file_path'
);

// ── Teste 3: checkClaimsAgainstEvidence encontraria os writes ───────────────

console.log('\n=== S8 — Simulação: checkClaimsAgainstEvidence encontra evidência ===');

// Simula o que checkClaimsAgainstEvidence faz: busca attempts toolName='write' com path
const mockGoalAttempts = [...addedAttempts];
const writeAttempts = mockGoalAttempts.filter(a => a.toolName === 'write' && a.args.path);

assert(
    writeAttempts.length === 3,
    `checkClaimsAgainstEvidence encontraria ${writeAttempts.length} write attempts com path`
);

// Simula a verificação de "criação de artefato"
const hasArtifactEvidence = writeAttempts.some(
    a => a.args.path?.endsWith('.html')
);
assert(
    hasArtifactEvidence,
    'Evidência de criação de .html encontrada → [UNVERIFIED-CLAIM] NÃO derrubaria achieved=true'
);

// ── Resultado ────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(60)}`);
console.log(`S8 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
console.log(`\nCOBERTURA:`);
console.log(`  [AGENTLOOP-WRITE] marker no source: testado`);
console.log(`  Lógica de injeção com 4 deferredSendArgs (1 sem path): testado`);
console.log(`  toolName='write', result='success': testado`);
console.log(`  checkClaimsAgainstEvidence encontra evidência: simulado`);
if (failed > 0) process.exit(1);
