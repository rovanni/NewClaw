/**
 * extractMissingExecutable — função pura compartilhada: dado um texto de erro, decide se ele é
 * evidência de EXECUTÁVEL ausente (processo que o SO não conseguiu localizar/rodar) e, se for,
 * extrai o nome normalizado do binário.
 *
 * ACHADO que motivou a extração (auditoria desta sessão): a mesma pergunta — "este erro indica
 * um executável ausente?" — era respondida por 3 implementações divergentes: o método privado
 * `extractMissingToolName()` e a const local `isCommandMissing` (ambas em GoalEvaluator.ts,
 * já divergentes entre si — a segunda não reconhecia o texto do cmd.exe no Windows nem
 * "spawn ENOENT") e a const local `isCommandNotFound` em AgentLoop.ts (regex própria, com
 * `ENOENT` bare — sujeita ao mesmo falso-positivo de ENOENT de arquivo/diretório que já tinha
 * sido corrigido em GoalEvaluator.ts). Não existe (e nunca existiu) uma função equivalente em
 * exec_command.ts — confirmado por busca global antes desta extração.
 *
 * Retorna `string | null` (não um objeto estruturado): os 3 consumidores reais só precisam de
 * um booleano ("achou evidência?") e do nome extraído — nenhum precisa hoje de uma 3ª categoria
 * além de "executável ausente" vs "não é isso".
 */

const FS_ENOENT_SYSCALLS = 'open|scandir|lstat|stat|access|unlink|mkdir|rmdir|readdir|rename|copyfile|realpath';

// ENOENT de operação de arquivo/diretório (fs), NÃO de processo. Precisa ser checado ANTES de
// qualquer padrão de executável ausente: "ENOENT: no such file or directory, open 'input.mp3'"
// não tem relação nenhuma com um binário faltando. O shape do Node distingue os dois: erro de
// spawn é "spawn <cmd> ENOENT" (ENOENT no final, sem vírgula); erro de fs é "ENOENT: no such
// file or directory, <syscall> '<path>'" (ENOENT no início, com o verbo de syscall depois da
// vírgula) — nunca usar ENOENT bare como evidência suficiente.
const FS_ENOENT_PATTERN = new RegExp(`ENOENT:\\s*no such file or directory,\\s*(?:${FS_ENOENT_SYSCALLS})`, 'i');

/**
 * Normaliza um nome/caminho de executável extraído para uma chave estável: remove diretório
 * (basename) e extensão executável do Windows (.exe/.cmd/.bat/.com). Não normaliza outras
 * extensões — um nome como "script.py" continua "script.py".
 */
