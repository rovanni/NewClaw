/**
 * weather — Previsão do tempo via wttr.in
 * Rápido, sem API key, dados em tempo real.
 */

import { ToolExecutor, ToolResult } from '../loop/AgentLoop';
import { execSync } from 'child_process';

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

    async execute(args: Record<string, any>): Promise<ToolResult> {
        const city = (args.city as string || '').trim();
        const format = (args.format as string) || 'detailed';

        if (!city) {
            return { success: false, output: '', error: 'Cidade não informada.' };
        }

        try {
            let url: string;
            switch (format) {
                case 'simple':
                    url = `https://wttr.in/${encodeURIComponent(city)}?format=3`;
                    break;
                case 'full':
                    url = `https://wttr.in/${encodeURIComponent(city)}`;
                    break;
                case 'detailed':
                default:
                    // Format: cidade + condição + temperatura + vento + umidade
                    url = `https://wttr.in/${encodeURIComponent(city)}?format="%l:+%c+%t+Ventos:+%w+Umidade:+%h"`;
                    break;
            }

            const result = execSync(
                `curl -s --max-time 10 -H "Accept-Language: pt-BR" "${url}"`,
                { timeout: 15000, encoding: 'utf-8' }
            ).trim();

            if (!result || result.includes('Unknown location') || result.includes('ERROR')) {
                // Fallback: try simple format
                const fallback = execSync(
                    `curl -s --max-time 10 "https://wttr.in/${encodeURIComponent(city)}?format=3"`,
                    { timeout: 15000, encoding: 'utf-8' }
                ).trim();

                if (!fallback || fallback.includes('Unknown') || fallback.includes('ERROR')) {
                    return { success: false, output: '', error: `Cidade "${city}" não encontrada no wttr.in.` };
                }

                return { success: true, output: `🌤️ ${fallback}` };
            }

            if (format === 'full') {
                return { success: true, output: `🌤️ Previsão completa para ${city}:\n${result}` };
            }

            return { success: true, output: `🌤️ ${result}` };
        } catch (error: any) {
            return { success: false, output: '', error: `Erro ao buscar clima: ${error.message}` };
        }
    }
}