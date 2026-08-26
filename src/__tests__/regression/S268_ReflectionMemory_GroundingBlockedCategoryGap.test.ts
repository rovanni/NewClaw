/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S268
 *
 * Achado real (26/08/2026, C:\Users\lucia\Downloads\prompt.txt +
 * C:\Users\lucia\NewClaw\logs\newclaw-audit.log): o usuário perguntou "O que é deepseek
 * harness?" 4 vezes na MESMA conversa (web:conv_1787700769312), em 25/08 20:33, 21:10, 23:21 e
 * 26/08 05:41 — nas 4 vezes a barreira de groundedness (ADR-010, AgentLoop.commitResponse)
 * bloqueou a entrega com estado NOT_EVALUABLE, e nas 4 vezes o usuário recebeu a mesma mensagem
 * genérica sem nenhuma adaptação de estratégia entre tentativas.
 *
 * Causa raiz isolada por leitura de código (não hipótese): o record() chamado no bloqueio de
 * grounding (AgentLoop.ts, dentro de commitResponse, logo após
 * `log.warn(...[GROUNDING] estado=...)`) grava pattern='grounding_blocked' mas NUNCA passou
 * `category` — ao contrário do record() do ObserverValidator "normal" (mesmo arquivo, ~30 linhas
 * abaixo, dentro de validateAndReflect) que sempre inclui `category` vindo de
 * intentDecision.category. Como ReflectionMemory.findCategoryHints(intentDecision.category) —
 * o único mecanismo que o turno de chat (AgentLoop, categoria "information") consulta para saber
 * "esse tipo de pedido tende a falhar?" — filtra por `category = ?` (com fallback só para
 * registros legados onde `pattern` literalmente contém o nome da categoria, o que nunca é o caso
 * aqui: pattern='grounding_blocked' ≠ category='information'), toda falha de grounding ficava
 * INVISÍVEL para esse hint. Resultado observado no log real: TURN-DIAGNOSTICS da 4ª tentativa
 * (05:41) mostra `reflectionHint: injected=false ... followed=false` mesmo após 3 bloqueios
 * idênticos anteriores na mesma conversa — o sistema não tinha como aprender e repetia a mesma
 * jogada perdedora indefinidamente.
 *
 * Correção: `category: last.category` adicionado ao record() do bloqueio de grounding
 * (last = this.getTurnState(conversationId).lastToolExecution, já populado com
 * intentDecision.category em todo write-site — dado já em escopo, nenhum parâmetro novo
 * threading por 6 call sites de commitResponse). TurnState.lastToolExecution.category também
 * teve o tipo apertado de `string` para `IntentCategory` (era `string` solto; os 3 write-sites já
 * só atribuíam IntentCategory de verdade — a tipagem larga só escondia que o record() abaixo
 * podia receber (ou, como aqui, deixar de receber) um valor incompatível sem o compilador acusar).
 *
 * Isto é uma lacuna DISTINTA das 5 já documentadas em S16 (aquelas eram sobre prefixo de string /
 * fragmentação por tool_used nos mecanismos de S3a-S4/ARCH-006; esta é sobre um campo
 * simplesmente nunca preenchido no ÚNICO record() introduzido depois, pela barreira de
 * groundedness do ADR-010).
 *
 * NÃO é o mecanismo que decide se a resposta É correta — a barreira ADR-010/C1 e sua política de
 * bloqueio continuam exatamente como estavam. Este teste cobre só a integração dela com o loop de
 * aprendizado pós-falha (ReflectionMemory) que já existia para todo o resto do sistema.
 *
 * Execução: npx ts-node src/__tests__/regression/S268_ReflectionMemory_GroundingBlockedCategoryGap.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { ReflectionMemory } from '../../memory/ReflectionMemory';

