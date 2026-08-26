/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S269
 *
 * Campanha "deepseek harness" (26/08/2026, prompt.txt + newclaw-audit.log): o usuário perguntou
 * "O que é deepseek harness?" 5 vezes na mesma conversa; nas 5 vezes a barreira de groundedness
 * (ADR-010/C1, ver S217) bloqueou a resposta com NOT_EVALUABLE porque um detalhe periférico
 * ("com licença MIT") não estava sustentado pela busca — mesmo quando a maior parte da resposta
 * (7-8 de 9-13 afirmações, dependendo da tentativa) era sustentada. ADR-010 §16 deixou a política
 * de recuperação para REJECTED/NOT_EVALUABLE deliberadamente em aberto; nunca foi implementada.
 * O usuário não tinha NENHUM caminho — só a mensagem genérica de bloqueio, repetida ad infinitum.
 *
 * Investigação Fase 1-5 (mesma sessão) concluiu: a evidência para uma resposta parcial já existe
 * — `GroundingVerdict.claims` decompõe a resposta em afirmação→veredito na MESMA chamada de LLM
 * que bloqueia, e era descartada (só `state` agregado era usado). Correção: quando existe pelo
 * menos 1 claim SUPPORTED, `AgentLoop.trySynthesizePartialResponse()` pede uma nova síntese curta
 * restrita SOMENTE a essas afirmações, e revalida essa síntese pela MESMA barreira (uma única vez,
 * sem recursão) antes de entregar. Sem claims SUPPORTED (inclui sempre UNVALIDATED, cujo `claims`
 * é sempre `[]`), cai direto no bloqueio de sempre — comportamento inalterado.
 *
 * `AgentLoop` não pode ser instanciado fora do runtime completo (ProviderFactory, MemoryManager,
 * SkillLearner, WorkflowEngine, ...) — mesma restrição documentada em S93. Este teste segue o
 * mesmo padrão: verificação estrutural do código real (ordem, chamadas, guards) + reprodução
 * isolada do único trecho de lógica pura nova (o sinal estrutural "INSUFICIENTE").
 *
 * Execução: npx ts-node src/__tests__/regression/S269_Grounding_PartialResponseRecovery.test.ts
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

