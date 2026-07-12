/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S76
 *
 * Investigação (09/07/2026): usuário reportou "o áudio está falando errado, repetindo
 * letras" e pediu pra analisar o workspace e os textos usados para gerar áudio ontem e
 * hoje. Cruzando `data/sessions/telegram~8071707790.jsonl` (tool_call de send_audio,
 * persistido graças ao fix S74 desta mesma sessão) com `newclaw-audit.log`:
 *
 *   09/07 08:19:40 — send_audio.text = "Resumo do mercado de criptomoedas de hoje:
 *   [resultado_do_passo_1]" — um identificador em snake_case dentro de colchetes,
 *   literalmente uma variável de template NÃO substituída. Esse caso específico não
 *   chegou a virar áudio real (foi pego por DELIVERY-DEDUP por outro motivo — áudio já
 *   entregue neste goal), mas confirma que passou ILESO pelo gate que deveria pegá-lo:
 *
 *   [SanitizePlanSteps] ... 'send_audio.text' preenchido ANTES de um step produtor de
 *   dado dinâmico já ter rodado — este log (goal_1783595837919_vw9qo) é de uma tentativa
 *   POSTERIOR e DIFERENTE (976 chars) — o texto curto de 65 chars com
 *   "[resultado_do_passo_1]" passou pelo caminho do ELSE (sawDataProducingTool=false,
 *   já que o step 1 tinha virado 'agentloop' genérico, fora de DATA_PRODUCING_TOOLS) e
 *   foi checado contra CONTENT_STUB_PATTERNS — que NÃO tinha nenhum padrão pra colchetes
 *   com identificador em snake_case. É a 6ª variação documentada da mesma classe de bug
 *   (colchetes referenciando resultado de step ainda não executado) escapando da lista —
 *   as 5 anteriores (step_1 → step 1 → etapas anteriores → gerado pelo assistente →
 *   passo 1) estão documentadas nos comentários de shared/contentStubPatterns.ts.
 *
 * Causa raiz: nenhum padrão em CONTENT_STUB_PATTERNS cobria "[identificador_em_snake_case]"
 * genericamente — só variantes com "step"/"passo" como palavra isolada ou frases com
 * verbo+preposição. "resultado_do_passo_1" é um único token colado (sem espaços), formato
 * de nome de variável de template, não de prosa.
 *
 * Fix: 1 padrão novo, genérico — qualquer colchete envolvendo um identificador em
 * snake_case (≥2 segmentos separados por "_") é sinal de variável de template vazada,
 * independente de qual nome de variável específico foi usado (não é mais uma string
 * literal — cobre a CLASSE inteira, prosa real em português nunca produz isso).
 *
 * Escopo tocado: shared/contentStubPatterns.ts (1 padrão).
 *
 * Execução: npx ts-node src/__tests__/regression/S76_ContentStub_SnakeCaseBracketPlaceholder.test.ts
 */

import { CONTENT_STUB_PATTERNS } from '../../shared/contentStubPatterns';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

function matches(text: string): boolean {
    return CONTENT_STUB_PATTERNS.some(p => p.test(text));
}

async function main(): Promise<void> {

console.log('\n=== S76-1 [runtime — reprodução do incidente real] — texto exato do incidente é detectado como content-stub ===');
{
    const real = 'Resumo do mercado de criptomoedas de hoje: [resultado_do_passo_1]';
    assert(matches(real), 'texto real do incidente (send_audio.text com [resultado_do_passo_1]) agora é detectado', real);
}

console.log('\n=== S76-2 [runtime] — classe genérica: qualquer identificador em snake_case dentro de colchetes é pego, não só "passo" ===');
{
    const variants = [
        'Aqui está o resultado: [dados_do_step_2]',
        'Confira: [valor_calculado_anteriormente]',
        'Texto final: [conteudo_gerado]',
        '[analise_do_mercado_hoje] é o que temos até agora.',
    ];
    for (const v of variants) {
        assert(matches(v), `variante genérica detectada: "${v}"`, v);
    }
}

console.log('\n=== S76-3 [regressão] — as 5 variações históricas documentadas continuam cobertas (nenhuma foi enfraquecida) ===');
{
    const historicos = [
        'PLACEHOLDER_GERADO_EM_RUNTIME',
        'Aqui está a previsão do tempo para amanhã: [inserir dados obtidos no step_1]',
        'conteúdo será gerado em runtime com base nos dados de memória recuperados',
        'Análise completa: (Os preços e variações coletados nas etapas anteriores devem ser inseridos aqui para narração).',
        'conteúdo gerado pelo assistente',
        'Previsão do tempo para amanhã em Belo Horizonte, inserir dados reais obtidos no passo 1.',
    ];
    for (const h of historicos) {
        assert(matches(h), `caso histórico continua detectado: "${h.slice(0, 60)}..."`, h);
    }
}

console.log('\n=== S76-4 [anti-falso-positivo] — conteúdo real (prosa natural em português) NÃO é bloqueado pelo novo padrão ===');
{
    // O texto real do incidente de hoje que FOI entregue com sucesso (workspace:
    // mercado-cripto-09-07-2026.txt / send_audio bem-sucedido às 08:18) — prosa legítima,
    // sem colchetes com identificador, não pode disparar falso-positivo.
    const realContent = 'Olá, Luciano! Aqui está um panorama do mercado de criptomoedas hoje, 9 de julho de 2026. ' +
        'O Bitcoin mantém-se como referência principal do setor. A Pi Network segue em seu processo ' +
        'de consolidação, com a comunidade atenta a novidades e possíveis listagens em exchanges maiores.';
    assert(!matches(realContent), 'narração real e bem-formada (sem colchetes) não é falsamente bloqueada', realContent);

    // Colchetes usados legitimamente (raro em áudio, comum em texto/relatório) não devem
    // disparar o padrão SE não houver underscore — ex: citação numérica ou nota.
    const citacaoNumerica = 'Segundo a fonte [1], o mercado cripto teve alta hoje.';
    assert(!matches(citacaoNumerica), 'colchete com citação numérica simples ([1], sem underscore) não é falso-positivo', citacaoNumerica);

    // Palavra única em colchetes sem underscore (não é um identificador composto) também não
    // deve casar — o padrão exige explicitamente ≥2 segmentos unidos por "_".
    const palavraUnica = 'O resultado foi [positivo] para o setor.';
    assert(!matches(palavraUnica), 'colchete com palavra única (sem underscore) não é falso-positivo — padrão exige snake_case composto', palavraUnica);
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S76 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;

}

main().catch((err) => {
    console.error('S76 erro inesperado:', err);
    process.exitCode = 1;
});
