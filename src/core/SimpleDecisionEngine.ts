/**
 * SimpleDecisionEngine — Deterministic intent parser (OpenClaw pattern)
 * 
 * Classification: DIRECT_REPLY | EXECUTE
 * EXECUTE routes to a specific tool based on keywords — NO tool definitions sent to LLM.
 * The backend decides what to run. The LLM only generates text.
 */

export type SimpleDecision = 'EXECUTE' | 'DIRECT_REPLY';

export interface DetectedIntent {
    action: SimpleDecision;
    tool?: string;         // Which tool to run
    params?: Record<string, any>;  // Pre-extracted params
    reason: string;
    taskType: string;
    confidence: number;
}

// Tool routing rules — deterministic, no LLM needed
const TOOL_RULES: Array<{
    tool: string;
    keywords: string[];
    extractParams: (input: string) => Record<string, any>;
}> = [
    {
        tool: 'crypto_report',
        keywords: ['preço', 'valor', 'cotação', 'cotacao', 'quanto custa', 'quanto chega', 'chega em quanto', 'cripto', 'crypto', 'bitcoin', 'btc', 'ethereum', 'eth', 'solana', 'sol', 'cardano', 'ada', 'xrp', 'dogecoin', 'doge', 'preco', 'price', 'market cap', 'river', 'subir', 'caindo', 'subiu', 'caiu', 'alta', 'baixa', 'lucro', 'ganho', 'percentual', 'por cento', '%'],
        extractParams: (input) => ({})
    },
    {
        tool: 'web_search',
        keywords: ['buscar na web', 'pesquisar na internet', 'google', 'procure na web', 'search web', 'notícia sobre', 'noticia sobre', 'o que é', 'o que e', 'quem é', 'quem e', 'onde fica', 'como funciona', 'explique', 'defina', 'o que significa'],
        extractParams: (input) => ({ query: input })
    },
    {
        tool: 'exec_command',
        keywords: ['executar comando', 'rodar comando', 'run command', 'terminal', 'shell', 'bash', 'ssh', 'instalar', 'install', 'pip install', 'npm install', 'apt', 'sudo'],
        extractParams: (input) => ({ command: input })
    },
    {
        tool: 'manage_memory',
        keywords: ['lembrar', 'lembre', 'memorizar', 'memorize', 'guardar', 'guarde', 'salvar na memória', 'salvar na memoria', 'adicionar nó', 'criar nó', 'conectar nó', 'buscar na memória', 'buscar na memoria', 'busca semântica', 'busca semantica', 'busca na memória', 'busca na memoria', 'o que você sabe', 'o que voce sabe', 'você lembra', 'voce lembra', 'pesquisar', 'pesquise', 'pesquisa', 'procura', 'busque', 'busca sobre', 'pesquisa sobre'],
        extractParams: (input) => {
            const lower = input.toLowerCase();
            if (lower.includes('buscar') || lower.includes('busque') || lower.includes('pesquisar') || lower.includes('pesquise') || lower.includes('pesquisa') || lower.includes('procurar') || lower.includes('busca') || lower.includes('search') || lower.includes('lembra') || lower.includes('sabe sobre')) {
                const cleaned = input.replace(/^(pesquise\s*(sobre)?|pesquisar\s*(sobre)?|busque\s*(na\s*memó?ria?)?|buscar\s*(na\s*memó?ria?)?|procurar\s*(na\s*memó?ria?)?|busca\s*(semâ?ntica)?\s*(na\s*memó?ria?)?|search|o\s*que\s*(você|voce)\s*(sabe|lembra)\s*(sobre)?)/i, '').trim();
                return { action: 'search', query: cleaned || input };
            }
            if (lower.includes('conectar') || lower.includes('connect')) {
                return { action: 'connect_nodes' };
            }
            return { action: 'upsert_node' };
        }
    },
    {
        tool: 'write',
        keywords: ['criar arquivo', 'criar página', 'criar site', 'novo arquivo', 'gerar html', 'salvar'],
        extractParams: (input) => {
            return { path: './workspace/tmp/', content: '' };
        }
    },
    {
        tool: 'read',
        keywords: ['listar arquivos', 'ler arquivo', 'ver arquivo', 'mostrar arquivo', 'listar diretório'],
        extractParams: (input) => {
            return { path: './workspace/sites/' };
        }
    },
    {
        tool: 'edit',
        keywords: ['mover arquivo', 'deletar arquivo', 'editar arquivo', 'alterar arquivo', 'substituir'],
        extractParams: (input) => {
            return { path: './workspace/' };
        }
    },
    {
        tool: 'send_audio',
        keywords: ['enviar áudio', 'enviar audio', 'falar', 'tts', 'voice', 'voz', 'ouvir', 'narrar', 'converter em áudio', 'converter em audio'],
        extractParams: (input) => ({ text: input })
    },
];

