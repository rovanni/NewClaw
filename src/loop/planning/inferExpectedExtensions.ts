/**
 * Infere extensões de arquivo esperadas a partir de texto livre (userIntent/descrição de step).
 * Retorna lista vazia se não há tipo de arquivo identificável.
 *
 * Extraído de GoalExecutionLoop (era método privado, dois call sites: checkDeliverables e
 * checkClaimsAgainstEvidence) para reuso por RiskAnalyzer na resolução de file_path durante o
 * replan (docs/REVISAO_ARQUITETURAL_SPRINT_R6_2026-07-13.md §1) — mesmo padrão de extração já
 * aplicado a sanitizePlanSteps/toolAliasResolver/CONTENT_STUB_PATTERNS neste projeto.
 */
export function inferExpectedExtensions(userIntent: string): string[] {
    const lower = userIntent.toLowerCase();
    const exts: string[] = [];
    if (/pptx|apresenta|slides?|powerpoint/i.test(lower)) exts.push('.pptx', '.ppt');
    if (/pdf/i.test(lower)) exts.push('.pdf');
    if (/docx?|word|documento/i.test(lower)) exts.push('.docx', '.doc');
    if (/xlsx?|excel|planilha/i.test(lower)) exts.push('.xlsx', '.xls');
    if (/mp4|vídeo|video/i.test(lower)) exts.push('.mp4', '.avi', '.mkv');
    if (/mp3|áudio|audio/i.test(lower)) exts.push('.mp3', '.ogg', '.wav');
    if (/html|página|pagina/i.test(lower)) exts.push('.html');
    if (/zip|comprim/i.test(lower)) exts.push('.zip');
    // Imagens só são entregáveis se o objetivo explícito for produzir imagens.
    // Excluir quando o intent contém marcadores de VisionHandler ("[IMAGEM RECEBIDA:")
    // ou quando o intent menciona slides/pptx (foto enviada como feedback, não entregável).
    const isImageDeliveryIntent =
        /png|jpg|jpeg|imagem|image/i.test(lower) &&
        !lower.includes('[imagem recebida:') &&
        !/slides?|pptx|apresenta|powerpoint/i.test(lower);
    if (isImageDeliveryIntent) exts.push('.png', '.jpg', '.jpeg');
    return exts;
}
