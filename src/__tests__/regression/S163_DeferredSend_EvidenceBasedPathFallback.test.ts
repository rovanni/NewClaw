/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S163
 * GoalExecutionLoop: send_document diferido com file_path inferido de um 'write' irmão
 * NUNCA VERIFICADO, despachado bem depois de replans que podem ter abandonado esse write
 *
 * INCIDENTE REAL (newclaw-audit.log, 2026-07-30 19:40:49-19:43:13, goal_1785451137648_rf6nv,
 * Telegram): RiskAnalyzer inferiu `send_document.file_path = "workspace/Aula_Montada.txt"` de
 * um step 'write' IRMÃO no MESMO batch de plano ("file_path inferred from prior write" —
 * RiskAnalyzer.ts linha ~647), sem checar se aquele write de fato rodaria com sucesso. O
 * send_document ficou pendente (diferido) e só foi despachado ~2min30s depois, atravessando
 * outros replans — nesse meio tempo o write original nunca produziu o arquivo. Resultado:
 * "Arquivo não encontrado" no despacho, apesar de um OUTRO artefato real e completo
 * (tmp/aula_sdt_passo_a_passo.txt) já existir em disco e ter sido a resposta de fato entregue
 * ao usuário no MESMO ciclo — o goal foi reportado como "1 de 2 arquivo(s) não entregues"
 * mesmo com o conteúdo real já na mão do usuário.
 *
 * O mecanismo de correção já existente em runValidationAchievedPhase() (achado 2026-07-12,
 * `[SEND-PATH-CORRECTED]`) só olha `validation.artifactPaths` (confirmados pela própria
 * validação LLM do goal) — quando isso não resolve para exatamente 1 candidato (0 ou >1), o
 * código antigo desistia e deixava o send falhar.
 *
 * FIX: quando validation.artifactPaths não resolve, cai para
 * resolveArtifactPathFromEvidence() (já existente, criado pela Sprint R5-R7 para RiskAnalyzer)
 * — a MESMA fonte de verdade de evidência real (goal.attempts com result='success' e
 * producedArtifactPaths verificados em disco), consultada de novo no momento real do
 * despacho, não só no momento (mais cedo, potencialmente obsoleto) do replan.
 *
 * REGRESSÃO SE: o fallback evidence-based for removido, ou passar a rodar ANTES do fallback
 * de validation.artifactPaths (a ordem importa: validation.artifactPaths é mais específico ao
 * ciclo atual), ou aceitar um path que não existe em disco / já foi enviado.
 *
 * Execução: npx ts-node src/__tests__/regression/S163_DeferredSend_EvidenceBasedPathFallback.test.ts
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

// ── 1. Inspeção do source: fallback presente e na ordem correta ────────────────

console.log('\n=== S163 — Inspeção do source GoalExecutionLoop.ts ===');

const loopPath = path.join(process.cwd(), 'src', 'loop', 'GoalExecutionLoop.ts');
const loopSource = fs.readFileSync(loopPath, 'utf-8');

