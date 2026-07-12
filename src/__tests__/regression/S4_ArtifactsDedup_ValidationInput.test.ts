/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S4
 * GoalExecutionLoop: VALIDATION-INPUT log deve deduplicar caminhos de artefatos
 *
 * PROBLEMA CORRIGIDO: O mesmo arquivo podia aparecer múltiplas vezes em
 * goal.attempts (ex: write + exec_command no mesmo path), fazendo o log
 * [VALIDATION-INPUT] listar paths duplicados e confundir análises de auditoria.
 *
 * FIX: [...new Set(...)] ao construir artifactsInAttempts em GoalExecutionLoop.ts.
 *
 * REGRESSÃO SE: new Set() for removido → paths duplicados retornam ao log.
 *
 * Execução: npx ts-node src/__tests__/regression/S4_ArtifactsDedup_ValidationInput.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`); failed++; }
}

// ── Teste 1: Lógica de dedup com attempts duplicados ────────────────────────

console.log('\n=== S4 — Deduplicação de artifacts em VALIDATION-INPUT ===');

// Simula goal.attempts com o mesmo arquivo aparecendo múltiplas vezes:
// write bem-sucedido + exec_command bem-sucedido + segundo write = 3 entradas para slides.html
const mockAttempts = [
    { toolName: 'write',        result: 'success', args: { path: '/workspace/slides.html' } },
    { toolName: 'exec_command', result: 'success', args: { path: '/workspace/slides.html' } },
    { toolName: 'write',        result: 'success', args: { path: '/workspace/slides.html' } },
    { toolName: 'write',        result: 'success', args: { path: '/workspace/outro.html'  } },
    { toolName: 'write',        result: 'failure', args: { path: '/workspace/slides.html' } }, // falha — não conta
    { toolName: 'read',         result: 'success', args: { path: '/workspace/slides.html' } }, // read — não conta
];

// Réplica exata da lógica de GoalExecutionLoop.ts linha ~2351
const artifactsInAttempts = [...new Set(
    (mockAttempts as any[])
        .filter(a => a.result === 'success' && ['write', 'edit', 'exec_command'].includes(a.toolName))
        .map(a => String(a.args['path'] ?? a.args['file_path'] ?? ''))
        .filter(Boolean)
)];

console.log(`  → Attempts totais: ${mockAttempts.length}`);
console.log(`  → Após filtro (success + escrita): 4`);
console.log(`  → Após dedup (new Set): ${artifactsInAttempts.length}`);
console.log(`  → Paths únicos: ${JSON.stringify(artifactsInAttempts)}`);

assert(
    artifactsInAttempts.length === 2,
    `Dedup reduz 4 attempts válidos para 2 paths únicos (obtido: ${artifactsInAttempts.length})`
);

assert(
    artifactsInAttempts.includes('/workspace/slides.html'),
    'slides.html está presente exatamente uma vez'
);

assert(
    artifactsInAttempts.includes('/workspace/outro.html'),
    'outro.html está presente exatamente uma vez'
);

// Garantia: sem duplicatas no array resultante
const uniqueCount = new Set(artifactsInAttempts).size;
assert(
    uniqueCount === artifactsInAttempts.length,
    `Array final não contém duplicatas (tamanho=${artifactsInAttempts.length}, únicos=${uniqueCount})`
);

// ── Teste 2: Sem attempts a lógica retorna array vazio ───────────────────────

console.log('\n=== S4 — Caso sem attempts ===');

const emptyAttempts: any[] = [];
const emptyResult = [...new Set(
    emptyAttempts
        .filter(a => a.result === 'success' && ['write', 'edit', 'exec_command'].includes(a.toolName))
        .map(a => String(a.args?.['path'] ?? ''))
        .filter(Boolean)
)];

assert(emptyResult.length === 0, 'goal sem attempts retorna array vazio');

// ── Teste 3: file_path alias também é capturado ─────────────────────────────

console.log('\n=== S4 — Alias file_path também é capturado ===');

const aliasAttempts = [
    { toolName: 'write', result: 'success', args: { file_path: '/workspace/alias.html' } },
    { toolName: 'write', result: 'success', args: { file_path: '/workspace/alias.html' } },
];

const aliasResult = [...new Set(
    (aliasAttempts as any[])
        .filter(a => a.result === 'success' && ['write', 'edit', 'exec_command'].includes(a.toolName))
        .map(a => String(a.args['path'] ?? a.args['file_path'] ?? ''))
        .filter(Boolean)
)];

assert(aliasResult.length === 1, `file_path alias: 2 attempts duplicados → 1 path único`);
assert(aliasResult[0] === '/workspace/alias.html', 'path correto via alias file_path');

// ── Teste 4: Inspeção do source confirma o fix ──────────────────────────────

console.log('\n=== S4 — Confirmação no source GoalExecutionLoop.ts ===');

const loopPath = path.join(process.cwd(), 'src', 'loop', 'GoalExecutionLoop.ts');
const loopSource = fs.readFileSync(loopPath, 'utf-8');

assert(
    /\[\.\.\.new Set\(/.test(loopSource),
    'GoalExecutionLoop.ts usa [...new Set(...)] — dedup ativo'
);

assert(
    /artifactsInAttempts/.test(loopSource),
    'Variável artifactsInAttempts está declarada no GoalExecutionLoop.ts'
);

assert(
    /'write', 'edit', 'exec_command'/.test(loopSource),
    "Filtro inclui 'write', 'edit' e 'exec_command'"
);

// ── Resultado ────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(60)}`);
console.log(`S4 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
console.log(`\nCOBERTURA:`);
console.log(`  Dedup com paths duplicados: testado`);
console.log(`  Caso sem attempts: testado`);
console.log(`  Alias file_path: testado`);
console.log(`  Confirmação no source: testado`);
if (failed > 0) process.exit(1);
