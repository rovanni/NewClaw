/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S282 (issue 030, Sprint 4)
 *
 * `GoalBlocker.description` tem DOIS consumidores com necessidades opostas:
 *   - `GoalPlanner.buildReplanPrompt()` ("BLOCKER ATUAL: ${blocker.description}") — quer jargão
 *     interno, instrução imperativa ao LLM replanejador.
 *   - `GracefulDeliveryOrchestrator.buildFailureMessage()` ("O que faltou") — quer texto
 *     compreensível para o usuário final.
 *
 * Rastreada a cadeia completa (GoalExecutionLoop → blocker.description → GracefulDeliveryOrchestrator
 * → mensagem ao usuário), achados DOIS pontos reais de vazamento — não um caso isolado:
 *   1. `semantic_mismatch` (~GoalExecutionLoop.ts:1856): "...retornou output irrelevante sem chance
 *      de retry ajudar (ferramenta fixa, mesmos argumentos): ..." — jargão de retryBudget/mecanismo.
 *   2. "BONUS REPLAN" (~GoalExecutionLoop.ts:1598): "[BONUS REPLAN — 80% concluído] Complete APENAS
 *      os componentes pendentes: ..." — instrução IMPERATIVA dirigida ao LLM, não ao usuário.
 *
 * Correção na autoridade correta (quem PRODUZ o blocker, não o orquestrador que só o exibe): novo
 * campo opcional `GoalBlocker.userSummary` — a versão sem jargão, preenchida SÓ nos dois pontos que
 * misturavam instrução interna. `description` continua bit-a-bit idêntica (GoalPlanner não muda).
 * `GracefulDeliveryOrchestrator` passa a preferir `userSummary`, caindo para `description` quando
 * ausente — a maioria dos blockers ("Ferramenta 'X' não encontrada no sistema") já é legível e não
 * precisou de nada novo.
 *
 * Nota de escopo (auditoria cruzada): o Core hoje emite todo texto fixo em pt-BR, para qualquer
 * idioma configurado (`docs/issues/018`, débito conhecido e fora do escopo desta correção) — este
 * teste valida SÓ o texto em português, que é o único que o Core produz. A correção também não
 * toca filesystem/caminho/SO — puramente lógica em TypeScript, sem superfície Windows/Linux/macOS.
 *
 * Execução: npx ts-node src/__tests__/regression/S282_UserFacingBlockerSummary_NoInternalJargonLeak.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { GracefulDeliveryOrchestrator } from '../../loop/GracefulDeliveryOrchestrator';
