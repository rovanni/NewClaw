import { ToolExecutor, ToolResult } from '../loop/AgentLoop';

export class ApiRequestTool implements ToolExecutor {
    name = 'api_request';
    description = 'Faz chamadas HTTP genéricas para APIs externas, webhooks ou serviços gRPC/REST, além do backend local (http://localhost:3090/api/memory...).';
    parameters = {
        type: 'object',
        properties: {
            method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE'], description: 'Método HTTP' },
            url: { type: 'string', description: 'URL completa do endpoint (ex: https://api.github.com/... ou http://localhost:3090/api/...)' },
            body: { type: 'string', description: 'String JSON com os dados do corpo (Apenas para POST/PUT)' },
            headers: { type: 'string', description: 'Headers opcionais em formato JSON (string) caso precise passar autenticação (Bearer Token, Auth)' }
        },
        required: ['method', 'url']
    };

    async execute(args: Record<string, any>): Promise<ToolResult> {
        try {
            const method = args.method?.toUpperCase() || 'GET';
            let url = args.url || args.endpoint || '';
            if (!url) return { success: false, output: '', error: 'URL não fornecida.' };

            // Trata chamadas em legado para o backend local se o modelo omitir o hostname
            if (url.startsWith('/')) {
                url = `http://localhost:3090${url}`;
            }

            const options: RequestInit = {
                method,
                headers: { 'Content-Type': 'application/json' }
            };

            if (args.headers) {
                try {
                    const extraHeaders = typeof args.headers === 'string' ? JSON.parse(args.headers) : args.headers;
                    options.headers = { ...options.headers, ...extraHeaders };
                } catch { /* ignorar warn error parse headers */ }
            }

            if (args.body && (method === 'POST' || method === 'PUT')) {
                options.body = typeof args.body === 'string' ? args.body : JSON.stringify(args.body);
            }

            const res = await fetch(url, options);
            const data = await res.text();

            if (!res.ok) {
                return {
                    success: false,
                    output: '',
                    error: `HTTP Error ${res.status}: ${data}`
                };
            }

            return {
                success: true,
                output: data,
            };
        } catch (error: any) {
            return {
                success: false,
                output: '',
                error: `Network Error: ${error.message}`
            };
        }
    }
}
