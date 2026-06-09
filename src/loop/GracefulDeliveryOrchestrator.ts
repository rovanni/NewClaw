/**
 * GracefulDeliveryOrchestrator — Entrega parcial quando o replanBudget é esgotado.
 *
 * Problema: quando o replanBudget chega a 0, o sistema retorna "objetivo não atingido"
 * sem entregar nada do que foi obtido durante a execução.
 *
 * Solução: antes de retornar 'failed', escaneia o histórico de execução para:
 *   1. Identificar outputs úteis dos attempts bem-sucedidos (web_search, crypto_analysis, etc.)
 *   2. Identificar artefatos gerados (arquivos em workspace ainda disponíveis)
 *   3. Identificar descobertas acumuladas no contexto cognitivo
 *   4. Construir uma resposta parcial estruturada e legível para o usuário
 *
 * Não altera o status final do goal (continua 'failed') — apenas enriquece
 * a mensagem final com o que foi obtido, em vez de retornar silêncio.
 */

import { createLogger } from '../shared/AppLogger';
import { Goal, StepCognitiveContext } from './GoalTypes';

const log = createLogger('GracefulDeliveryOrchestrator');

export interface GracefulDeliveryResult {
    /** true se há algum conteúdo parcial útil para incluir na resposta */
    hasPartialContent: boolean;
    /** Mensagem formatada para substituir o genérico "objetivo não atingido" */
    partialSummary: string;
    /** Caminhos de artefatos gerados (para send_document posterior se necessário) */
    artifactPaths: string[];
    /** Outputs textuais relevantes coletados durante a execução */
    textualOutputs: string[];
}

const CONTENT_TOOLS = new Set([
    'web_search', 'memory_search', 'crypto_analysis',
    'web_navigate', 'api_request', 'read', 'read_document',
]);

export class GracefulDeliveryOrchestrator {
    /**
     * Avalia o que foi obtido durante a execução e constrói uma entrega parcial.
     */
    assess(goal: Goal, cognitiveContext: StepCognitiveContext): GracefulDeliveryResult {
        const artifactPaths = this.collectArtifacts(goal, cognitiveContext);
        const textualOutputs = this.collectTextualOutputs(goal, cognitiveContext);
        const discoveries = cognitiveContext.discoveries.filter(d => d.trim().length > 20).slice(0, 5);

        const hasPartialContent =
            artifactPaths.length > 0 ||
            textualOutputs.length > 0 ||
            discoveries.length > 0;

        if (!hasPartialContent) {
            log.info(`[GracefulDelivery] goal=${goal.id} no_partial_content — returning empty`);
            return { hasPartialContent: false, partialSummary: '', artifactPaths: [], textualOutputs: [] };
        }

        const partialSummary = this.buildSummary(goal, artifactPaths, textualOutputs, discoveries);
        log.info(
            `[GracefulDelivery] goal=${goal.id}` +
            ` artifacts=${artifactPaths.length}` +
            ` text_outputs=${textualOutputs.length}` +
            ` discoveries=${discoveries.length}` +
            ` summary_len=${partialSummary.length}`
        );

        return { hasPartialContent, partialSummary, artifactPaths, textualOutputs };
    }

    private collectArtifacts(goal: Goal, ctx: StepCognitiveContext): string[] {
        const paths = new Set<string>();

        for (const artifact of ctx.generatedArtifacts) {
            paths.add(artifact);
        }

        for (const artifact of ctx.filesModified) {
            paths.add(artifact);
        }

        for (const attempt of goal.attempts) {
            if (attempt.result === 'success' && (attempt.toolName === 'write' || attempt.toolName === 'edit')) {
                const p = attempt.args['path'];
                if (typeof p === 'string') paths.add(p);
            }
        }

        return Array.from(paths);
    }

    private collectTextualOutputs(goal: Goal, ctx: StepCognitiveContext): string[] {
        const outputs: string[] = [];
        const seen = new Set<string>();

        for (const imp of ctx.importantOutputs.slice(0, 3)) {
            const trimmed = imp?.trim();
            if (trimmed && trimmed.length > 20 && !seen.has(trimmed)) {
                outputs.push(trimmed);
                seen.add(trimmed);
            }
        }

        for (const attempt of goal.attempts) {
            if (attempt.result === 'success' && CONTENT_TOOLS.has(attempt.toolName) && attempt.output) {
                const truncated = attempt.output.slice(0, 400).trim();
                if (truncated.length > 30 && !seen.has(truncated)) {
                    outputs.push(truncated);
                    seen.add(truncated);
                }
            }
        }

        return outputs.slice(0, 4);
    }

    private buildSummary(
        goal: Goal,
        artifacts: string[],
        textOutputs: string[],
        discoveries: string[],
    ): string {
        const lines: string[] = [];
        lines.push(`Não consegui completar o objetivo integralmente, mas aqui está o que obtive:`);

        if (textOutputs.length > 0) {
            lines.push('');
            lines.push('**Informações coletadas:**');
            for (const out of textOutputs) {
                lines.push(`• ${out}`);
            }
        }

        if (discoveries.length > 0) {
            lines.push('');
            lines.push('**Descobertas durante a execução:**');
            for (const d of discoveries) {
                lines.push(`• ${d}`);
            }
        }

        if (artifacts.length > 0) {
            lines.push('');
            lines.push('**Arquivos gerados:**');
            for (const a of artifacts) {
                lines.push(`• \`${a}\``);
            }
        }

        const lastBlocker = goal.blockers[goal.blockers.length - 1];
        if (lastBlocker?.description) {
            lines.push('');
            lines.push(`**O que faltou:** ${lastBlocker.description}`);
        }

        return lines.join('\n').trim();
    }
}