import { makeLoop, makeGoal } from './_fixtures/goalLoopHarness';
import type { GoalBlocker } from '../../shared/domainTypes';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  OK ${message}`); passed++; }
    else { console.error(`  FALHOU: ${message}`, detail ?? ''); failed++; }
}

const JARGON_PATTERNS = [/retryBudget/i, /ferramenta fixa, mesmos argumentos/i, /BONUS REPLAN/i, /Complete APENAS/i, /após esgotar retryBudget/i, /alreadyHinted/i];

function blocker(over: Partial<GoalBlocker>): GoalBlocker {
    return { kind: 'tool_error', description: 'descrição padrão', suggestedActions: [], detectedAt: Date.now(), ...over };
}

async function main(): Promise<void> {
    const loopSrc = fs.readFileSync(path.resolve(__dirname, '../../loop/GoalExecutionLoop.ts'), 'utf8');
    const plannerSrc = fs.readFileSync(path.resolve(__dirname, '../../loop/GoalPlanner.ts'), 'utf8');

    console.log('\n=== S282.1 [estrutural] — os dois pontos de vazamento reais têm userSummary sem jargão ===');
    {
        const semanticBlock = loopSrc.slice(loopSrc.indexOf("kind: 'semantic_mismatch' as const"), loopSrc.indexOf("kind: 'semantic_mismatch' as const") + 800);
        assert(/userSummary: `A etapa/.test(semanticBlock), 'semantic_mismatch: userSummary preenchido', semanticBlock.slice(0, 200));
        assert(!/userSummary[\s\S]{0,200}(retryOutcomeLabel|ferramenta fixa|alreadyHinted)/.test(semanticBlock),
            'semantic_mismatch: userSummary NÃO contém o jargão (retryOutcomeLabel/ferramenta fixa/alreadyHinted)', semanticBlock);
        assert(/description: `Step[\s\S]{0,60}retornou output irrelevante \$\{retryOutcomeLabel\}/.test(semanticBlock),
            'semantic_mismatch: description ORIGINAL continua intocada (retryOutcomeLabel preservado, para o replanejador)', semanticBlock);

        const bonusAnchor = loopSrc.indexOf('[BONUS REPLAN');
        const bonusBlock = loopSrc.slice(bonusAnchor - 200, bonusAnchor + 500);
        assert(/userSummary: `O objetivo foi concluído parcialmente/.test(bonusBlock), 'bonus replan: userSummary preenchido', bonusBlock.slice(0, 200));
        assert(!/userSummary[\s\S]{0,200}(BONUS REPLAN|Complete APENAS)/.test(bonusBlock),
            'bonus replan: userSummary NÃO contém o imperativo dirigido ao LLM', bonusBlock);
        assert(/description: `\[BONUS REPLAN/.test(bonusBlock), 'bonus replan: description ORIGINAL continua intocada ([BONUS REPLAN], para o replanejador)', bonusBlock);
    }

    console.log('\n=== S282.2 [auditoria cruzada] — GoalPlanner (replanejamento) só lê .description, nunca .userSummary ===');
    {
        assert(/blocker\.description/.test(plannerSrc), 'GoalPlanner.ts continua lendo blocker.description (BLOCKER ATUAL do prompt de replan)', plannerSrc.includes('blocker.description'));
        assert(!/blocker\.userSummary/.test(plannerSrc), 'GoalPlanner.ts NUNCA lê blocker.userSummary — o replanejador continua recebendo o texto técnico completo', plannerSrc);
    }

    console.log('\n=== S282.3 — GracefulDeliveryOrchestrator (real, sem mock): prefere userSummary quando presente ===');
    {
        const authority = new GracefulDeliveryOrchestrator();
        const { goalStore } = makeLoop({ achieved: true });

        // (a) blocker com userSummary — a mensagem ao usuário usa a versão limpa, nunca o jargão.
        const goalWithSummary = makeGoal(goalStore, [], {
            blockers: [blocker({
                kind: 'semantic_mismatch',
                description: `Step 'Verificar o arquivo' retornou output irrelevante sem chance de retry ajudar (ferramenta fixa, mesmos argumentos): motivo real aqui`,
                userSummary: 'A etapa "Verificar o arquivo" não produziu o resultado esperado: motivo real aqui.',
            })],
        });
        const msgA = authority.buildFailureMessage(goalWithSummary);
        assert(msgA.includes('A etapa "Verificar o arquivo" não produziu o resultado esperado'), 'usa userSummary na seção "O que faltou"', msgA);
        for (const p of JARGON_PATTERNS) assert(!p.test(msgA), `jargão ${p} NÃO vaza para o usuário`, msgA);
        assert(msgA.includes('motivo real aqui'), 'o motivo real (dado, não jargão) continua presente', msgA);

        // (b) blocker SEM userSummary (o caso comum, ex. "Ferramenta 'X' não encontrada") —
        // comportamento de antes desta correção, inalterado.
        const goalWithoutSummary = makeGoal(goalStore, [], {
            blockers: [blocker({ kind: 'missing_tool', description: "Ferramenta 'pandoc' não encontrada no sistema" })],
        });
        const msgB = authority.buildFailureMessage(goalWithoutSummary);
        assert(msgB.includes("Ferramenta 'pandoc' não encontrada no sistema"), 'sem userSummary, cai para description normalmente (regressão do caminho comum)', msgB);
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S282 RESULTADO: ${passed} passou | ${failed} falhou`);
    if (failed > 0) process.exit(1);
    process.exit(0);
}

main().catch(err => { console.error('S282 erro inesperado:', err); process.exit(1); });
