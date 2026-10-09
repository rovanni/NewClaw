/**
 * Divisão de um orçamento de caracteres entre vários textos que vão juntos para um LLM.
 *
 * Fonte única (campanha 09/10/2026): a regra nasceu dentro do juiz de grounding
 * (`ObserverValidator.evidenceCapForBudget`, issue 051) e passou a ser usada também pela etapa do agente que
 * recebe os resultados dos passos anteriores de um goal. Duas cópias da mesma regra divergiriam — por isso ela
 * mora aqui, num módulo-folha sem dependências, e os dois lados a importam.
 *
 * Puro e determinístico; não decide nada sobre o conteúdo — só quanto de cada texto cabe.
 */

/**
 * O maior limite único `c` tal que Σ min(tamanho, c) ≤ `disponivel` ("water-filling"): textos menores que `c`
 * entram inteiros; os maiores são cortados por igual em `c`.
 *
 * - Tudo cabe → `Infinity` (nada é cortado).
 * - Nada cabe (`disponivel` ≤ 0) → `0`.
 */
export function limiteComum(tamanhos: number[], disponivel: number): number {
    const sizes = tamanhos.filter(n => n > 0);
    const total = sizes.reduce((s, n) => s + n, 0);
    if (total <= disponivel) return Infinity;
    if (disponivel <= 0) return 0;

    sizes.sort((a, b) => a - b);
    let remaining = disponivel;
    for (let i = 0; i < sizes.length; i++) {
        const left = sizes.length - i;
        // Se todos os textos restantes couberem no limite `sizes[i]`, este entra inteiro; senão o
        // limite comum é a divisão por igual do que sobrou entre os restantes.
        if (sizes[i] * left > remaining) return Math.floor(remaining / left);
        remaining -= sizes[i];
    }
    return Infinity;
}
