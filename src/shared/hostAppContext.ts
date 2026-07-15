/**
 * hostAppContext — fonte única do bloco de contexto do "aplicativo hospedeiro".
 *
 * Alguns canais rodam DENTRO de outro aplicativo (hoje: o suplemento do PowerPoint;
 * amanhã: Word, Excel, etc.). Nesses casos o adapter/rota de entrada popula
 * `NormalizedMessage.metadata.hostApp` (+ dados extras, ex.: `slideContext`) e o
 * restante do sistema precisa saber que a conversa acontece dentro desse aplicativo.
 *
 * BUG REAL (investigação 2026-07-14, docs/INVESTIGACAO_POWERPOINT_ADDIN_2026-07-14.md):
 * este bloco era montado inline em SessionContext.buildLLMMessages() — ou seja, SÓ o
 * caminho AgentLoop enxergava o PowerPoint aberto. Toda mensagem classificada como goal
 * ia para GoalOrchestrator → GoalExecutionLoop → GoalPlanner, que nunca liam
 * `ChannelContext.metadata`: o planner "caçava" a apresentação como arquivo no workspace
 * (list_workspace/read), chegou a executar `Presentation('apresentacao.pptx')` sobre um
 * arquivo de 0 bytes, e nunca considerava powerpoint_control. Extraído para cá para que
 * SessionContext (AgentLoop) e GoalExecutionLoop (planner) consumam a MESMA formatação —
 * uma fonte de verdade, qualquer hostApp futuro herda os dois caminhos de graça.
 *
 * O sinal é `metadata.hostApp` (determinístico, definido pelo canal) — nunca vocabulário
 * do usuário. Funciona igualmente em qualquer idioma e sistema operacional.
 */

export interface HostSlideContext {
    presentationTitle?: string;
    activeSlideIndex?: number;
    totalSlides?: number;
    slideTitles?: string[];
}

const HOST_APP_HINTS: Record<string, string> = {
    powerpoint:
        'Suplemento Microsoft PowerPoint — o usuario esta interagindo de dentro do PowerPoint. '
        + 'Quando o usuario mencionar "tema", "slide", "apresentacao", "design", cores ou termos similares, '
        + 'presuma que se refere a apresentacao ABERTA no PowerPoint (descrita abaixo), nao a arquivos do workspace. '
        + 'Para LER a apresentacao aberta use a ferramenta powerpoint_control: action=getPresentation lista os '
        + 'slides com IDs e titulos; action=getSlide retorna os shapes/textos/tabelas de um slide. '
        + 'NUNCA procure a apresentacao aberta como arquivo fisico no workspace — ela vive no PowerPoint do usuario. '
        + 'Voce pode gerar e inserir slides na apresentacao ativa enviando um .pptx via send_document. '
        + 'IMPORTANTE: todo .pptx enviado sera INSERIDO na apresentacao aberta e PRECISA ser estrutural e '
        + 'editavel — gere com python-pptx (shapes de texto reais). NUNCA gere via Marp CLI: o export pptx do '
        + 'Marp rasteriza cada slide em uma imagem nao-editavel e o usuario nao consegue alterar texto nem cores.',
};

/**
 * Monta o bloco de contexto do aplicativo hospedeiro a partir do metadata do canal.
 * Retorna string vazia quando a conversa não vem de um host conhecido — chamadas de
 * qualquer canal comum (Telegram, Discord, dashboard web…) são no-op por construção.
 */
export function buildHostAppContextBlock(metadata?: Record<string, unknown>): string {
    const hostApp = metadata?.hostApp as string | undefined;
    if (!hostApp || !HOST_APP_HINTS[hostApp]) return '';

    let block = `Canal: ${HOST_APP_HINTS[hostApp]}`;

    const slideContext = metadata?.slideContext as HostSlideContext | undefined;
    if (slideContext) {
        block += `\n\n[CONTEXTO DO POWERPOINT ABERTO]`;
        if (slideContext.presentationTitle) {
            block += `\nArquivo: ${slideContext.presentationTitle}`;
        }
        if (slideContext.activeSlideIndex && slideContext.totalSlides) {
            block += `\nSlide ativo: ${slideContext.activeSlideIndex} de ${slideContext.totalSlides}`;
        }
        if (slideContext.slideTitles && slideContext.slideTitles.length > 0) {
            block += `\nTítulos dos slides:\n` + slideContext.slideTitles.map((title, idx) => `  ${idx + 1}. ${title}`).join('\n');
        } else {
            block += `\nEstrutura de slides: (Nenhum slide ou título encontrado)`;
        }
    }

    return block;
}
