/**
 * weather — Previsão do tempo via open-meteo.com
 * Rápido, sem API key, dados em tempo real, ideal para código aberto.
 */

import { ToolExecutor, ToolResult } from '../loop/AgentLoop';

export class WeatherTool implements ToolExecutor {
    name = 'weather';
    description = 'Obtém a previsão do tempo atual para qualquer cidade. Use quando o usuário perguntar sobre clima, temperatura, chuva, ou previsão do tempo. Sempre use esta ferramenta para clima — NÃO use web_search para isso.';
    parameters = {
        type: 'object',
        properties: {
            city: { type: 'string', description: 'Nome da cidade (ex: Cornélio Procópio, São Paulo)' },
            format: { type: 'string', enum: ['simple', 'detailed', 'full'], description: 'Nível de detalhe: simple (1 linha), detailed (resumo), full (completo). Padrão: detailed' }
        },
        required: ['city']
    };

    private getWeatherDescription(code: number): string {
        // WMO Weather interpretation codes (WW)
        const codes: Record<number, string> = {
            0: 'Céu limpo ☀️',
            1: 'Principalmente claro 🌤️',
            2: 'Parcialmente nublado ⛅',
            3: 'Nublado ☁️',
            45: 'Nevoeiro 🌫️',
            48: 'Nevoeiro com geada 🌫️❄️',
            51: 'Chuvisco leve 🌧️',
            53: 'Chuvisco moderado 🌧️',
            55: 'Chuvisco denso 🌧️',
            56: 'Chuvisco congelante leve 🌧️❄️',
            57: 'Chuvisco congelante denso 🌧️❄️',
            61: 'Chuva leve ☔',
            63: 'Chuva moderada ☔',
            65: 'Chuva forte ☔',
            66: 'Chuva congelante leve ☔❄️',
            67: 'Chuva congelante forte ☔❄️',
            71: 'Queda de neve leve 🌨️',
            73: 'Queda de neve moderada 🌨️',
            75: 'Queda de neve forte 🌨️',
            77: 'Grãos de neve 🌨️',
            80: 'Pancadas de chuva leves 🌦️',
            81: 'Pancadas de chuva moderadas 🌦️',
            82: 'Pancadas de chuva violentas ⛈️',
            85: 'Pancadas de neve leves 🌨️',
            86: 'Pancadas de neve fortes 🌨️',
            95: 'Trovoada leve ou moderada 🌩️',
            96: 'Trovoada com granizo leve ⛈️❄️',
            99: 'Trovoada com granizo forte ⛈️❄️'
        };
        return codes[code] || 'Desconhecido ❓';
    }

    async execute(args: Record<string, any>): Promise<ToolResult> {
        const city = (args.city as string || '').trim();
        const format = (args.format as string) || 'detailed';

        if (!city) {
            return { success: false, output: '', error: 'Cidade não informada.' };
        }

        try {
            // 1. Geocoding
            const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=pt`;
            const geoRes = await fetch(geoUrl, { signal: AbortSignal.timeout(10000) });
            if (!geoRes.ok) throw new Error('Falha ao buscar a cidade na API de geocoding.');
            
            const geoData = await geoRes.json() as any;
            if (!geoData.results || geoData.results.length === 0) {
                return { success: false, output: '', error: `Cidade "${city}" não encontrada.` };
            }
            
            const location = geoData.results[0];
            const lat = location.latitude;
            const lon = location.longitude;
            
            const adminPart = location.admin1 ? `${location.admin1} - ` : '';
            const countryPart = location.country || '';
            const cityName = `${location.name}, ${adminPart}${countryPart}`.replace(/,\s*$/, '');

            // 2. Weather
            const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m&timezone=auto`;
            const weatherRes = await fetch(weatherUrl, { signal: AbortSignal.timeout(10000) });
            if (!weatherRes.ok) throw new Error('Falha ao buscar o clima na API do open-meteo.');

            const weatherData = await weatherRes.json() as any;
            const current = weatherData.current;
            const units = weatherData.current_units;

            const desc = this.getWeatherDescription(current.weather_code);
            const temp = `${current.temperature_2m}${units.temperature_2m}`;
            const feelsLike = `${current.apparent_temperature}${units.apparent_temperature}`;
            const wind = `${current.wind_speed_10m}${units.wind_speed_10m}`;
            const humidity = `${current.relative_humidity_2m}${units.relative_humidity_2m}`;
            const precip = `${current.precipitation}${units.precipitation}`;

            let output = '';
            switch (format) {
                case 'simple':
                    output = `${cityName}: ${desc}, ${temp}`;
                    break;
                case 'full':
                    output = `Previsão completa para ${cityName}:\nCondição: ${desc}\nTemperatura: ${temp} (Sensação de ${feelsLike})\nVento: ${wind}\nUmidade: ${humidity}\nPrecipitação: ${precip}`;
                    break;
                case 'detailed':
                default:
                    output = `${cityName}: ${desc} | Temp: ${temp} | Vento: ${wind} | Umidade: ${humidity}`;
                    break;
            }

            return { success: true, output };
        } catch (error: any) {
            return { success: false, output: '', error: `Erro ao buscar clima: ${error.message}` };
        }
    }
}