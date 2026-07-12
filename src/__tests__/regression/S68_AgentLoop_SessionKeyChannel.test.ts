/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S68
 * Investigação de log real (2026-07-08, suplemento PowerPoint, sessão
 * web:powerpoint-addin-09e597ca-11a2-4287-876e-67c62479b275,
 * newclaw-audit.log linhas 59258-60361):
 *
 *   Usuário pediu para deixar o fundo de uma aula .pptx branco. O assistente rodou vários
 *   passos (exec_command, write, read) e terminou o turno perguntando: "Quer que eu execute
 *   agora?" (script otimizado para aplicar fundo branco em todos os 10 slides). O usuário
 *   respondeu "sim" 21s depois. UnifiedIntentRouter classificou corretamente como
 *   category=confirmation e liberou TODAS as ferramentas ("[TOOLS] Sending all tools"), mas o
 *   modelo respondeu apenas "Estou pronto. Como posso ajudar com a sua apresentação ou
 *   qualquer outra tarefa agora?" — toolCalls=0, nenhuma ação executada.
 *
 * Causa raiz: em AgentLoop.runWithTools, o sessionKey usado para recuperar a transcript da
 * sessão (SessionContext.buildLLMMessages → SessionManager.buildContext) tinha o channel
 * HARDCODED como 'telegram':
 *
 *   const sessionKey: SessionKey = { channel: 'telegram', userId: conversationId };
 *
 * SessionManager chaveia sessões por `${channel}:${userId}` (SessionManager.ts:193).
 * MessageBus grava a transcript com o channel REAL do canal de origem (msg.channel — 'web',
 * 'discord', 'signal', 'whatsapp' ou 'telegram'), mas o AgentLoop sempre LIA de volta com
 * channel='telegram'. Para qualquer canal diferente de Telegram, a leitura caía numa chave
 * que nunca teve nada escrito — SessionContext logava "0 recent msgs" em TODOS os turnos da
 * sessão (confirmado no log: linhas com timestamps 01:03:27, 01:05:57, 01:07:56, 01:09:29 —
 * todas com "0 recent msgs", inclusive turnos que tinham histórico real). Isso apagava
 * silenciosamente toda a continuidade conversacional entre turnos para web/discord/
 * signal/whatsapp — o bug só não aparecia no Telegram porque lá o canal real também é
 * 'telegram' (TelegramAdapter.ts), coincidindo por acidente com o valor fixo.
 *
 * Fix: usar o channel real do ChannelContext do turno (channelContext?.channel), com
 * 'telegram' como fallback apenas quando não há ChannelContext (ex.: chamada de
 * AgentController.ts via scheduler, que hoje não propaga contexto nenhum).
 *
 * Escopo tocado: loop/AgentLoop.ts (runWithTools, construção de sessionKey).
 *
 * Execução: npx ts-node src/__tests__/regression/S68_AgentLoop_SessionKeyChannel.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`); failed++; }
}

const agentLoopPath = path.join(process.cwd(), 'src', 'loop', 'AgentLoop.ts');
const agentLoopSource = fs.readFileSync(agentLoopPath, 'utf-8');

async function main(): Promise<void> {

console.log('\n=== S68-1 — sessionKey.channel não está mais hardcoded para "telegram" ===');
{
    assert(
        !/channel:\s*'telegram',\s*userId:\s*conversationId/.test(agentLoopSource),
        'não existe mais "channel: \'telegram\', userId: conversationId" fixo no arquivo',
    );
}

console.log('\n=== S68-2 — sessionKey usa o channel real do ChannelContext do turno ===');
{
    const match = agentLoopSource.match(/const sessionKey: SessionKey = \{ channel: ([^,]+), userId: conversationId \};/);
    assert(match !== null, 'linha de construção do sessionKey encontrada no formato esperado');
    if (match) {
        assert(
            /channelContext\?\.channel/.test(match[1]),
            `expressão do channel lê channelContext?.channel (encontrado: "${match[1]}")`,
        );
        assert(
            /\?\?\s*'telegram'/.test(match[1]),
            `mantém fallback 'telegram' para chamadas sem ChannelContext (encontrado: "${match[1]}")`,
        );
    }
}

console.log('\n=== S68-3 — SessionManager delega a composição da chave pro SessionKeyFactory canônico (pós-consolidação S69) ===');
{
    const sessionManagerPath = path.join(process.cwd(), 'src', 'session', 'SessionManager.ts');
    const sessionManagerSource = fs.readFileSync(sessionManagerPath, 'utf-8');
    assert(
        /composeSessionKey\(key\)/.test(sessionManagerSource),
        'SessionManager.sessionKey() delega pra composeSessionKey(key) em vez de montar a string manualmente',
    );

    const factoryPath = path.join(process.cwd(), 'src', 'session', 'SessionKeyFactory.ts');
    const factorySource = fs.readFileSync(factoryPath, 'utf-8');
    assert(
        /`\$\{key\.channel\}:\$\{key\.userId\}`/.test(factorySource),
        'SessionKeyFactory.composeSessionKey continua produzindo o formato `channel:userId` (contrato de fato inalterado)',
    );
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S68 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;

}

main().catch((err) => {
    console.error('S68 erro inesperado:', err);
    process.exitCode = 1;
});