const SMALL_TALK = /^(oi+|ol[aá]+|opa+|eai+|bom dia|boa tarde|boa noite|tudo bem|blz+|beleza+|tranquilo|obrigado|valeu+|kk+|haha+)\s*[!.?]*$/i;

const DESTRUCTIVE_KEYWORDS = ['rm -rf', 'rm -r', 'del /', 'format', 'formatar', 'drop database', 'drop table', 'delete all', 'truncate', 'sudo rm', 'mkfs'];

export class SimpleDecisionEngine {
    classify(input: string, lastTask?: string): any {
        const normalized = input.toLowerCase().trim();

        // 1. Destructive → EXECUTE with confirmation needed upstream
        if (DESTRUCTIVE_KEYWORDS.some(kw => normalized.includes(kw))) {
            return {
                decision: 'EXECUTE',
                reason: 'destructive_action',
                taskType: 'system_operation',
                confidence: 0.99,
                context: { isContinuation: false, lastTask, hasToolKeywords: true, isDestructive: true }
            };
        }

        // 2. Small talk → DIRECT_REPLY (no tools needed)
        if (SMALL_TALK.test(normalized) || normalized.length <= 3) {
            return {
                decision: 'DIRECT_REPLY',
                reason: 'small_talk',
                taskType: 'conversation',
                confidence: 0.95,
                context: { isContinuation: false, lastTask, hasToolKeywords: false, isDestructive: false }
            };
        }

        // 3. Try to match a specific tool
        for (const rule of TOOL_RULES) {
            if (rule.keywords.some(kw => normalized.includes(kw))) {
                return {
                    decision: 'EXECUTE',
                    reason: 'tool_match',
                    taskType: this.inferTaskType(normalized),
                    confidence: 0.85,
                    context: { isContinuation: false, lastTask, hasToolKeywords: true, isDestructive: false },
                    detectedIntent: {
                        action: 'EXECUTE',
                        tool: rule.tool,
                        params: rule.extractParams(input),
                    }
                };
            }
        }

        // 4. Fallback → DIRECT_REPLY (LLM decides, but without tools)
        return {
            decision: 'DIRECT_REPLY',
            reason: 'no_tool_match',
            taskType: 'conversation',
            confidence: 0.7,
            context: { isContinuation: false, lastTask, hasToolKeywords: false, isDestructive: false }
        };
    }

    private inferTaskType(input: string): string {
        if (/\b(instalar|install|pip|npm|apt)\b/i.test(input)) return 'system_operation';
        if (/\b(áudio|audio|voz|tts)\b/i.test(input)) return 'system_operation';
        if (/\b(criar|create|gerar|gera)\b/i.test(input)) return 'content_generation';
        if (/\b(buscar|search|procurar)\b/i.test(input)) return 'information_request';
        if (/\b(analisar|análise|calcular)\b/i.test(input)) return 'data_analysis';
        return 'system_operation';
    }
}