/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S74
 *
 * Investigação (08/07/2026, log real — terceira parte da mesma sessão de S72/S73):
 * usuário pediu áudio sobre cripto às 23:27 (bem-sucedido) e, dois minutos depois,
 * perguntou "Consegue me enviar o texto que gerou o áudio para eu analisar?". O
 * sistema tentou memory_search, exec_command, read, exec_command, memory_search — e
 * falhou em TODAS as tentativas porque o texto nunca existiu em lugar nenhum
 * persistido:
 *
 *   - send_audio.ts gera o mp3/ogg, envia, e IMEDIATAMENTE apaga os dois arquivos
 *     (cleanupFiles) — o `text` recebido como argumento nunca é salvo em disco.
 *   - GoalExecutionLoop.ts:1648 já chama sessionManager.recordToolCall(...) para
 *     cada step bem-sucedido — mas o pedido de áudio original (23:27) rotou por
 *     `route=agentloop` (log: GOAL-ROUTING route=agentloop reason=heuristic_negative),
 *     não por GoalExecutionLoop.
 *   - AgentLoop.ts (usado por route=agentloop) NUNCA chamava recordToolCall em
 *     nenhum dos 3 pontos onde despacha tool calls — cycleHistory (onde os
 *     toolArgs ficavam) é uma `const` local ao método runWithTools(), descartada
 *     assim que o turno termina.
 *
 * Resultado real: o áudio foi gerado e entregue com sucesso, mas o texto usado
 * ficou irrecuperável — não por falha de busca, mas porque o dado nunca existiu
 * em nenhum lugar consultável. GoalExecutionLoop e AgentLoop são os dois caminhos
 * de execução de turno (a escolha entre eles é uma classificação de intent que o
 * usuário não controla) e deveriam ter paridade de comportamento aqui.
 *
 * Fix: os 3 pontos de despacho de tool call em AgentLoop.ts (nativo, json_action,
 * delivery-guard) passam a chamar sessionContext.getSessionManager().recordToolCall(...)
 * após sucesso, no mesmo formato já usado por GoalExecutionLoop.ts — reuso da
 * infraestrutura de transcript já existente (recordToolCall já existia, só nunca
 * era chamado por este caminho), sem nenhuma tabela/campo novo.
 *
 * Escopo tocado: session/SessionContext.ts (1 getter novo), loop/AgentLoop.ts
 * (3 call sites).
 *
 * Nota de escopo: este teste é estrutural (inspeção de código-fonte), não
 * funcional — AgentLoop.runWithTools() tem um grafo de dependências grande
 * (ProviderFactory, MemoryManager, SkillLearner, SkillLoader, ...) que tornaria um
 * teste de execução real caro e frágil para provar um ponto que é, em essência,
 * "esta chamada existe e está no lugar certo". Mesmo padrão já usado em S36-4 e
 * S71-10 para reivindicações equivalentes (código presente vs. ausente em um
 * caminho de execução específico).
 *
 * Execução: npx ts-node src/__tests__/regression/S74_AgentLoop_ToolCallPersistence.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

function readSrc(relPath: string): string {
    return fs.readFileSync(path.join(process.cwd(), 'src', relPath), 'utf-8');
}

async function main(): Promise<void> {

console.log('\n=== S74-1 [estrutural] — SessionContext expõe o SessionManager para callers externos ===');
{
    const src = readSrc('session/SessionContext.ts');
    assert(/getSessionManager\(\):\s*SessionManager\s*\{\s*return this\.sessionManager;\s*\}/.test(src),
        'SessionContext.getSessionManager() existe e retorna a instância injetada no construtor', null);
}

console.log('\n=== S74-2 [estrutural] — os 3 pontos de despacho de tool call em AgentLoop chamam recordToolCall após sucesso ===');
{
    const src = readSrc('loop/AgentLoop.ts');

    const occurrences = [...src.matchAll(/\.getSessionManager\(\)\.recordToolCall\(/g)];
    assert(occurrences.length === 3,
        `exatamente 3 call sites de recordToolCall em AgentLoop.ts (nativo, json_action, delivery-guard) — encontrado: ${occurrences.length}. Se um novo caminho de despacho de tool for adicionado no futuro, ele também precisa desse registro.`,
        occurrences.length);

    // Cada ocorrência deve estar condicionada a sucesso da tool E a channelContext existir
    // (sem channelContext não há como montar a SessionKey channel/userId).
    for (const m of occurrences) {
        const idx = m.index ?? 0;
        const before = src.slice(Math.max(0, idx - 250), idx);
        const hasSuccessGuard = /result\.success\s*&&\s*channelContext|result\.result\.success\s*&&\s*channelContext/.test(before);
        assert(hasSuccessGuard, `call site em offset ${idx} está condicionado a (result.success ou result.result.success) && channelContext`, before.slice(-150));
    }

    // Confirma que o padrão usado é fire-and-forget (.catch(() => {})) — mesma convenção do
    // GoalExecutionLoop.ts:1648..1652, para nunca bloquear/derrubar o turno por falha de
    // persistência do transcript (que é best-effort, não crítica para a resposta ao usuário).
    for (const m of occurrences) {
        const idx = m.index ?? 0;
        const after = src.slice(idx, idx + 400);
        assert(/\)\.catch\(\(\) => \{\}\);/.test(after), `call site em offset ${idx} é fire-and-forget (.catch(() => {})), não bloqueia nem derruba o turno em caso de falha`, after);
    }
}

console.log('\n=== S74-3 [estrutural] — GoalExecutionLoop mantém seu próprio recordToolCall (paridade, não regressão) ===');
{
    const src = readSrc('loop/GoalExecutionLoop.ts');
    assert(src.includes('this.sessionManager.recordToolCall('),
        'GoalExecutionLoop.ts continua chamando sessionManager.recordToolCall diretamente (já tinha isso antes do S74 — não foi alterado, só replicado para o outro caminho)', null);
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S74 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;

}

main().catch((err) => {
    console.error('S74 erro inesperado:', err);
    process.exitCode = 1;
});
