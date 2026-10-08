/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S351 (issue 067)
 *
 * Produção, 07/10/2026, goal ENADE: o validador de qualidade (ObserverValidator.validate) recebia a resposta final
 * cortada em 500 caracteres, sem aviso. A resposta tinha 1914 caracteres; o juiz viu a tabela de entrega
 * interrompida e reprovou ("A resposta final ao usuário está truncada no meio da tabela"). A reprovação entra na
 * ReflectionMemory como falha da ferramenta — dado aprendido que vira restrição dura a partir de 90% de falha.
 *
 * REGRESSÃO SE: a resposta julgada voltar a ser cortada, ou um dado de contexto cortado chegar sem o aviso do corte.
 *
 * Execução: npx ts-node src/__tests__/regression/S351_ObserverQuality_JudgesWholeResponse.test.ts
 */
import { ObserverValidator } from '../../loop/ObserverValidator';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}

function capturador() {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getBudgetAuxiliar } = require('../../shared/auxTimeout');
    const prompts: string[] = [];
    const factory = {
        chatWithFallback: async (msgs: Array<{ content: string }>) => {
            prompts.push(msgs[msgs.length - 1].content);
            return { status: 'success', content: '{"approved": true, "reason": "ok", "confidence": 0.9, "failure_type": "none"}', attempts: [] };
        },
        getBudgetAuxiliar: (perfil: 'classificacao' | 'validacao') => getBudgetAuxiliar(perfil, null, null),
    } as unknown as import('../../core/ProviderFactory').ProviderFactory;
    return { factory, prompts };
}

async function main(): Promise<void> {
    console.log('\n=== S351 — o validador de qualidade julga a resposta inteira ===');
    const { factory, prompts } = capturador();
    const juiz = new ObserverValidator(factory, 'modelo-de-teste');

    const linhas = Array.from({ length: 40 }, (_, i) => `| Questão C${i + 1} | Compiladores | gabarito comentado |`);
    const resposta = `✅ Arquivo entregue.\n\n| Questão | Disciplina | Conteúdo |\n|---|---|---|\n${linhas.join('\n')}\n\n**Ressalva importante:** remova os gabaritos antes de aplicar.`;
    const resultado = 'Conteúdo adicionado: questoes.md\n' + 'x'.repeat(3000) + '\nFIM_DO_RESULTADO';
    const pedido = 'Crie questões no padrão ENADE para Compiladores, Teoria da Computação e Sistemas Operacionais. '.repeat(10);

    await juiz.validate(pedido, 'creation', 'edit', resultado, resposta);
    const p = prompts[0] ?? '';

    assert(resposta.length > 1500, `cenário: resposta longa como a de produção (${resposta.length} chars)`);
    assert(p.includes(resposta), 'a resposta final chega INTEIRA ao juiz (antes: só os primeiros 500 chars)');
    assert(p.includes('**Ressalva importante:** remova os gabaritos'), 'o fim da resposta — a "ressalva" que o juiz disse faltar — está no prompt');
    assert(!p.includes('FIM_DO_RESULTADO'), 'o resultado da ferramenta continua sendo um trecho (o custo do prompt não explode)');
    // Sprint V6: o trecho de cada resultado passou de 1000 para 2000 chars (todas as ferramentas do turno entram).
    assert(/trecho: primeiros 2000 de \d+ caracteres/.test(p), 'o corte do resultado da ferramenta é declarado ao juiz');
    // Sprint V6 (Informação Completa para Decidir): a pergunta é "atende o pedido?" — o pedido vai ÍNTEGRO.
    assert(p.includes(pedido) && !/trecho: primeiros 500 de/.test(p), 'o pedido chega íntegro ao juiz (antes: 500 chars com corte declarado)');

    console.log('\n=== S351 — conteúdo com "$" é inserido literalmente ===');
    prompts.length = 0;
    const comCifrao = 'O preço é R$ 10,00 — padrão $& e $1 e $` aparecem literais no texto da resposta final.';
    await juiz.validate('quanto custa?', 'question', 'web_search', 'preço: R$ 10,00 (fonte)', comCifrao);
    assert((prompts[0] ?? '').includes(comCifrao), 'sequências especiais de String.replace ("$&", "$`") não corrompem a resposta');

    console.log('\n=== S351 — dado curto chega sem aviso de corte ===');
    prompts.length = 0;
    await juiz.validate('qual a previsão?', 'question', 'web_search', 'Resultado curto da ferramenta com dados suficientes', 'Resposta curta mas completa ao usuário, sem nenhum corte.');
    assert(!(prompts[0] ?? '').includes('trecho: primeiros'), 'nenhum aviso de corte quando nada foi cortado');

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S351 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    if (failed > 0) process.exitCode = 1;
}
main().catch((err) => { console.error('S351 erro inesperado:', err); process.exitCode = 1; });
