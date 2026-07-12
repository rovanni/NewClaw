/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S93
 * commitResponse() só bloqueava promessa de ação em curso ("estou fazendo... agora") quando
 * ZERO tools rodaram no turno (`last === null`, ver S56). Quando uma tool rodava COM SUCESSO
 * mas a resposta final ainda assim ignorava o resultado e só repetia a promessa, nada bloqueava.
 *
 * BUG REAL (auditoria 11/07/2026, Telegram, correlationId=df2aeb8f-de22-45af-bb62-6cbc84e1a800):
 * usuário perguntou se a resposta sobre a NVIDIA era recente. O modelo chamou `web_search` DUAS
 * vezes com sucesso (resultados reais retornados, ver newclaw-audit.log linhas 97611-97627),
 * mas a resposta final foi só "Vou buscar informações atualizadas agora." — ignorando os
 * resultados já disponíveis em `last.toolOutput`. ObserverValidator.validateResponseCommit()
 * detectou isso corretamente (`approved=false confidence=0.95 reason="A resposta final apenas
 * promete buscar informações atualizadas, mas não apresenta os resultados..."`), mas por
 * DESIGN (ver ObserverValidator.ts, comentário "isso NÃO é necessariamente uma alucinação de
 * ação... NÃO bloqueamos a mensagem") a rejeição de qualidade vinda do caminho LLM nunca
 * bloqueia sozinha — `commit.blocked` ficou `false`. O usuário recebeu a promessa vazia como
 * resposta final e nunca soube que os dados já tinham sido coletados.
 *
 * Detalhe importante descoberto DURANTE a implementação deste teste: a frase real do incidente
 * ("Vou buscar informações atualizadas agora") NÃO bate no regex existente
 * looksLikePendingActionPromise (que espera gerúndio "estou X-ndo", não futuro perifrástico
 * "vou X"). Por isso o fix adicionou um segundo helper dedicado,
 * looksLikeUnfulfilledFuturePromise — deliberadamente SEPARADO (não fundido no helper
 * existente) porque "vou verbo... agora" é mais propenso a falso positivo em respostas
 * legítimas; só é seguro usar já combinado com commit.valid===false, ao contrário do guard
 * `!last` do S56 que não tem esse gate.
 *
 * Fix: dentro de commitResponse(), quando `last` existe (tool rodou) E `commit.valid === false`
 * E a resposta bate em QUALQUER UM dos dois padrões (looksLikePendingActionPromise OU
 * looksLikeUnfulfilledFuturePromise), a resposta é substituída por uma correção honesta.
 * Combina sinais independentes (rejeição do LLM + padrão textual determinístico) para não
 * bloquear por causa só de uma rejeição de qualidade genérica — respeita a política deliberada
 * do ObserverValidator (comentário citado acima) sem reabrir a classe de bug que ela existia
 * para evitar.
 *
 * Escopo tocado: loop/AgentLoop.ts (commitResponse + novo helper estático
 * looksLikeUnfulfilledFuturePromise — o guard `!last`/looksLikePendingActionPromise existente
 * do S56 não foi alterado, nem a política do ObserverValidator).
 *
 * Execução: npx ts-node src/__tests__/regression/S93_CommitResponse_PendingPromiseDespiteToolSuccess.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  OK ${message}`); passed++; }
    else { console.error(`  FALHOU: ${message}`, detail ?? ''); failed++; }
}

const agentLoopPath = path.join(process.cwd(), 'src', 'loop', 'AgentLoop.ts');
const agentLoopSource = fs.readFileSync(agentLoopPath, 'utf-8');

// Mesmos regexes exatos dos helpers reais — reproduzidos isolados, mesmo padrão de S56, porque
// a classe real não pode ser instanciada fora do runtime completo (ProviderFactory,
// MemoryManager, SkillLearner, SkillLoader, ...).
function looksLikePendingActionPromise(text: string): boolean {
    return /\best(ou|á)\s+\w+ndo\b[^.!?]{0,40}\b(agora|neste\s+momento)\b/i.test(text)
        || /\b(te\s+|lhe\s+)?(envio|mando)\s+em\s+(instantes|breve|seguida)\b/i.test(text)
        || /\bj[aá]\s+j[aá](?![a-zà-ÿ])/i.test(text);
}
function looksLikeUnfulfilledFuturePromise(text: string): boolean {
    return /\bvou\s+\w+[^.!?]{0,40}\b(agora|neste\s+momento)\b/i.test(text);
}

async function main(): Promise<void> {

console.log('\n=== S93-1 — AgentLoop.ts: novo guard existe, roda DEPOIS do bloqueio de alucinação e ANTES do "return response" final ===');
{
    const guardIdx = agentLoopSource.indexOf('!commit.valid && (AgentLoop.looksLikePendingActionPromise(response) || AgentLoop.looksLikeUnfulfilledFuturePromise(response))');
    const hallucinationBlockIdx = agentLoopSource.indexOf('if (commit.blocked && commit.correctedResponse)');
    const finalReturnIdx = agentLoopSource.lastIndexOf('return response;\n        } catch (err) {');

    assert(guardIdx > -1, 'guard combinado `!commit.valid && (looksLikePendingActionPromise || looksLikeUnfulfilledFuturePromise)` existe em commitResponse()');
    assert(hallucinationBlockIdx > -1 && guardIdx > hallucinationBlockIdx, 'novo guard roda DEPOIS do bloqueio de alucinação existente (prioridade preservada)');
    assert(finalReturnIdx > -1 && guardIdx < finalReturnIdx, 'novo guard roda ANTES do "return response" final de sucesso');
}

console.log('\n=== S93-2 — guard exige AMBOS os sinais (commit.valid===false E algum dos padrões textuais), não só um deles ===');
{
    const guardLine = agentLoopSource.slice(
        agentLoopSource.indexOf('// Mesma classe de bug do guard `!last` acima'),
        agentLoopSource.indexOf('return `Já executei')
    );
    assert(guardLine.includes('!commit.valid'), 'condição inclui commit.valid===false (sinal do ObserverValidator)', guardLine);
    assert(guardLine.includes('looksLikePendingActionPromise(response)'), 'condição inclui o padrão do S56 (gerúndio "estou X-ndo")', guardLine);
    assert(guardLine.includes('looksLikeUnfulfilledFuturePromise(response)'), 'condição inclui o novo padrão (futuro perifrástico "vou X")', guardLine);
    assert(/!commit\.valid\s*&&\s*\(/.test(guardLine), 'commit.valid===false é combinado com AND aos padrões textuais (não dispara sozinho)', guardLine);
}

