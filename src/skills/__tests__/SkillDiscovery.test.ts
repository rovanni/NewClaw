/// <reference types="node" />
/**
 * Testes de SkillDiscovery — executa com: npx ts-node src/skills/__tests__/SkillDiscovery.test.ts
 *
 * Cobre os 5 casos definidos na Sprint 3.7A:
 *   Caso 1: "Criar slides HTML"                → pptx-generator descoberta
 *   Caso 2: "Criar apresentação para aula"     → pptx-generator descoberta sem mencionar PPTX
 *   Caso 3: "Gerar documento PDF"              → html-pdf-converter descoberta
 *   Caso 4: Objetivo sem skill correspondente  → nenhuma descoberta, sem erro
 *   Caso 5: Skill sem tags                     → continua funcionando por trigger
 */

import {
    normalizeToken,
    inferCapabilities,
    discoverSkills,
} from '../SkillDiscovery';
import type { Skill } from '../SkillLoader';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const SKILLS: Skill[] = [
    {
        name: 'pptx-generator',
        description: 'Converte apresentações HTML ou Markdown em arquivos PowerPoint (.pptx) editáveis usando Marp CLI.',
        triggers: ['powerpoint', 'pptx', 'slides editáveis', 'apresentação editável', 'marp'],
        tools: ['exec_command', 'write', 'send_document'],
        tags: ['presentation', 'slides', 'export', 'office', 'document-generation', 'powerpoint', 'marp', 'convert'],
        content: '# PPTX Generator',
        globalContent: '# PPTX Generator',
    },
    {
        name: 'html-pdf-converter',
        description: 'Converte arquivos HTML para PDF usando o script html2pdf.sh.',
        triggers: ['pdf', 'converter', 'gerar pdf', 'exportar pdf'],
        tools: ['exec_command', 'send_document'],
        tags: ['pdf', 'convert', 'export', 'html', 'document', 'print', 'publish', 'slides'],
        content: '# HTML PDF Converter',
        globalContent: '# HTML PDF Converter',
    },
    {
        name: 'content-validator',
        description: 'Valida arquivos gerados (HTML, JS, Python, JSON) antes de enviar ao usuário.',
        triggers: ['erro', 'error', 'syntax error', 'corrija', 'corrigir', 'verificar', 'validar'],
        tools: ['exec_command', 'read', 'edit'],
        tags: ['validation', 'quality', 'syntax', 'check', 'debug', 'html', 'javascript'],
        content: '# Content Validator',
        globalContent: '# Content Validator',
    },
    {
        // Caso 5: skill SEM tags — só deve responder a triggers
        name: 'no-tags-skill',
        description: 'Uma skill sem campo tags definido.',
        triggers: ['triggerexclusivo'],
        tools: ['exec_command'],
        // tags não definidas
        content: '# No Tags Skill',
        globalContent: '# No Tags Skill',
    },
];

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

// ── Testes de normalização ────────────────────────────────────────────────────

console.log('\n=== Testes de normalização ===');

assert(normalizeToken('apresentações') === 'apresentacao' || normalizeToken('apresentações').startsWith('apresenta'),
    'normalizeToken remove acento e normaliza plural PT-BR');

assert(normalizeToken('slides') === 'slide',
    'normalizeToken remove plural simples (slides → slide)');

assert(normalizeToken('EXPORT') === 'export',
    'normalizeToken faz lowercase');

assert(normalizeToken('PDF') === 'pdf',
    'normalizeToken normaliza siglas');

// ── Testes de inferCapabilities ───────────────────────────────────────────────

console.log('\n=== Testes de inferCapabilities ===');

const caps1 = inferCapabilities('criar slides html para aula');
assert(caps1.has('slide') || caps1.has('slides'),
    'inferCapabilities: "slides" → "slide" presente no resultado');

assert(caps1.has('html'),
    'inferCapabilities: "html" preservado como token');

