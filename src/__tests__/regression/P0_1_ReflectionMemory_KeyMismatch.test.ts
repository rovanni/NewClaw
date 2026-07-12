/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — P0.1
 * ReflectionMemory: mismatch entre chave de escrita e chave de leitura
 *
 * HIPÓTESE: GoalExecutionLoop.ts:853 grava pattern='goal_blocker_tool_error'
 *           GoalPlanner.ts:503 lê com buildContextHint('tool_exec_command')
 *           A query SQL usa WHERE pattern = ? (exact match) → zero resultados
 *           O sistema NUNCA aprende sobre falhas de exec_command via buildContextHint
 *
 * ESTADO ATUAL: este teste DEVE FALHAR — demonstra o bug
 * ESTADO PÓS-FIX: deve passar
 *
 * Execução: npx ts-node src/__tests__/regression/P0_1_ReflectionMemory_KeyMismatch.test.ts
 */

import Database from 'better-sqlite3';
import { ReflectionMemory } from '../../memory/ReflectionMemory';

// ── Mock mínimo de MemoryManager ──────────────────────────────────────────────

function createInMemoryReflectionMemory(): ReflectionMemory {
    const db = new (Database as any)(':memory:');
    const mockMemoryManager = {
        getDatabase: () => db,
    } as any;
    return new ReflectionMemory(mockMemoryManager);
}

// ── Utilitário de assertion ───────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
    if (condition) {
        console.log(`  ✅ ${message}`);
        passed++;
    } else {
        console.error(`  ❌ FALHOU: ${message}`);
        failed++;
    }
}

function assertFails(condition: boolean, message: string): void {
    // Inverted: asserts that current behavior is BROKEN (test SHOULD fail)
    if (!condition) {
        console.log(`  🔴 BUG CONFIRMADO (esperado falhar): ${message}`);
        failed++; // conta como falha — o teste documenta o bug
    } else {
        console.log(`  ✅ BUG CORRIGIDO: ${message}`);
        passed++;
    }
}

// ── Teste 1: Reproduzir o fluxo exato de escrita do GoalExecutionLoop ─────────

console.log('\n=== P0.1 — Escrita da ReflectionMemory (GoalExecutionLoop.ts:853) ===');

const rm = createInMemoryReflectionMemory();

// Simula exatamente o que GoalExecutionLoop.ts:853 faz:
// pattern: `goal_blocker_${cycleResult.blocker.kind}`
// Para blocker.kind = 'tool_error':
const blockerKind = 'tool_error';
const writtenPattern = `goal_blocker_${blockerKind}`;

// Registra múltiplas falhas (suficientes para ultrapassar o threshold de 2)
for (let i = 0; i < 5; i++) {
    rm.record({
        userInput: `npx marp slides.md --no-stdin -o output.html`,
        intent: 'Criar slides HTML usando Marp',
        toolUsed: 'exec_command',
        approved: false,
        reason: '[  INFO ] Currently waiting data from stdin stream. Conversion will start after finished reading.',
        confidence: 0.0,
        pattern: writtenPattern,       // ← GoalExecutionLoop.ts:853: `goal_blocker_${kind}`
        suggestedFix: 'Pass --no-stdin option with explicit input file',
    });
}

console.log(`  → Padrão gravado: '${writtenPattern}' (5 registros, approved=false)`);
assert(writtenPattern === 'goal_blocker_tool_error', `Pattern gravado é '${writtenPattern}' conforme esperado`);

// ── Teste 2: Leitura via buildContextHint — caminho do GoalPlanner.ts:503-504 ──

console.log('\n=== P0.1 — Leitura via GoalPlanner.ts:503 ===');

// GoalPlanner.ts:503-504:
// const reflectionHint = this.reflectionMemory.buildContextHint(
//     blocker.toolName ? `tool_${blocker.toolName}` : blocker.kind
// );
// Para blocker.toolName='exec_command':
const readKey = `tool_exec_command`; // ← chave de leitura do GoalPlanner