console.log('\n=== S93-3 — helper novo existe, com escopo/comentário explicando por que é separado do helper do S56 ===');
{
    assert(/private static looksLikeUnfulfilledFuturePromise\(text: string\): boolean/.test(agentLoopSource),
        'looksLikeUnfulfilledFuturePromise existe como método estático dedicado');
    const helperIdx = agentLoopSource.indexOf('private static looksLikeUnfulfilledFuturePromise');
    const pendingHelperIdx = agentLoopSource.indexOf('private static looksLikePendingActionPromise');
    assert(helperIdx > pendingHelperIdx, 'novo helper é declarado depois do helper original (não o substituiu)');
}

console.log('\n=== S93-4 — reprodução isolada: frase EXATA do incidente real é detectada pelo NOVO padrão (não pelo padrão antigo) ===');
{
    const realResponse = 'Você tem toda razão em questionar! Minha resposta anterior foi baseada em conhecimento geral, ' +
        'não em fontes recentes de julho/2026. Vou buscar informações atualizadas agora.';
    assert(!looksLikePendingActionPromise(realResponse), 'sanity: o padrão ANTIGO (gerúndio) NÃO captura esta frase — confirma que o novo helper era necessário', realResponse);
    assert(looksLikeUnfulfilledFuturePromise(realResponse), 'o NOVO padrão (futuro perifrástico "vou X... agora") captura a frase exata do incidente real');
}

console.log('\n=== S93-5 — variações do padrão "vou X agora" são detectadas ===');
{
    assert(looksLikeUnfulfilledFuturePromise('Vou verificar isso agora mesmo.'), '"vou verificar... agora" é detectado');
    assert(looksLikeUnfulfilledFuturePromise('Vou gerar o relatório neste momento.'), '"vou gerar... neste momento" é detectado');
}

console.log('\n=== S93-6 — respostas que REALMENTE usam o resultado da tool não disparam falso positivo em nenhum dos dois padrões ===');
{
    const goodResponse = 'Pesquisei agora e encontrei: as ações da NVIDIA caíram 8% essa semana após o anúncio de ' +
        'resultados trimestrais abaixo do esperado, segundo o Bing News.';
    assert(!looksLikePendingActionPromise(goodResponse), 'resposta com dados reais não dispara o padrão antigo');
    assert(!looksLikeUnfulfilledFuturePromise(goodResponse), 'resposta com dados reais não dispara o padrão novo');
}

console.log('\n=== S93-7 — mensagem de correção é honesta sobre o que aconteceu (não finge que a tool falhou) ===');
{
    const correctionIdx = agentLoopSource.indexOf('Já executei "${last.toolName}" e tenho os resultados');
    assert(correctionIdx > -1, 'mensagem de correção referencia a tool que JÁ teve sucesso (não trata como falha)', null);
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S93 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;

}

main().catch((err) => {
    console.error('S93 erro inesperado:', err);
    process.exitCode = 1;
});
