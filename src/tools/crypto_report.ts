/**
 * crypto_report — Relatório de criptomoedas via CoinGecko API
 */

import { ToolExecutor, ToolResult } from '../loop/AgentLoop';

interface CacheEntry {
    data: any;
    timestamp: number;
}

const cache = new Map<string, CacheEntry>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

const COINGECKO_IDS: Record<string, string> = {
    'btc': 'bitcoin',
    'bitcoin': 'bitcoin',
    'eth': 'ethereum',
    'ethereum': 'ethereum',
    'sol': 'solana',
    'solana': 'solana',
    'paxg': 'pax-gold',
    'pax gold': 'pax-gold',
    'river': 'river',
    'ada': 'cardano',
    'cardano': 'cardano',
    'xrp': 'ripple',
    'ripple': 'ripple',
    'doge': 'dogecoin',
    'dogecoin': 'dogecoin',
    'dot': 'polkadot',
    'polkadot': 'polkadot',
};

export class CryptoReportTool implements ToolExecutor {
    name = 'crypto_report';
    description = 'Busca preço e variação de criptomoedas (BTC, ETH, SOL, PAXG, RIVER, etc.)';
    parameters = {
        type: 'object',
        properties: {
            symbol: { type: 'string', description: 'Símbolo da criptomoeda (btc, eth, sol, paxg, river)' }
        },
        required: ['symbol']
    };

    async execute(args: Record<string, any>): Promise<ToolResult> {
        const symbol = (args.symbol as string || '').toLowerCase().trim();
        const coinId = COINGECKO_IDS[symbol];

        if (!coinId) {
            const available = Object.keys(COINGECKO_IDS).filter(k => !k.includes(' ')).join(', ');
            return { success: false, output: '', error: `Moeda não suportada. Disponíveis: ${available}` };
        }

        try {
            const url = `https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=usd,brl&include_24hr_change=true&include_market_cap=true&include_24hr_vol=true`;
            
            let data: any;
            const cached = cache.get(url);
            if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
                data = cached.data;
            } else {
                const response = await fetch(url);
                if (!response.ok) {
                    if (response.status === 429) {
                        return { success: false, output: '', error: `CoinGecko API limit reached (429). Please try again later.` };
                    }
                    return { success: false, output: '', error: `CoinGecko API error: ${response.status}` };
                }
                data = await response.json() as any;
                cache.set(url, { data, timestamp: Date.now() });
            }

            const coin = data[coinId];

            if (!coin) {
                return { success: false, output: '', error: 'Dados não encontrados' };
            }

            const usd = coin.usd ? `$${coin.usd.toLocaleString()}` : 'N/A';
            const brl = coin.brl ? `R$${coin.brl.toLocaleString()}` : 'N/A';
            const change24h = coin.usd_24h_change ? `${coin.usd_24h_change >= 0 ? '+' : ''}${coin.usd_24h_change.toFixed(2)}%` : 'N/A';
            const marketCap = coin.usd_market_cap ? `$${(coin.usd_market_cap / 1e9).toFixed(2)}B` : 'N/A';
            const vol24h = coin.usd_24h_vol ? `$${(coin.usd_24h_vol / 1e6).toFixed(2)}M` : 'N/A';

            const report = `${symbol.toUpperCase()}: ${usd} | ${brl} | 24h: ${change24h} | Cap: ${marketCap} | Vol: ${vol24h}`;

            return { success: true, output: report };
        } catch (error: any) {
            return { success: false, output: '', error: error.message };
        }
    }
}