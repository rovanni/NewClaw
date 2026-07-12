/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S54
 * Investigação de log real (05/07/2026, Telegram, 4 tentativas consecutivas do mesmo pedido
 * "teria como ter no máximo 10 linhas por slides que tem conteúdos que não aparecem"):
 *
 *   Todas as 4 tentativas (19:07, 19:32, 19:33, 20:01 — 2 delas já rodando o build com o fix
 *   S53) dispararam o SAFETY-GUARD de context_growth (ratio≈2.6-2.7, threshold=2.5) logo
 *   após o único `read` necessário para entender o arquivo antes de editá-lo. O guard já
 *   injeta a mensagem "[CONTEXTO EXCESSIVO] ... OBRIGATÓRIO: Use exec_command ... AGORA" —
 *   mas na sequência define dedupAbort=true e sai do loop, caindo direto na síntese pós-loop,
 *   que é OBRIGATORIAMENTE texto puro ("RESPONDA EM TEXTO PURO... NÃO use formato
 *   action/thought") e portanto NUNCA pode executar exec_command. A própria instrução do
 *   guard é estruturalmente impossível de cumprir. Resultado observado nos 4 casos: ou uma
 *   alucinação bloqueada (Q4 risk=0.90-1.00) ou uma resposta honesta mas incompleta ("vou ler
 *   o arquivo... e depois ajustar") — nunca a edição de verdade.
 *
 * Fix: quando o guard dispara no caso needsWriteNow (last=read, sem write/exec ainda,
 * intent não é análise), concede UMA chance real extra (steps += 2, mesmo padrão já usado
 * pelo DELIVERY-GUARD com deliveryStepCap=maxSteps+2) em vez de abortar direto — dando ao
 * modelo a oportunidade real de agir na própria instrução que acabou de receber. Um flag
 * one-shot (contextGuardWriteExtensionUsed) impede loop infinito: se o guard disparar de novo
 * (contexto continuou crescendo sem produzir write/exec), aborta de verdade na 2ª vez.
 * Os outros 2 ramos do guard (análise — só precisa responder, sem tools; "outro motivo" —
 * já usou os dados, sem tools) continuam abortando direto, sem mudança — não pedem
 * exec_command, então synthesis-only já era suficiente para eles.
 *
 * Escopo tocado: loop/AgentLoop.ts (guard de context_growth, ratio_limit/absolute_limit).
 *
 * Execução: npx ts-node src/__tests__/regression/S54_ContextGuard_WriteExtension.test.ts
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

console.log('\n=== S54-1 — AgentLoop.ts: guard de context_growth concede extensão antes de abortar ===');
{
    assert(
        /contextGuardWriteExtensionUsed/.test(agentLoopSource),
        'flag one-shot contextGuardWriteExtensionUsed existe — evita re-conceder extensão indefinidamente',
    );
    assert(
        /needsWriteNow\s*=\s*lastToolInCycle === 'read' && !writeToolsUsedThisTurn && !isAnalysisAbort/.test(agentLoopSource),
        'needsWriteNow identifica exatamente o caso que a mensagem OBRIGATÓRIO exige tool (não análise, ainda sem write/exec)',
    );
    assert(
        /if \(needsWriteNow && !contextGuardWriteExtensionUsed\)/.test(agentLoopSource),
        'extensão só é concedida no caso needsWriteNow, e só uma vez por turno',
    );
    assert(
        /if \(maxSteps < stepCount \+ 2\) maxSteps = stepCount \+ 2;/.test(agentLoopSource),
        'orçamento estendido o suficiente para caber a próxima chamada real (mesmo padrão +2 do DELIVERY-GUARD)',
    );
    // O guard fica no TOPO do while (antes da chamada LLM) — um `continue` logo após conceder
    // a extensão volta pro `while(...)` e reavalia o MESMO guard antes de qualquer chamada LLM
    // acontecer, consumindo o one-shot sem o modelo nunca ter agido. Precisa cair (fall through)
    // pro código abaixo em vez de `continue`.
    const extensionBranch = agentLoopSource.match(
        /if \(needsWriteNow && !contextGuardWriteExtensionUsed\) \{[\s\S]*?\n\s*\} else \{/
    )?.[0] ?? '';
    assert(extensionBranch.length > 0, 'consegue isolar o corpo do branch needsWriteNow (regex de âncora ainda bate no arquivo)');
    assert(
        !/continue;/.test(extensionBranch),
        'branch needsWriteNow NÃO usa continue — cai pra chamada LLM abaixo na MESMA iteração em vez de voltar pro topo do while',
    );
}

console.log('\n=== S54-2 — reprodução isolada: 1ª ocorrência estende, 2ª ocorrência aborta de verdade ===');
{
    // Reproduz a decisão exata do guard, isolada do resto do AgentLoop.
    let maxSteps = 15;
    let dedupAbort = false;
    let contextGuardWriteExtensionUsed = false;
    let extensionsGranted = 0;

    function onGuardTrigger(stepCount: number, needsWriteNow: boolean) {
        if (needsWriteNow && !contextGuardWriteExtensionUsed) {
            contextGuardWriteExtensionUsed = true;
            if (maxSteps < stepCount + 2) maxSteps = stepCount + 2;
            extensionsGranted++;
            return; // continue no loop principal com tools disponíveis
        }
        dedupAbort = true; // cai na síntese pós-loop (texto puro)
    }

    // 1ª ocorrência: read acabou de rodar, sem write/exec ainda — deve estender, não abortar.
    onGuardTrigger(3, true);
    assert(!dedupAbort, '1ª ocorrência (needsWriteNow=true) não aborta o loop');
    assert(extensionsGranted === 1, '1ª ocorrência concede exatamente 1 extensão');

    // 2ª ocorrência no mesmo turno (contexto cresceu de novo sem produzir write/exec) — aborta de verdade.
    onGuardTrigger(5, true);
    assert(dedupAbort, '2ª ocorrência no mesmo turno aborta de verdade (one-shot já consumido)');
    assert(extensionsGranted === 1, '2ª ocorrência não concede uma segunda extensão (sem loop infinito)');
}

console.log('\n=== S54-3 — ramos de análise e "outro motivo" continuam abortando direto (sem regressão) ===');
{
    let dedupAbort = false;
    let contextGuardWriteExtensionUsed = false;
    let extensionsGranted = 0;

    function onGuardTrigger(needsWriteNow: boolean) {
        if (needsWriteNow && !contextGuardWriteExtensionUsed) {
            contextGuardWriteExtensionUsed = true;
            extensionsGranted++;
            return;
        }
        dedupAbort = true;
    }

    // Intent de análise (isAnalysisAbort=true) → needsWriteNow=false — comportamento inalterado.
    onGuardTrigger(false);
    assert(dedupAbort, 'intent de análise continua abortando direto para síntese (já era o comportamento correto)');
    assert(extensionsGranted === 0, 'nenhuma extensão concedida para o ramo de análise');
}

console.log('\n=== S54-4 — simulação fiel do while-loop: extensão precisa alcançar a chamada LLM na MESMA iteração ===');
{
    // S54-2 usava `return` para "não abortar", que é uma abstração boa demais: no código
    // real, o guard fica no TOPO do corpo do while, ANTES da chamada LLM — um `continue`
    // ali volta pro `while(...)` e reavalia o MESMO guard de novo, sem nenhuma chamada LLM
    // ter acontecido no meio. Isso permitiu um bug real passar despercebido: a extensão do
    // S54 usava `continue` em vez de "cair" (fall through) pro código da chamada LLM abaixo,
    // consumindo o one-shot na iteração seguinte sem o modelo nunca ter recebido a instrução.
    // Achado ao vivo em 2026-07-05 21:33 (Step 3 concedeu extensão, Step 4 logou imediatamente
    // depois SEM nenhuma chamada LLM/tool no meio, disparou o guard de novo e abortou de
    // verdade). Esta simulação reproduz a estrutura real do while (guard no topo, chamada LLM
    // depois) para travar esse tipo de regressão.
    function simulateTurn(): { llmCallsAfterGuardFired: number; abortedBeforeAnyLLMCall: boolean } {
        let stepCount = 0;
        let maxSteps = 15;
        let dedupAbort = false;
        let contextGuardWriteExtensionUsed = false;
        // Passos 1-2 = recon (exec_command) + read, igual ao incidente real — não relevantes
        // pro guard ainda (ratio só cresce o suficiente DEPOIS do read). A partir daí, o
        // arquivo foi lido e nenhuma escrita aconteceu ainda — condição que mantém o guard
        // disparando até o modelo de fato chamar exec_command (só na chamada LLM concedida).
        let readDoneNoWriteYet = false;
        let llmCallsAfterGuardFired = 0;
        let guardEverFired = false;

        while (stepCount < maxSteps && !dedupAbort) {
            stepCount++;
            if (stepCount <= 2) { readDoneNoWriteYet = stepCount === 2; continue; } // recon + read

            // Guard no TOPO do loop, igual ao código real.
            const guardTriggered = readDoneNoWriteYet;
            if (guardTriggered) {
                guardEverFired = true;
                const needsWriteNow = true; // last=read, sem write/exec, não é análise
                if (needsWriteNow && !contextGuardWriteExtensionUsed) {
                    contextGuardWriteExtensionUsed = true;
                    if (maxSteps < stepCount + 2) maxSteps = stepCount + 2;
                    // SEM continue — cai pro código da chamada LLM abaixo nesta MESMA iteração.
                } else {
                    dedupAbort = true;
                    continue;
                }
            }

            // Ponto da chamada LLM real (código real: várias dezenas de linhas abaixo do guard).
            if (guardEverFired) llmCallsAfterGuardFired++;
            readDoneNoWriteYet = false; // modelo age na instrução: chama exec_command com sucesso
        }

        return { llmCallsAfterGuardFired, abortedBeforeAnyLLMCall: dedupAbort && llmCallsAfterGuardFired === 0 };
    }

    const { llmCallsAfterGuardFired, abortedBeforeAnyLLMCall } = simulateTurn();
    assert(llmCallsAfterGuardFired >= 1, 'pelo menos 1 chamada LLM real acontece depois do guard conceder a extensão (a regressão do continue fazia esse número ser 0)');
    assert(!abortedBeforeAnyLLMCall, 'o turno não aborta sem nunca ter dado ao modelo uma chance real de agir');
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S54 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;

}

main().catch((err) => {
    console.error('S54 erro inesperado:', err);
    process.exitCode = 1;
});
