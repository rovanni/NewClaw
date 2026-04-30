/**
 * crypto_analysis — Análise de criptomoedas: top 100, sangradas, oportunidades
 * Busca dados reais da CoinGecko e identifica:
 * - Moedas em queda (sangrando)
 * - Moedas com potencial de alta (RSI-like, volume vs variação)
 * - Top gainers / losers
 */

import { ToolExecutor, ToolResult } from '../loop/AgentLoop';

interface CacheEntry {
    data: any;
    timestamp: number;
}

const cache = new Map<string, CacheEntry>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

export class CryptoAnalysisTool implements ToolExecutor {
    name = 'crypto_analysis';
    description = 'Ferramenta definitiva para buscar DADOS REAIS e PREÇOS de QUALQUER criptomoeda (mesmo pequenas ou fora do top 100). Traz preço atual, market cap, variações e análise de mercado (sangrando, gainers, losers). USE SEMPRE esta ferramenta no lugar de web_search para pesquisar o valor ou dados de um token crypto!';
    parameters = {
        type: 'object',
        properties: {
            type: {
                type: 'string',
                description: 'Tipo de análise: "sangrando" (em queda com potencial), "gainers" (maiores altas), "losers" (maiores quedas), "top100" (visão geral), "detail" (detalhe de moeda específica)',
                enum: ['sangrando', 'gainers', 'losers', 'top100', 'detail']
            },
            limit: {
                type: 'number',
                description: 'Quantidade de resultados (default 10, max 50)'
            },
            symbol: {
                type: 'string',
                description: 'Símbolo da moeda para análise detail (ex: btc, eth, sol)'
            }
        },
        required: ['type']
    };

    async execute(args: Record<string, any>): Promise<ToolResult> {
        const type = (args.type as string || 'sangrando').toLowerCase();
        const limit = Math.min(args.limit as number || 10, 50);
        const symbol = (args.symbol as string || '').toLowerCase();

        try {
            switch (type) {
                case 'sangrando': return await this.analiseSangrando(limit);
                case 'gainers': return await this.topGainers(limit);
                case 'losers': return await this.topLosers(limit);
                case 'top100': return await this.top100(limit);
                case 'detail': return await this.detail(symbol);
                default: return await this.analiseSangrando(limit);
            }
        } catch (error: any) {
            return { success: false, output: '', error: `Erro na análise: ${error.message}` };
        }
    }

    private async fetchMarkets(perPage: number = 100): Promise<any[]> {
        const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${perPage}&page=1&sparkline=false&price_change_percentage=1h%2C24h%2C7d`;
        
        const cached = cache.get(url);
        if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
            return cached.data;
        }

        let response = await fetch(url);
        if (!response.ok) {
            if (response.status === 429) throw new Error('CoinGecko API limit reached (429)');
            const fallbackUrl = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${perPage}&page=1`;
            response = await fetch(fallbackUrl);
            if (!response.ok) {
                if (response.status === 429) throw new Error('CoinGecko API limit reached (429)');
                throw new Error(`CoinGecko API error: ${response.status}`);
            }
        }
        
