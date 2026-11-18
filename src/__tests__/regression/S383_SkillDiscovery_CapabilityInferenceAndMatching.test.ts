/// <reference types="node" />
/**
 * Testes de SkillDiscovery — executa com: npx ts-node src/__tests__/regression/S383_SkillDiscovery_CapabilityInferenceAndMatching.test.ts (movido de src/skills/__tests__/ em 10/10/2026: nenhum script o executava)
 *
 * Até 17/11/2026 este teste cobria o casamento por CAPACIDADE da Sprint 3.7A (palavras do pedido × etiquetas e palavras da
 * descrição das skills). A ADR-040 (decisão da operadora, 17/11/2026) tirou esse casamento: nas 443 mensagens reais
 * medidas ele trazia até 26 skills por mensagem (p90 6), puxadas por "quando" (185 mensagens), "arquivo" (99) e "para"
 * (54). O planejador já recebe o catálogo inteiro (nome + descrição) e escolhe por ele; por texto, só gatilho em frase.
 *
 * Os 5 casos da Sprint 3.7A, agora pela regra de frase:
 *   Caso 1: "Criar slides HTML"                → nenhuma skill por palavra de etiqueta (antes: pptx-generator por "slide")
 *   Caso 2: "Criar apresentação para aula"     → nenhuma (antes: pptx-generator por etiqueta)
 *   Caso 3: "Gerar documento PDF"              → html-pdf-converter pelo gatilho "pdf"
 *   Caso 4: Objetivo sem skill correspondente  → nenhuma descoberta, sem erro
 *   Caso 5: Skill sem tags                     → continua funcionando por gatilho
 *   Caso 6 (produção): "quando" na descrição de uma skill aprendida não a traz mais
 */

import { discoverSkills, matchSkillByTrigger } from '../../skills/SkillDiscovery';
import type { Skill } from '../../skills/SkillLoader';

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
        triggers: ['syntax error', 'validar o arquivo'],
        tools: ['exec_command', 'read', 'edit'],
        tags: ['validation', 'quality', 'syntax', 'check', 'debug', 'html', 'javascript'],
        content: '# Content Validator',
        globalContent: '# Content Validator',
    },
    {
        // Caso 5: skill SEM tags — só responde a gatilhos
        name: 'no-tags-skill',
        description: 'Uma skill sem campo tags definido.',
        triggers: ['triggerexclusivo'],
        tools: ['exec_command'],
        content: '# No Tags Skill',
        globalContent: '# No Tags Skill',
    },
    {
        // Caso 6: como as aprendidas eram exportadas até 17/11 (etiquetas derivadas do nome/origem; descrição com "Quando")
        name: 'calendario-turma-imagem-para-markdown',
        description: 'Quando o usuário enviar a imagem do calendário da turma, montar o documento em markdown.',
        triggers: ['organiza o calendário dessa turma', 'monta o cronograma da turma em markdown'],
        tools: ['read', 'write'],
        tags: ['aprendida-calendario-turma-imagem-para-markdown', 'trajetoria', 'calendario-turma-imagem-para-markdown'],
        content: '# Calendário da turma',
        globalContent: '# Calendário da turma',
    },
];

// ── Utilitário de assertion ───────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string, detalhe?: unknown): void {
    if (condition) {
        console.log(`  ✅ ${message}`);
        passed++;
    } else {
        console.error(`  ❌ FALHOU: ${message}`, detalhe ?? '');
        failed++;
    }
}
const nomes = (q: string) => discoverSkills(SKILLS, q).map(s => s.name);

console.log('\n=== Caso 1: "Criar slides HTML" ===');
assert(nomes('criar slides html').length === 0, 'nenhuma skill por palavra de etiqueta ("slide", "html")', nomes('criar slides html'));

console.log('\n=== Caso 2: "Criar apresentação para aula" ===');
assert(nomes('criar apresentação para aula').length === 0, 'nenhuma skill sem gatilho no pedido (o planejador tem o catálogo)', nomes('criar apresentação para aula'));
assert(nomes('quero uma apresentação editável da aula').includes('pptx-generator'), 'com a frase do gatilho ("apresentação editável"), pptx-generator vem');

console.log('\n=== Caso 3: "Gerar documento PDF" ===');
assert(JSON.stringify(nomes('gerar documento PDF')) === JSON.stringify(['html-pdf-converter']), 'html-pdf-converter pelo gatilho "pdf", e só ela', nomes('gerar documento PDF'));

console.log('\n=== Caso 4: Objetivo sem skill correspondente ===');
let semErro = true;
let r4: string[] = [];
try { r4 = nomes('qual a temperatura em são paulo amanhã'); } catch { semErro = false; }
assert(semErro && r4.length === 0, 'nenhuma skill e nenhum erro para objetivo de clima');

console.log('\n=== Caso 5: Skill sem tags — gatilho ainda funciona ===');
assert(nomes('quero usar o triggerexclusivo aqui').includes('no-tags-skill'), 'skill sem tags descoberta pelo gatilho');
assert(!nomes('fazer algo completamente diferente').includes('no-tags-skill'), 'sem o gatilho no texto, não vem');

console.log('\n=== Caso 6: palavra comum da descrição não traz skill (produção, 17/11) ===');
assert(nomes('quando puder, me manda o arquivo para revisar').length === 0, '"quando", "arquivo", "para" não trazem nenhuma skill', nomes('quando puder, me manda o arquivo para revisar'));
assert(nomes('organiza o calendário dessa turma pra mim').includes('calendario-turma-imagem-para-markdown'), 'a frase do gatilho traz a aprendida');

console.log('\n=== discoverSkills é exatamente o filtro de matchSkillByTrigger (uma regra só) ===');
for (const q of ['gerar documento PDF', 'criar slides html', 'organiza o calendário dessa turma', 'nada a ver']) {
    const esperado = SKILLS.filter(s => matchSkillByTrigger(s, q)).map(s => s.name);
    assert(JSON.stringify(nomes(q)) === JSON.stringify(esperado), `"${q}": mesma lista e ordem`, { obtido: nomes(q), esperado });
}

console.log(`\n${'─'.repeat(50)}`);
console.log(`Resultado: ${passed} passaram, ${failed} falharam`);
process.exit(failed > 0 ? 1 : 0);
