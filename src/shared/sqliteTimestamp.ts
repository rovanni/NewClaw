/**
 * Fonte única (issue 063) para o formato de data que o SQLite grava com `DEFAULT CURRENT_TIMESTAMP` /
 * `datetime('now')`: `"YYYY-MM-DD HH:MM:SS"` em **UTC, sem indicador de fuso**. Qualquer consumidor que passe esse
 * texto direto a `new Date()` o lê como hora LOCAL — no painel, toda conversa vinda do servidor aparecia com o
 * deslocamento do fuso do navegador (06/10/2026: 14:33 em Brasília exibido como 17:33).
 *
 * Módulo-folha neutro (QUANDO_EXTRAIR_DUPLICACAO): a mesma regra já existia embutida em
 * `memory/conversationRepository.ts`, e o repositório do painel precisava dela — um não importa o outro.
 *
 * Conversão de FORMATO, não interpretação: só o padrão exato do SQLite é convertido; texto que já traz fuso
 * (ISO com `Z`/offset) ou qualquer outra forma volta inalterado — nunca adivinha.
 */
const SQLITE_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/;

export function sqliteUtcToIso<T extends string | null | undefined>(value: T): T | string {
    if (typeof value !== 'string' || !SQLITE_UTC_TIMESTAMP.test(value)) return value;
    return new Date(value.replace(' ', 'T') + 'Z').toISOString();
}
