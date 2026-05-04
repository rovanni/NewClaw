/**
 * Intent Router — Deterministic + LLM fallback
 */

export interface RouteResult {
    action: 'tool' | 'llm' | 'compound' | 'audio_request';
    tool?: string;
    params?: Record<string, any>;
    dataTool?: string;
    dataParams?: Record<string, any>;
    audioText?: string;
}

export function routeIntent(text: string): RouteResult {
    const lower = text.toLowerCase().trim();

    // ── Small talk
    if (/^(oi+|ol[aá]+|opa+|eai+|bom dia|boa tarde|boa noite|tudo bem|blz|beleza|tranquilo|valeu|kk|haha+)\s*[!.?]*$/i.test(lower) || lower.length <= 3) {
        return { action: 'llm' };
    }

    // ── Audio/TTS request — only when user explicitly requests audio
    const audioRequestPattern = /^(por favor\s*)?(me\s*)?(gerar?\s*(um|uma)?\s*(áudio|audio|voz)|criar?\s*(um|uma)?\s*(áudio|audio|voz)|envi[ae]r?\s*(um|uma)?\s*(áudio|audio|voz)|mand[ae]r?\s*(um|uma)?\s*(áudio|audio|voz)|falar?\s*(em)?\s*voz|narre|narrar|tts)/i;
    if (audioRequestPattern.test(lower)) {
        // Extract what they want to hear (not the command itself)
        let topic = text
            .replace(/^(por favor\s*)?(me\s*)?(gere|gerar|gera|cria|criar|envia|enviar|envie|manda|mandar|mande|fale|falar|narre|narrar)\s*(um|uma)?\s*(áudio|audio|voz|som)?\s*(sobre|com|do|da|de|para)?\s*/i, '')
            .trim();
        
        // Check if topic needs live data
        const needsData = /(valor|pre[cç]o|cota[cç][aã]o|quanto|bitcoin|btc|ethereum|eth|solana|sol|cardano|ada|xrp|dogecoin|doge|river|cripto|crypto|clima|tempo|temperatura)/i.test(topic);

        if (needsData) {
            return { action: 'compound', dataTool: 'web_search', dataParams: { query: topic }, tool: 'send_audio', audioText: topic };
        }

        // Send topic to LLM to generate real TTS content
        return { action: 'audio_request', audioText: topic || 'apresentação' };
    }

    // ── Memory write
    if (/(guarde|salve|lembre|lembrete|memorize|anote|registre|adicionar|adiciona|guarda)\b/i.test(lower)) {
        return { action: 'tool', tool: 'memory_write', params: { action: 'create', id: `fact_${Date.now()}`, type: 'fact', name: text.slice(0, 50), content: text } };
    }

    // ── Memory search
    if (/(o que (você|voce) sabe|lembra|buscar na mem[óo]ria|pesquisar|pesquise|busque|procurar|busca (sem[aâ]ntica|na mem|sobre))/i.test(lower)) {
        const query = text.replace(/^(o que (você|voce) (sabe|lembra)( sobre)?|buscar na mem[óo]ria|pesquisar|pesquise|procurar|busque|busca\s*(sem[aâ]ntica|na mem[oó]ria)?\s*(sobre)?)/i, '').trim() || text;
        return { action: 'tool', tool: 'memory_search', params: { query } };
    }

    // ── Crypto (clean query)
    if (/(pre[cç]o|cota[cç][aã]o|quanto (custa|est[aá]|chega|vale)|bitcoin|btc|ethereum|eth\b|solana|sol\b|cardano|ada\b|xrp|dogecoin|doge|river|cripto|crypto|market cap|tend[eê]ncia|alta|baixa|subir|caiu|subiu)/i.test(lower)) {
        const cleanQuery = text.replace(/^(e\s+)?(a\s+)?(qual|[eé]\s+)?/i, '').trim();
        return { action: 'tool', tool: 'web_search', params: { query: cleanQuery } };
    }

    // ── Web search
    if (/(buscar na web|pesquisar na internet|google|procure na web|not[ií]cia|search web|o que [eé]|quem [eé]|como funciona|onde fica|explique|defina)/i.test(lower)) {
        return { action: 'tool', tool: 'web_search', params: { query: text } };
    }

    // ── Shell commands
    if (/(executar comando|rodar comando|run command|terminal|shell|bash|instalar|pip install|npm install|apt)/i.test(lower)) {
        return { action: 'tool', tool: 'exec_command', params: { command: text } };
    }

    // ── File operations (create, read, edit — split tools like OpenClaw)
    if (/(criar|novo|gerar|escrever|salvar|html|css|site|p[aá]gina)/i.test(lower)) {
        return { action: 'tool', tool: 'write', params: { path: './workspace/sites/', content: '' } };
    }
    if (/(ler|ver|mostrar|listar|existe|confirmar|verificar|buscar\s+(o\s+)?arquivo)/i.test(lower)) {
        return { action: 'tool', tool: 'read', params: { path: './workspace/sites/' } };
    }
    if (/(editar|mudar|alterar|substituir|mover|deletar)/i.test(lower)) {
        return { action: 'tool', tool: 'edit', params: { path: './workspace/' } };
    }

    // ── Default → LLM with tools
    return { action: 'llm' };
}
