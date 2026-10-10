/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S374 (campanha 09/10/2026, teste ao vivo com glm-5.3-flash)
 *
 * Seis de doze casos voltaram "saída do modelo sem a estrutura do contrato": o modelo escreve uma análise em prosa — com
 * chaves soltas e exemplos de JSON no meio — ANTES do veredito, e o leitor do motor pegava "do primeiro { ao último }" e
 * quebrava. Com a política `bloquear` (conclusão do objetivo, conteúdo-molde) isso virava falso bloqueio. O juiz de qualidade
 * antigo varria os objetos candidatos; essa robustez se perdeu na troca ao motor único.
 *
 * REGRESSÃO SE: o leitor voltar a depender de "primeiro { / último }", ou aceitar objeto que não é de veredito, ou
 * "consertar" uma saída sem veredito.
 *
 * Execução: npx ts-node src/__tests__/regression/S374_VerdictReader_FindsTheVerdictInProse.test.ts
 */
import { extrairObjetoDoVeredito, lerSaidaDoModelo, citacaoExiste } from '../../validation/contratoDeValidacao';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}

const VEREDITO = '{"estado":"aprovado","itens":[{"item":"x","confere":"sim"}],"confianca":0.9,"motivo":"ok"}';

console.log('\n=== S374-1 — o objeto de veredito no meio da prosa ===');
{
    assert(extrairObjetoDoVeredito(VEREDITO)?.estado === 'aprovado', 'JSON puro');
    assert(extrairObjetoDoVeredito('```json\n' + VEREDITO + '\n```')?.estado === 'aprovado', 'JSON em bloco de código');
    const comExemplo = 'Vou analisar.\n\nFormato: {"estado":"aprovado|reprovado","itens":[...]} hmm, o exemplo mostra "motivo":"curto".\n\nResposta:\n' + VEREDITO + '\n\nFim.';
    assert(extrairObjetoDoVeredito(comExemplo)?.estado === 'aprovado', 'exemplo quebrado no meio da prosa não atrapalha; vale o veredito', extrairObjetoDoVeredito(comExemplo));
    const doisVereditos = '{"estado":"reprovado","itens":[]} ... corrigindo ... ' + VEREDITO;
    assert(extrairObjetoDoVeredito(doisVereditos)?.estado === 'aprovado', 'dois objetos de veredito: vale o ÚLTIMO (a conclusão do modelo)');
    const chavesEmTexto = '{"estado":"aprovado","itens":[],"motivo":"o texto cita {chaves} e \\"aspas\\" dentro da string"}';
    assert(extrairObjetoDoVeredito('Análise: ' + chavesEmTexto)?.estado === 'aprovado', 'chaves e aspas escapadas dentro de string não fecham o objeto');
    const outroObjeto = 'Dados: {"preco": 1.17, "moeda": "USD"} e nada mais.';
    assert(extrairObjetoDoVeredito(outroObjeto) === null, 'objeto que não é de veredito (sem estado/itens) é ignorado');
    assert(extrairObjetoDoVeredito('sem json nenhum') === null, 'sem JSON → nulo');
    assert(extrairObjetoDoVeredito('{"estado":"aprovado","itens":[') === null, 'JSON cortado → nulo (nunca "consertado")');
}

console.log('\n=== S374-2 — lerSaidaDoModelo continua estrito sobre o conteúdo do objeto achado ===');
{
    const lido = lerSaidaDoModelo('Análise longa com {chaves} soltas.\n' + VEREDITO);
    assert(lido?.estadoDoModelo === 'aprovado' && lido.itens.length === 1 && lido.confianca === 0.9, 'lê o veredito achado na prosa', lido);
    assert(lerSaidaDoModelo('{"estado":"aprovado","itens":[{"item":"x","confere":"talvez"}]}') === null, 'valor fora do contrato em "confere" → nulo');
    assert(lerSaidaDoModelo('{"estado":"aprovado","itens":[{"confere":"sim"}]}') === null, 'item sem texto → nulo');
    const extras = lerSaidaDoModelo('Análise.\n{"estado":"reprovado","itens":[],"riscos":"a | b"}', ['riscos']);
    assert(extras?.extras?.riscos === 'a | b', 'campos extras declarados continuam sendo lidos', extras);
}

console.log('\n=== S374-3 — a citação é conferida só por forma tipográfica: o sinal de menos Unicode não reprova uma citação correta ===');
{
    const fonte = ['Variação 24h: -0,43% | Preço: US$ 1,18 (CoinGecko)\nCap. de mercado — **US$ 23,16M**'];
    assert(citacaoExiste('Variação 24h: −0,43%', fonte), 'sinal de menos Unicode (−) vale como hífen');
    assert(citacaoExiste('Cap. de mercado – US$ 23,16M', fonte), 'travessão/meia-risca valem como o traço da fonte; markdown ignorado');
    assert(citacaoExiste('Preço:\u00A0US$ 1,18', fonte), 'espaço não separável vale como espaço');
    assert(citacaoExiste('preço: us$ 1,18 (coingecko)', fonte), 'maiúsculas e minúsculas não importam');
    assert(!citacaoExiste('Variação 24h: +0,43%', fonte), 'mas o SENTIDO conta: o sinal trocado não confere');
    assert(!citacaoExiste('Preço: US$ 9,99', fonte), 'e um valor que não está na fonte não confere');
    assert(!citacaoExiste('', fonte), 'citação vazia não confere');
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S374 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;
