/**
 * GracefulDeliveryOrchestrator — AUTORIDADE ÚNICA da mensagem que o usuário lê quando um goal falha
 * (issue 020, Incremento 1).
 *
 * Antes desta mudança, a "síntese de falha" existia em duas formas divergentes: 5 saídas do
 * `GoalExecutionLoop` produziam o texto por `GoalEvaluator.buildFailureExplanation()` (um resumo
 * seco, sem nada do que o goal obteve), e apenas 1 delas — replan budget esgotado — passava por este
 * orquestrador, cuja mensagem SUBSTITUÍA a anterior e perdia o fato "já enviei X" que a outra
 * carregava. Política que vale num caminho e não nos outros é política que ainda não existe
 * (mesma classe de `ADR-005` §5.1).
 *
 * Agora todo caminho de falha genérica chama `buildFailureMessage()` — e só ele. Compõe, na mesma
 * ordem sempre:
 *   1. o que FOI entregue ao usuário (`goal.sentArtifacts`) ou, se nada, que o pedido não foi
 *      completado;
 *   2. o motivo específico, quando o chamador tem um (`reason`);
 *   3. as ferramentas tentadas;
 *   4. o que foi obtido (resultados de ferramentas — nunca narração do modelo);
 *   5. arquivos que EXISTEM mas NÃO foram entregues;
 *   6. o que faltou (último bloqueio) e o próximo passo possível.
 *
 * REGRAS (não são decoração — cada uma existe por um incidente):
 *   - **"Existe um arquivo no disco" NÃO significa "existe um arquivo pronto para o usuário".**
 *     Este componente NUNCA entrega nada. `artifactPaths` é um FATO para o texto, não uma autorização
 *     de envio: extensão (.md/.js/.html) não prova entregabilidade, e o contrato da skill
 *     `html-pdf-converter` (nunca enviar `.html` cru) e o `htmlConversionPending` do AgentLoop
 *     continuam sendo as únicas autoridades sobre o que pode ser enviado.
 *   - Não cria fonte de verdade nova sobre "o que é entregável".
 *   - Nunca despeja campos internos de replanejamento (`strategiesTried`) — só `toolsTried`
 *     (incidente da `S73`).
 *
 * Fora do escopo, de propósito: saídas cuja mensagem É a razão específica e deliberada (objetivo
 * expirou, abandonado por nova mensagem, plano bloqueado antes de executar, aguardando autorização,
 * falha de envio pós-validação). Elas não usam o resumo genérico e não passam por aqui.
 */

import { createLogger } from '../shared/AppLogger';
import { Goal, StepCognitiveContext } from './GoalTypes';

const log = createLogger('GracefulDeliveryOrchestrator');

export interface GracefulDeliveryResult {
    /** true se há algum conteúdo parcial útil para incluir na resposta */
    hasPartialContent: boolean;
    /** Caminhos de arquivos que o goal produziu. FATO para o texto — nunca autorização de envio. */
    artifactPaths: string[];
    /** Outputs textuais relevantes coletados durante a execução */
    textualOutputs: string[];
    /** Descobertas acumuladas no contexto cognitivo */
    discoveries: string[];
}

const CONTENT_TOOLS = new Set([
    'web_search', 'memory_search', 'crypto_analysis',
    'web_navigate', 'api_request', 'read', 'read_document',
]);

/** Contexto vazio: chamadores sem `GoalExecutionState` (ex.: o fallback de `buildResult`) usam só o goal. */
const EMPTY_CONTEXT: StepCognitiveContext = {
    filesRead: [], filesModified: [], generatedArtifacts: [], discoveries: [],
    failedStrategies: [], importantOutputs: [], executedCommands: [],
};

const NEXT_STEP = 'Você pode reformular o pedido ou fornecer mais informações para eu tentar de outra forma.';

const baseName = (p: string): string => (p.split(/[\\/]/).pop() ?? p).toLowerCase();

const isAbsolutePath = (p: string): boolean => /^(?:[a-zA-Z]:[\\/]|[\\/])/.test(p);

/**
 * Caminhos como o usuário pode ler. Achado da validação real de 21/09/2026: o mesmo arquivo
 * aparecia duas vezes (relativo e absoluto) e o absoluto (`C:\Users\<usuário>\...`) vazava para o
 * canal o nome de usuário e a estrutura de pastas da máquina do servidor. Deduplica por nome de
 * arquivo, prefere o caminho relativo ao workspace e, se só existir o absoluto, mostra só o nome.
 */
function presentablePaths(paths: string[]): string[] {
    const byName = new Map<string, string>();
    for (const p of paths) {
        const key = baseName(p);
        const shown = isAbsolutePath(p) ? (p.split(/[\\/]/).pop() ?? p) : p;
        const current = byName.get(key);
        // um relativo (contém diretório) é mais informativo que só o nome
        if (current === undefined || (!current.includes('/') && !current.includes('\\') && shown !== current && (shown.includes('/') || shown.includes('\\')))) {
            byName.set(key, shown);
        }
    }
    return Array.from(byName.values());
}

export class GracefulDeliveryOrchestrator {
    /**
     * Avalia o que foi obtido durante a execução. Só FATOS — não decide nada e não entrega nada.
     */
    assess(goal: Goal, cognitiveContext: StepCognitiveContext = EMPTY_CONTEXT): GracefulDeliveryResult {
        const artifactPaths = this.collectArtifacts(goal, cognitiveContext);
        const textualOutputs = this.collectTextualOutputs(goal, cognitiveContext);
        const discoveries = cognitiveContext.discoveries.filter(d => d.trim().length > 20).slice(0, 5);
        const hasPartialContent = artifactPaths.length > 0 || textualOutputs.length > 0 || discoveries.length > 0;
        return { hasPartialContent, artifactPaths, textualOutputs, discoveries };
    }

