/**
 * Data e hora de agora, em texto, para quem decide (o juiz). Módulo-folha.
 *
 * Quem julga "o ATH foi em 26/01/2026" ou "atualizado hoje" precisa saber que dia é hoje — uma pessoa sabe; o juiz não sabia
 * (relatado por ele mesmo no campo `faltou`, 10/10/2026). O fuso é o da MÁQUINA (Windows, Linux e macOS informam o seu); nada
 * é escrito à mão.
 */
export function descreverAgora(agora: Date = new Date()): string {
    const fuso = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    const texto = agora.toLocaleString('pt-BR', { timeZone: fuso, dateStyle: 'full', timeStyle: 'short' });
    return `${texto} (fuso ${fuso})`;
}
