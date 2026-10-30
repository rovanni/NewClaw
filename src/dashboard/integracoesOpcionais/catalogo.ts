/**
 * Catálogo de integrações opcionais (ADR-031, nota de 30/10/2026): dado, não código.
 *
 * É o único lugar do núcleo que pode citar uma integração opcional, e só pelo nome e pelo endereço do manifesto que ela
 * publica. Tirar uma linha daqui não muda nada no núcleo. O teste S465 confere que nenhum outro arquivo de `src/` cita
 * as integrações listadas.
 */

export interface ItemDoCatalogo {
    id: string;
    manifesto: string;
}

/** De onde manifesto e pacote podem vir (HTTPS). */
export const HOSTS_PERMITIDOS = ['raw.githubusercontent.com', 'codeload.github.com', 'github.com'] as const;

export const CATALOGO: ItemDoCatalogo[] = [
    { id: 'newclaw-ivox', manifesto: 'https://raw.githubusercontent.com/rovanni/newclaw-ivox/main/newclaw-integracao.json' },
];