function createInMemoryReflectionMemory(): ReflectionMemory {
    const db = new (Database as any)(':memory:');
    const mockMemoryManager = { getDatabase: () => db } as any;
    return new ReflectionMemory(mockMemoryManager);
}

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`); failed++; }
}

function readSource(relPath: string): string {
    return fs.readFileSync(path.join(process.cwd(), 'src', relPath), 'utf-8');
}

async function main() {
    console.log('\n=== S268.1 — record() do bloqueio de grounding agora inclui category (leitura de código) ===');

    const agentLoopSrc = readSource('loop/AgentLoop.ts');
    const groundingBlockSite = agentLoopSrc.slice(
        agentLoopSrc.indexOf("[GROUNDING] estado=${g.state}"),
        agentLoopSrc.indexOf("return AgentLoop.groundingBlockedMessage(g.state);"),
    );
    assert(
        /pattern:\s*'grounding_blocked'/.test(groundingBlockSite),
        "o bloco de bloqueio de grounding ainda grava pattern='grounding_blocked' (comportamento existente preservado)"
    );
    assert(
        /category:\s*last\.category,?\s*\}\);/.test(groundingBlockSite),
        "record() do bloqueio de grounding agora passa category: last.category — gap fechado"
    );

    console.log('\n=== S268.2 — TurnState.lastToolExecution.category tipado como IntentCategory (não string solto) ===');
    const turnStateDecl = agentLoopSrc.slice(
        agentLoopSrc.indexOf('export interface TurnState'),
        agentLoopSrc.indexOf('pendingObserverFeedback: string[];'),
    );
    assert(
        /lastToolExecution:\s*\{\s*toolName:\s*string;\s*toolOutput:\s*string;\s*intent:\s*string;\s*category:\s*IntentCategory\s*\}\s*\|\s*null;/.test(turnStateDecl),
        'TurnState.lastToolExecution.category é IntentCategory, não string — o compilador agora barra um record() sem categoria válida'
    );

    // ── S268.3 — reprodução comportamental do incidente real ──────────────────────
    // Simula exatamente o que os 4 turnos do log real gravaram: 2+ bloqueios de grounding
    // (pattern='grounding_blocked', approved=false) para a MESMA categoria ("information"),
    // sem nenhum sucesso recente que suprimisse o sinal — igual à conversa real, onde as 4
    // tentativas falharam e nenhuma teve sucesso nas 3h anteriores.
    console.log('\n=== S268.3 — Com category preenchida, findCategoryHints("information") enxerga bloqueios de grounding repetidos (reprodução do incidente) ===');

    const rmFixed = createInMemoryReflectionMemory();
    for (let i = 0; i < 3; i++) {
        rmFixed.record({
            userInput: 'O que é deepseek harness?',
            intent: 'information',
            toolUsed: i < 2 ? 'web_search' : 'web_navigate',
            approved: false,
            reason: `NOT_EVALUABLE: ${i + 5} afirmação(ões) não sustentada(s)`,
            confidence: 0,
            pattern: 'grounding_blocked',
            outcome: 'failure',
            category: 'information',
        });
    }
    const hintFixed = rmFixed.findCategoryHints('information');
    assert(
        hintFixed.length > 0,
        `com a correção, 3 bloqueios repetidos de grounding na categoria "information" produzem um hint não-vazio (retornou: "${hintFixed.slice(0, 70) || '(vazio)'}")`
    );

    console.log('\n=== S268.4 — Sem category (comportamento ANTERIOR à correção), o mesmo histórico ficava invisível ===');

    const rmBroken = createInMemoryReflectionMemory();
    for (let i = 0; i < 3; i++) {
        rmBroken.record({
            userInput: 'O que é deepseek harness?',
            intent: 'information',
            toolUsed: i < 2 ? 'web_search' : 'web_navigate',
            approved: false,
            reason: `NOT_EVALUABLE: ${i + 5} afirmação(ões) não sustentada(s)`,
            confidence: 0,
            pattern: 'grounding_blocked',
            outcome: 'failure',
            // category OMITIDA deliberadamente — reproduz o bug tal como estava em produção.
        });
    }
    const hintBroken = rmBroken.findCategoryHints('information');
    assert(
        hintBroken.length === 0,
        'sem category (bug original), findCategoryHints("information") não encontra os mesmos 3 registros — confirma que o hint dependia exclusivamente do campo que faltava'
    );

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S268 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    if (failed > 0) process.exit(1);
}

main().catch(err => { console.error('ERRO NÃO TRATADO:', err); process.exit(1); });