    /**
     * A mensagem de falha. Único ponto que a compõe — ver o cabeçalho.
     *
     * @param reason motivo ESPECÍFICO que o chamador conhece (ex.: "'ffmpeg' não pôde ser instalado
     *   automaticamente..." ou o motivo da validação final). É um fato de entrada, não uma decisão:
     *   quem compõe o texto é este método.
     */
    buildFailureMessage(goal: Goal, cognitiveContext: StepCognitiveContext = EMPTY_CONTEXT, reason?: string): string {
        const facts = this.assess(goal, cognitiveContext);
        const delivered = goal.sentArtifacts ?? [];
        const deliveredNames = new Set(delivered.map(baseName));
        // Um arquivo já entregue não é "pendente" — e um pendente nunca é apresentado como entregável.
        const undelivered = presentablePaths(facts.artifactPaths.filter(p => !deliveredNames.has(baseName(p))));

        const lines: string[] = [];

        // 1. O que o usuário JÁ recebeu (fato mais importante — o goal pode ter entregue arquivos
        //    válidos e só depois esbarrado num step adicional; reproduzido ao vivo em 09/07/2026).
        lines.push(delivered.length > 0
            ? `Consegui gerar e enviar: ${delivered.join(', ')}. Porém não finalizei o restante do pedido.`
            : `Não consegui completar: "${goal.userIntent.slice(0, 150)}".`);

        // 2. Motivo específico do chamador.
        const lastBlocker = goal.blockers[goal.blockers.length - 1];
        const reasonText = reason?.trim();
        if (reasonText) {
            lines.push('', `**O que aconteceu:** ${reasonText}`);
        }

        // 3. Ferramentas realmente tentadas (toolsTried — nunca strategiesTried, ver S73).
        if (goal.toolsTried.length > 0) {
            lines.push('', `Tentei: ${goal.toolsTried.join(', ')}.`);
        }

        // 4. O que foi obtido.
        if (facts.textualOutputs.length > 0) {
            lines.push('', '**Informações coletadas:**');
            for (const out of facts.textualOutputs) lines.push(`• ${out}`);
        }
        if (facts.discoveries.length > 0) {
            lines.push('', '**Descobertas durante a execução:**');
            for (const d of facts.discoveries) lines.push(`• ${d}`);
        }

        // 5. Arquivos que existem e NÃO foram entregues — dito assim, sem oferecer envio: existir no
        //    disco não é estar pronto. Só o usuário (ou o fluxo normal de entrega) decide.
        if (undelivered.length > 0) {
            lines.push('', '**Arquivos criados que NÃO foram enviados a você (podem estar incompletos):**');
            for (const a of undelivered) lines.push(`• \`${a}\``);
        }

        // 6. O que faltou (sem repetir o motivo) e o próximo passo.
        const blockerText = lastBlocker?.description?.trim();
        if (blockerText && (!reasonText || !reasonText.includes(blockerText))) {
            lines.push('', `**O que faltou:** ${blockerText}`);
        }
        lines.push('', NEXT_STEP);

        log.info(
            `[GracefulDelivery] goal=${goal.id} delivered=${delivered.length} undelivered=${undelivered.length}` +
            ` text_outputs=${facts.textualOutputs.length} discoveries=${facts.discoveries.length}` +
            ` reason=${reasonText ? 'yes' : 'no'}`
        );
        return lines.join('\n').trim();
    }

    /**
     * PROCEDÊNCIA: só entra o que uma FERRAMENTA reportou. `cognitiveContext.importantOutputs` e
     * `.generatedArtifacts` ficam de fora de propósito — o primeiro recebe qualquer texto de step
     * (inclusive a narração do LLM nos steps `agentloop`) e o segundo é preenchido por regex sobre
     * esse texto ("criou X"). Achado na validação real de 21/09/2026: sob "Informações coletadas"
     * apareceu "O arquivo de apresentação foi enviado" — narração do modelo, FALSA, numa mensagem cujo
     * objetivo é dizer ao usuário a verdade sobre a falha. Uma afirmação do modelo não é um fato.
     */
    private collectArtifacts(goal: Goal, _ctx: StepCognitiveContext): string[] {
        const paths = new Set<string>();

        for (const attempt of goal.attempts) {
            if (attempt.result !== 'success') continue;
            if (attempt.toolName === 'write' || attempt.toolName === 'edit') {
                const p = attempt.args['path'];
                if (typeof p === 'string') paths.add(p);
            }
            // Caminhos que a própria ferramenta declarou ter produzido (inclui os de steps agentloop).
            for (const p of attempt.producedArtifactPaths ?? []) {
                if (typeof p === 'string' && p) paths.add(p);
            }
        }

        return Array.from(paths);
    }

    private collectTextualOutputs(goal: Goal, _ctx: StepCognitiveContext): string[] {
        const outputs: string[] = [];
        const seen = new Set<string>();

        for (const attempt of goal.attempts) {
            if (attempt.result === 'success' && CONTENT_TOOLS.has(attempt.toolName) && attempt.output) {
                // Uma linha só (quebras viram espaço) e deduplicada pelo início: a mesma busca
                // aparecia duas vezes na validação real.
                const oneLine = attempt.output.replace(/\s+/g, ' ').trim();
                const key = oneLine.slice(0, 80);
                if (oneLine.length > 30 && !seen.has(key)) {
                    outputs.push(oneLine.slice(0, 300));
                    seen.add(key);
                }
            }
        }

        return outputs.slice(0, 4);
    }
}
