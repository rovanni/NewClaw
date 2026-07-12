/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S7 (atualizado 10/07 — ver Bug "replan timeout" em memória)
 * GoalPlanner: os timeouts de LLM (plan/replan/planRoadmap) devem escalar com o tamanho
 * do prompt, não usar um número fixo curto.
 *
 * HISTÓRICO: originalmente este teste só garantia que plan() usava 90_000ms fixo (em vez
 * dos 45_000ms que abortavam planos iniciais complexos — ver comentário S7 no código).
 * Mas o MESMO bug reapareceu em replan(): um contexto de ~73KB abortou aos exatos 45021ms
 * ("replan empty after parse"), porque 45_000 fixo nunca escala com o tamanho real do
 * prompt — só empurrar o número fixo pra cima (como fez o fix original) resolve até o
 * próximo goal com contexto ainda maior.
 *
 * FIX: plan(), replan() e planRoadmap() agora usam computeDynamicTimeout(messages)
 * (src/shared/dynamicTimeout.ts) — a mesma fórmula já validada em produção pelo
 * AgentLoop.callLLMWithFallback (extraída de lá, fonte única).
 *
 * REGRESSÃO SE: qualquer um dos três voltar a usar um timeout fixo hardcoded em vez de
 * computeDynamicTimeout, OU se a fórmula deixar de dar tempo suficiente pra prompts grandes.
 *
 * Execução: npx ts-node src/__tests__/regression/S7_PlannerTimeout_90s.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { computeDynamicTimeout } from '../../shared/dynamicTimeout';
import { LLMMessage } from '../../core/ProviderFactory';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`); failed++; }
}

function messagesOfSize(chars: number): LLMMessage[] {
    return [{ role: 'user', content: 'x'.repeat(chars) }];
}

// ── Teste 1: comportamento real da fórmula (não inspeção de texto) ─────────────

console.log('\n=== S7 — computeDynamicTimeout: prompt pequeno tem pelo menos o que o plano inicial tinha antes (90s) ===');

const smallPrompt = computeDynamicTimeout(messagesOfSize(2000)); // ~500 tokens, abaixo do TOKEN_THRESHOLD
assert(
    smallPrompt.timeoutMs >= 90_000,
    `Prompt pequeno: timeoutMs=${smallPrompt.timeoutMs}ms >= 90_000ms (garantia original do plano inicial)`
);

console.log('\n=== S7 — computeDynamicTimeout: prompt grande (reprodução do bug real de 10/07, ~73KB) não trava em 45s ===');

const largePrompt = computeDynamicTimeout(messagesOfSize(73_000)); // caso real que abortou em produção
assert(
    largePrompt.timeoutMs > 45_000,
    `Prompt de 73KB (caso real reproduzido): timeoutMs=${largePrompt.timeoutMs}ms > 45_000ms — antes travava exatamente aqui`
);
assert(
    largePrompt.timeoutMs <= 420_000,
    `Prompt de 73KB: timeoutMs=${largePrompt.timeoutMs}ms respeita o teto de 420_000ms (mesmo clamp do AgentLoop)`
);

// ── Teste 2: os 3 call sites de contexto grande usam a função compartilhada ─────

console.log('\n=== S7 — GoalPlanner.ts: plan()/replan()/planRoadmap() usam computeDynamicTimeout ===');

const plannerPath = path.join(process.cwd(), 'src', 'loop', 'GoalPlanner.ts');
const plannerSource = fs.readFileSync(plannerPath, 'utf-8');

assert(
    /import\s*\{\s*computeDynamicTimeout\s*\}\s*from\s*['"]\.\.\/shared\/dynamicTimeout['"]/.test(plannerSource),
    'GoalPlanner.ts importa computeDynamicTimeout de shared/dynamicTimeout'
);

const dynamicCalls = [...plannerSource.matchAll(/const\s*\{\s*timeoutMs\s*\}\s*=\s*computeDynamicTimeout\(messages\);\s*\n\s*const result = await this\.callPlannerLLM\(messages, timeoutMs\)/g)];
assert(
    dynamicCalls.length === 3,
    `3 call sites usando computeDynamicTimeout(messages) → callPlannerLLM(messages, timeoutMs) — encontrado: ${dynamicCalls.length}`
);

// Nenhum dos 3 call sites de contexto grande deve ter voltado a usar timeout fixo curto.
const hardcodedShortTimeouts = [...plannerSource.matchAll(/callPlannerLLM\(messages,\s*(45|90)_000\)/g)];
assert(
    hardcodedShortTimeouts.length === 0,
    `Nenhum callPlannerLLM(messages, 45_000|90_000) hardcoded restante (encontrado: ${hardcodedShortTimeouts.length}) — plan/replan/planRoadmap devem ser dinâmicos`
);

// retryWithMinimalPrompt() continua com timeout fixo curto — comportamento ESPERADO (prompt
// deliberadamente minimalista, não o caso que este teste protege).
assert(
    /callPlannerLLM\(messages,\s*30_000\)/.test(plannerSource),
    'retryWithMinimalPrompt() mantém 30_000ms fixo (prompt minimalista, não afetado por este fix)'
);

// ── Teste 3: shared/dynamicTimeout.ts existe e é a mesma fórmula usada pelo AgentLoop ──

console.log('\n=== S7 — AgentLoop.ts usa a mesma fonte única (sem duplicar a fórmula) ===');

const agentLoopPath = path.join(process.cwd(), 'src', 'loop', 'AgentLoop.ts');
const agentLoopSource = fs.readFileSync(agentLoopPath, 'utf-8');

assert(
    /import\s*\{\s*computeDynamicTimeout\s*\}\s*from\s*['"]\.\.\/shared\/dynamicTimeout['"]/.test(agentLoopSource),
    'AgentLoop.ts importa computeDynamicTimeout de shared/dynamicTimeout (não duplica a fórmula)'
);

// ── Resultado ────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(60)}`);
console.log(`S7 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
console.log(`\nDIAGNÓSTICO:`);
console.log(`  plan/replan/planRoadmap: computeDynamicTimeout(messages) — escala com o prompt`);
console.log(`  retryWithMinimalPrompt:  30_000ms fixo — prompt deliberadamente pequeno`);
console.log(`  Causa raiz evitada: timeout fixo curto abortando prompt grande, perdendo replanBudget`);
if (failed > 0) process.exit(1);