// Mesmo regex exato de trySynthesizePartialResponse, reproduzido isolado (padrão S93).
function isInsufficientSentinel(text: string): boolean {
    return /^["'*_\s]*INSUFICIENTE["'.!*_\s]*$/i.test(text);
}

async function main(): Promise<void> {

console.log('\n=== S269-1 — recuperação parcial vive DENTRO do bloco de bloqueio de grounding, DEPOIS do record() de falha ===');
{
    const blockStart = agentLoopSource.indexOf("[GROUNDING] estado=${g.state}");
    const failureRecordIdx = agentLoopSource.indexOf("pattern: 'grounding_blocked'");
    const supportedClaimsIdx = agentLoopSource.indexOf('const supportedClaims = g.claims.filter');
    const blockedMessageIdx = agentLoopSource.indexOf('return AgentLoop.groundingBlockedMessage(g.state);');

    assert(blockStart > -1 && failureRecordIdx > blockStart, 'o record() de falha (pattern=grounding_blocked) continua sendo o primeiro efeito do bloqueio (comportamento do Sprint 1 preservado)');
    assert(supportedClaimsIdx > failureRecordIdx, 'a tentativa de recuperação parcial roda DEPOIS do record() de falha, não antes (a falha original continua sempre registrada)');
    assert(blockedMessageIdx > supportedClaimsIdx, 'o bloqueio padrão (mensagem genérica) continua existindo DEPOIS da tentativa de recuperação — é o fallback, não foi removido');
}

console.log('\n=== S269-2 — recuperação só é tentada quando existe ao menos 1 claim SUPPORTED (guard estrutural, não heurística) ===');
{
    const guardLine = agentLoopSource.slice(
        agentLoopSource.indexOf('const supportedClaims = g.claims.filter'),
        agentLoopSource.indexOf('const partial = await this.trySynthesizePartialResponse'),
    );
    assert(/g\.claims\.filter\(c => c\.verdict === 'SUPPORTED'\)/.test(guardLine), 'filtro usa o enum ClaimVerdict já produzido pelo juiz (SUPPORTED), não um novo julgamento');
    assert(/if \(supportedClaims\.length > 0\)/.test(guardLine), 'só tenta síntese parcial quando supportedClaims.length > 0 — para UNVALIDATED (claims=[] sempre) o guard já é false por construção, sem checagem extra de estado');
}

console.log('\n=== S269-3 — a resposta parcial é revalidada pela MESMA barreira antes de ser aceita (nunca entregue sem checagem) ===');
{
    const methodBody = agentLoopSource.slice(
        agentLoopSource.indexOf('private async trySynthesizePartialResponse'),
        agentLoopSource.indexOf('// ── Entry points'),
    );
    assert(/this\.observer\.validateGrounding\(text, evidences, signal\)/.test(methodBody), 'trySynthesizePartialResponse chama validateGrounding() de novo sobre o texto novo (mesma barreira, não um atalho)');
    assert(/revalidated\.state !== 'VALIDATED' && revalidated\.state !== 'NOT_APPLICABLE'/.test(methodBody), 'só aceita a resposta parcial se o segundo julgamento também aprovar (VALIDATED ou NOT_APPLICABLE) — mesmo critério fail-closed do bloqueio original');
    // Sem recursão: o método não chama a si mesmo nem re-tenta em loop — uma falha na revalidação
    // devolve null e quem chamou (commitResponse) cai direto no bloqueio padrão.
    const selfCallCount = (methodBody.match(/this\.trySynthesizePartialResponse/g) ?? []).length;
    assert(selfCallCount === 0, 'trySynthesizePartialResponse não se chama recursivamente — no máximo 1 tentativa de síntese parcial por bloqueio');
}

console.log('\n=== S269-4 — falha na síntese parcial nunca lança: cai em null, nunca quebra o turno (fail-safe consistente com o resto de commitResponse) ===');
{
    const methodBody = agentLoopSource.slice(
        agentLoopSource.indexOf('private async trySynthesizePartialResponse'),
        agentLoopSource.indexOf('// ── Entry points'),
    );
    assert(/catch \(err\) \{[\s\S]*?return null;/.test(methodBody), 'erro dentro de trySynthesizePartialResponse é capturado e vira null, não exceção propagada');
}

console.log('\n=== S269-5 — recuperação bem-sucedida grava um registro DISTINTO na ReflectionMemory (outcome=partial), não reaproveita o pattern de falha ===');
{
    const successRecordBlock = agentLoopSource.slice(
        agentLoopSource.indexOf("log.info(`[${this.ts()}] [GROUNDING] resposta parcial"),
        agentLoopSource.indexOf('return partial;'),
    );
    assert(successRecordBlock.includes("pattern: 'grounding_partial_recovered'"), "registro de sucesso usa pattern próprio ('grounding_partial_recovered'), distinto de 'grounding_blocked'");
    assert(successRecordBlock.includes("outcome: 'partial'"), "outcome='partial' (AttemptOutcome já existente) — não é tratado como 'success' pleno nem como 'failure'");
    assert(successRecordBlock.includes('category: last.category'), 'registro de sucesso também inclui category — mesma correção do Sprint 1, aplicada aqui desde o início (sem repetir o gap original)');
}

console.log('\n=== S269-6 — sinal "INSUFICIENTE": reconhece o literal e variações de formatação, rejeita respostas reais que mencionam a palavra ===');
{
    assert(isInsufficientSentinel('INSUFICIENTE'), 'literal exato é reconhecido');
    assert(isInsufficientSentinel('insuficiente'), 'case-insensitive');
    assert(isInsufficientSentinel('"INSUFICIENTE"'), 'entre aspas (comum quando o modelo "cita" a própria resposta) é reconhecido');
    assert(isInsufficientSentinel('**INSUFICIENTE**'), 'negrito markdown é reconhecido');
    assert(isInsufficientSentinel('INSUFICIENTE.'), 'pontuação final é tolerada');
    assert(isInsufficientSentinel('  INSUFICIENTE  '), 'espaços extras são tolerados');

    const realAnswer = 'As informações disponíveis são insuficientes para confirmar a licença, mas o projeto é open-source segundo a DeepSeek.';
    assert(!isInsufficientSentinel(realAnswer), 'uma resposta real que MENCIONA "insuficiente" no meio de uma frase não é confundida com o sentinela (âncora ^...$ exige a palavra inteira, não substring)');
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S269 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;

}

main().catch((err) => {
    console.error('S269 erro inesperado:', err);
    process.exitCode = 1;
});