        const data = await response.json() as any[];
        cache.set(url, { data, timestamp: Date.now() });
        return data;
    }

    private async analiseSangrando(limit: number): Promise<ToolResult> {
        const coins = await this.fetchMarkets(100);

        // Filtrar: em queda > 3% nas 24h, mas com volume significativo e não estávelcoin
        const opportunities = coins
            .filter((c: any) => {
                const change = c.price_change_percentage_24h || 0;
                const isStablecoin = ['usdt','usdc','dai','busd','tusd','frax','usdd','dai'].includes(c.symbol?.toLowerCase());
                const volumeOk = (c.total_volume || 0) > 1000000; // > $1M volume
                return change < -3 && !isStablecoin && volumeOk;
            })
            .map((c: any) => {
                const change24h = c.price_change_percentage_24h || 0;
                const change7d = c.price_change_percentage_7d_in_currency || 0;
                const change1h = c.price_change_percentage_1h_in_currency || 0;
                const volume = c.total_volume || 0;
                const marketCap = c.market_cap || 0;
                const volToMcap = marketCap > 0 ? volume / marketCap : 0;

                // Score: quanto maior o volume relativo ao mcap + queda, maior a oportunidade
                // Moedas em queda forte mas com volume alto = interesse do mercado
                const recoveryScore = Math.abs(change24h) * volToMcap * 100;

                return {
                    rank: c.market_cap_rank,
                    symbol: c.symbol?.toUpperCase(),
                    name: c.name,
                    price: c.current_price,
                    change24h: change24h.toFixed(2),
                    change7d: change7d.toFixed(2),
                    change1h: change1h?.toFixed(2) || 'N/A',
                    volume24h: this.formatCurrency(volume),
                    marketCap: this.formatCurrency(marketCap),
                    volToMcap: (volToMcap * 100).toFixed(2) + '%',
                    recoveryScore: recoveryScore.toFixed(1),
                    signal: change1h > 0 ? '🟢 RECUPERAÇÃO' : '🔴 AINDA CAINDO'
                };
            })
            .sort((a: any, b: any) => parseFloat(b.recoveryScore) - parseFloat(a.recoveryScore))
            .slice(0, limit);

        if (opportunities.length === 0) {
            return { success: true, output: '📊 Nenhuma moeda do Top 100 com queda > 3% e volume significativo no momento. Mercado estável ou em alta.' };
        }

        let report = `📉 **MOEDAS SANGRANDO — Oportunidades de Compra (Top ${opportunities.length})**\n`;
        report += `_Critério: Queda > 3% em 24h, Volume > $1M, sem stablecoins_\n\n`;

        for (const coin of opportunities) {
            report += `**#${coin.rank} ${coin.symbol}** (${coin.name})\n`;
            report += `   Preço: $${coin.price?.toLocaleString() || 'N/A'} | 24h: ${coin.change24h}% | 7d: ${coin.change7d}%\n`;
            report += `   Vol/MCap: ${coin.volToMcap} | Score: ${coin.recoveryScore} | ${coin.signal}\n\n`;
        }

        report += `\n💡 **Estratégia:** Moedas com Score alto = queda forte com volume alto = possível fundo. `;
        report += `Sinal 🟢 RECUPERAÇÃO = preço já subindo na última hora (possível reversão).`;

        return { success: true, output: report };
    }

    private async topGainers(limit: number): Promise<ToolResult> {
        const coins = await this.fetchMarkets(100);
        const gainers = coins
            .filter((c: any) => !['usdt','usdc','dai','busd'].includes(c.symbol?.toLowerCase()))
            .sort((a: any, b: any) => (b.price_change_percentage_24h || 0) - (a.price_change_percentage_24h || 0))
            .slice(0, limit);

        let report = `📈 **TOP ${limit} GAINERS (24h)**\n\n`;
        for (const c of gainers) {
            const change = (c.price_change_percentage_24h || 0).toFixed(2);
            report += `#${c.market_cap_rank} **${c.symbol?.toUpperCase()}** (${c.name}): $${c.current_price?.toLocaleString()} | +${change}%\n`;
        }
        return { success: true, output: report };
    }

    private async topLosers(limit: number): Promise<ToolResult> {
        const coins = await this.fetchMarkets(100);
        const losers = coins
            .filter((c: any) => !['usdt','usdc','dai','busd'].includes(c.symbol?.toLowerCase()))
            .sort((a: any, b: any) => (a.price_change_percentage_24h || 0) - (b.price_change_percentage_24h || 0))
            .slice(0, limit);

        let report = `📉 **TOP ${limit} LOSERS (24h)**\n\n`;
        for (const c of losers) {
            const change = (c.price_change_percentage_24h || 0).toFixed(2);
            report += `#${c.market_cap_rank} **${c.symbol?.toUpperCase()}** (${c.name}): $${c.current_price?.toLocaleString()} | ${change}%\n`;
        }
        return { success: true, output: report };
    }

    private async top100(limit: number): Promise<ToolResult> {
        const coins = await this.fetchMarkets(limit);
        let report = `📊 **TOP ${limit} CRIPTOMOEDAS**\n\n`;
        for (const c of coins.slice(0, limit)) {
            const change = (c.price_change_percentage_24h || 0).toFixed(2);
            const emoji = parseFloat(change) >= 0 ? '🟢' : '🔴';
            report += `#${c.market_cap_rank} ${emoji} **${c.symbol?.toUpperCase()}**: $${c.current_price?.toLocaleString()} | ${change}%\n`;
        }
        return { success: true, output: report };
    }

    private async detail(symbol: string): Promise<ToolResult> {
        const coinMap: Record<string, string> = {
            'btc': 'bitcoin', 'eth': 'ethereum', 'sol': 'solana', 'ada': 'cardano',
            'xrp': 'ripple', 'doge': 'dogecoin', 'dot': 'polkadot', 'paxg': 'pax-gold',
            'bnb': 'binancecoin', 'avax': 'avalanche-2', 'matic': 'matic-network',
            'link': 'chainlink', 'uni': 'uniswap', 'atom': 'cosmos', 'ltc': 'litecoin',
            'near': 'near', 'arb': 'arbitrum', 'op': 'optimism', 'mkr': 'maker',
        };
        const coinId = coinMap[symbol] || symbol;

        const url = `https://api.coingecko.com/api/v3/coins/${coinId}?localization=false&tickers=false&community_data=false&developer_data=false`;
        
        let data: any;
        const cached = cache.get(url);
        if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
            data = cached.data;
        } else {
            const response = await fetch(url);
            if (!response.ok) {
                if (response.status === 429) return { success: false, output: '', error: 'CoinGecko API limit reached (429)' };
                return { success: false, output: '', error: `Moeda "${symbol}" não encontrada` };
            }
            data = await response.json() as any;
            cache.set(url, { data, timestamp: Date.now() });
        }

        const md = data.market_data;
        let report = `🔍 **${data.name} (${data.symbol?.toUpperCase()})**\n\n`;
        report += `Preço: $${md.current_price?.usd?.toLocaleString()}\n`;
        report += `Market Cap: $${this.formatCurrency(md.market_cap?.usd)}\n`;
        report += `Volume 24h: $${this.formatCurrency(md.total_volume?.usd)}\n\n`;
        report += `Variações:\n`;
        report += `  1h:  ${md.price_change_percentage_1h_in_currency?.usd?.toFixed(2) || 'N/A'}%\n`;
        report += `  24h: ${md.price_change_percentage_24h?.toFixed(2) || 'N/A'}%\n`;
        report += `  7d:  ${md.price_change_percentage_7d?.toFixed(2) || 'N/A'}%\n`;
        report += `  30d: ${md.price_change_percentage_30d?.toFixed(2) || 'N/A'}%\n\n`;
        report += `ATH: $${md.ath?.usd?.toLocaleString() || 'N/A'} (${md.ath_date?.usd ? new Date(md.ath_date.usd).toLocaleDateString('pt-BR') : 'N/A'})\n`;
        report += `ATL: $${md.atl?.usd?.toLocaleString() || 'N/A'}\n`;

        return { success: true, output: report };
    }

    private formatCurrency(value: number | null | undefined): string {
        if (!value) return 'N/A';
        if (value >= 1e12) return `$${(value / 1e12).toFixed(2)}T`;
        if (value >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
        if (value >= 1e6) return `$${(value / 1e6).toFixed(2)}M`;
        return `$${value.toLocaleString()}`;
    }
}