/**
 * Nome da pasta de uma skill aprendida em `skills/` — módulo-folha (QUANDO_EXTRAIR_DUPLICACAO): o `SkillLearner` grava a
 * pasta com este nome, e a importação do conhecimento (ADR-020/ADR-034) precisa do MESMO nome para saber se uma skill que
 * chega foi desativada ou recusada aqui. Duas cópias da regra divergiriam, e uma skill desativada voltaria ativa.
 */
export function pastaDaSkill(sourcePatternOuNome: string): string {
    return sourcePatternOuNome
        .toLowerCase()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_|_$/g, '');
}
