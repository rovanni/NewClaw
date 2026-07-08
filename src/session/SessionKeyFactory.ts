/**
 * SessionKeyFactory — fonte canônica única para compor/decompor a identidade de uma conversa
 * (channel + userId) em todos os lugares que hoje fazem isso manualmente.
 *
 * MICROAUDITORIA HOLÍSTICA (2026-07-08, continuidade conversacional): antes deste módulo,
 * `${channel}:${userId}` era composto de forma independente em pelo menos 4 arquivos
 * (SessionManager, GoalOrchestrator, SessionLearner, MessageBus) e decomposto via
 * `str.split(':')` com destructuring em 4 call sites (GoalOrchestrator.ts:530,
 * GoalExecutionLoop.ts:518/1522/2405) — um padrão que TRUNCA silenciosamente qualquer userId
 * que contenha ':' (o array de split tem mais de 2 elementos, e só os 2 primeiros são usados).
 * SessionAutoCleaner.ts já tinha a versão correta (`slice(1).join(':')`), provando que as duas
 * implementações divergiam sem ninguém perceber. Nenhum canal real produz userId com ':' hoje
 * (Telegram/Discord = ID numérico, Signal/WhatsApp = telefone sem símbolos, web = UUID do
 * localStorage do frontend ou o sessionId enviado no corpo da requisição HTTP) — por isso o
 * bug nunca se manifestou em produção — mas nada no código impedia estruturalmente essa classe
 * de colisão de identidade entre dois usuários caso um userId viesse a conter ':'.
 *
 * `parse` usa o PRIMEIRO ':' como delimitador (não destructuring de split ilimitado) — round-trip
 * exato com `compose` para qualquer userId, incluindo um que contenha ':'.
 */

export interface SessionKeyParts {
    channel: string;
    userId: string;
}

/** Compõe a identidade composta `channel:userId` — única forma correta de construir essa string. */
export function composeSessionKey(key: SessionKeyParts): string {
    return `${key.channel}:${key.userId}`;
}

/**
 * Decompõe uma identidade composta `channel:userId` de volta em suas partes.
 * Delimita no PRIMEIRO ':' — userId pode conter ':' sem ser truncado (round-trip exato com compose).
 * Sem ':' no input (chave malformada/legado), tudo vira userId e channel fica vazio.
 */
export function parseSessionKey(composite: string): SessionKeyParts {
    const idx = composite.indexOf(':');
    if (idx === -1) return { channel: '', userId: composite };
    return { channel: composite.slice(0, idx), userId: composite.slice(idx + 1) };
}

/**
 * Codifica uma identidade composta para uso seguro como NOME DE ARQUIVO.
 *
 * BUG REAL confirmado em produção (2026-07-08, instalação Windows do próprio usuário,
 * `dir /r` em data/sessions): ':' dentro de um nome de arquivo não é um caractere comum no
 * NTFS — é o separador de Alternate Data Stream (ADS). `path.join(dir, "web:powerpoint-addin-
 * ....jsonl")` no Windows não cria um arquivo chamado literalmente isso; cria uma ADS
 * ":powerpoint-addin-....jsonl" pendurada num arquivo-base vazio chamado "web". O processo
 * consegue ler/escrever essa ADS de volta normalmente (por isso os dados nunca se perderam —
 * a aplicação sempre usou o mesmo path composto para ler e escrever), mas QUALQUER código que
 * enumera sessões via `fs.readdirSync(transcriptDir)` (ex.: SessionAutoCleaner.compactStale())
 * NUNCA vê essas entradas — só os arquivos-base "telegram"/"web" (que nem terminam em .jsonl).
 * Resultado comprovado: a compactação automática de sessões NUNCA rodou em nenhuma instalação
 * Windows deste projeto — todo o histórico de sessão cresce sem limite, invisível a qualquer
 * ferramenta de backup/limpeza que dependa de listagem de diretório.
 *
 * Fix: troca ':' por '~' (caractere seguro em NTFS/ext4/APFS, não usado hoje em nenhum channel
 * ou userId real) só na hora de derivar o nome de arquivo — a identidade lógica (`composite`,
 * usada em Maps, DB, logs) continua sendo `channel:userId` sem nenhuma mudança de comportamento
 * fora do disco.
 */
export function toFileSafeId(composite: string): string {
    return composite.replace(/:/g, '~');
}

/**
 * Reverte toFileSafeId — usado por código que precisa ir de um nome de arquivo já no disco
 * (ex.: SessionAutoCleaner varrendo o diretório) de volta pra identidade lógica `channel:userId`.
 *
 * LIMITAÇÃO CONHECIDA E ACEITA (documentada, não corrigida — ver toFileSafeId): assume que o
 * composite original nunca continha '~' literal. Nenhum channel real (enum fixo) ou userId real
 * (ID numérico do Telegram/Discord, telefone do Signal/WhatsApp, UUID do localStorage do
 * dashboard/add-in) produz '~' hoje. O único vetor teórico é um cliente HTTP customizado
 * enviando um `sessionId` arbitrário com '~' direto pro endpoint /api/chat — nesse caso essa
 * ÚNICA sessão específica pode ter seu channel/userId reconstruído incorretamente por uma
 * varredura de compactação em background (sem perda de dados — o arquivo em si continua
 * correto e legível pela própria aplicação, que nunca precisa desta função para ler/escrever,
 * só para relistar arquivos já existentes no disco). Resolver isso exigiria um esquema de
 * escaping com estado (tipo URL-encoding), que troca uma lacuna teórica e inofensiva por
 * complexidade real — desproporcional ao risco.
 */
export function fromFileSafeId(fileSafeId: string): string {
    return fileSafeId.replace(/~/g, ':');
}
