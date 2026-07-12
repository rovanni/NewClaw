/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S94
 * TelegramAdapter captura o texto citado quando o usuário responde (reply) a uma mensagem
 * específica do bot, mas esse sinal nunca era lido em nenhum outro lugar do código —
 * capturado, logado, e descartado.
 *
 * BUG REAL (auditoria 11/07/2026, Telegram): usuário respondeu (reply nativo do Telegram) à
 * mensagem "Vou buscar informações atualizadas agora." com "Conseguiu fazer isso?". O log
 * confirma a captura: `[TelegramAdapter] reply_to_captured userId=8071707790 quotedLen=173`
 * (173 = tamanho exato da mensagem citada). Mas `quotedText` (armazenado em
 * `msg.metadata.quotedText`) nunca aparecia em NENHUM outro arquivo do projeto — nem
 * UnifiedIntentRouter, nem GoalExtractor, nem ContextBuilder, nem SessionContext. O sinal mais
 * confiável disponível sobre a que "isso" se referia (a própria API do Telegram, não
 * inferência) era jogado fora. Combinado com S92 (compressão de sessão apagando a mensagem
 * citada do histórico), o modelo ficou sem NENHUMA forma de saber a que a pergunta se referia
 * — e executou uma tarefa antiga não relacionada.
 *
 * Fix: SessionContext.buildLLMMessages() injeta `channelMetadata.quotedText` (quando presente)
 * no `stateBlock` — DEPOIS da classificação de intenção (AgentLoop.run() chama
 * intentRouter.route() antes de buildLLMMessages(), ver S94-3 abaixo), preservando a
 * preocupação original do autor (comentário em TelegramAdapter.ts: não embutir no texto da
 * mensagem para não interferir na detecção de intenção) enquanto entrega o sinal ao LLM na
 * geração da resposta final. Mesmo padrão já usado para hostApp/slideContext (suplemento
 * PowerPoint) no mesmo bloco.
 *
 * Escopo tocado: session/SessionContext.ts (buildLLMMessages, stateBlock). TelegramAdapter.ts
 * não foi alterado — já capturava o dado corretamente, só ninguém consumia.
 *
 * Nota de escopo: teste estrutural (inspeção de código-fonte), não funcional —
 * SessionContext.buildLLMMessages() depende de ContextBuilder/MultiLayerRetriever (geração de
 * embeddings, possivelmente rede/Ollama), caro e frágil de instanciar num teste determinístico
 * (mesmo raciocínio já usado em S74 para AgentLoop.runWithTools()).
 *
 * Execução: npx ts-node src/__tests__/regression/S94_QuotedTextReply_ContextInjection.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  OK ${message}`); passed++; }
    else { console.error(`  FALHOU: ${message}`, detail ?? ''); failed++; }
}

function readSrc(relPath: string): string {
    return fs.readFileSync(path.join(process.cwd(), 'src', relPath), 'utf-8');
}

async function main(): Promise<void> {

console.log('\n=== S94-1 — TelegramAdapter ainda captura quotedText corretamente (não regrediu) ===');
{
    const src = readSrc('channels/TelegramAdapter.ts');
    assert(/const replyToText = ctx\.message!\.reply_to_message\?\.text;/.test(src), 'captura reply_to_message.text do update do Telegram');
    assert(/quotedText:\s*replyToText/.test(src), 'quotedText é incluído em msg.metadata quando há reply');
}

console.log('\n=== S94-2 — SessionContext.buildLLMMessages() agora lê channelMetadata.quotedText e injeta no stateBlock ===');
{
    const src = readSrc('session/SessionContext.ts');
    assert(/channelMetadata\?\.quotedText/.test(src), 'lê quotedText de channelMetadata');
    const quotedIdx = src.indexOf('channelMetadata?.quotedText as string');
    const stateBlockDeclIdx = src.indexOf('let stateBlock');
    const activeFilesIdx = src.indexOf('const activeFiles = this.sessionManager.getActiveFilesBlock');
    assert(quotedIdx > -1 && stateBlockDeclIdx > -1 && quotedIdx > stateBlockDeclIdx, 'injeção acontece DEPOIS que stateBlock já existe (concatena, não substitui)');
    assert(quotedIdx > -1 && activeFilesIdx > -1 && quotedIdx < activeFilesIdx, 'bloco de quotedText fica no mesmo grupo dos outros blocos de estado (hostApp/activeFiles), antes da montagem final de blocks');
    assert(/stateBlock \+= `\\n\\n\[MENSAGEM RESPONDIDA\]/.test(src), 'conteúdo é concatenado em stateBlock (mesmo canal usado por hostApp/slideContext), não em currentUserMessage');
}

console.log('\n=== S94-3 — classificação de intenção roda ANTES de buildLLMMessages ser chamado (quotedText não interfere na detecção de intenção) ===');
{
    const src = readSrc('loop/AgentLoop.ts');
    const routeIdx = src.indexOf('await this.intentRouter.route(userText,');
    const buildLLMIdx = src.indexOf('await this.sessionContext.buildLLMMessages(');
    assert(routeIdx > -1 && buildLLMIdx > -1 && routeIdx < buildLLMIdx,
        'intentRouter.route() é chamado antes de buildLLMMessages() — preserva a preocupação original de TelegramAdapter.ts (não embutir no texto pra não afetar detecção de intenção)');
}

console.log('\n=== S94-4 — quotedText não é injetado em currentMessage/texto usado pela classificação (continua fora do msg.text) ===');
{
    const src = readSrc('channels/TelegramAdapter.ts');
    // O texto da mensagem em si (msg.text) permanece só o texto digitado pelo usuário — a
    // citação vai exclusivamente em metadata.quotedText, nunca concatenada em `text`.
    const textFieldMatch = src.match(/text,\s*\n\s*rawContext: ctx,/);
    assert(!!textFieldMatch, 'campo text do NormalizedMessage continua sendo só o texto digitado (sem concatenação da citação)', textFieldMatch);
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S94 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;

}

main().catch((err) => {
    console.error('S94 erro inesperado:', err);
    process.exitCode = 1;
});
