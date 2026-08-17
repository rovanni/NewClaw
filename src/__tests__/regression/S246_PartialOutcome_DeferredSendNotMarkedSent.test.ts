/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S246
 * GoalExecutionLoop.handlePartialOutcome(): um send_document meramente AGENDADO
 * (cycleResult.deferredSends) por um step cujo outcome caiu para 'partial' NÃO pode ser
 * marcado em sentArtifacts como se já tivesse sido ENTREGUE.
 *
 * HISTÓRICO: o teste S10 (S10_SentArtifacts_DeliveryGuard.test.ts) já documentou e corrigiu,
 * em 02/07/2026, EXATAMENTE esta classe de bug — mas só no bloco de `case 'success'` do switch
 * de outcomes (hoje handleSuccessOutcome). Um bloco GÊMEO ("CORREÇÃO 2 (S10-PARTIAL)"), presente
 * em handlePartialOutcome desde a criação de GoalExecutionLoop.ts (13/06/2026), fazia a MESMA
 * coisa errada — chamava trackArtifact(fp) para todo `cycleResult.deferredSends`, com a premissa
 * de que isso cobria "DELIVERY-GUARD entregou mas o callback onArtifactDelivered falhou
 * silenciosamente". Essa premissa é estruturalmente impossível: deferredSends é populado por
 * deferSendDocument() (intercept de send_document sob reason=goal_execution_policy, AgentLoop.ts)
 * — só existe quando o envio foi DIFERIDO, nunca quando foi entregue de verdade. Entrega real
 * (DELIVERY-GUARD) sinaliza por um callback inteiramente separado, onArtifactDelivered, que nunca
 * alimenta deferredSends. O regex do teste S10 prendia o padrão de código exato do bloco antigo
 * (`if (fp) trackArtifact(fp)`, sem a condição extra `&& !sentArtifacts.has(fp)` nem o log
 * `[S10-PARTIAL]`) — por isso não pegou este gêmeo em handlePartialOutcome, escrito com uma
 * sintaxe levemente diferente.
 *
 * INCIDENTE REAL (newclaw-audit.log + newclaw.db, 16/08/2026, goal_1786897254318_i6lzp, sessão
 * web:o3-reproducao, "qual o valor do dolar hoje?"): o primeiro ciclo do step 'agentloop' (3ª
 * estratégia, planGeneration=2) escreveu tmp/cotacao_dolar.txt e deferiu o envio (AGENTLOOP-SEND,
 * file_path="tmp/cotacao_dolar.txt") — mas teve outcome rebaixado para 'partial' por
 * SEMANTIC-MISMATCH. O bloco S10-PARTIAL marcou tmp/cotacao_dolar.txt como "já enviado" em
 * sentArtifacts NESTE MOMENTO, antes de qualquer envio real. Cascata resultante, confirmada via
 * consulta direta a goals.attempts no SQLite: (1) o retry bem-sucedido do mesmo step não
 * reinjetou o send como pending step (DELIVERY-DEDUP contra sentArtifacts); (2) no despacho
 * final do send_document original do plano (step_3, file_path="cotacao_dolar.txt" — inferido por
 * RiskAnalyzer de um step 'write' irmão AINDA NÃO EXECUTADO, sem o prefixo "tmp/" real),
 * resolveArtifactPathFromEvidence() encontrou corretamente "tmp/cotacao_dolar.txt" em
 * goal.attempts (result='success', producedArtifactPaths correto) — mas o guard
 * `!sentArtifacts.has(evidencePath)` bloqueou a correção, porque o arquivo já constava como
 * "enviado". SendDocumentTool então falhou com "Arquivo não encontrado:
 * C:\Users\lucia\NewClaw\workspace\cotacao_dolar.txt", e o goal terminou success=false apesar do
 * conteúdo real já pronto e correto em disco.
 *
 * FIX (GoalExecutionLoop.ts, handlePartialOutcome): bloco S10-PARTIAL removido por completo —
 * mesma correção que já existe em handleSuccessOutcome desde 02/07/2026. Nenhum trackArtifact()
 * é chamado a partir de deferredSends em NENHUM outcome; sentArtifacts só recebe um artefato via
 * execução real de send_document (dispatch bem-sucedido) ou via callback onArtifactDelivered
 * (entrega direta do DELIVERY-GUARD) — nunca por mera intenção de enviar mais tarde.
 *
 * REGRESSÃO SE: handlePartialOutcome voltar a chamar trackArtifact()/sentArtifacts.add() a
 * partir de cycleResult.deferredSends, sob qualquer condição.
 *
 * Execução: npx ts-node src/__tests__/regression/S246_PartialOutcome_DeferredSendNotMarkedSent.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { resolveArtifactPathFromEvidence } from '../../loop/planning/artifactContract';
