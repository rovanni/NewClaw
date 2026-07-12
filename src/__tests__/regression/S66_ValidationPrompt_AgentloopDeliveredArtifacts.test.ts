/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S66
 * GoalExecutionLoop.validateGoalCompletion: prompt do validador deve enxergar
 * artefatos já entregues via agentloop (goal.sentArtifacts).
 *
 * PROBLEMA CORRIGIDO: quando um step sem toolName (dispatch via agentloop) executa
 * write+exec_command+send_document internamente, isso vira UMA tentativa opaca
 * toolName='agentloop' em goal.attempts — invisível para stepsContext/attemptsContext/
 * artifactBlock do prompt de validação. Se um replan seguinte roda apenas
 * read/exec_command/refresh_workspace (sem produzir nada novo), o validador só enxerga
 * ESSES steps e escreve um "summary" que ignora a entrega real já feita, confundindo o
 * usuário sobre o que realmente aconteceu.
 *
 * EVIDÊNCIA REAL (goal_1783430280404_xk7ht, 2026-07-07, sessão do suplemento PowerPoint):
 * um .pptx foi gerado e enviado com sucesso via agentloop; um step redundante de
 * exec_command (nome de script genérico — ver S67/pptx-generator) rodou um script antigo
 * por engano, disparou 2 mismatches semânticos e forçou um replan; o replan só releu o
 * markdown de origem; a validação final relatou "o arquivo .md foi lido e validado" —
 * nunca mencionando o .pptx que já tinha sido entregue.
 *
 * FIX: GoalExecutionLoop.ts / validateGoalCompletion — novo bloco deliveredArtifactsBlock
 * lê goal.sentArtifacts (populado pelo DELIVERY-GUARD durante agentloop), confirma
 * existência em disco via fs.statSync, e injeta no prompt do validador + instrução
 * explícita para o summary mencionar o artefato. artifactCount (métrica de log) também
 * passou a somar sentArtifacts.
 *
 * REGRESSÃO SE: deliveredArtifactsBlock for removido do prompt, ou sentArtifacts parar
 * de ser lido em validateGoalCompletion.
 *
 * Execução: npx ts-node src/__tests__/regression/S66_ValidationPrompt_AgentloopDeliveredArtifacts.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`); failed++; }
}

// ── Teste 1: réplica exata da lógica de deliveredArtifactLines ──────────────

console.log('\n=== S66 — deliveredArtifactsBlock inclui artefato existente em disco ===');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'S66-'));
const realArtifact = path.join(tmpDir, 'aula_dhcp.pptx');
fs.writeFileSync(realArtifact, Buffer.alloc(1024, 'x'));

function buildDeliveredArtifactLines(sentArtifacts: string[]): string[] {
    const lines: string[] = [];
    for (const rawPath of sentArtifacts) {
        if (rawPath === '__send_audio_delivered__') continue;
        try {
            const stat = fs.statSync(rawPath);
            lines.push(`- ${rawPath} (${stat.size} bytes, já entregue ao usuário nesta sessão)`);
        } catch {
            // arquivo listado como entregue mas não encontrado em disco — não afirmar entrega
        }
    }
    return lines;
}

const withRealFile = buildDeliveredArtifactLines([realArtifact]);
assert(withRealFile.length === 1, 'artefato existente em disco gera 1 linha no bloco');
assert(withRealFile[0].includes('1024 bytes'), 'linha inclui o tamanho real do arquivo');
assert(withRealFile[0].includes('já entregue'), 'linha sinaliza explicitamente que já foi entregue');

// ── Teste 2: sentinela de áudio é ignorada (não é arquivo real) ─────────────

console.log('\n=== S66 — sentinela __send_audio_delivered__ é filtrada ===');

const withSentinelOnly = buildDeliveredArtifactLines(['__send_audio_delivered__']);
assert(withSentinelOnly.length === 0, 'sentinela de dedup de áudio não vira linha no bloco (não é path de arquivo)');

const mixed = buildDeliveredArtifactLines([realArtifact, '__send_audio_delivered__']);
assert(mixed.length === 1, 'sentinela é filtrada mesmo misturada com artefato real');

// ── Teste 3: artefato listado mas ausente em disco não gera alegação falsa ──

console.log('\n=== S66 — artefato inexistente em disco não entra no bloco ===');

const missingPath = path.join(tmpDir, 'nao-existe.pptx');
const withMissing = buildDeliveredArtifactLines([missingPath]);
assert(withMissing.length === 0, 'path sem arquivo correspondente em disco não gera afirmação de entrega');

// ── Teste 4: goal sem sentArtifacts produz bloco vazio (sem quebrar o prompt) ──

console.log('\n=== S66 — sem sentArtifacts o bloco fica vazio ===');

const emptyLines = buildDeliveredArtifactLines([]);
const emptyBlock = emptyLines.length > 0
    ? `\nARTEFATOS JÁ ENTREGUES...\n${emptyLines.join('\n')}`
    : '';
assert(emptyBlock === '', 'goal sem entregas anteriores não injeta bloco algum no prompt');

fs.rmSync(tmpDir, { recursive: true, force: true });

// ── Teste 5: confirmação no source — fix presente em GoalExecutionLoop.ts ───

console.log('\n=== S66 — confirmação no source GoalExecutionLoop.ts ===');

const loopPath = path.join(process.cwd(), 'src', 'loop', 'GoalExecutionLoop.ts');
const loopSource = fs.readFileSync(loopPath, 'utf-8');

assert(
    /deliveredArtifactsBlock/.test(loopSource),
    'deliveredArtifactsBlock está declarado em GoalExecutionLoop.ts',
);

assert(
    /goal\.sentArtifacts ?\?\? \[\]\)\s*\{/.test(loopSource) || /for \(const rawPath of goal\.sentArtifacts/.test(loopSource),
    'validateGoalCompletion itera goal.sentArtifacts para montar o bloco de artefatos entregues',
);

assert(
    /\$\{attemptsContext \|\| '\(nenhum\)'\}\$\{artifactBlock\}\$\{deliveredArtifactsBlock\}/.test(loopSource),
    'deliveredArtifactsBlock está de fato concatenado no prompt enviado ao validador (não só declarado)',
);

assert(
    /ARTEFATOS JÁ ENTREGUES AO USUÁRIO/.test(loopSource),
    'instrução explícita ao validador sobre artefatos já entregues está presente no prompt',
);

assert(
    /\(goal\.sentArtifacts \?\? \[\]\)\.filter\(a => a !== '__send_audio_delivered__'\)\.length/.test(loopSource),
    'artifactCount (métrica de log) soma sentArtifacts, não fica preso a attempts write/send_document',
);

// ── Resultado ────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(60)}`);
console.log(`S66 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
console.log(`\nCOBERTURA:`);
console.log(`  Artefato real em disco entra no bloco: testado`);
console.log(`  Sentinela de áudio filtrada: testado`);
console.log(`  Artefato ausente em disco não afirma entrega: testado`);
console.log(`  Goal sem entregas produz bloco vazio: testado`);
console.log(`  Confirmação no source: testado`);
if (failed > 0) process.exit(1);
