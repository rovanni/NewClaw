/**
 * sanitizePlanSteps — normaliza um PlanStep[] bruto vindo de um LLM (parse inicial do
 * GoalPlanner OU ajuste de risco do RiskAnalyzer) em steps executáveis com segurança.
 *
 * Extraído de GoalPlanner.parsePlanResponse() (Etapa 1 da consolidação — extract & redirect,
 * não move & clean): a lógica abaixo é a MESMA que já existia em GoalPlanner.ts, sem alteração
 * de comportamento, apenas parametrizada para poder ser redirecionada por outros chamadores
 * (GoalPlanner na Etapa 2, RiskAnalyzer na Etapa 3).
 *
 * A única substituição mecânica é `TOOL_ALIASES[rawToolName] ?? rawToolName` (inline) por
 * `resolveToolAlias(rawToolName)` (mesmo cálculo, extraído para toolAliasResolver.ts).
 *
 * O campo `mutations` no retorno é uma adição não-invasiva: acumula, para cada step
 * convertido para AgentLoop, o motivo e a tool original — nenhum comportamento existente lê
 * ou depende disso hoje. Existe para a Etapa 3 (RiskAnalyzer precisa saber quais steps
 * perderam args obrigatórios para decidir se rejeita o plano inteiro) sem precisar duplicar
 * a lógica de detecção outra vez.
 *
 * `detectMissingRequiredArgs` é recebido por parâmetro em vez de importado de GoalPlanner.ts:
 * GoalPlanner.ts importa `sanitizePlanSteps` (Etapa 2), então um import direto no sentido
 * contrário criaria um ciclo — CommonJS resolveria com os exports de GoalPlanner.ts ainda
 * incompletos nesse ponto (a constante é declarada depois do ponto do arquivo onde o ciclo
 * seria disparado), quebrando em runtime.
 *
 * `classifyContentStub` (09/07/2026): substituiu o parâmetro `writeContentStubPatterns:
 * RegExp[]` — ver shared/contentStubClassifier.ts para o motivo (regex precisou de 6 rodadas
 * de patch por incidentes reais; um LLM julgando a CLASSE do problema generaliza sem precisar
 * de um padrão novo por frase). Função agora é `async` por causa disso — a checagem estrutural
 * (`sawDataProducingTool`) continua síncrona e continua sendo a primeira linha de defesa,
 * gratuita e determinística; o LLM só é chamado quando ela não se aplica.
 */

import fs from 'fs';
import { createLogger } from '../../shared/AppLogger';
import { PlanStep } from '../GoalTypes';
import { PLACEHOLDER_ARG_PATTERN } from '../../shared/placeholderPatterns';
import { resolveToolAlias } from './toolAliasResolver';
import { ContentStubClassifier } from '../../shared/contentStubClassifier';
import { resolvePath } from '../../utils/crossPlatform';

const log = createLogger('SanitizePlanSteps');

// Tools cujo OUTPUT é dado dinâmico que só existe DEPOIS de rodar — usado pelo check de 'content'
// abaixo (TOOL_DEPENDENCY_ARG): se um step de conteúdo (write/send_audio) mais adiante no MESMO
// plano já vem com o argumento preenchido pelo LLM autor do plano, esse valor não pode conter
// dado real (o LLM não tem como já saber o resultado de uma tool que ainda não executou). Isso é
// verdade INDEPENDENTE do texto/idioma usado — é uma garantia estrutural, não uma adivinhação de
// vocabulário. Ver `sawDataProducingTool` abaixo: detector estrutural que substitui a necessidade
// de caçar cada nova frase-molde (5 rodadas de regex nesta família de bug: "step_1" → "step 1" →
// "etapas anteriores" → "gerado pelo assistente" → "passo 1", ver shared/contentStubPatterns.ts)
// por uma regra determinística sobre a ORDEM dos steps no plano, não sobre as palavras do LLM.
const DATA_PRODUCING_TOOLS = new Set([
    'weather', 'crypto_analysis', 'web_search', 'web_navigate',
    'read', 'read_document', 'memory_search', 'exec_command', 'ssh_exec',
]);