assert(
    /resolveArtifactPathFromEvidence\(goal, String\(sendStep\.description[\s\S]{0,60}\?\?[\s\S]{0,40}resolveArtifactPathFromEvidence\(goal, ''\)/.test(loopSource),
    'resolveArtifactPathFromEvidence() tenta com sendStep.description E, se vazio, com goal.userIntent (sem viés da descrição do step que falhou)'
);

const candidatesIdx = loopSource.indexOf('candidates.length === 1');
const evidenceIdx = loopSource.indexOf('resolveArtifactPathFromEvidence(goal, String(sendStep.description');
assert(
    candidatesIdx !== -1 && evidenceIdx !== -1 && candidatesIdx < evidenceIdx,
    'fallback evidence-based vem DEPOIS da checagem de validation.artifactPaths (ordem correta)'
);

assert(
    /evidencePath && evidencePath !== filePath && !sentArtifacts\.has\(evidencePath\) && fs\.existsSync/.test(loopSource),
    'fallback só aceita o path de evidência se existir em disco e ainda não tiver sido enviado'
);

// ── 2. Simulação: reproduz o incidente real (rf6nv) ─────────────────────────────

console.log('\n=== S163 — Simulação: reproduz goal_1785451137648_rf6nv ===');

function makeGoal(attempts: GoalAttempt[], sentArtifacts: string[]): Goal {
    const now = Date.now();
    return {
        id: 'goal_s163',
        sessionKey: 'telegram:s163',
        conversationId: 's163',
        userIntent: 'Consegue montar uma aula bem passo a passo sobre esse conteúdo?',
        objective: 'montar aula passo a passo',
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

// Réplica da lógica corrigida (mesmo shape do bloco real em GoalExecutionLoop.ts)
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

const REAL_EXISTING_FILES = new Set(['tmp/aula_sdt_passo_a_passo.txt']);
const fileExists = (p: string) => REAL_EXISTING_FILES.has(p);

{
    const goal = makeGoal(
        [
            {
                id: 'att_1', planStepId: 'step_2', toolName: 'write',
                args: { path: 'tmp/aula_sdt_passo_a_passo.txt' },
                result: 'success', output: 'Criado com sucesso',
                durationMs: 100, executedAt: Date.now(),
                producedArtifactPaths: ['tmp/aula_sdt_passo_a_passo.txt'],
            } as GoalAttempt,
        ],
        [], // sentArtifacts vazio — send ainda não despachado
    );

    // validation.artifactPaths vazio nesta simulação — reproduz o caso em que a checagem
    // antiga (só validation.artifactPaths) NÃO resolve, forçando o fallback novo.
    const result = correctSendPath(
        'workspace/Aula_Montada.txt', // hallucinado, nunca escrito
        [], // validation.artifactPaths não ajuda
        new Set(),
        goal,
        'Enviar o documento da aula montada para o usuário.',
        fileExists,
    );

    assert(result.reason === 'requested_file_missing_evidence_based_fallback', `usa o fallback evidence-based (obtido: ${result.reason})`);
    assert(result.corrected === 'tmp/aula_sdt_passo_a_passo.txt', `corrige para o artefato real (obtido: "${result.corrected}")`);
}

// ── 2b. Precisão preservada: quando há 2 artefatos reais de tipos diferentes, a descrição do
// step (quando NÃO é enganosa) ainda desambigua corretamente na primeira tentativa ───────────

console.log('\n=== S163 — Precisão preservada: 2 artefatos reais, descrição do step desambigua ===');
{
    const goal = makeGoal(
        [
            {
                id: 'att_1', planStepId: 'step_1', toolName: 'write',
                args: { path: 'tmp/rascunho.txt' }, result: 'success', output: 'ok',
                durationMs: 50, executedAt: Date.now() - 5000,
                producedArtifactPaths: ['tmp/rascunho.txt'],
            } as GoalAttempt,
            {
                id: 'att_2', planStepId: 'step_2', toolName: 'exec_command',
                args: {}, result: 'success', output: 'ok',
                durationMs: 50, executedAt: Date.now(),
                producedArtifactPaths: ['tmp/apresentacao_final.pptx'],
            } as GoalAttempt,
        ],
        [],
    );
    const multiFileExists = (p: string) => p === 'tmp/rascunho.txt' || p === 'tmp/apresentacao_final.pptx';
    const result = correctSendPath(
        'workspace/nome_errado.pptx',
        [],
        new Set(),
        goal,
        'Enviar a apresentação em pptx gerada para o usuário.', // menciona "pptx" — desambigua corretamente
        multiFileExists,
    );
    assert(result.corrected === 'tmp/apresentacao_final.pptx', `escolhe o .pptx (o mais recente E do tipo certo), não o .txt mais antigo (obtido: "${result.corrected}")`);
}

// ── 3. Não regride: validation.artifactPaths com 1 candidato continua tendo prioridade ──

console.log('\n=== S163 — Não regride: validation.artifactPaths com 1 candidato continua funcionando ===');
{
    const goal = makeGoal([], []);
    const result = correctSendPath(
        'workspace/arquivo_errado.txt',
        ['tmp/arquivo_certo.txt'],
        new Set(),
        goal,
        'Enviar o arquivo gerado.',
        (p) => p === 'tmp/arquivo_certo.txt',
    );
    assert(result.reason === 'requested_file_missing_single_validated_artifact_found', `usa o caminho antigo quando validation.artifactPaths resolve (obtido: ${result.reason})`);
    assert(result.corrected === 'tmp/arquivo_certo.txt', `corrige via validation.artifactPaths (obtido: "${result.corrected}")`);
}

// ── 4. Não regride: sem nenhuma evidência real, mantém o comportamento antigo (falha clara) ──

console.log('\n=== S163 — Não regride: sem evidência nenhuma, mantém file_path original (falha clara) ===');
{
    const goal = makeGoal([], []);
    const result = correctSendPath(
        'workspace/nunca_existiu.txt',
        [],
        new Set(),
        goal,
        'Enviar o arquivo gerado.',
        () => false,
    );
    assert(result.reason === 'unchanged', `sem evidência nenhuma, mantém comportamento antigo (obtido: ${result.reason})`);
    assert(result.corrected === 'workspace/nunca_existiu.txt', 'file_path original preservado — falha com mensagem clara em vez de adivinhar');
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S163 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
console.log(`\nCOBERTURA:`);
console.log(`  Fallback evidence-based presente e na ordem correta (source): testado`);
console.log(`  Reprodução do incidente real (rf6nv): simulado`);
console.log(`  Não regride validation.artifactPaths (caso antigo): testado`);
console.log(`  Não regride caso sem evidência nenhuma: testado`);
if (failed > 0) process.exit(1);
