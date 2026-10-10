/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S362 (Sprint V6 do princípio "Informação Completa para Decidir", 08/10/2026)
 *
 * O validador de qualidade ("a resposta atende o pedido?") recebia só a ÚLTIMA ferramenta do turno e o pedido cortado
 * em 500 caracteres. Num turno com várias ferramentas, julgava se a resposta atendia sem ver o que as outras
 * devolveram — e a pergunta é sobre o pedido, que chegava pela metade.
 *
 * REGRESSÃO SE: o julgamento voltar a ver só a última ferramenta, o pedido voltar a ser cortado, ou um prompt acima do
 * teto ser julgado em vez de "não avaliável".
 *
 * Execução: npx ts-node src/__tests__/regression/S362_QualityValidatorSeesAllTurnTools.test.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { ObserverValidator } from '../../loop/ObserverValidator';
import { DECISION_PROMPT_MAX_CHARS } from '../../core/providerTypes';
import './_fixtures/motorLegado';   // juízes simulados no formato antigo → formato do motor único (ADR-014)

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}
const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
    const orig = process.stdout.write.bind(process.stdout);
    (process.stdout.write as unknown) = (): boolean => true;
    try { return await fn(); } finally { process.stdout.write = orig; }
};
function validador(prompts: string[]) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getBudgetAuxiliar } = require('../../shared/auxTimeout');
    const f = {
        chatWithFallback: async (msgs: Array<{ content: string }>) => { prompts.push(msgs[msgs.length - 1].content); return { status: 'success', content: '{"approved": true, "reason": "ok", "confidence": 0.9}', attempts: [] }; },
        getBudgetAuxiliar: (p: 'classificacao' | 'validacao') => getBudgetAuxiliar(p, null, null),
    } as any;
    return new ObserverValidator(f, 'm');
}

const PEDIDO = 'Busque a cotação do bitcoin e a previsão do tempo em Curitiba, e no final me diga se vale levar guarda-chuva. '.repeat(6);
const TURNO = [
    { tool: 'crypto_analysis', output: 'BTC/USD preço atual: 64231.55 USD — RESULTADO_DA_PRIMEIRA_FERRAMENTA' },
    { tool: 'weather', output: 'Curitiba: 18.4 °C, chuva 80% — RESULTADO_DA_SEGUNDA_FERRAMENTA' },
];
const RESPOSTA = 'O bitcoin está a 64,2 mil dólares. Em Curitiba faz 18 °C com 80% de chance de chuva: leve guarda-chuva.';

async function main(): Promise<void> {
    console.log('\n=== S362-1 — o julgamento de qualidade vê todas as ferramentas do turno e o pedido íntegro ===');
    const prompts: string[] = [];
    // weather/crypto teriam atalho determinístico (KNOWN_GOOD_TOOLS) — usa uma ferramenta sem atalho como "última".
    const ultima = { tool: 'edit', output: 'Conteúdo adicionado: resumo.md' };
    await quiet(() => validador(prompts).validateResponseCommit(PEDIDO, ultima.tool, ultima.output, RESPOSTA, undefined, [...TURNO, ultima]));
    const p = prompts[0] ?? '';
    assert(prompts.length === 1, 'o julgamento por LLM foi feito');
    assert(p.includes('RESULTADO_DA_PRIMEIRA_FERRAMENTA') && p.includes('RESULTADO_DA_SEGUNDA_FERRAMENTA'), 'os resultados das ferramentas ANTERIORES chegam ao validador (antes: só a última)');
    assert(/ferramenta=crypto_analysis/.test(p) && /ferramenta=weather/.test(p) && /ferramenta=edit/.test(p), 'a lista de ferramentas do turno está no prompt (uma seção por ferramenta)');
    assert(p.includes(PEDIDO), `pedido íntegro (${PEDIDO.length} chars; antes: 500)`);

    console.log('\n=== S362-2 — sem a lista do turno, comportamento anterior (só a última) ===');
    const p2: string[] = [];
    await quiet(() => validador(p2).validateResponseCommit(PEDIDO, ultima.tool, ultima.output, RESPOSTA));
    assert((p2[0] ?? '').includes('Conteúdo adicionado: resumo.md') && !(p2[0] ?? '').includes('RESULTADO_DA_PRIMEIRA'), 'sem ferramentasDoTurno, usa a última');

    console.log('\n=== S362-3 — acima do teto: não avaliável, sem chamar o LLM ===');
    const p3: string[] = [];
    const r = await quiet(() => validador(p3).validateResponseCommit('x'.repeat(DECISION_PROMPT_MAX_CHARS), ultima.tool, ultima.output, RESPOSTA));
    assert(p3.length === 0 && r.valid === true && r.blocked === false, 'o LLM não é chamado e nada é bloqueado (o validador de qualidade só aconselha)');

    console.log('\n=== S362-4 — o AgentLoop passa as ferramentas do turno ===');
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'loop', 'AgentLoop.ts'), 'utf-8');
    assert(/validateResponseCommit\([\s\S]{0,400}AgentLoop\.evidencesFromTrace\(trace\)\.map\(e => \(\{ tool: e\.tool, (input: descreverArgumentos\(e\.input\), )?output: e\.output \}\)\)/.test(src), 'validateResponseCommit recebe evidencesFromTrace(trace)');

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S362 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    if (failed > 0) process.exitCode = 1;
}
main().catch((err) => { console.error('S362 erro inesperado:', err); process.exitCode = 1; });
