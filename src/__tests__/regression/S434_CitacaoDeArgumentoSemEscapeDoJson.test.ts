/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S434
 * A citação do juiz que copia o VALOR de um argumento de ferramenta confere com a evidência, mesmo que o argumento esteja
 * no prompt como JSON (barra invertida, aspas e quebra de linha escapadas).
 *
 * INCIDENTE REAL (Windows, 19/10/2026, "consegue salvar isso na memória?"): o juiz de saida_contra_evidencia devolveu
 * `aprovado` com 9 de 9 itens `confere: sim`. Duas citações eram caminhos do Windows copiados do `content` do memory_write;
 * nas evidências o argumento aparecia como `C:\\Users\\…` (JSON.stringify em descreverArgumentos) e a conferência literal
 * falhou → 6/9 sustentadas → NOT_EVALUABLE → a usuária recebeu "Não encontrei, nas fontes que consultei, confirmação…".
 *
 * Execução: npx ts-node src/__tests__/regression/S434_CitacaoDeArgumentoSemEscapeDoJson.test.ts
 */
import { citacaoExiste } from '../../validation/contratoDeValidacao';
import { descreverArgumentos } from '../../shared/argumentosDaChamada';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}

// A evidência montada como em ObserverValidator: "[E3] ferramenta=memory_write args=<descreverArgumentos>\n<saída>".
const args = {
    action: 'create', type: 'infrastructure', name: 'caminho_app',
    content: 'App instalado em C:\\Users\\exemplo\\Apps\\Studio, com estrutura backend e skills\\studio.\nDados: "C:\\Users\\exemplo\\AppData\\Roaming\\Studio"',
};
const evidencia = `[E3] ferramenta=memory_write args=${descreverArgumentos(args)}\n✅ Nó "caminho_app_1" criado.`;

console.log('\n=== S434-1 — o argumento está mesmo escapado no prompt (pré-condição do incidente) ===');
assert(evidencia.includes('C:\\\\Users\\\\exemplo'), 'no texto da evidência a barra aparece duplicada', evidencia.slice(0, 160));

console.log('\n=== S434-2 — a citação do valor real confere ===');
assert(citacaoExiste('em C:\\Users\\exemplo\\Apps\\Studio, com estrutura backend e skills\\studio', [evidencia]), 'caminho do Windows com barras simples');
assert(citacaoExiste('Dados: "C:\\Users\\exemplo\\AppData\\Roaming\\Studio"', [evidencia]), 'aspas escapadas no JSON valem como aspas');
assert(citacaoExiste('skills\\studio. Dados:', [evidencia]), 'quebra de linha escapada (\\n) vale como espaço em branco');
assert(citacaoExiste('✅ Nó "caminho_app_1" criado.', [evidencia]), 'a saída da ferramenta (sem JSON) continua conferindo');

console.log('\n=== S434-3 — o SENTIDO continua contando ===');
assert(!citacaoExiste('em C:\\Users\\outro\\Apps\\Studio', [evidencia]), 'outro caminho não confere');
assert(!citacaoExiste('em D:\\Users\\exemplo\\Apps\\Studio', [evidencia]), 'outra unidade não confere');
assert(citacaoExiste('C:\\\\Users\\\\exemplo\\\\Apps', [evidencia]), 'a forma escapada, como está no prompt, também confere');

console.log(`\n${'─'.repeat(60)}`);
console.log(`S434 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;
