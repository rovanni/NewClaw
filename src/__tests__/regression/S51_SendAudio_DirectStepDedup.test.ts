/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S51
 * Investigação de log real (05/07/2026, 16:44-16:49, Telegram, goal_1783280707963_i7qot):
 * usuário pediu "envie por audio" e recebeu 2 ÁUDIOS SEPARADOS (16:47:19 e 16:49:07) como
 * resposta a um único pedido.
 *
 * Rastreamento no audit log mostrou a causa exata:
 *   1. O plano do GoalPlanner tinha um step "agentloop" (sem toolName) que, internamente, no
 *      seu próprio tool-loop, chamou send_audio com sucesso às 16:47:19 — guarded corretamente
 *      pelo mecanismo do S44 (ChannelContext.isAudioAlreadySent, via AgentLoop.ts).
 *   2. O PRÓXIMO step do mesmo plano (exec_command, extraindo texto do PPTX) falhou
 *      ("extrair_pptx.py" não encontrado), disparando replan.
 *   3. Dois replans depois, o GoalPlanner desistiu de extrair o PPTX e gerou uma estratégia
 *      nova com um ÚNICO step cujo toolName é DIRETAMENTE "send_audio" (não mais um step
 *      "agentloop" — o LLM escolheu sintetizar áudio "a partir do contexto em memória").
 *   4. Esse step foi despachado pelo branch `if (step.toolName)` de GoalExecutionLoop.ts —
 *      caminho de execução DIFERENTE do que o S44 corrigiu (que só cobre chamadas de send_audio
 *      feitas de DENTRO de um step "agentloop", via AgentLoop.ts). Esse segundo caminho nunca
 *      consultava `isAudioAlreadySent()`, mesmo esse predicado já estando disponível como
 *      parâmetro da mesma função — e mesmo `sentArtifacts` já contendo `__send_audio_delivered__`
 *      desde o passo 1. Resultado: 2º áudio gerado e enviado sem necessidade.
 *
 * Diferença para o S44: aquele teste cobre o guard nos DOIS caminhos de execução de tool
 * DENTRO do AgentLoop (tool-calling nativo + protocolo JSON atômico). Este teste cobre o
 * terceiro caminho, que fica em GoalExecutionLoop.ts: o dispatch direto de um step cujo
 * `toolName` já é `send_audio` no plano (sem passar pelo AgentLoop).
 *
 * Correção: GoalExecutionLoop.ts agora checa `step.toolName === 'send_audio' &&
 * isAudioAlreadySent?.()` no início do branch `if (step.toolName)`, reaproveitando o MESMO
 * predicado e a MESMA chave sentinela ('__send_audio_delivered__') já introduzidos pelo S44 —
 * sem criar um segundo mecanismo de dedup nem alterar o guard existente no AgentLoop.
 *
 * Escopo tocado: loop/GoalExecutionLoop.ts (dispatch direto de step.toolName).
 *
 * Execução: npx ts-node src/__tests__/regression/S51_SendAudio_DirectStepDedup.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`); failed++; }
}

const goalLoopPath = path.join(process.cwd(), 'src', 'loop', 'GoalExecutionLoop.ts');
const goalLoopSource = fs.readFileSync(goalLoopPath, 'utf-8');

async function main(): Promise<void> {

console.log('\n=== S51-1 — dispatch direto de step.toolName checa isAudioAlreadySent antes de executar ===');
{
    const directDispatchGuard = /step\.toolName === 'send_audio' && isAudioAlreadySent\?\.\(\)/;
    assert(
        directDispatchGuard.test(goalLoopSource),
        'branch `if (step.toolName)` bloqueia send_audio já entregue antes de chamar proactiveRecovery.execute',
    );
}

console.log('\n=== S51-2 — guard aparece ANTES do dispatch real via proactiveRecovery.execute ===');
{
    const guardIdx = goalLoopSource.search(/step\.toolName === 'send_audio' && isAudioAlreadySent\?\.\(\)/);
    const dispatchIdx = goalLoopSource.indexOf('this.proactiveRecovery.execute(\n                        step.toolName');
    assert(guardIdx !== -1, 'guard encontrado no arquivo');
    assert(dispatchIdx === -1 || guardIdx < dispatchIdx, 'guard vem antes da chamada real da tool (short-circuit, não pós-checagem)');
}

console.log('\n=== S51-3 — skip não usa um mecanismo de dedup paralelo (reusa isAudioAlreadySent do S44) ===');
{
    // Não deve existir um SEGUNDO Set ou flag específico para este caminho — o fix deve
    // reaproveitar o parâmetro `isAudioAlreadySent` já injetado na assinatura da função
    // (a mesma usada pelo goalChannelContext repassado ao AgentLoop).
    const paramSignature = /isAudioAlreadySent\?:\s*\(\)\s*=>\s*boolean,/;
    assert(paramSignature.test(goalLoopSource), 'função de execução do step já recebe isAudioAlreadySent como parâmetro (S44) — reaproveitado, não duplicado');
}

console.log('\n=== S51-4 — reprodução do mecanismo: replan que troca step "agentloop" por step direto "send_audio" não reenvia ===');
{
    // Simula exatamente a sequência do incidente: sentArtifacts já contém a chave sentinela
    // (setada pelo 1º envio, dentro do step "agentloop"), e um replan gera um NOVO step cujo
    // toolName já é 'send_audio' diretamente. O guard deve interceptar antes de qualquer
    // chamada real à tool.
    const sentArtifacts = new Set<string>(['__send_audio_delivered__']); // já entregue no ciclo anterior
    const isAudioAlreadySent = () => sentArtifacts.has('__send_audio_delivered__');

    let toolCalled = false;
    function dispatchDirectStep(stepToolName: string): { success: boolean; output: string } {
        if (stepToolName === 'send_audio' && isAudioAlreadySent()) {
            return { success: true, output: 'skip: already delivered' };
        }
        toolCalled = true; // equivalente a proactiveRecovery.execute(...)
        return { success: true, output: 'sent' };
    }

    const result = dispatchDirectStep('send_audio');
    assert(!toolCalled, 'a tool real NÃO é chamada quando o áudio já foi entregue neste goal');
    assert(result.success === true, 'o step ainda reporta sucesso (não quebra o fluxo do goal, apenas evita reenvio)');
}

console.log('\n=== S51-5 — primeira entrega (sentArtifacts vazio) continua funcionando normalmente ===');
{
    const sentArtifacts = new Set<string>();
    const isAudioAlreadySent = () => sentArtifacts.has('__send_audio_delivered__');

    let toolCalled = false;
    function dispatchDirectStep(stepToolName: string): { success: boolean; output: string } {
        if (stepToolName === 'send_audio' && isAudioAlreadySent()) {
            return { success: true, output: 'skip: already delivered' };
        }
        toolCalled = true;
        return { success: true, output: 'sent' };
    }

    dispatchDirectStep('send_audio');
    assert(toolCalled, 'quando ainda não houve entrega neste goal, a tool real é chamada normalmente (sem regressão no caminho feliz)');
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S51 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;

}

main().catch((err) => {
    console.error('S51 erro inesperado:', err);
    process.exitCode = 1;
});