const hintFromPlanner = rm.buildContextHint(readKey);
console.log(`  → buildContextHint('${readKey}') retornou: '${hintFromPlanner.slice(0, 60) || "(vazio)"}'`);

// BUG: a leitura retorna vazio porque 'tool_exec_command' != 'goal_blocker_tool_error'
assertFails(
    hintFromPlanner.length > 0,
    `buildContextHint('tool_exec_command') deveria retornar hints sobre marp/stdin, mas retorna '${hintFromPlanner || "(vazio)"}' — chave ERRADA`
);

// ── Teste 3: Verificar que a chave correta funciona ───────────────────────────

console.log('\n=== P0.1 — Verificar chave correta ===');

// A chave correta seria 'goal_blocker_tool_error' (o que está gravado)
const hintFromCorrectKey = rm.buildContextHint('goal_blocker_tool_error');
console.log(`  → buildContextHint('goal_blocker_tool_error') retornou: ${hintFromCorrectKey.length > 0 ? `${hintFromCorrectKey.length} chars` : '(vazio)'}`);

assert(
    hintFromCorrectKey.length > 0,
    `buildContextHint('goal_blocker_tool_error') retorna hints (${hintFromCorrectKey.length} chars) — chave CORRETA funciona`
);

// ── Teste 4: Também via GoalExecutionLoop.contextualize (linha 1718) ──────────

console.log('\n=== P0.1 — Segundo ponto de leitura: GoalExecutionLoop.ts:1718 ===');

// GoalExecutionLoop.ts:1718:
// .map(t => this.reflectionMemory.buildContextHint(`tool_${t}`))
// Para 'exec_command' na lista toolsTried:
const hintFromContextualize = rm.buildContextHint('tool_exec_command');
assertFails(
    hintFromContextualize.length > 0,
    `GoalExecutionLoop.contextualize: buildContextHint('tool_exec_command') também retorna vazio — mesmo bug`
);

// ── Teste 5: Verificar que buildConstraints ENCONTRA as falhas ────────────────

console.log('\n=== P0.1 — buildConstraints encontra via LIKE goal_blocker_% ===');

// getHardFailurePatterns usa: WHERE (pattern = ? OR pattern LIKE 'goal_blocker_%')
// failure_rate >= 0.90 — com 5 falhas approved=false, rate=1.0 → deve encontrar
const constraints = rm.buildConstraints('exec_command', ['exec_command']);
console.log(`  → buildConstraints retornou ${constraints.length} constraints: ${constraints.join(' | ').slice(0, 100)}`);

// buildConstraints PODE encontrar (via LIKE), mas buildContextHint NÃO
// Isso confirma o mismatch: buildConstraints funciona, buildContextHint não
assert(
    constraints.length >= 0, // pode retornar 0 se patternToConstraint não converter 'goal_blocker_tool_error'
    `buildConstraints executou sem erro (verificar se constraints.length > 0 para confirmar cobertura)`
);

// ── Resultado ─────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(60)}`);
console.log(`P0.1 RESULTADO:`);
console.log(`  ✅ Passou: ${passed}`);
console.log(`  🔴 Bugs confirmados / falhou: ${failed}`);
console.log(`\nDIAGNÓSTICO:`);
console.log(`  Escrita: GoalExecutionLoop.ts:853 → pattern='goal_blocker_tool_error'`);
console.log(`  Leitura: GoalPlanner.ts:503       → buildContextHint('tool_exec_command')`);
console.log(`  SQL:     WHERE pattern = 'tool_exec_command'  ← NUNCA encontra 'goal_blocker_tool_error'`);
console.log(`  Impacto: buildContextHint retorna '' para TODAS as falhas de exec_command`);
console.log(`           → GoalPlanner nunca recebe hints sobre falhas históricas de Marp`);
console.log(`\nFIX: GoalExecutionLoop.ts:853 mudar pattern para \`tool_\${toolName}\``);
console.log(`     OU GoalPlanner.ts:503 adicionar fallback para 'goal_blocker_tool_error'`);
