/**
 * envSerializer — fronteira única de escrita segura em arquivo `.env`.
 *
 * Campanha de Security (CORS + `.env` + `DASHBOARD_HOST`), item A. Causa raiz corrigida aqui:
 * `persistConfigToEnv()` (dashboard/routes/config.ts) gravava 14+ campos livres — incluindo
 * `SYSTEM_PROMPT`, totalmente editável pela UI sem validação — via `${key}=${value}` sem
 * nenhum escape. Um valor contendo uma quebra de linha seguida de `OUTRA_CHAVE=valor` virava,
 * literalmente, uma segunda variável de ambiente no próximo boot — incluindo `DASHBOARD_PASSWORD`
 * e `TELEGRAM_ALLOWED_USER_IDS` no mesmo arquivo. Correção na FRONTEIRA (esta função, chamada uma
 * vez para todos os campos), não campo a campo.
 *
 * Formato alvo é o parser real do pacote `dotenv` (node_modules/dotenv/lib/main.js) — verificado
 * empiricamente (não só lendo a fonte), porque esse parser só entende dois escapes: dentro de
 * aspas duplas, a sequência literal de dois caracteres `\n`/`\r` vira controle real; nada mais é
 * desescapado (nem `\"`, nem `\\`). Isso limita o que pode ser representado com fidelidade total:
 *
 * - Sem quebra de linha/CR real E sem aspa simples literal → aspas simples, SEM nenhum escape.
 *   O `dotenv` nunca reinterpreta o conteúdo de um valor entre aspas simples — `"` e `\` literais
 *   sobrevivem perfeitamente (é o caso mais comum: chaves de API, URLs, nomes de modelo, e a
 *   maioria dos system prompts).
 * - Senão (tem quebra de linha/CR, ou tem aspa simples forçando sair do caso acima): precisa de
 *   aspas duplas, escapando quebra de linha real → `\n` literal e CR real → `\r` literal. Só é
 *   seguro quando o valor NÃO contém aspa dupla literal nem a sequência de texto `\n`/`\r` já
 *   escapada — as duas ficam ambíguas com o próprio mecanismo de escape do `dotenv` (ele não
 *   distingue "isto já era um `\n` de texto" de "isto é o meu escape da quebra real"), e ele
 *   também nunca desescapa `\"` de volta pra `"` sozinho.
 *
 * Um valor que cai nessa última categoria (quebra de linha REAL + aspa dupla literal, ou aspa
 * simples + aspa dupla ao mesmo tempo, ou `\n`/`\r` de texto literal junto de quebra real) não tem
 * representação fiel nesse formato — `encodeEnvValue()` devolve `null`, e quem chama NUNCA deve
 * escrever um substituto silencioso: rejeitar e avisar é o comportamento correto, não uma
 * aproximação "quase certa" salva sem avisar.
 */

/** Serializa um valor para uma linha `.env`, ou `null` se não houver representação fiel nesse
 *  formato — nunca inventa uma aproximação. */
export function encodeEnvValue(value: string): string | null {
    const hasNewline = value.includes('\n') || value.includes('\r');
    const hasSingleQuote = value.includes("'");
    const hasDoubleQuote = value.includes('"');
    // Sequência de TEXTO literal "\n"/"\r" (barra + letra, não controle real) — ambígua com o
    // próprio escape deste método se cair no ramo de aspas duplas (dotenv não distingue as duas
    // origens ao desescapar).
    const hasLiteralBackslashNOrR = /\\[nr]/.test(value);

    if (!hasNewline && !hasSingleQuote) {
        return `'${value}'`;
    }
    if (hasDoubleQuote || hasLiteralBackslashNOrR) {
        return null;
    }
    const escaped = value.replace(/\n/g, '\\n').replace(/\r/g, '\\r');
    return `"${escaped}"`;
}

export interface EnvUpdateResult {
    /** Conteúdo final do arquivo — só reflete as chaves que puderam ser codificadas com segurança. */
    content: string;
    /** Chaves que NÃO foram escritas por não terem representação fiel no formato `.env` — o valor
     *  anterior daquela chave (se existia) permanece intocado no arquivo. Nunca fica silencioso:
     *  quem chama esta função é responsável por logar/reportar esta lista. */
    rejected: string[];
}

/**
 * Aplica `updates` sobre o conteúdo atual do `.env`, uma única fronteira para todas as chaves.
 * Linhas não gerenciadas (comentários, chaves fora de `updates`) sobrevivem intocadas — mesma
 * garantia que o mecanismo anterior já dava, preservada aqui.
 */
export function applyEnvUpdates(existingContent: string, updates: Record<string, string>): EnvUpdateResult {
    const lines = existingContent.length > 0 ? existingContent.split(/\r?\n/) : [];
    // Índice da linha de cada chave gerenciável já presente no arquivo — parse determinístico por
    // linha, não regex construída dinamicamente a partir do nome da chave (evita reconstruir a
    // mesma ambiguidade de "match cruza linha" que o mecanismo anterior tinha com `.` não
    // cobrindo newline em modo multiline).
    const lineIndexByKey = new Map<string, number>();
    for (let i = 0; i < lines.length; i++) {
        const match = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(lines[i]);
        if (match) lineIndexByKey.set(match[1], i);
    }

    const rejected: string[] = [];
    for (const [key, value] of Object.entries(updates)) {
        const encoded = encodeEnvValue(value);
        if (encoded === null) {
            rejected.push(key);
            continue; // valor anterior (se existir) permanece — nunca substituído por aproximação
        }
        const newLine = `${key}=${encoded}`;
        const existingIndex = lineIndexByKey.get(key);
        if (existingIndex !== undefined) {
            lines[existingIndex] = newLine;
        } else {
            lines.push(newLine);
            lineIndexByKey.set(key, lines.length - 1);
        }
    }

    const content = lines.join('\n');
    return { content: content.length > 0 ? content.trim() + '\n' : '', rejected };
}
