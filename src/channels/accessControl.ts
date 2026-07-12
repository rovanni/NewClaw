/**
 * accessControl — Semântica única de allowlist para TODOS os canais.
 *
 * Motivação (auditoria adversarial 2026-07-12, achado C2): cada adapter reimplementava a
 * verificação de remetente autorizado com uma guarda `allowlist.length > 0 &&`. O efeito era
 * que uma allowlist VAZIA fazia o bloco inteiro ser pulado — ou seja, "vazio = aceita QUALQUER
 * remetente" no WhatsApp, Signal e Discord. O Telegram, por escrever `if (!allowlist.includes(id))
 * return;` sem a guarda de tamanho, tinha a semântica OPOSTA: vazio = bloqueia todos. Essa
 * divergência entre canais permitia que uma instalação com um canal habilitado mas sem allowlist
 * configurada aceitasse comandos de terceiros — incluindo goals que executam ferramentas perigosas
 * (exec_command, ssh_exec).
 *
 * O NewClaw é um ASSISTENTE PESSOAL (ver package.json: "Agente pessoal de IA"): o proprietário
 * configura os próprios IDs. A postura correta e única é FAIL-CLOSED — allowlist vazia nega tudo,
 * em todos os canais. Este módulo é o ponto único dessa regra; nenhum adapter deve reimplementá-la.
 */

/**
 * Retorna true somente se ao menos uma das identidades do remetente estiver na allowlist.
 *
 * FAIL-CLOSED: allowlist ausente/vazia (após remover entradas em branco) → SEMPRE nega. Isso é
 * deliberado e uniforme entre canais — nunca "vazio = aberto".
 *
 * `identities` aceita múltiplas formas do mesmo remetente porque cada canal identifica o usuário
 * de um jeito (WhatsApp: jid completo OU só o número; Signal: número E.164; Discord/Telegram: id
 * numérico). Passar todas e deixar o helper casar qualquer uma preserva o comportamento de cada
 * adapter sem espalhar a lógica de "vazio = nega" por 4 arquivos.
 */
export function isSenderAllowed(
    allowlist: readonly string[] | undefined,
    ...identities: Array<string | undefined | null>
): boolean {
    const list = (allowlist ?? []).filter((entry) => typeof entry === 'string' && entry.trim().length > 0);
    if (list.length === 0) return false; // fail-closed — vazio nega tudo, sem exceção
    return identities.some((id) => typeof id === 'string' && id.length > 0 && list.includes(id));
}

/**
 * Retorna true se a mensagem passa por um filtro de ESCOPO opcional (ex.: allowlist de guilds do
 * Discord). Diferente de `isSenderAllowed`, este é FAIL-OPEN quando vazio: o escopo é um
 * estreitamento secundário ("aceite só nestes servidores"), NÃO o controle de autorização
 * primário — e mensagens diretas (DM) legitimamente não têm escopo (guild) algum. A autorização
 * real continua sendo sempre `isSenderAllowed` sobre o remetente.
 *
 * `scopeId` undefined (ex.: DM sem guild) sempre passa — o filtro só se aplica quando há um escopo
 * concreto a comparar E uma lista configurada.
 */
export function isWithinScope(scopeAllowlist: readonly string[] | undefined, scopeId: string | undefined | null): boolean {
    const list = (scopeAllowlist ?? []).filter((entry) => typeof entry === 'string' && entry.trim().length > 0);
    if (list.length === 0) return true;   // fail-open — escopo não configurado não restringe
    if (!scopeId) return true;            // sem escopo concreto (ex.: DM) — filtro não se aplica
    return list.includes(scopeId);
}