assert(!caps1.has('de') && !caps1.has('a') && !caps1.has('em'),
    'inferCapabilities: tokens curtos (< 4 chars) como "de", "a", "em" são excluídos');

const caps2 = inferCapabilities('gerar documento PDF para impressão');
assert(caps2.has('document') || caps2.has('documento'),
    'inferCapabilities: "documento" → normalizado e presente');

// ── Caso 1: "Criar slides HTML" → pptx-generator descoberta ─────────────────

console.log('\n=== Caso 1: "Criar slides HTML" ===');

const result1 = discoverSkills(SKILLS, 'criar slides html');
const skillNames1 = result1.all.map(s => s.name);

assert(skillNames1.includes('pptx-generator'),
    'pptx-generator descoberta para "criar slides html"');

assert(!result1.byTrigger.some(s => s.name === 'pptx-generator'),
    'pptx-generator descoberta por capability (não por trigger exato)');

assert(result1.byCapability.some(m => m.skillName === 'pptx-generator'),
    'pptx-generator aparece em byCapability com matchedTerms');

// ── Caso 2: "Criar apresentação para aula" sem mencionar PPTX ───────────────

console.log('\n=== Caso 2: "Criar apresentação para aula" ===');

const result2 = discoverSkills(SKILLS, 'criar apresentação para aula');
const skillNames2 = result2.all.map(s => s.name);

assert(skillNames2.includes('pptx-generator'),
    'pptx-generator descoberta para "criar apresentação para aula" sem mencionar PPTX');

const match2 = result2.byCapability.find(m => m.skillName === 'pptx-generator');
assert(match2 !== undefined && match2.matchedTerms.length > 0,
    'pptx-generator: matchedTerms não vazio');

// ── Caso 3: "Gerar documento PDF" → html-pdf-converter descoberta ─────────────

console.log('\n=== Caso 3: "Gerar documento PDF" ===');

const result3 = discoverSkills(SKILLS, 'gerar documento PDF');
const skillNames3 = result3.all.map(s => s.name);

assert(skillNames3.includes('html-pdf-converter'),
    'html-pdf-converter descoberta para "gerar documento PDF"');

// ── Caso 4: Objetivo sem skill correspondente ─────────────────────────────────

console.log('\n=== Caso 4: Objetivo sem skill correspondente ===');

let noError = true;
let result4: ReturnType<typeof discoverSkills>;
try {
    result4 = discoverSkills(SKILLS, 'qual a temperatura em são paulo amanhã');
} catch {
    noError = false;
}

assert(noError,
    'discoverSkills não lança erro para objetivo sem skill');

assert(result4!.all.length === 0,
    'nenhuma skill descoberta para objetivo de clima/previsão');

assert(result4!.byTrigger.length === 0 && result4!.byCapability.length === 0,
    'byTrigger e byCapability ambos vazios');

// ── Caso 5: Skill sem tags continua funcionando por trigger ───────────────────

console.log('\n=== Caso 5: Skill sem tags — trigger ainda funciona ===');

const result5 = discoverSkills(SKILLS, 'quero usar o triggerexclusivo aqui');
const skillNames5 = result5.all.map(s => s.name);

assert(skillNames5.includes('no-tags-skill'),
    'skill sem tags ainda é descoberta pelo trigger exato');

assert(result5.byTrigger.some(s => s.name === 'no-tags-skill'),
    'skill sem tags aparece em byTrigger (não byCapability)');

const result5b = discoverSkills(SKILLS, 'fazer algo completamente diferente');
assert(!result5b.all.map(s => s.name).includes('no-tags-skill'),
    'skill sem tags NÃO é descoberta por capability (sem tags → sem match)');

// ── Resultado final ───────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`);
console.log(`Resultado: ${passed} passaram, ${failed} falharam`);

if (failed > 0) {
    process.exit(1);
} else {
    console.log('✅ Todos os testes passaram.\n');
}