function normalizeExecutableName(raw: string): string {
    const trimmed = raw.trim().replace(/^['"]|['"]$/g, '');
    const basename = trimmed.split(/[\\/]/).pop() || trimmed;
    return basename.replace(/\.(exe|cmd|bat|com)$/i, '');
}

/**
 * Extrai o nome do executável ausente de um texto de erro, ou `null` se o texto não contém
 * evidência de executável ausente (inclui explicitamente o caso de ENOENT de arquivo/diretório,
 * que deve ser tratado como um erro diferente pelo chamador).
 *
 * Exemplos reconhecidos:
 *   "spawn edge-tts ENOENT"             → "edge-tts"
 *   "spawnSync edge-tts ENOENT"         → "edge-tts"
 *   "bash: pandoc: command not found"  → "pandoc"
 *   "pandoc: command not found"        → "pandoc"
 *   "which: no ffmpeg in (...)"        → "ffmpeg"
 *   "cannot find 'marp'"                → "marp"
 *   "'edge-tts' is not recognized as an internal or external command" → "edge-tts"
 *   "'yq' não é reconhecido como um comando interno ou externo" → "yq"
 *
 * Exemplos que retornam null (ENOENT de fs, não de processo):
 *   "ENOENT: no such file or directory, open 'input.mp3'"
 *   "ENOENT: no such file or directory, scandir 'temp'"
 */
export function extractMissingExecutable(errorText: string): string | null {
    if (FS_ENOENT_PATTERN.test(errorText)) return null;

    // Node child_process: "spawn <cmd> ENOENT" / "spawnSync <cmd> ENOENT" — mensagem gerada
    // pelo próprio runtime (exec/execFile usam "spawn" internamente; execFileSync/spawnSync
    // usam "spawnSync"). Só ocorre quando o SO falhou ao localizar o processo a rodar — nunca
    // aparece em erros de fs (excluídos acima).
    const spawnEnoent = errorText.match(/\bspawn(?:Sync)?\s+(.+?)\s+ENOENT\b/i);
    if (spawnEnoent) return normalizeExecutableName(spawnEnoent[1]);

    // "bash: pandoc: command not found" / "sh: 1: pandoc: not found"
    const shellPrefix = errorText.match(/(?:bash|sh|zsh|dash|fish|cmd):\s*(?:\d+:\s*)?(\w[\w.-]*?):\s*(?:command\s+)?not found/i);
    if (shellPrefix) return shellPrefix[1];

    // "pandoc: command not found" (sem prefixo de shell)
    const plainNotFound = errorText.match(/^(\w[\w.-]*?):\s*command not found/im);
    if (plainNotFound) return plainNotFound[1];

    // "which: no pandoc in ..."
    const whichNo = errorText.match(/which:\s*no\s+(\w[\w.-]*?)\s+in/i);
    if (whichNo) return whichNo[1];

    // "cannot find 'pandoc'" ou "cannot find pandoc"
    const cannotFind = errorText.match(/cannot find ['"]?(\w[\w.-]*?)['"]?(?:\s|$)/i);
    if (cannotFind) return cannotFind[1];

    // cmd.exe (Windows): o console do Windows quebra linha por largura de coluna, então a mesma
    // mensagem pode chegar com um \r\n inserido NO MEIO da frase (achado real: validação E2E,
    // 24/07 — "comando interno\r\nou externo", quebra depois de "interno"; o ponto de quebra
    // varia com o tamanho do nome do binário e a largura do console). \s+ entre cada palavra (em
    // vez de espaço literal) tolera isso em QUALQUER idioma reconhecido aqui — não é um problema
    // exclusivo do pt-BR, é do cmd.exe; resolvido uma vez para as duas variantes.
    //
    // "'edge-tts' is not recognized as an internal or external command"
    const winNotRecognized = errorText.match(/'([^']+)'\s+is\s+not\s+recognized\s+as\s+an\s+internal\s+or\s+external\s+command/i);
    if (winNotRecognized) return normalizeExecutableName(winNotRecognized[1]);

    // cmd.exe (Windows, pt-BR — locale do SO, não do NewClaw): "'yq' não é reconhecido como um
    // comando interno ou externo, um programa operável ou um arquivo em lotes". Sem isto, o
    // binário ausente nunca é detectado numa instalação Windows configurada em português.
    //
    // "não é" (2ª achado, mesma validação): o cmd.exe emite esse trecho num codepage (ex.:
    // CP850/CP1252) que não é UTF-8; o child_process do Node decodifica como UTF-8 por padrão, e
    // cada byte inválido de "ã"/"é" vira U+FFFD — a string real chega como "n�o � reconhecido...",
    // nunca com os acentos intactos. Casar literalmente com "não é" (o que se lê no terminal, não
    // o que chega como string) nunca bateria. Âncora só no trecho sem acento ("reconhecido como
    // um comando interno ou externo", estável em qualquer codepage por ser ASCII puro) e trata o
    // vão inicial como tamanho variável — resolve a causa (mojibake de codepage + quebra de
    // linha do console), não só o sintoma de uma execução isolada.
    // O vão usa [^'] (não [\s\S]) para nunca pular por cima de outra aspa — sem isso, um texto
    // com aspas anteriores (ex.: prefixo de outro contexto) poderia capturar o conteúdo errado.
    const winNaoReconhecido = errorText.match(/'([^']+)'[^']{0,20}?reconhecido\s+como\s+um\s+comando\s+interno\s+ou\s+externo/i);
    if (winNaoReconhecido) return normalizeExecutableName(winNaoReconhecido[1]);

    // ENOENT no caminho legado com aspas: ex. "ENOENT ... '/usr/bin/pandoc'"
    const enoent = errorText.match(/ENOENT[^']*'([^/']+)'/i);
    if (enoent) return enoent[1];

    return null;
}
