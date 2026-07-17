// Extensões de código-fonte/script — nunca contam como deliverable esperado, mesmo se
// mencionadas literalmente no texto (um script é meio, não fim). Achado ao vivo em 13/07/2026
// (docs/REVISAO_ARQUITETURAL_SPRINT_R7_2026-07-13.md, validação end-to-end do piloto):
// RiskAnalyzer.resolveArtifactPathFromEvidence() escolheu um .py em vez do .txt que o usuário
// pediu, porque .txt não tinha nenhuma keyword aqui — sem extensão esperada, o filtro virava
// permissivo e o candidato mais recente (o script-fonte) venceu. Mesma classe de bug que o
// teste S27 já cobria em outro call site (script enviado em vez do artefato gerado).
//
// Fonte única com AgentLoop.ts's DELIVERY-GUARD (Sprint F2, revisão de código pós-piloto):
// AgentLoop já tinha EXECUTABLE_SCRIPT_EXTENSIONS=['.py','.sh'] (scripts que precisam ser
// EXECUTADOS antes de contar como entregável) e DELIVERABLE_EXTENSIONS incluindo '.js'/'.ts'
// (tratados como entregável direto, não script). A lista anterior aqui incluía '.js'/'.ts' como
// "nunca deliverable", contradizendo essa decisão já existente — um .js/.ts gerado (ex: widget
// web) era aceito como deliverable pelo AgentLoop mas bloqueado incondicionalmente por
// resolveArtifactPathFromEvidence. Lista agora reflete a mesma fronteira que AgentLoop já
// desenha, só estendida com os tipos de script Windows (.ps1/.bat/.cmd) que AgentLoop nunca
// chegou a listar mas que exec_command também executa via wrapForWindowsPowerShell.
export const SOURCE_SCRIPT_EXTENSIONS = new Set(['.py', '.sh', '.ps1', '.bat', '.cmd']);

// Extensões que contam como entregável ao usuário quando aparecem no path de um `write`
// bem-sucedido — usado pelo DELIVERY-GUARD de AgentLoop.ts para decidir se um arquivo escrito
// mas nunca enviado precisa de um nudge de entrega antes da síntese final. Movida para cá
// (ARCH-026) para viver ao lado de SOURCE_SCRIPT_EXTENSIONS — mesma fronteira conceitual
// ("que tipo de arquivo é isto"), mesmo módulo já designado como fonte única para ela. Não é a
// mesma lista que `inferExpectedExtensions()` produz (aquela infere o tipo esperado a partir do
// TEXTO da intenção do usuário; esta classifica um path JÁ ESCRITO em disco) — propositalmente
// mantida como uma lista separada, não fundida com a lógica de inferência.
export const DELIVERABLE_EXTENSIONS: readonly string[] = ['.html', '.pdf', '.md', '.txt', '.js', '.ts', '.csv', '.json', '.docx', '.xlsx'];

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

    // Extensão literal mencionada no texto (ex: "planetas.txt", "resumo.csv") — cobre formatos
    // sem keyword dedicada acima (txt, csv, json, md...) sem precisar enumerar cada um. Só
    // letras (não dígitos) para não confundir com versão/decimal ("v2.0", "gpt-4.1"); scripts
    // ficam de fora mesmo quando citados de propósito.
    const literalExtMatches = lower.match(/\b[\w-]+\.([a-z]{2,4})\b/g) ?? [];
    for (const token of literalExtMatches) {
        const ext = '.' + token.slice(token.lastIndexOf('.') + 1);
        if (!SOURCE_SCRIPT_EXTENSIONS.has(ext) && !exts.includes(ext)) exts.push(ext);
    }

    return exts;
}
