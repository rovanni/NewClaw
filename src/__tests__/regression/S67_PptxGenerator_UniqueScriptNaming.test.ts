/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S67
 * skills/pptx-generator/SKILL.md: receita do Passo 0B não pode usar nomes genéricos
 * fixos para o script Python nem para o .pptx de saída.
 *
 * PROBLEMA CORRIGIDO: a skill instruía salvar o script sempre em `tmp/gerar_pptx.py` e
 * a apresentação sempre em `apresentacao.pptx`. Como o workspace é persistente entre
 * conversas, um `tmp/gerar_pptx.py` de uma tarefa antiga (outro assunto) continuava em
 * disco. Nesta sessão real (2026-07-07, suplemento PowerPoint, goal_1783430280404_xk7ht):
 * um step de plano seguiu a receita ao pé da letra e rodou `python3 tmp/gerar_pptx.py`
 * — só que o script que já existia nesse caminho era de uma aula de Excel de 5 dias
 * antes (`tmp/gerar_pptx.py`, 02/07 00:57, verificado em disco). Resultado: gerou e quase
 * enviou `funcoes_data.pptx` (9 slides, assunto errado) em vez do conteúdo pedido (DHCP,
 * 12 slides) — 2 tentativas idênticas, ambas com o mesmo resultado errado, forçando um
 * replan completo e ~3 minutos perdidos.
 *
 * FIX: SKILL.md passa a exigir nome ÚNICO derivado do assunto (script E saída, mesmo
 * padrão nos dois lugares) tanto no caminho python-pptx (Passo 0B) quanto no caminho
 * Marp CLI (Passo 3) — mesma classe de risco, mesmo princípio de correção.
 *
 * REGRESSÃO SE: os exemplos genéricos `tmp/gerar_pptx.py` / `apresentacao.pptx` (como
 * COMANDO A EXECUTAR, não como "não faça isso") voltarem à skill.
 *
 * Execução: npx ts-node src/__tests__/regression/S67_PptxGenerator_UniqueScriptNaming.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`); failed++; }
}

console.log('\n=== S67 — SKILL.md do pptx-generator não recomenda mais nomes genéricos ===');

const skillPath = path.join(process.cwd(), 'skills', 'pptx-generator', 'SKILL.md');
const skill = fs.readFileSync(skillPath, 'utf-8');

// O comando de execução real (Passo 0B.3) é o ponto crítico: é ele que roda o script.
// Não pode mais apontar para o nome genérico sem sufixo de assunto.
const execLineMatch = skill.match(/```bash\npython3 (tmp\/[^\n]+)\n```/);
assert(!!execLineMatch, 'Passo 0B.3 tem um bloco de comando `python3 tmp/...` identificável');
assert(
    !!execLineMatch && execLineMatch[1] !== 'tmp/gerar_pptx.py',
    `comando de execução do Passo 0B.3 não usa mais o nome genérico exato "tmp/gerar_pptx.py" (obtido: "${execLineMatch?.[1]}")`,
);

// prs.save(...) genérico não pode mais ser o exemplo de saída
assert(
    !/prs\.save\('apresentacao\.pptx'\)/.test(skill),
    "exemplo de saída python-pptx não usa mais o nome genérico exato 'apresentacao.pptx'",
);

// Comando marp de exemplo (Passo 3) não pode mais usar o par genérico slides.md/apresentacao.pptx
assert(
    !/marp slides\.md -o apresentacao\.pptx/.test(skill),
    'exemplo de conversão Marp (Passo 3) não usa mais o par genérico slides.md/apresentacao.pptx',
);

// A skill deve explicar o PORQUÊ (evita que a regra seja removida por parecer arbitrária)
assert(
    /workspace (é|persist)/i.test(skill) && /(tarefa anterior|tarefa antiga|tarefa diferente)/i.test(skill),
    'skill explica a causa (workspace persistente + colisão com tarefa anterior), não só a regra',
);

// A skill deve orientar explicitamente nome único derivado do assunto
assert(
    /nome[s]? (único|ÚNICO)/i.test(skill),
    'skill instrui explicitamente usar nome único derivado do assunto',
);

console.log(`\n${'─'.repeat(60)}`);
console.log(`S67 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
console.log(`\nCOBERTURA:`);
console.log(`  Comando de execução (0B.3) sem nome genérico: testado`);
console.log(`  Exemplo prs.save() sem nome genérico: testado`);
console.log(`  Exemplo Marp sem par genérico: testado`);
console.log(`  Justificativa (causa raiz) presente na skill: testado`);
console.log(`  Instrução de nome único presente: testado`);
if (failed > 0) process.exit(1);
