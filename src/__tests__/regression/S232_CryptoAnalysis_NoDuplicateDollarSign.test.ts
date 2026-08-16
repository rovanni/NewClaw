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
 * Execução: npx ts-node src/__tests__/regression/S232_CryptoAnalysis_NoDuplicateDollarSign.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

const SOURCE = fs.readFileSync(
    path.join(process.cwd(), 'src', 'tools', 'crypto_analysis.ts'), 'utf-8'
);

/** Reprodução exata de `formatCurrency()` — fidelidade garantida por S232-2 sobre o source real. */
function formatCurrency(value: number | null | undefined): string {
    if (!value) return 'N/A';
    if (value >= 1e12) return `$${(value / 1e12).toFixed(2)}T`;
    if (value >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
    if (value >= 1e6) return `$${(value / 1e6).toFixed(2)}M`;
    return `$${value.toLocaleString()}`;
}

console.log('\n=== S232-1 — reprodução do incidente: Market Cap / Volume 24h sem $ duplicado ===');
{
    // Valores reais do incidente (Bitcoin, 14/08/2026): market_cap≈1.26e12, volume≈19.83e9.
    const marketCapUsd = 1_260_000_000_000;
    const volumeUsd = 19_830_000_000;

    const marketCapLine = `Market Cap: ${formatCurrency(marketCapUsd)}`;
    const volumeLine = `Volume 24h: ${formatCurrency(volumeUsd)}`;

    assert(marketCapLine === 'Market Cap: $1.26T', 'Market Cap sem $ duplicado', marketCapLine);
    assert(volumeLine === 'Volume 24h: $19.83B', 'Volume 24h sem $ duplicado', volumeLine);
    assert(!marketCapLine.includes('$$'), 'Market Cap nunca contém "$$"');
    assert(!volumeLine.includes('$$'), 'Volume 24h nunca contém "$$"');
}

console.log('\n=== S232-2 — formatCurrency() continua prefixando $ internamente (contrato preservado) ===');
{
    assert(formatCurrency(1_260_000_000_000) === '$1.26T', 'formatCurrency prefixa $ para valores ≥1e12');
    assert(formatCurrency(19_830_000_000) === '$19.83B', 'formatCurrency prefixa $ para valores ≥1e9');
    assert(formatCurrency(5_000_000) === '$5.00M', 'formatCurrency prefixa $ para valores ≥1e6');
    assert(formatCurrency(0) === 'N/A', 'formatCurrency devolve N/A para valor ausente/zero, sem $ solto');
    assert(formatCurrency(undefined) === 'N/A', 'formatCurrency devolve N/A para undefined, sem $ solto');

    const fnMatch = SOURCE.match(/private formatCurrency\(value: number \| null \| undefined\): string \{[\s\S]*?\n {4}\}/);
    assert(!!fnMatch, 'formatCurrency() localizada no source real');
    assert(!!fnMatch && /return `\$\$\{/.test(fnMatch[0]),
        'formatCurrency() ainda prefixa $ internamente — reprodução acima é fiel ao source');
}

console.log('\n=== S232-3 — os dois call-sites de detail() não prefixam $ externo antes de formatCurrency() ===');
{
    // O bug exato: `$${this.formatCurrency(...)}` (o $ literal ANTES do ${...} soma com o $ que
    // formatCurrency() já devolve). Trava a ausência desse padrão nas duas linhas do incidente.
    assert(
        !/Market Cap: \$\$\{this\.formatCurrency/.test(SOURCE),
        'Market Cap não prefixa $ literal antes de formatCurrency()',
    );
    assert(
        !/Volume 24h: \$\$\{this\.formatCurrency/.test(SOURCE),
        'Volume 24h não prefixa $ literal antes de formatCurrency()',
    );
    assert(
        /Market Cap: \$\{this\.formatCurrency\(md\.market_cap\?\.usd\)\}/.test(SOURCE),
        'Market Cap usa exatamente um $ (o de dentro de formatCurrency)',
    );
    assert(
        /Volume 24h: \$\{this\.formatCurrency\(md\.total_volume\?\.usd\)\}/.test(SOURCE),
        'Volume 24h usa exatamente um $ (o de dentro de formatCurrency)',
    );
}

console.log('\n=== S232-4 — analiseSangrando() (nunca teve o bug) permanece sem regressão ===');
{
    // Estes call-sites (linhas 148-149) NUNCA prefixavam $ externo — é por isso que o bug só
    // aparecia em detail(), não em top100/gainers/losers/sangrando. Guarda contra alguém "corrigir"
    // aqui também e introduzir o bug oposto (perder o $ que só formatCurrency() fornece).
    assert(
        /volume24h: this\.formatCurrency\(volume\)/.test(SOURCE),
        'analiseSangrando() continua chamando formatCurrency() sem prefixo externo',
    );
    assert(
        /marketCap: this\.formatCurrency\(marketCap\)/.test(SOURCE),
        'analiseSangrando() continua chamando formatCurrency() sem prefixo externo (marketCap)',
    );
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S232 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;
