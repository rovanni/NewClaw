/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S44
 * Investigação de log real (05/07/2026, 13:30-13:41, Telegram, goal_1783269002590_inaml):
 * usuário pediu análise de cripto com resultado em áudio e recebeu 4 ÁUDIOS SEPARADOS como
 * resposta a um único pedido.
 *
 * Rastreamento no audit log mostrou a causa exata:
 *   1. `crypto_analysis` foi chamado com args que não correspondiam ao que o step pedia,
 *      caindo no fallback silencioso da ferramenta (retornou "moedas sangrando" genéricas em
 *      vez de Bitcoin/Ethereum/Dogecoin). O StepSemanticValidator corretamente detectou o
 *      mismatch (confidence=1.00) e escalou pra replan.
 *   2. O plano final virou um step "agentloop" (sem toolName — GoalExecutionLoop despacha pro
 *      AgentLoop com um prompt) que itera a lista de moedas e no fim chama send_audio.
 *   3. A CADA replan por mismatch semântico, o GoalExecutionLoop redespachava esse MESMO step
 *      "agentloop" DO ZERO — e como ele chama send_audio internamente, cada re-execução gerou
 *      e enviou um ÁUDIO NOVO (13:33:14, 13:33:56, ...), mesmo o outcome anterior já sendo
 *      'success'.
 *   4. Nada impedia isso porque o dedup de entrega existente (`sentArtifacts` em
 *      GoalExecutionLoop.ts, usado para não reenviar `send_document` duas vezes) é keyed
 *      exclusivamente por `path`/`file_path` — e `send_audio` (send_audio.ts) só tem os
 *      parâmetros `text`/`voice`, nunca um path. Toda chamada de send_audio era estruturalmente
 *      invisível pro dedup. O único guard existente era um debounce de 10s por tempo dentro do
 *      próprio SendAudioTool — insuficiente porque cada replan levava 40+ segundos.
 *
 * Correção: `ChannelContext.isAudioAlreadySent` (agentLoopTypes.ts) — reusa o MESMO Set
 * `sentArtifacts` já usado para send_document, com uma chave sentinela fixa
 * ('__send_audio_delivered__') em vez de um path real, já que áudio não tem path estável.
 * AgentLoop.ts consulta esse hook nos DOIS caminhos de execução de tool (tool-calling nativo E
 * protocolo JSON atômico) antes de rodar send_audio, e notifica via `onArtifactDelivered` (hook
 * já existente, genérico por string) depois de um envio bem-sucedido. GoalExecutionLoop.ts liga
 * os dois lados: `isAudioAlreadySent: () => sentArtifacts.has(AUDIO_DELIVERED_KEY)`.
 *
 * Escopo tocado: loop/agentLoopTypes.ts, loop/AgentLoop.ts, loop/GoalExecutionLoop.ts.
 *
 * Execução: npx ts-node src/__tests__/regression/S44_SendAudio_GoalReplanDedup.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`); failed++; }
}

const typesPath = path.join(process.cwd(), 'src', 'loop', 'agentLoopTypes.ts');
const agentLoopPath = path.join(process.cwd(), 'src', 'loop', 'AgentLoop.ts');
const goalLoopPath = path.join(process.cwd(), 'src', 'loop', 'GoalExecutionLoop.ts');
const typesSource = fs.readFileSync(typesPath, 'utf-8');
const agentLoopSource = fs.readFileSync(agentLoopPath, 'utf-8');
const goalLoopSource = fs.readFileSync(goalLoopPath, 'utf-8');

async function main(): Promise<void> {

console.log('\n=== S44-1 — ChannelContext expõe o hook de dedup de áudio ===');
{
    assert(
        /isAudioAlreadySent\?:\s*\(\)\s*=>\s*boolean/.test(typesSource),
        'ChannelContext.isAudioAlreadySent existe com a assinatura esperada',
    );
}

console.log('\n=== S44-2 — AgentLoop.ts bloqueia send_audio já entregue nos DOIS caminhos de execução ===');
{
    const nativePathGuard = /toolName === 'send_audio' && channelContext\?\.deliveryTracking\?\.isAudioAlreadySent\?\.\(\)/;
    const guardMatches = agentLoopSource.match(new RegExp(nativePathGuard.source, 'g')) ?? [];
    assert(
        guardMatches.length >= 2,
        `guard de send_audio já entregue aparece nos 2 caminhos de execução (nativo + JSON atômico) — encontrado ${guardMatches.length}x`,
    );

    const notifyMatches = agentLoopSource.match(/toolName === 'send_audio' && result\.success/g) ?? [];
    assert(
        notifyMatches.length >= 2,
        `notificação onArtifactDelivered após send_audio bem-sucedido aparece nos 2 caminhos — encontrado ${notifyMatches.length}x`,
    );

    assert(
        /onArtifactDelivered\?\.\('__send_audio_delivered__'\)/.test(agentLoopSource),
        'notificação usa a chave sentinela correta (mesma usada pelo GoalExecutionLoop)',
    );
}

console.log('\n=== S44-3 — GoalExecutionLoop.ts liga sentArtifacts ao hook de áudio (mesma chave sentinela) ===');
{
    assert(
        /AUDIO_DELIVERED_KEY = '__send_audio_delivered__'/.test(goalLoopSource),
        'chave sentinela definida em GoalExecutionLoop.ts',
    );
    assert(
        /isAudioAlreadySent = \(\) => sentArtifacts\.has\(AUDIO_DELIVERED_KEY\)/.test(goalLoopSource),
        'isAudioAlreadySent lê do MESMO Set sentArtifacts usado por send_document — sem mecanismo de dedup paralelo',
    );
    assert(
        /isAudioAlreadySent: \(\) => isAudioAlreadySent\?\.\(\) \?\? false/.test(goalLoopSource),
        'goalChannelContext (passado ao AgentLoop dentro de executeStep) propaga o predicado',
    );
}

console.log('\n=== S44-4 — reprodução do mecanismo: Set-based dedup por chave sentinela (sem path real) ===');
{
    // Reproduz o comportamento exato do fix: send_audio não tem file_path, então a
    // "entrega" é registrada com uma chave fixa em vez de um path por chamada.
    const sentArtifacts = new Set<string>();
    const AUDIO_DELIVERED_KEY = '__send_audio_delivered__';
    const trackArtifact = (fp: string) => { if (fp && !sentArtifacts.has(fp)) sentArtifacts.add(fp); };
    const isAudioAlreadySent = () => sentArtifacts.has(AUDIO_DELIVERED_KEY);

    assert(isAudioAlreadySent() === false, 'antes de qualquer envio, isAudioAlreadySent() é false');

    // 1ª tentativa do step "agentloop": send_audio roda e sucede
    assert(!isAudioAlreadySent(), 'guard não bloqueia a 1ª tentativa (áudio real deve ser gerado e enviado)');
    trackArtifact(AUDIO_DELIVERED_KEY); // equivalente a onArtifactDelivered('__send_audio_delivered__') após sucesso

    // replan por mismatch semântico re-despacha o MESMO step do zero
    assert(isAudioAlreadySent() === true, 'após 1 entrega, isAudioAlreadySent() vira true — replans seguintes são bloqueados');

    // simula 3 replans adicionais (reproduz os 4 áudios do incidente real) — nenhum deve re-marcar ou re-enviar
    for (let i = 0; i < 3; i++) {
        if (isAudioAlreadySent()) continue; // é exatamente o que o guard faz em AgentLoop.ts: `continue` sem executar a tool
        trackArtifact(AUDIO_DELIVERED_KEY); // não deveria ser alcançado
    }
    assert(sentArtifacts.size === 1, 'sentArtifacts continua com 1 único registro após múltiplos replans — sem duplicação');
}

console.log('\n=== S44-5 — send_document (com path real) continua funcionando lado a lado, sem colisão de chave ===');
{
    const sentArtifacts = new Set<string>();
    const AUDIO_DELIVERED_KEY = '__send_audio_delivered__';
    const trackArtifact = (fp: string) => { if (fp && !sentArtifacts.has(fp)) sentArtifacts.add(fp); };

    trackArtifact('/workspace/analise_cripto.md'); // send_document real
    trackArtifact(AUDIO_DELIVERED_KEY); // send_audio (sentinela)

    assert(sentArtifacts.has('/workspace/analise_cripto.md'), 'dedup por path de send_document não foi afetado pela chave sentinela de áudio');
    assert(sentArtifacts.has(AUDIO_DELIVERED_KEY), 'chave sentinela de áudio convive no mesmo Set sem colidir com paths reais');
    assert(sentArtifacts.size === 2, 'os dois registros são independentes (2 entradas, não fundidas)');
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S44 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;

}

main().catch((err) => {
    console.error('S44 erro inesperado:', err);
    process.exitCode = 1;
});
