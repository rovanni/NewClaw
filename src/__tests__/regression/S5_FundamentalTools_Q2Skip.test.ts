/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S5
 * RiskAnalyzer: ferramentas fundamentais não devem gerar falsos positivos no Q2
 *
 * PROBLEMA CORRIGIDO: O loop Q2 chamava buildContextHint para TODAS as tools,
 * incluindo 'write', 'web_search', 'read', etc. Falhas históricas de contextos
 * completamente diferentes (ex: "web_search falhou 9/9") contaminavam o Q2
 * com warnings irrelevantes que bloqueavam o GoalPlanner.
 *
 * FIX: FUNDAMENTAL_AGENT_TOOLS é um Set que contém as ferramentas cujas falhas
 * históricas são context-específicas. O loop Q2 pula buildContextHint para elas.
 *
 * REGRESSÃO SE: FUNDAMENTAL_AGENT_TOOLS for removido ou o guard !has() for retirado.
 *
 * Execução: npx ts-node src/__tests__/regression/S5_FundamentalTools_Q2Skip.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`); failed++; }
}

const riskPath = path.join(process.cwd(), 'src', 'loop', 'RiskAnalyzer.ts');
const riskSource = fs.readFileSync(riskPath, 'utf-8');

// ── Teste 1: FUNDAMENTAL_AGENT_TOOLS está definido no source ────────────────

console.log('\n=== S5 — FUNDAMENTAL_AGENT_TOOLS definido em RiskAnalyzer.ts ===');

assert(
    /const FUNDAMENTAL_AGENT_TOOLS\s*=\s*new Set\(/.test(riskSource),
    'FUNDAMENTAL_AGENT_TOOLS declarado como Set em RiskAnalyzer.ts'
);

// ── Teste 2: Set contém todas as ferramentas esperadas ───────────────────────

console.log('\n=== S5 — Ferramentas fundamentais no Set ===');

const setMatch = riskSource.match(/FUNDAMENTAL_AGENT_TOOLS\s*=\s*new Set\(\[([\s\S]*?)\]\)/);
assert(!!setMatch, 'Conteúdo de FUNDAMENTAL_AGENT_TOOLS pode ser extraído do source');

if (setMatch) {
    const setContent = setMatch[1];
    const expectedTools = [
        'write', 'read', 'edit', 'web_search',
        'send_document', 'send_message',
        'memory_search', 'memory_write',
        'list_workspace', 'analyze_workspace_groups',
    ];
    for (const tool of expectedTools) {
        assert(
            setContent.includes(`'${tool}'`),
            `FUNDAMENTAL_AGENT_TOOLS inclui '${tool}'`
        );
    }
}

// ── Teste 3: Guard está no loop Q2 ANTES de buildContextHint ────────────────

console.log('\n=== S5 — Guard !FUNDAMENTAL_AGENT_TOOLS.has() no loop Q2 ===');

assert(
    /!FUNDAMENTAL_AGENT_TOOLS\.has\(step\.toolName\)/.test(riskSource),
    'Guard !FUNDAMENTAL_AGENT_TOOLS.has(step.toolName) presente no source'
);

// NOTA (S3a, roadmap de aprendizado orientado a objetivos): RiskAnalyzer migrou de
// buildContextHint(`tool_${step.toolName}`) para findToolFailures(step.toolName) — mesma
// pergunta ("existe falha recorrente para esta ferramenta?"), consulta estruturada por
// tool_used em vez de string livre. O guard S5 continua protegendo o mesmo ponto do código,
// só a chamada protegida mudou de nome. Assertivas atualizadas para refletir o código real
// (não apagadas — mesma convenção usada em S16_ReflectionMemory_Baseline.test.ts).
const guardIndex        = riskSource.indexOf('!FUNDAMENTAL_AGENT_TOOLS.has(step.toolName)');
const buildHintIndex    = riskSource.indexOf('findToolFailures(step.toolName)');

assert(
    guardIndex !== -1,
    'Guard FUNDAMENTAL_AGENT_TOOLS.has encontrado no source'
);

assert(
    buildHintIndex !== -1,
    'findToolFailures(step.toolName) encontrado no source (substituiu buildContextHint na S3a)'
);

assert(
    guardIndex < buildHintIndex,
    'Guard aparece ANTES de findToolFailures (proteção está no caminho certo)'
);

// ── Teste 4: Simulação do filtro — comportamento esperado ───────────────────

console.log('\n=== S5 — Simulação: quais tools disparam buildContextHint? ===');

// Replica o FUNDAMENTAL_AGENT_TOOLS do source
const FUNDAMENTAL_AGENT_TOOLS_REPLICA = new Set([
    'write', 'read', 'edit', 'web_search', 'send_document', 'send_message',
    'memory_search', 'memory_write', 'list_workspace', 'analyze_workspace_groups',
]);

const toolCases = [
    { toolName: 'write',                   shouldCallHint: false },
    { toolName: 'read',                    shouldCallHint: false },
    { toolName: 'edit',                    shouldCallHint: false },
    { toolName: 'web_search',              shouldCallHint: false },
    { toolName: 'send_document',           shouldCallHint: false },
    { toolName: 'send_message',            shouldCallHint: false },
    { toolName: 'memory_search',           shouldCallHint: false },
    { toolName: 'memory_write',            shouldCallHint: false },
    { toolName: 'list_workspace',          shouldCallHint: false },
    { toolName: 'analyze_workspace_groups',shouldCallHint: false },
    { toolName: 'exec_command',            shouldCallHint: true  },
    { toolName: 'marp',                    shouldCallHint: true  },
    { toolName: 'pandoc',                  shouldCallHint: true  },
    { toolName: 'ssh_exec',                shouldCallHint: true  },
];

const hintCalledFor: string[] = [];
for (const { toolName, shouldCallHint } of toolCases) {
    const wouldCallHint = !FUNDAMENTAL_AGENT_TOOLS_REPLICA.has(toolName);
    if (wouldCallHint) hintCalledFor.push(toolName);
    assert(
        wouldCallHint === shouldCallHint,
        `'${toolName}': buildContextHint chamado=${wouldCallHint} (esperado: ${shouldCallHint})`
    );
}

console.log(`  → buildContextHint seria chamado para: [${hintCalledFor.join(', ')}]`);
assert(
    hintCalledFor.length === 4,
    `Exatamente 4 tools não-fundamentais disparam buildContextHint (obtido: ${hintCalledFor.length})`
);

// ── Resultado ────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(60)}`);
console.log(`S5 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
console.log(`\nCOBERTURA:`);
console.log(`  FUNDAMENTAL_AGENT_TOOLS definido: testado`);
console.log(`  Todas as 10 ferramentas no Set: testado`);
console.log(`  Guard antes de buildContextHint: testado`);
console.log(`  Comportamento do filtro para 14 tools: testado`);
if (failed > 0) process.exit(1);
