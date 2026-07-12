/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S6
 * GoalExecutionLoop: injeção de skill hints deve incluir TODAS as skills com prefixo AgentLoop
 *
 * PROBLEMA CORRIGIDO (dois sub-bugs):
 * (a) Apenas a primeira skill era injetada (skillHints[0]) — as demais eram ignoradas.
 * (b) O contexto da skill era injetado sem prefixo, e o LLM interpretava como
 *     "script para exec_command" em vez de "instrução de comportamento sem toolName".
 *
 * FIX: skillHints.map(h => `[SKILL: ${h.skillName}]\n⚠️ USE COMO INSTRUÇÃO...`) com join,
 *      setSkillContext(allHintTexts) injeta o texto concatenado de TODAS as skills.
 *
 * REGRESSÃO SE: código voltar a usar skillHints[0] ou remover o prefixo ⚠️.
 *
 * Execução: npx ts-node src/__tests__/regression/S6_SkillHints_AllSkillsPrefix.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`); failed++; }
}

// ── Teste 1: Inspeção do source GoalExecutionLoop.ts ────────────────────────

console.log('\n=== S6 — Inspeção do source: GoalExecutionLoop.ts ===');

const loopPath = path.join(process.cwd(), 'src', 'loop', 'GoalExecutionLoop.ts');
const loopSource = fs.readFileSync(loopPath, 'utf-8');

// Fix (a): Todas as skills via .map()
assert(
    /skillHints\.map\(h\s*=>/.test(loopSource),
    'skillHints.map(h => ...) presente — itera TODAS as skills, não apenas a primeira'
);

// Fix (b): Prefixo [SKILL: ...]
assert(
    /\[SKILL: \$\{h\.skillName\}\]/.test(loopSource),
    'Prefixo [SKILL: ${h.skillName}] presente em cada hint'
);

// Fix (b): Instrução de comportamento AgentLoop
assert(
    /USE COMO INSTRUÇÃO DE COMPORTAMENTO.*OMITA toolName/.test(loopSource),
    'Instrução "USE COMO INSTRUÇÃO DE COMPORTAMENTO: OMITA toolName" presente'
);

// Fix (b): Instrução sobre exec_command
assert(
    /NÃO use exec_command para invocar esta skill/.test(loopSource),
    'Instrução "NÃO use exec_command para invocar esta skill" presente'
);

// Join de múltiplas skills
assert(
    /\.join\s*\(\s*['"`\\n].*---/.test(loopSource),
    'Skills são concatenadas com separador via .join()'
);

// setSkillContext com o texto concatenado
assert(
    /setSkillContext\(allHintTexts\)/.test(loopSource),
    'setSkillContext(allHintTexts) injeta todas as skills concatenadas'
);

// Garantia de que skillHints[0] NÃO é mais usado isoladamente para este contexto
// (o map() garante isso, mas verificamos que não há acesso direto à [0])
const hasSingleHintAccess = /skillHints\[0\]/.test(loopSource);
assert(
    !hasSingleHintAccess,
    'skillHints[0] não é mais usado — código usa .map() para todas as skills'
);

// ── Teste 2: Lógica de construção do texto — simulação inline ───────────────

console.log('\n=== S6 — Simulação: múltiplas skills → texto concatenado ===');

// Replica a lógica exata do GoalExecutionLoop.ts linha ~371
const mockSkillHints = [
    { skillName: 'html-pdf-converter', skillContext: 'Instruções para converter HTML para PDF via Puppeteer.' },
    { skillName: 'pptx-generator',     skillContext: 'Instruções para gerar PPTX via python-pptx.'           },
];

const allHintTexts = mockSkillHints.map(h =>
    `[SKILL: ${h.skillName}]\n` +
    `⚠️ USE COMO INSTRUÇÃO DE COMPORTAMENTO: OMITA toolName neste step — NÃO use exec_command para invocar esta skill.\n` +
    `O AgentLoop executará as instruções abaixo diretamente, sem subprocess:\n\n` +
    h.skillContext
).join('\n\n---\n\n');

console.log(`  → Texto gerado (${allHintTexts.length} chars):`);
console.log(`    ${allHintTexts.slice(0, 120).replace(/\n/g, '\\n')}...`);

// Ambas as skills devem aparecer no texto
assert(
    allHintTexts.includes('[SKILL: html-pdf-converter]'),
    'html-pdf-converter aparece no texto concatenado'
);

assert(
    allHintTexts.includes('[SKILL: pptx-generator]'),
    'pptx-generator aparece no texto concatenado'
);

// O prefixo de instrução aparece para CADA skill (2x)
const prefixCount = (allHintTexts.match(/⚠️ USE COMO INSTRUÇÃO DE COMPORTAMENTO/g) ?? []).length;
assert(
    prefixCount === mockSkillHints.length,
    `Prefixo ⚠️ aparece ${prefixCount}x — uma vez por skill (esperado: ${mockSkillHints.length})`
);

// O separador --- separa as skills
assert(
    allHintTexts.includes('---'),
    'Separador --- presente entre as skills'
);

// O conteúdo de cada skill está presente
assert(
    allHintTexts.includes('Instruções para converter HTML'),
    'Conteúdo da skill html-pdf-converter preservado'
);

assert(
    allHintTexts.includes('Instruções para gerar PPTX'),
    'Conteúdo da skill pptx-generator preservado'
);

// ── Teste 3: Caso com skill única — funciona sem separador ──────────────────

console.log('\n=== S6 — Caso com uma única skill ===');

const singleSkill = [{ skillName: 'marp-slides', skillContext: 'Instruções marp.' }];
const singleHintText = singleSkill.map(h =>
    `[SKILL: ${h.skillName}]\n` +
    `⚠️ USE COMO INSTRUÇÃO DE COMPORTAMENTO: OMITA toolName neste step — NÃO use exec_command para invocar esta skill.\n` +
    `O AgentLoop executará as instruções abaixo diretamente, sem subprocess:\n\n` +
    h.skillContext
).join('\n\n---\n\n');

assert(
    singleHintText.includes('[SKILL: marp-slides]'),
    'Skill única tem o prefixo [SKILL: ...]'
);
assert(
    !singleHintText.includes('---'),
    'Skill única não tem separador --- desnecessário'
);

// ── Resultado ────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(60)}`);
console.log(`S6 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
console.log(`\nCOBERTURA:`);
console.log(`  .map() itera todas as skills: testado`);
console.log(`  Prefixo [SKILL: name] em cada hint: testado`);
console.log(`  Instrução ⚠️ OMITA toolName em cada hint: testado`);
console.log(`  setSkillContext(allHintTexts) com concatenação: testado`);
console.log(`  skillHints[0] não mais usado isolado: testado`);
if (failed > 0) process.exit(1);
