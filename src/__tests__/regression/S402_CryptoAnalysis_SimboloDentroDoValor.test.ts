/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S402
 * crypto_analysis: dado ausente aparece como "N/A" — nunca "$N/A" nem "N/A%".
 *
 * ORIGEM: cosmético registrado na auditoria da suíte (10/10/2026): o relatório de detalhe mostrava "ATH: $N/A (N/A)" para
 * moedas novas sem máximo histórico, e "1h: N/A%" nas variações — o símbolo ficava FORA do valor que podia faltar.
 *
 * REGRESSÃO SE: o relatório voltar a montar "$" ou "%" em volta de "N/A", ou deixar de mostrar o valor quando ele existe.
 *
 * Execução: npx ts-node src/__tests__/regression/S402_CryptoAnalysis_SimboloDentroDoValor.test.ts
 */
import { CryptoAnalysisTool } from '../../tools/crypto_analysis';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}

function moeda(md: Record<string, unknown>) {
    return { id: 'moeda-teste', symbol: 'tst', name: 'Moeda Teste', market_cap_rank: 999, market_data: md };
}

async function detalhe(md: Record<string, unknown>, simbolo: string): Promise<string> {
    const original = global.fetch;
    global.fetch = (async () => ({ ok: true, status: 200, json: async () => moeda(md) })) as unknown as typeof fetch;
    try { return (await new CryptoAnalysisTool().execute({ type: 'detail', symbol: simbolo })).output; }
    finally { global.fetch = original; }
}

async function main(): Promise<void> {
    console.log('\n=== S402-1 — moeda sem ATH/ATL nem variações: "N/A" limpo ===');
    const sem = await detalhe({ current_price: { usd: 1.12 }, market_cap: { usd: 1000 }, total_volume: { usd: 10 } }, 'semdados1');
    assert(!/\$N\/A/.test(sem) && !/N\/A%/.test(sem), 'nenhum "$N/A" nem "N/A%" no relatório', sem);
    assert(/ATH: N\/A\n/.test(sem) && /ATL: N\/A\n/.test(sem), 'ATH e ATL aparecem como "N/A", sem data entre parênteses inventada', sem);
    assert(/1h:\s+N\/A\n/.test(sem), 'variação ausente aparece como "N/A"', sem);

    console.log('\n=== S402-2 — com os dados, os valores aparecem com o símbolo ===');
    const com = await detalhe({
        current_price: { usd: 1.12 }, market_cap: { usd: 1000 }, total_volume: { usd: 10 },
        price_change_percentage_1h_in_currency: { usd: -0.5 }, price_change_percentage_24h: 2.25,
        ath: { usd: 87.73 }, ath_date: { usd: '2025-06-01T00:00:00Z' }, atl: { usd: 1.05 },
    }, 'comdados2');
    // Separador decimal do idioma da máquina ("87.73" ou "87,73") — o teste roda em Windows/Linux/CI com locales diferentes.
    assert(/ATH: \$87[.,]73 \(\d{2}\/\d{2}\/\d{4}\)/.test(com) && /ATL: \$1[.,]05/.test(com), 'ATH com valor e data; ATL com valor', com);
    assert(/1h:\s+-0\.50%/.test(com) && /24h:\s+2\.25%/.test(com), 'variações com "%"', com);

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S402 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    process.exit(failed > 0 ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
