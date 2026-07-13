import fs from 'fs';
import { Goal } from '../GoalTypes';
import { inferExpectedExtensions, SOURCE_SCRIPT_EXTENSIONS } from './inferExpectedExtensions';

/**
 * Tamanho mínimo (bytes) para um arquivo contar como deliverable real, não stub/placeholder.
 * Fonte única — antes duplicado como literal `200` só em GoalExecutionLoop.deliverable_check
 * (Fix S1). Reusado agora também para verificar declarações `ARTIFACT:` de exec_command
 * (docs/REVISAO_ARQUITETURAL_SPRINT_R7_2026-07-13.md §2).
 */
export const MIN_DELIVERABLE_SIZE = 200;

const ARTIFACT_LINE = /^ARTIFACT:\s*(.+)$/gm;

/**
 * Extrai paths declarados via linha `ARTIFACT: <path>` no stdout de exec_command (convenção
 * de R1 §10.1/R6 §2 — declarativo, nunca varredura do workspace) e verifica cada um contra o
 * disco antes de confiar na declaração: existe e tem tamanho ≥ MIN_DELIVERABLE_SIZE. Um script
 * que crasha depois de emitir a linha mas antes de terminar de escrever o arquivo não deve
 * gerar uma alegação falsa em GoalAttempt.producedArtifactPaths.
 *
 * `resolvePathFn` resolve o path declarado (relativo ao workspace ou absoluto) para um path
 * de disco real — injetado pelo chamador para reusar a mesma resolvePath() de crossPlatform.ts
 * usada por write/read/exec_command, sem duplicar a lógica de resolução aqui. Retorna `error`
 * quando o path está fora do sandbox permitido (Sprint F2, revisão de código pós-piloto): sem
 * checar esse campo, um `ARTIFACT: <path fora do sandbox>` no stdout de um script (bug do
 * próprio script, ou path traversal) podia ser aceito como evidência verificada só porque o
 * arquivo apontado por `.resolved` acontecia de existir em disco — send_document validaria de
 * novo no envio, mas resolveArtifactPathFromEvidence podia escolher esse candidato espúrio
 * antes disso, no lugar do artefato real.
 */
export function extractVerifiedArtifacts(
    stdout: string,
    resolvePathFn: (raw: string) => { resolved: string; error?: string },
): string[] {
    const verified: string[] = [];
    for (const match of stdout.matchAll(ARTIFACT_LINE)) {
        const raw = match[1].trim();
        if (!raw) continue;
        const { resolved, error } = resolvePathFn(raw);
        if (error) continue;
        try {
            const stat = fs.statSync(resolved);
            if (stat.isFile() && stat.size >= MIN_DELIVERABLE_SIZE) {
                verified.push(resolved);
            }
        } catch {
            // Arquivo declarado mas não existe / não acessível — declaração descartada, não
            // propagada como producedArtifactPaths. Falha silenciosa aqui é intencional: o
            // exit code do exec_command já reflete o resultado real do comando.
        }
    }
    return verified;
}

/**
 * Resolve o artefato mais recente compatível com o deliverable esperado, usando evidência
 * real já persistida em goal.attempts — em vez da inferência sintática original do
 * RiskAnalyzer (proximidade textual no JSON do plano, que não sobrevive a replan quando o
 * step 'write' que produziu o arquivo não está mais no batch de steps sendo revisado).
 *
 * Ordem de resolução (docs/REVISAO_ARQUITETURAL_SPRINT_R5..R7_2026-07-13.md):
 *   1. goal.attempts com producedArtifactPaths, filtrado por extensão esperada
 *      (inferExpectedExtensions), mais recente primeiro (executedAt).
 *   2. Se nada compatível: leitura (nunca escrita) de goal.sentArtifacts — cobre o caso em
 *      que o artefato foi produzido/entregue dentro de um step 'agentloop' opaco, cujos
 *      writes internos não aparecem em goal.attempts com toolName write/exec_command
 *      (mesma classe de bug documentada em project_session_bugs_jul2026_ak, decisão
 *      explícita de emendar o hard gate da Sprint R3 — ver R7 §7).
 *   3. undefined — chamador cai para o comportamento heurístico anterior.
 *
 * Achado ao vivo em 13/07/2026 (validação end-to-end do piloto, docs/REVISAO_ARQUITETURAL_
 * SPRINT_R7_2026-07-13.md): sem extensão esperada inferível, o filtro (passo 1) é permissivo
 * por design (R6 §4) — mas isso não pode incluir um script-fonte (.py/.sh/...) como candidato
 * válido, porque um script é meio, não fim (mesma classe de bug que o teste S27 já cobria em
 * outro call site). Bloqueio é incondicional, não condicionado a `expectedExts`: uma descrição
 * de step tipicamente menciona o NOME do script (ex.: "executar gerar_planetas.py e enviar
 * planetas.txt") — se scripts pudessem "se qualificar" por menção literal, o próprio texto que
 * descreve a etapa de execução reabriria a mesma brecha. Pedido explícito pelo script em si cai
 * para o fallback normal (AgentLoop resolve via tool-calling com contexto real), não por aqui.
 *
 * Sprint F2 (revisão de código pós-piloto): só `GoalAttempt.result === 'success'` conta como
 * evidência — `'partial'` fica de fora. `GoalStore.downgradeLastAttemptToPartial` rebaixa um
 * attempt pra 'partial' quando o SemanticValidator julga o output irrelevante ao objetivo,
 * preservando `producedArtifactPaths` intacto; sem essa exclusão, um artefato que o próprio
 * sistema já sinalizou como duvidoso seria tratado como evidência plenamente confiável.
 */
export function resolveArtifactPathFromEvidence(
    goal: Pick<Goal, 'attempts' | 'sentArtifacts' | 'userIntent'>,
    stepDescription: string,
): string | undefined {
    // Combina os dois textos em vez de só usar userIntent como fallback do || — uma description
    // de step genérica ("Enviar o arquivo gerado") não deve fazer o sistema ignorar keywords de
    // tipo de arquivo já presentes no userIntent do goal ("gerar apresentação de slides").
    const expectedExts = inferExpectedExtensions(`${stepDescription} ${goal.userIntent ?? ''}`.trim());
    const matchesExpected = (p: string): boolean =>
        expectedExts.length === 0 || expectedExts.some(ext => p.toLowerCase().endsWith(ext));
    const isScript = (p: string): boolean => {
        const dot = p.lastIndexOf('.');
        return dot !== -1 && SOURCE_SCRIPT_EXTENSIONS.has(p.slice(dot).toLowerCase());
    };

    const candidates = (goal.attempts ?? [])
        .filter(a => a.result === 'success' && a.producedArtifactPaths && a.producedArtifactPaths.length > 0)
        .flatMap(a => (a.producedArtifactPaths ?? []).map(p => ({ path: p, executedAt: a.executedAt })))
        .filter(c => matchesExpected(c.path) && !isScript(c.path))
        .sort((a, b) => b.executedAt - a.executedAt);

    if (candidates.length > 0) return candidates[0].path;

    const sent = (goal.sentArtifacts ?? []).filter(p => matchesExpected(p) && !isScript(p));
    if (sent.length > 0) return sent[sent.length - 1];

    return undefined;
}
