/**
 * stripHtmlTags — remove tags HTML/XML de uma string de forma robusta a tags aninhadas.
 *
 * Consolidado de 3 implementações idênticas em passe único (`text.replace(/<[^>]+>/g, '')`,
 * DiscordAdapter.ts, TelegramPollingSupervisor.ts, agentOutputParser.ts) — CodeQL
 * (js/incomplete-multi-character-sanitization) aponta que um passe único não é robusto a tags
 * aninhadas/sobrepostas (ex: `<scr<script>ipt>` — o passe único casa só `<scr<script>`, deixando
 * `ipt>` — mas construções mais adversariais podem reconstruir uma tag válida após um único
 * passe). Fix recomendado pelo próprio CodeQL pra esta regra: repetir a substituição até o
 * resultado estabilizar — cada passe remove uma camada de tags válidas, e como `[^>]+` sempre
 * exige conteúdo não-vazio, a string só encolhe ou para, nunca cresce ou loopa infinitamente.
 */
export function stripHtmlTags(text: string): string {
    let prev: string;
    let current = text;
    do {
        prev = current;
        current = current.replace(/<[^>]+>/g, '');
    } while (current !== prev);
    return current;
}
