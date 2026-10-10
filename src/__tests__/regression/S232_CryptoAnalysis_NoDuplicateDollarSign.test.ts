/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S232
 * `crypto_analysis` (comando `detail`, usado por perguntas como "cotação do Bitcoin agora") não
 * duplica o símbolo de moeda em Market Cap / Volume 24h.
 *
 * INCIDENTE REAL (14/08/2026, logs/newclaw-audit.log, goal_1786759359533_um60t —
 * "Qual a cotação do Bitcoin agora?"): a resposta entregue ao usuário trazia
 *
 *     Market Cap: $$1.26T
 *     Volume 24h: $$19.83B
 *
 * CAUSA: `formatCurrency()` (crypto_analysis.ts) já prefixa `$` internamente ao formatar valores
 * ≥ 1e6 — mas os dois call-sites de `detail()` (a única rota que responde "cotação de X agora")
 * prefixavam OUTRO `$` literal antes de chamar `formatCurrency()`. Bug puramente determinístico de
 * formatação de string — nenhuma interpretação semântica envolvida (RESPONSABILIDADE_ANTES_DO_
 * MECANISMO não se aplica; é forma verificável, não significado). `analiseSangrando()` chama
 * `formatCurrency()` sem duplicar (linhas 148-149) — só `detail()` tinha a duplicação, por isso o
 * bug só aparecia em "cotação/detalhe de UMA moeda", não nos relatórios de top100/gainers/losers.
 *
 * REGRESSÃO SE: `detail()` voltar a prefixar `$` antes de `formatCurrency()`, ou se
 * `formatCurrency()` deixar de prefixar `$` internamente (quebraria os outros call-sites que já
 * dependem disso sem prefixo externo).
 *
 *
 * Auditoria da suíte (10/10/2026): a parte "comportamental" deste teste nunca executava o `detail()` — formatava com uma CÓPIA de
 * `formatCurrency()` e concatenava dentro do próprio teste; passaria mesmo se a produção voltasse a duplicar o "$". Agora o caminho
 * PÚBLICO real (`CryptoAnalysisTool.execute({ type: 'detail' })`) roda sobre uma resposta simulada da CoinGecko (`fetch` trocado, sem
 * rede), e a saída entregue ao usuário é conferida. O guarda estático que sobra (S232-2) cobre o único caso que a saída não mostra.
 *
 * Execução: npx ts-node src/__tests__/regression/S232_CryptoAnalysis_NoDuplicateDollarSign.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { CryptoAnalysisTool } from '../../tools/crypto_analysis';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

const SOURCE = fs.readFileSync(
    path.join(process.cwd(), 'src', 'tools', 'crypto_analysis.ts'), 'utf-8'
);

/** Troca o `fetch` global por respostas fixas da CoinGecko, por id de moeda. Cada cenário usa um id próprio (o cache da ferramenta é por URL). */
function simularCoinGecko(moedas: Record<string, { name: string; symbol: string; market_data?: Record<string, unknown> }>): void {
    (globalThis as { fetch: unknown }).fetch = async (url: string) => {
        const id = /\/coins\/([^?/]+)\?/.exec(String(url))?.[1] ?? '';
        const corpo = moedas[id];
        if (!corpo) return { ok: false, status: 404, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => corpo };
    };
}

async function detalhe(id: string): Promise<string> {
    const r = await new CryptoAnalysisTool().execute({ type: 'detail', symbol: id });
    if (!r.success) throw new Error(`detail falhou: ${r.error}`);
    return r.output;
}

async function main(): Promise<void> {
    const fetchOriginal = (globalThis as { fetch: unknown }).fetch;
    try {
        simularCoinGecko({
            'moeda-grande': { name: 'Moeda Grande', symbol: 'mg', market_data: { current_price: { usd: 98765 }, market_cap: { usd: 1_260_000_000_000 }, total_volume: { usd: 19_830_000_000 } } },
            'moeda-media': { name: 'Moeda Media', symbol: 'mm', market_data: { current_price: { usd: 2 }, market_cap: { usd: 5_000_000 }, total_volume: { usd: 1_500_000_000 } } },
            'moeda-vazia': { name: 'Moeda Vazia', symbol: 'mv', market_data: { current_price: { usd: 1 }, market_cap: { usd: 0 } } },
        });

        console.log('\n=== S232-1 — o detail() REAL, sobre os valores do incidente (Bitcoin, 14/08/2026): sem $ duplicado ===');
        {
            // Valores reais do incidente: market_cap≈1.26e12, volume≈19.83e9.
            const saida = await detalhe('moeda-grande');
            assert(saida.includes('Market Cap: $1.26T'), 'Market Cap sai com exatamente um $ ("$1.26T")', saida.split('\n').find(l => l.startsWith('Market Cap')));
            assert(saida.includes('Volume 24h: $19.83B'), 'Volume 24h sai com exatamente um $ ("$19.83B")', saida.split('\n').find(l => l.startsWith('Volume 24h')));
            assert(!saida.includes('$$'), 'a saída entregue ao usuário nunca contém "$$"');
        }

        console.log('\n=== S232-2 — o contrato de formatCurrency() visto pela saída real: escala, e "N/A" sem $ solto ===');
        {
            const media = await detalhe('moeda-media');
            assert(media.includes('Market Cap: $5.00M'), 'valor na casa dos milhões: "$5.00M"', media.split('\n').find(l => l.startsWith('Market Cap')));
            assert(media.includes('Volume 24h: $1.50B'), 'valor na casa dos bilhões: "$1.50B"', media.split('\n').find(l => l.startsWith('Volume 24h')));
            const vazia = await detalhe('moeda-vazia');
            assert(vazia.includes('Market Cap: N/A') && vazia.includes('Volume 24h: N/A'), 'valor zero/ausente vira "N/A", sem $ solto', vazia.split('\n').filter(l => /Market Cap|Volume/.test(l)));
            // Só as duas linhas deste contrato: o relatório inteiro tem "ATH: $N/A" / "ATL: $N/A" quando faltam dados (achado da auditoria,
            // fora do escopo deste teste — registrado na auditoria da suíte, sem mexer na produção aqui).
            assert(!vazia.split('\n').filter(l => /^(Market Cap|Volume 24h):/.test(l)).some(l => /\$N\/A/.test(l)), 'nas linhas de Market Cap e Volume nunca "$N/A"');
        }

        console.log('\n=== S232-3 — o guarda ESTÁTICO que sobra: analiseSangrando() (nunca teve o bug) não ganha prefixo externo ===');
        {
            // Esses valores formatados são calculados em analiseSangrando() mas NÃO aparecem no relatório — não há saída para observar;
            // por isso o único mecanismo possível é estático. Guarda contra alguém "corrigir" aqui e introduzir o bug oposto
            // (perder o $ que só formatCurrency() fornece).
            assert(/volume24h: this\.formatCurrency\(volume\)/.test(SOURCE), 'analiseSangrando() continua chamando formatCurrency() sem prefixo externo');
            assert(/marketCap: this\.formatCurrency\(marketCap\)/.test(SOURCE), 'analiseSangrando() continua chamando formatCurrency() sem prefixo externo (marketCap)');
        }
    } finally {
        (globalThis as { fetch: unknown }).fetch = fetchOriginal;
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S232 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    if (failed > 0) process.exitCode = 1;
}

main().catch(e => { console.error(e); process.exit(1); });
