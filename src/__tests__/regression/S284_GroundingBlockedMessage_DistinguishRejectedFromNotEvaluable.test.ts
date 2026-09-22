/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S284
 *
 * Achado real em produção (22/09/2026, `newclaw-audit.log` de 16-30/08/2026, correlacionado com o
 * mesmo tipo de evidência que motivou o S269 — "prompt.txt + newclaw-audit.log"): dos 53 bloqueios
 * reais de groundedness (ADR-010/C1) no período, só 3 tiveram recuperação parcial (S269); os
 * outros 50 (94%) caíam em `groundingBlockedMessage()`. Até esta correção, `REJECTED` (13
 * ocorrências) e `NOT_EVALUABLE` (31 ocorrências — a categoria MAIS comum) recebiam o MESMO texto,
 * apesar de serem estados epistemológicos opostos (ADR-010 §5):
 *
 *   REJECTED       → a evidência determina POSITIVAMENTE que a afirmação é falsa
 *   NOT_EVALUABLE  → a evidência não determina nada, nem a favor nem contra
 *
 * Tratar os dois como "os dados não sustentam" transforma ausência de evidência em falsidade —
 * exatamente o que `ADR-010 §15` proíbe explicitamente, só que na mensagem ao usuário, não na
 * barreira. Caso real recorrente: um usuário perguntando sobre "DeepSeek Harness" (o mesmo
 * incidente do S269) bateu em `NOT_EVALUABLE` repetidamente ao longo de um dia inteiro
 * (26/08/2026, 05:42–22:04), sempre recebendo uma mensagem que soa como "você disse algo falso".
 *
 * Correção: `groundingBlockedMessage()` ganha um terceiro texto, específico para `NOT_EVALUABLE`
 * — sem reaproveitar `g.reason` cru (formato técnico "REJECTED: N afirmação(ões)..." — texto de
 * log, não de usuário, mesma lição da issue 030). Puramente determinístico: `state` já é um enum
 * fechado decidido pelo LLM Judge; mapear texto por valor de enum já resolvido não reabre
 * interpretação semântica nenhuma.
 *
 * `AgentLoop` não pode ser instanciado fora do runtime completo (mesma restrição de S93/S269) —
 * mas `groundingBlockedMessage` é `private static`, chamável sem instância. Este teste chama a
 * função REAL de produção (não uma cópia/regex sobre o código-fonte).
 *
 * Execução: npx ts-node src/__tests__/regression/S284_GroundingBlockedMessage_DistinguishRejectedFromNotEvaluable.test.ts
 */

import { AgentLoop } from '../../loop/AgentLoop';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  OK ${message}`); passed++; }
    else { console.error(`  FALHOU: ${message}`, detail ?? ''); failed++; }
}

// Acesso ao método privado estático — mesma técnica já usada no projeto para métodos privados
// (ex.: chamadas de handler privado via `(loop as any)` nos testes de GoalExecutionLoop).
function blockedMessage(state: 'REJECTED' | 'NOT_EVALUABLE' | 'UNVALIDATED'): string {
    return (AgentLoop as unknown as { groundingBlockedMessage: (s: string) => string }).groundingBlockedMessage(state);
}

async function main(): Promise<void> {
    console.log('\n=== S284.1 — os 3 estados produzem TEXTOS DIFERENTES (a causa raiz era tratá-los como 1 só) ===');
    {
        const rejected = blockedMessage('REJECTED');
        const notEvaluable = blockedMessage('NOT_EVALUABLE');
        const unvalidated = blockedMessage('UNVALIDATED');

        assert(rejected !== notEvaluable, 'REJECTED e NOT_EVALUABLE não compartilham mais o mesmo texto (o defeito real de produção)', { rejected, notEvaluable });
        assert(notEvaluable !== unvalidated, 'NOT_EVALUABLE continua distinto de UNVALIDATED (já era antes)');
        assert(rejected !== unvalidated, 'REJECTED continua distinto de UNVALIDATED (já era antes)');
    }

    console.log('\n=== S284.2 — REJECTED: linguagem de CONTRADIÇÃO (evidência determina que é falso) ===');
    {
        const msg = blockedMessage('REJECTED');
        assert(/contradiz|contradição|contradizem/i.test(msg), 'usa linguagem de contradição/conflito', msg);
        assert(!/não encontrei confirmação|não determina/i.test(msg), 'não usa a linguagem de INDETERMINAÇÃO que agora pertence a NOT_EVALUABLE', msg);
    }

    console.log('\n=== S284.3 — NOT_EVALUABLE: linguagem de INDETERMINAÇÃO (evidência não decide nem a favor nem contra) ===');
    {
        const msg = blockedMessage('NOT_EVALUABLE');
        assert(/não encontrei|não determina|não chegam a confirmar|confirmação específica/i.test(msg), 'usa linguagem de ausência/indeterminação, não de contradição', msg);
        assert(!/contradiz|contradição|contradizem/i.test(msg), 'NÃO afirma que os dados contradizem — essa é a confusão real que este teste protege', msg);
        // A regra normativa exata que motivou a correção (ADR-010 §15).
        assert(/não é que os dados contradigam/i.test(msg), 'a mensagem nomeia explicitamente a distinção (ausência ≠ falsidade), não só implica', msg);
    }

    console.log('\n=== S284.4 — nenhuma mensagem vaza o texto técnico interno (g.reason) ===');
    {
        for (const state of ['REJECTED', 'NOT_EVALUABLE', 'UNVALIDATED'] as const) {
            const msg = blockedMessage(state);
            assert(!/afirmação\(ões\)|primeira não sustentada/i.test(msg),
                `${state}: não contém o formato técnico de g.reason ("N afirmação(ões); primeira não sustentada: ...")`, msg);
        }
    }

    console.log('\n=== S284.5 — nenhum estado devolve string vazia/undefined (fail-closed: sempre há uma mensagem) ===');
    {
        for (const state of ['REJECTED', 'NOT_EVALUABLE', 'UNVALIDATED'] as const) {
            const msg = blockedMessage(state);
            assert(typeof msg === 'string' && msg.trim().length > 20, `${state}: mensagem não-vazia e substancial`, msg);
        }
    }

    console.log('\n=== S284.6 [estrutural] — a distinção REJECTED/NOT_EVALUABLE não interfere na recuperação parcial (S269) ===');
    {
        const fs = await import('fs');
        const path = await import('path');
        const src = fs.readFileSync(path.resolve(__dirname, '../../loop/AgentLoop.ts'), 'utf8');
        // A ordem continua: record() de falha → tentativa de recuperação parcial → só então
        // groundingBlockedMessage(g.state) como fallback. Esta correção mudou só o CONTEÚDO da
        // função, nunca ONDE/QUANDO ela é chamada.
        const supportedClaimsIdx = src.indexOf('const supportedClaims = g.claims.filter');
        const blockedMessageCallIdx = src.indexOf('return AgentLoop.groundingBlockedMessage(g.state);');
        assert(supportedClaimsIdx !== -1 && blockedMessageCallIdx > supportedClaimsIdx,
            'groundingBlockedMessage(g.state) continua sendo chamada DEPOIS da tentativa de recuperação parcial — S269 intocado');
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S284 RESULTADO: ${passed} passou | ${failed} falhou`);
    if (failed > 0) process.exit(1);
    process.exit(0);
}

main().catch(err => { console.error('S284 erro inesperado:', err); process.exit(1); });
