/**
 * weather — Previsão do tempo via open-meteo.com
 * Rápido, sem API key, dados em tempo real, ideal para código aberto.
 */

import { ToolExecutor, ToolResult } from '../loop/AgentLoop';
import { createLogger } from '../shared/AppLogger';
const log = createLogger('WeatherTool');

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

        // Try sources in order: open-meteo → wttr.in → cached
        const sources = [
            { name: 'open-meteo', fn: () => this.fetchOpenMeteo(city, format) },
            { name: 'wttr.in', fn: () => this.fetchWttrIn(city, format) },
        ];

        for (const source of sources) {
            try {
                const result = await source.fn();
                if (result.success) return result;
            } catch (error: any) {
                log.warn(`[WeatherTool] ${source.name} failed for ${city}: ${error.message}`);
            }
        }

        // All sources failed
        return { success: false, output: '', error: `Não foi possível obter a previsão do tempo para "${city}" no momento. Tente novamente em alguns minutos.` };
    }

    /**
     * Primary: Open-Meteo API (no key required, good for coordinates)
     */
    private async fetchOpenMeteo(city: string, format: string): Promise<ToolResult> {
        // 1. Geocoding
        const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=pt`;
        const geoRes = await fetch(geoUrl, { signal: AbortSignal.timeout(10000) });
        if (!geoRes.ok) throw new Error('Falha ao buscar a cidade na API de geocoding.');
        
        const geoData = await geoRes.json() as any;
        if (!geoData.results || geoData.results.length === 0) {
            throw new Error(`Cidade "${city}" não encontrada.`);
        }
        
        const location = geoData.results[0];
        const lat = location.latitude;
        const lon = location.longitude;
        
        const adminPart = location.admin1 ? `${location.admin1} - ` : '';
        const countryPart = location.country || '';
        const cityName = `${location.name}, ${adminPart}${countryPart}`.replace(/,\s*$/, '');

        // 2. Weather (current + daily forecast for tomorrow)
        const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=2`;
        const weatherRes = await fetch(weatherUrl, { signal: AbortSignal.timeout(10000) });
        if (!weatherRes.ok) throw new Error('Falha ao buscar o clima na API do open-meteo.');

        const weatherData = await weatherRes.json() as any;
        const current = weatherData.current;
        const units = weatherData.current_units;
        const daily = weatherData.daily;

        const desc = this.getWeatherDescription(current.weather_code);
        const temp = `${current.temperature_2m}${units.temperature_2m}`;
        const feelsLike = `${current.apparent_temperature}${units.apparent_temperature}`;
        const wind = `${current.wind_speed_10m}${units.wind_speed_10m}`;
        const humidity = `${current.relative_humidity_2m}${units.relative_humidity_2m}`;
        const precip = `${current.precipitation}${units.precipitation}`;

        // Build tomorrow forecast if available
        let tomorrowForecast = '';
        if (daily && daily.time && daily.time.length > 1) {
            const tomorrowDate = daily.time[1];
            const tomorrowCode = daily.weather_code?.[1];
            const tomorrowMax = daily.temperature_2m_max?.[1];
            const tomorrowMin = daily.temperature_2m_min?.[1];
            const tomorrowPrecip = daily.precipitation_probability_max?.[1];
            if (tomorrowCode !== undefined) {
                const tomorrowDesc = this.getWeatherDescription(tomorrowCode);
                tomorrowForecast = `\nAmanhã (${tomorrowDate}): ${tomorrowDesc}`;
                if (tomorrowMin !== undefined && tomorrowMax !== undefined) tomorrowForecast += `, ${tomorrowMin}°C–${tomorrowMax}°C`;
                if (tomorrowPrecip !== undefined) tomorrowForecast += `, chuva ${tomorrowPrecip}%`;
            }
        }

        let output = '';
        switch (format) {
            case 'simple':
                output = `${cityName}: ${desc}, ${temp}${tomorrowForecast ? ' | ' + tomorrowForecast.trim() : ''}`;
                break;
            case 'full':
                output = `Previsão completa para ${cityName}:\nCondição: ${desc}\nTemperatura: ${temp} (Sensação de ${feelsLike})\nVento: ${wind}\nUmidade: ${humidity}\nPrecipitação: ${precip}${tomorrowForecast}`;
                break;
            case 'detailed':
            default:
                output = `${cityName}: ${desc} | Temp: ${temp} | Vento: ${wind} | Umidade: ${humidity}${tomorrowForecast}`;
                break;
        }

        return { success: true, output };
    }

    /**
     * Fallback: wttr.in (simple format, no key required)
     */
    private async fetchWttrIn(city: string, format: string): Promise<ToolResult> {
        // wttr.in supports JSON format
        const url = `https://wttr.in/${encodeURIComponent(city)}?format=j1`;
        const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
        if (!res.ok) throw new Error(`wttr.in falhou: ${res.status}`);

        const data = await res.json() as any;
        const current = data?.current_condition?.[0];
        if (!current) throw new Error('wttr.in: sem dados de clima atual');

        const temp = `${current.temp_C}°C`;
        const feelsLike = `${current.FeelsLikeC}°C`;
        const humidity = `${current.humidity}%`;
        const wind = `${current.windspeedKmph} km/h`;
        const desc = current.lang_pt?.[0]?.value || current.weatherDesc?.[0]?.value || 'Indisponível';

        // Tomorrow forecast from wttr.in
        const tomorrow = data?.weather?.[1];
        let tomorrowForecast = '';
        if (tomorrow) {
            const tMax = tomorrow.maxtempC;
            const tMin = tomorrow.mintempC;
            const tDesc = tomorrow.hourly?.[4]?.lang_pt?.[0]?.value || tomorrow.hourly?.[4]?.weatherDesc?.[0]?.value || '';
            tomorrowForecast = `\nAmanhã: ${tDesc}, ${tMin}°C–${tMax}°C`;
        }

        let output = '';
        switch (format) {
            case 'simple':
                output = `${city}: ${desc}, ${temp}${tomorrowForecast ? ' | ' + tomorrowForecast.trim() : ''}`;
                break;
            case 'full':
                output = `Previsão completa para ${city}:\nCondição: ${desc}\nTemperatura: ${temp} (Sensação de ${feelsLike})\nVento: ${wind}\nUmidade: ${humidity}${tomorrowForecast}`;
                break;
            case 'detailed':
            default:
                output = `${city}: ${desc} | Temp: ${temp} | Vento: ${wind} | Umidade: ${humidity}${tomorrowForecast}`;
                break;
        }

        return { success: true, output };
    }
}