import { Goal, GoalAttempt } from '../../loop/GoalTypes';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

// ── 1. Inspeção do source: handlePartialOutcome não chama trackArtifact a partir de
// cycleResult.deferredSends (extrai só o corpo dessa função, não o arquivo inteiro — o bug
// gêmeo escapou do teste S10 justamente por viver numa função diferente da que aquele teste
// inspeciona) ──────────────────────────────────────────────────────────────────────────────

console.log('\n=== S246 — Inspeção do source: handlePartialOutcome ===');

const loopPath = path.join(process.cwd(), 'src', 'loop', 'GoalExecutionLoop.ts');
const loopSource = fs.readFileSync(loopPath, 'utf-8');

const partialStart = loopSource.indexOf('private async handlePartialOutcome');
assert(partialStart !== -1, 'handlePartialOutcome() encontrado no source');
const nextMethodStart = loopSource.indexOf('\n    private ', partialStart + 1);
const partialBody = loopSource.slice(partialStart, nextMethodStart === -1 ? undefined : nextMethodStart);

assert(
    !/for\s*\(\s*const sendArgs of cycleResult\.deferredSends/.test(partialBody),
    'handlePartialOutcome() não itera mais cycleResult.deferredSends (bloco S10-PARTIAL removido) — checagem no CÓDIGO, não em comentários explicativos',
);
assert(
    !/[^/]\btrackArtifact\(/.test(partialBody.replace(/\/\/.*$/gm, '')),
    'handlePartialOutcome() não chama trackArtifact() em nenhuma circunstância (comentários excluídos da checagem)',
);
assert(
    !/\[S10-PARTIAL\]/.test(loopSource),
    'log [S10-PARTIAL] (do bloco removido) não existe mais em nenhum lugar do arquivo',
);

// ── 2. handleSuccessOutcome (o gêmeo já corrigido em 02/07/2026) continua correto — não
// regrediu ao aplicar o fix simétrico em handlePartialOutcome ──────────────────────────────────

console.log('\n=== S246 — handleSuccessOutcome (fix histórico de 02/07/2026) permanece intacto ===');

assert(
    /onArtifactDelivered:\s*\(filePath: string\)\s*=>\s*\{/.test(loopSource),
    'callback onArtifactDelivered (entrega real, DELIVERY-GUARD) continua presente',
);
assert(
    /\(fp\) => \{ if \(fp\) trackArtifact\(fp\); \}/.test(loopSource),
    'trackArtifact em entrega real (não agendamento) continua presente em outro call site',
);

// ── 3. Simulação: reproduz a cascata completa do incidente real (goal_1786897254318_i6lzp) ──

console.log('\n=== S246 — Simulação: reproduz goal_1786897254318_i6lzp ("qual o valor do dolar hoje?") ===');

function makeGoal(attempts: GoalAttempt[], sentArtifacts: string[]): Goal {
    const now = Date.now();
    return {
        id: 'goal_s246',
        sessionKey: 'web:s246',
        conversationId: 's246',
        userIntent: 'qual o valor do dolar hoje?',
        objective: 'informar a cotação do dólar',
        status: 'executing',
        currentPlan: [],
        attempts,
        sentArtifacts,
        blockers: [],
        toolsTried: [],
        strategiesTried: [],
        successCriteria: [],
        retryBudget: 3,
        replanBudget: 3,
        confidence: 0.9,
        requiresAuth: false,
        authorizationScope: [],
        createdAt: now,
        updatedAt: now,
        expiresAt: now + 3600_000,
    };
}

// Réplica do dispatch final (mesmo shape do bloco real em GoalExecutionLoop.ts, já exercido
// isoladamente pelo teste S163 — aqui reusado para provar a cascata ponta-a-ponta).
function correctSendPath(
    filePath: string,
    validationArtifactPaths: string[],
    sentArtifacts: Set<string>,
    goal: Goal,
    stepDescription: string,
    fileExists: (p: string) => boolean,
): { corrected: string; reason: string } {
    if (!fileExists(filePath)) {
        const candidates = validationArtifactPaths.filter(p => p !== filePath && !sentArtifacts.has(p) && fileExists(p));
        if (candidates.length === 1) {
            return { corrected: candidates[0], reason: 'requested_file_missing_single_validated_artifact_found' };
        }
        const evidencePath = resolveArtifactPathFromEvidence(goal, stepDescription)
            ?? resolveArtifactPathFromEvidence(goal, '');
        if (evidencePath && evidencePath !== filePath && !sentArtifacts.has(evidencePath) && fileExists(evidencePath)) {
            return { corrected: evidencePath, reason: 'requested_file_missing_evidence_based_fallback' };
        }
    }
    return { corrected: filePath, reason: 'unchanged' };
}

const REAL_FILE = 'tmp/cotacao_dolar.txt';
const fileExists = (p: string) => p === REAL_FILE;

// Attempts reais extraídos de goals.attempts (SQLite) para goal_1786897254318_i6lzp: a
// pseudo-attempt injetada por finalizeStepAttempt() quando o AgentLoop deferiu o send_document
// dentro do step 'agentloop' — presente independentemente do outcome do step ter caído para
// 'partial' (isso nunca mudou; o bug estava em sentArtifacts, não em goal.attempts).
const attempts: GoalAttempt[] = [
    {
        id: 'att_agentloop_write_1', planStepId: 'step_2', toolName: 'send_document',
        args: { file_path: REAL_FILE }, result: 'success',
        output: '[AGENTLOOP-WRITE] Arquivo gravado e entregue pelo AgentLoop',
        durationMs: 0, executedAt: Date.now(),
        producedArtifactPaths: [REAL_FILE],
    } as GoalAttempt,
];

{
    // CENÁRIO CORRIGIDO: handlePartialOutcome não chamou trackArtifact — sentArtifacts chega
    // vazio ao dispatch final, exatamente como a inspeção do source (seção 1) agora garante.
    const sentArtifacts = new Set<string>();
    const goal = makeGoal(attempts, [...sentArtifacts]);

    // step_3 do plano: file_path inferido por RiskAnalyzer de um 'write' irmão não verificado
    // (mesma mecânica do S163) — falta o prefixo "tmp/" real.
    const result = correctSendPath(
        'cotacao_dolar.txt',
        [], // validation.artifactPaths vazio (write aconteceu dentro do agentloop opaco)
        sentArtifacts,
        goal,
        'Enviar o arquivo de texto com a cotação do dólar diretamente ao usuário',
        fileExists,
    );

    assert(
        result.reason === 'requested_file_missing_evidence_based_fallback',
        `com sentArtifacts correto (vazio), a correção evidence-based dispara (obtido: ${result.reason})`,
    );
    assert(
        result.corrected === REAL_FILE,
        `e corrige para o artefato real, tmp/cotacao_dolar.txt (obtido: "${result.corrected}")`,
    );
}

{
    // CENÁRIO DO BUG (para contraste — prova que a simulação captura o mecanismo certo):
    // se sentArtifacts já contivesse o artefato real (o que o bloco removido fazia), a mesma
    // correção teria ficado bloqueada pelo guard `!sentArtifacts.has(evidencePath)`, e o
    // send_document falharia com o file_path original, nunca existente em disco.
    const sentArtifactsPoisoned = new Set<string>([REAL_FILE]);
    const goal = makeGoal(attempts, [...sentArtifactsPoisoned]);

    const result = correctSendPath(
        'cotacao_dolar.txt',
        [],
        sentArtifactsPoisoned,
        goal,
        'Enviar o arquivo de texto com a cotação do dólar diretamente ao usuário',
        fileExists,
    );

    assert(
        result.reason === 'unchanged' && result.corrected === 'cotacao_dolar.txt',
        `contraste: com sentArtifacts poluído (bug antigo), a correção fica bloqueada e o dispatch usaria o path inexistente (obtido: reason=${result.reason} corrected="${result.corrected}")`,
    );
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S246 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
console.log(`\nCOBERTURA:`);
console.log(`  handlePartialOutcome não chama trackArtifact a partir de deferredSends (source): testado`);
console.log(`  handleSuccessOutcome (fix gêmeo de 02/07/2026) não regrediu: testado`);
console.log(`  Reprodução da cascata completa do incidente real (goal_1786897254318_i6lzp): simulado`);
console.log(`  Contraste com o comportamento antigo (poisoned sentArtifacts): simulado`);
if (failed > 0) process.exit(1);