/**
 * Duas naturezas DIFERENTES de "este argumento depende de algo que um step anterior ainda não
 * produziu", consolidadas num único mapa (27/07/2026 — antes eram dois mapas quase-espelhados,
 * CONTENT_BEARING_ARG e FILE_REFERENCE_ARG, cada um com seu próprio bloco de `if` quase idêntico
 * — puro refactor de forma, sem mudança de comportamento):
 *
 * - 'content': o argumento carrega CONTEÚDO FINAL gerado pelo LLM (texto que o usuário vai
 *   ler/ouvir) — candidato a "stub" se preenchido antes de um step produtor de dado dinâmico
 *   (DATA_PRODUCING_TOOLS) ter rodado. Ex: write.content, send_audio.text.
 * - 'file_reference': o argumento é uma REFERÊNCIA a um arquivo que precisa já existir em disco
 *   (ou ser produzido por um 'write' anterior no MESMO plano) no momento em que o step roda. Ex:
 *   send_document.file_path. Achado real (26-27/07/2026, goal_1785117691685_2cj7x): plano
 *   [write(script.js), send_document(saida.pptx)] sem exec_command entre os dois — o LLM
 *   escreveu o script gerador mas nunca agendou rodá-lo, e send_document tentou enviar um
 *   arquivo inexistente 3 vezes seguidas antes de desistir (o que parou foi o SAFETY-GUARD
 *   genérico de falhas consecutivas do AgentLoop.ts, cego a "por quê"). Um aviso em TEXTO já
 *   existia na skill (pptx-generator/SKILL.md) — não impediu o LLM de ignorá-lo.
 *
 * As DUAS continuam sendo checagens estruturais (ordem dos steps, não palavras/idioma) — só a
 * TABELA de "qual tool, qual argumento, qual natureza" foi unificada. O algoritmo de cada
 * natureza continua distinto (uma decide por sawDataProducingTool + classificador de stub; a
 * outra por writtenPaths + existência real em disco) — fundir os DOIS mapas não significa que
 * as duas checagens sejam a mesma coisa, só que vivem na mesma tabela de consulta.
 *
 * Antes de adicionar uma TERCEIRA entrada com um `kind` novo aqui (ou antes de propor o próximo
 * passo óbvio — cada Tool declarar seus próprios contratos produces/consumes, eliminando este
 * arquivo precisar conhecer nominalmente cada tool) — ver docs/issues/017-tool-dependency-arg-
 * declarative-contracts-trigger.md (privado) para os gatilhos já definidos de quando essa
 * generalização deixa de ser prematura.
 */
type StepDependencyKind = 'content' | 'file_reference';

interface StepDependencySpec {
    arg: string;
    kind: StepDependencyKind;
}

const TOOL_DEPENDENCY_ARG: Record<string, StepDependencySpec> = {
    write:         { arg: 'content',   kind: 'content' },
    send_audio:    { arg: 'text',      kind: 'content' },
    send_document: { arg: 'file_path', kind: 'file_reference' },
};

export type StepMutationReason = 'tool_not_found' | 'placeholder' | 'content_stub' | 'missing_args' | 'premature_content' | 'missing_file_reference';

export interface StepMutation {
    stepId: string;
    /** Nome canônico da tool que o step tinha ANTES de ser convertido para AgentLoop. */
    originalTool: string;
    reason: StepMutationReason;
    detail: string;
    description: string;
}

export interface SanitizePlanStepsResult {
    steps: PlanStep[];
    /** Todo step que foi convertido para AgentLoop (toolName undefined), com o motivo. */
    mutations: StepMutation[];
}

/**
 * @param rawSteps     Steps brutos (já parseados do JSON do LLM, ainda não validados).
 * @param toolRegistry Precisa apenas de `.get(name)` — aceita o singleton ToolRegistry ou
 *                      qualquer instância/mock com o mesmo formato.
 * @param logPrefix    Prefixo de log, ex: "[GoalPlanner]" ou "[RiskAnalyzer]".
 * @param detectMissingRequiredArgs Validador de args obrigatórios por tool (de GoalPlanner.ts).
 * @param classifyContentStub       Classificador LLM de content-stub (shared/contentStubClassifier.ts).
 * @param knownExistingPaths        Paths (já resolvidos) que o CHAMADOR já sabe corresponder a
 *                                  artefatos reais, mesmo que não produzidos por nenhum step
 *                                  DESTE plano — ex: RiskAnalyzer.ts resolve file_path de
 *                                  send_document via evidência de goal.attempts/sentArtifacts
 *                                  de um CICLO ANTERIOR (resolveArtifactPathFromEvidence), que
 *                                  sanitizePlanSteps() não teria como enxergar sozinho (só vê os
 *                                  steps do plano ATUAL). Sem isso, o check de
 *                                  kind:'file_reference' (TOOL_DEPENDENCY_ARG) trataria um
 *                                  file_path já validado por evidência real como "referência
 *                                  prematura" — regressão de um fix anterior (ver
 *                                  S111_RiskAnalyzer_ReplanArtifactEvidence).
 */
