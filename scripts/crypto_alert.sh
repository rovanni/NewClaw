#!/bin/bash
# crypto_alert.sh — Envia alerta de criptomoedas 3x ao dia
# Horários: 09:00, 14:00, 20:00 (America/Sao_Paulo)
# Executado via crontab do venus

BOT_TOKEN="REPLACE_ME_WITH_YOUR_TELEGRAM_BOT_TOKEN"
CHAT_ID="REPLACE_ME_WITH_YOUR_TELEGRAM_CHAT_ID"

# Buscar preços via CoinGecko
PRICES=$(curl -s "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana,river&vs_currencies=usd,brl&include_24hr_change=true" 2>/dev/null)

if [ -z "$PRICES" ]; then
    echo "Erro: CoinGecko API sem resposta"
    exit 1
fi

# Parse com python3
MESSAGE=$(echo "$PRICES" | python3 -c "
import sys, json

data = json.load(sys.stdin)

coins = {
    'bitcoin': 'BTC',
    'ethereum': 'ETH', 
    'solana': 'SOL',
    'river': 'RIVER'
}

emoji_up = '📈'
emoji_down = '📉'

lines = ['📊 Cotação Cripto:']
lines.append('')

for coin_id, symbol in coins.items():
    if coin_id in data:
        info = data[coin_id]
        usd = info.get('usd', 0)
        brl = info.get('brl', 0)
        change = info.get('usd_24h_change', 0)
        
        emoji = emoji_up if change >= 0 else emoji_down
        sign = '+' if change >= 0 else ''
        
        if coin_id == 'river':
            lines.append(f'{emoji} {symbol}: R$ {brl:.2f} (US$ {usd:.4f}) {sign}{change:.1f}%')
        else:
            if brl >= 1000:
                lines.append(f'{emoji} {symbol}: R$ {brl:,.0f} (US$ {usd:,.0f}) {sign}{change:.1f}%')
            else:
                lines.append(f'{emoji} {symbol}: R$ {brl:.2f} (US$ {usd:.2f}) {sign}{change:.1f}%')

lines.append('')


print('\n'.join(lines))
" 2>/dev/null)

if [ -z "$MESSAGE" ]; then
    echo "Erro ao parsear preços"
    exit 1
fi

# Enviar via Telegram
curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
    -d chat_id="${CHAT_ID}" \
    -d text="${MESSAGE}" \
    -d parse_mode="HTML" 2>/dev/null

echo "Alerta enviado: $(date)"