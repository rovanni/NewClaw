import { OpenAIProvider } from './OpenAIProvider';

/**
 * DeepSeek fala a mesma API OpenAI-Compatible que `OpenAIProvider` já implementa
 * (`/chat/completions`, `/models`, mesmo formato de tool-calling, mesmo header de auth) — herda
 * `chat()`/`discoverModels()` inteiros em vez de reimplementá-los (D-07,
 * docs/ARCHITECTURE/INVENTARIO_DUPLICACAO_2026-08-24.md). Mesmo padrão já usado por
 * `OpenRouterProvider` (`OpenAIProvider.ts`) — não uma abstração nova.
 *
 * Comparação estrutural feita antes de escolher `extends` em vez de uma classe neutra
 * `OpenAICompatibleProvider`: nenhum comportamento herdado de `OpenAIProvider` é ilegítimo para
 * a DeepSeek — proteção SSRF (`assertNotSsrfTarget`) é inerte pra um `baseUrl` fixo no código,
 * nunca escolhido pelo usuário, mas inofensiva; o probe de liveness (`CONNECT_TIMEOUT_MS`) só
 * adiciona uma checagem extra em caso de timeout, nunca subtrai comportamento; a conversão de
 * imagem (`toOpenAIContent`) FECHA um bug real que a DeepSeek tinha e o OpenAIProvider já
 * corrigiu (S192) — visão silenciosamente ignorada quando `visionProfile.provider` aponta pra
 * cá. Único efeito colateral real, aceito conscientemente: a mensagem de erro HTTP passa a
 * incluir o corpo da resposta (`${this.name} API error (status): body`, herdado de
 * OpenAIProvider) em vez do formato terso anterior (`DeepSeek API error: status`) — mais
 * diagnóstico, nenhuma classificação de retry em ProviderFactory.chatWithFallback depende do
 * formato exato da mensagem.
 */
export class DeepSeekProvider extends OpenAIProvider {
    constructor(apiKey: string, model: string = 'deepseek-chat') {
        super(apiKey, model, 'https://api.deepseek.com/v1', 'deepseek');
        this.name = 'deepseek';
    }
}