export async function sanitizePlanSteps(
    rawSteps: Array<Record<string, unknown>>,
    toolRegistry: { get(name: string): unknown },
    logPrefix: string,
    detectMissingRequiredArgs: (tool: string, args: Record<string, unknown>) => string | null,
    classifyContentStub: ContentStubClassifier,
    knownExistingPaths?: Iterable<string>,
): Promise<SanitizePlanStepsResult> {
    const mutations: StepMutation[] = [];

    // Atualizado ao final de cada iteração (só quando o step SOBREVIVE à sanitização com uma
    // DATA_PRODUCING_TOOLS válida) — reflete se algum step ANTERIOR no plano vai efetivamente
    // buscar/produzir dado dinâmico em runtime, ainda não disponível no momento em que este
    // plano está sendo montado.
    let sawDataProducingTool = false;

    // Paths (resolvidos, não string literal — evita falso-positivo tipo "workspace/x" vs "x")
    // que algum step 'write' ANTERIOR no plano já vai produzir DIRETAMENTE — mesmo que ainda não
    // existam em disco no momento da validação (planejamento acontece ANTES da execução). Sem
    // isso, o check de kind:'file_reference' abaixo teria falso-positivo no caso legítimo e comum
    // write(saida.pptx) → send_document(saida.pptx) — o `write` É a tool que produz o arquivo
    // final diretamente, não precisa de exec_command no meio. Pré-semeado com knownExistingPaths
    // (ver doc do parâmetro acima) — mesmo conjunto, mesma semântica ("já sei que este path é
    // válido"), só a ORIGEM da confiança muda (step deste plano vs. evidência externa).
    const writtenPaths = new Set<string>(knownExistingPaths ?? []);

    // Loop sequencial (não Promise.all): sawDataProducingTool é lido e atualizado na ORDEM dos
    // steps — um step i precisa saber se algum step ANTERIOR (< i) sobreviveu como produtor de
    // dado, então cada iteração precisa terminar antes da próxima começar (inclusive esperando
    // a chamada LLM de classifyContentStub, quando ela roda).
    const steps: PlanStep[] = [];
    for (let i = 0; i < rawSteps.length; i++) {
        const s = rawSteps[i];
        const rawToolName = s.toolName ? String(s.toolName) : undefined;

        // Resolve alias antes de validar (ex: provide_file → send_document)
        const canonicalName = rawToolName
            ? resolveToolAlias(rawToolName)
            : undefined;

        // Valida se a tool existe no ToolRegistry.
        let resolvedTool = canonicalName && toolRegistry.get(canonicalName)
            ? canonicalName
            : undefined;

        if (rawToolName && !resolvedTool) {
            log.warn(`${logPrefix} tool '${rawToolName}' não existe no ToolRegistry — step será tratado sem tool`);
            mutations.push({
                stepId: String(s.id ?? `step_${i + 1}`),
                originalTool: rawToolName,
                reason: 'tool_not_found',
                detail: `'${rawToolName}' não existe no ToolRegistry`,
                description: String(s.description ?? 'Execute step'),
            });
        } else if (canonicalName && canonicalName !== rawToolName) {
            log.info(`${logPrefix} tool alias '${rawToolName}' → '${canonicalName}'`);
        }

        // Registra o path que este 'write' PRETENDE produzir — a partir do dado BRUTO (s), não
        // de toolArgs/resolvedTool pós-sanitização. Precisa ser independente de o step ser
        // rebaixado por outro motivo nesta mesma iteração (ex: content_stub no CONTEÚDO inline):
        // o destino pretendido continua o mesmo mesmo quando o AgentLoop reescreve o conteúdo em
        // runtime — só o MECANISMO de geração muda, não o path de saída. RiskAnalyzer.ts já pode
        // ter inferido o file_path de um send_document a partir deste MESMO write ANTES de
        // sanitizePlanSteps rodar (ver RiskAnalyzer.ts ~640) — se este check só contasse writes
        // que sobrevivem intactos, um write com conteúdo classificado como stub faria seu path
        // "desaparecer" daqui, e o check de kind:'file_reference' mais abaixo marcaria um falso
        // positivo para um send_document cujo file_path já é legítimo.
        if (canonicalName === 'write' && s.toolArgs && typeof s.toolArgs === 'object') {
            const rawPath = (s.toolArgs as Record<string, unknown>).path;
            if (typeof rawPath === 'string' && rawPath) {
                const { resolved: writtenResolved } = resolvePath(rawPath);
                writtenPaths.add(writtenResolved);
            }
        }

        // Item 8: Detectar placeholder paths em toolArgs.
        // Se algum argumento é um placeholder (caminho_do_*, <path>, {file}),
        // remove toolName/toolArgs para forçar AgentLoop a resolver o caminho real.
        let toolArgs: Record<string, unknown> | undefined = resolvedTool && s.toolArgs && typeof s.toolArgs === 'object'
            ? s.toolArgs as Record<string, unknown>
            : undefined;

        if (resolvedTool && toolArgs) {
            const placeholderEntry = Object.entries(toolArgs).find(
                ([, v]) => typeof v === 'string' && PLACEHOLDER_ARG_PATTERN.test(v)
            );
            if (placeholderEntry) {
                log.warn(`${logPrefix} step ${i + 1} has placeholder arg ${placeholderEntry[0]}="${String(placeholderEntry[1]).slice(0, 80)}" — converting to AgentLoop step`);
                mutations.push({
                    stepId: String(s.id ?? `step_${i + 1}`),
                    originalTool: resolvedTool,
                    reason: 'placeholder',
                    detail: `${placeholderEntry[0]}="${String(placeholderEntry[1]).slice(0, 80)}"`,
                    description: String(s.description ?? 'Execute step'),
                });
                resolvedTool = undefined;
                toolArgs = undefined;
            }
        }

        // CONTENT-STUB: detecta steps com conteúdo placeholder (descrição do que deveria ser
        // gerado, em vez do conteúdo real) e converte para AgentLoop. Quando o model gera
        // {"toolName":"write","content":"<82-char-stub>"}, a execução "succeeds" mas grava lixo
        // — o GoalExecutionLoop gasta todo o replanBudget em exec_command/ssh_exec antes de
        // perceber que o artefato é inválido. A conversão para AgentLoop faz o LLM sintetizar o
        // conteúdo REAL em runtime, com acesso ao output dos steps anteriores (web_search, read,
        // etc.). Cobre qualquer tool com kind:'content' em TOOL_DEPENDENCY_ARG (não só
        // write.content) — send_audio.text adicionado após reprodução ao vivo (04/07/2026): o
        // RiskAnalyzer (Q2) reescreveu um step de agentloop para send_audio com text="...Um ser
        // ir dado os obtidos no step 1" (prosa referenciando o step sem os dados reais) e essa
        // checagem, restrita a 'write' na época, nunca viu o argumento — o usuário recebeu um
        // áudio incompreensível.
        const contentDepSpec = resolvedTool ? TOOL_DEPENDENCY_ARG[resolvedTool] : undefined;
        if (resolvedTool && contentDepSpec?.kind === 'content' && toolArgs?.[contentDepSpec.arg]) {
            const contentStr = String(toolArgs[contentDepSpec.arg]);

            if (sawDataProducingTool) {
                // ESTRUTURAL: um step anterior no plano ainda vai buscar dado dinâmico (weather,
                // web_search, exec_command...) que ainda não rodou — então este conteúdo, não
                // importa o que diga, não pode ser o dado real. Não precisa (e não tenta) casar
                // nenhuma palavra: a garantia vem da ORDEM dos steps, não do texto.
                log.warn(
                    `${logPrefix} step ${i + 1}: '${resolvedTool}.${contentDepSpec.arg}' preenchido ANTES de um step ` +
                    `produtor de dado dinâmico já ter rodado (${contentStr.length} chars) — convertendo para AgentLoop step`
                );
                mutations.push({
                    stepId: String(s.id ?? `step_${i + 1}`),
                    originalTool: resolvedTool,
                    reason: 'premature_content',
                    detail: `${contentStr.length} chars, depende de step produtor de dado ainda não executado`,
                    description: String(s.description ?? 'Execute step'),
                });
                resolvedTool = undefined;
                toolArgs = undefined;
            } else {
                const verdict = await classifyContentStub(contentStr, resolvedTool);
                if (verdict.isStub) {
                    log.warn(
                        `${logPrefix} step ${i + 1}: '${resolvedTool}.${contentDepSpec.arg}' content stub detectado ` +
                        `(${contentStr.length} chars, LLM reason="${verdict.reason.slice(0, 80)}") ` +
                        `— convertendo para AgentLoop step`
                    );
                    mutations.push({
                        stepId: String(s.id ?? `step_${i + 1}`),
                        originalTool: resolvedTool,
                        reason: 'content_stub',
                        detail: `${contentStr.length} chars, LLM reason="${verdict.reason.slice(0, 80)}"`,
                        description: String(s.description ?? 'Execute step'),
                    });
                    resolvedTool = undefined;
                    toolArgs = undefined;
                }
            }
        }

        // Valida args obrigatórios de ferramentas que falham silenciosamente
        // quando chamadas sem os parâmetros corretos. Converte para AgentLoop
        // (sem toolName) para que o LLM resolva com contexto completo, em vez
        // de deixar a tool explodir com erro de parâmetro obrigatório.
        // Validate required args even when toolArgs is absent (e.g. send_document without file_path).
        // Previously the check was skipped when toolArgs was undefined, letting invalid steps
        // pass through to the RiskAnalyzer instead of being caught here.
        if (resolvedTool) {
            const missing = detectMissingRequiredArgs(resolvedTool, toolArgs ?? {});
            if (missing) {
                log.warn(`${logPrefix} step ${i + 1}: '${resolvedTool}' ${missing} — converting to AgentLoop step`);
                mutations.push({
                    stepId: String(s.id ?? `step_${i + 1}`),
                    originalTool: resolvedTool,
                    reason: 'missing_args',
                    detail: missing,
                    description: String(s.description ?? 'Execute step'),
                });
                resolvedTool = undefined;
                toolArgs = undefined;
            }
        }

        // PREMATURE FILE REFERENCE: arquivo referenciado ainda não existe E nenhum step 'write'
        // ANTERIOR no plano produz esse MESMO path diretamente (nem é evidência de ciclo
        // anterior, via knownExistingPaths). Ver TOOL_DEPENDENCY_ARG acima (kind:'file_reference')
        // para o achado real que motivou este check. Roda depois da validação de args
        // obrigatórios: só avalia existência quando o argumento sobreviveu como string não-vazia
        // (file_path ausente já foi tratado como 'missing_args' acima).
        //
        // DELIBERADAMENTE não usa sawDataProducingTool/exec_command como "produtor plausível"
        // (versão anterior deste check usava) — removido por simplificação, não por regressão.
        // "Rodou algum exec_command antes" não tem nenhuma relação verificável com "esse arquivo
        // específico vai existir": o nome final quase nunca aparece na linha de comando (o script
        // decide o nome internamente), então essa permissão era uma aposta não verificada, não
        // uma garantia — e mascarava exatamente o mesmo tipo de falso-negativo que este check
        // existe para eliminar. Sem ela: quando o arquivo REALMENTE vai ser gerado por um
        // exec_command futuro (caso legítimo, ex. write(script)→exec_command→send_document de um
        // artefato com nome DIFERENTE do script), este step vira AgentLoop — que resolve
        // corretamente em runtime, depois que o exec_command já rodou de verdade e o arquivo
        // realmente existe. Custo: um turno extra de LLM nesse caso; ganho: nunca confia numa
        // suposição não verificável sobre o que um comando de shell arbitrário vai produzir.
        const fileRefDepSpec = resolvedTool ? TOOL_DEPENDENCY_ARG[resolvedTool] : undefined;
        if (resolvedTool && toolArgs && fileRefDepSpec?.kind === 'file_reference' && typeof toolArgs[fileRefDepSpec.arg] === 'string' && toolArgs[fileRefDepSpec.arg]) {
            const { resolved: resolvedFilePath } = resolvePath(String(toolArgs[fileRefDepSpec.arg]));
            if (!writtenPaths.has(resolvedFilePath) && !fs.existsSync(resolvedFilePath)) {
                log.warn(
                    `${logPrefix} step ${i + 1}: '${resolvedTool}.${fileRefDepSpec.arg}'="${toolArgs[fileRefDepSpec.arg]}" ` +
                    `ainda não existe em disco e nenhum 'write' anterior no plano produz esse path ` +
                    `— convertendo para AgentLoop step`
                );
                mutations.push({
                    stepId: String(s.id ?? `step_${i + 1}`),
                    originalTool: resolvedTool,
                    reason: 'missing_file_reference',
                    detail: `"${toolArgs[fileRefDepSpec.arg]}" não existe; nenhum 'write' anterior no plano produz esse path`,
                    description: String(s.description ?? 'Execute step'),
                });
                resolvedTool = undefined;
                toolArgs = undefined;
            }
        }

        // Só conta como "produtor de dado" se o step sobreviveu com essa tool (não foi
        // rebaixado pra AgentLoop por nenhum dos checks acima) — um step inválido nunca vai
        // realmente rodar, então não produz dado nenhum pros steps seguintes.
        if (resolvedTool && DATA_PRODUCING_TOOLS.has(resolvedTool)) {
            sawDataProducingTool = true;
        }

        steps.push({
            id: String(s.id ?? `step_${i + 1}`),
            description: String(s.description ?? 'Execute step'),
            toolName: resolvedTool,
            toolArgs,
            fallbackSteps: [],
            status: 'pending' as const,
        });
    }

    return { steps, mutations };
}
