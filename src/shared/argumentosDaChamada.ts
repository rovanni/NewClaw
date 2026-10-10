/**
 * Os argumentos de uma chamada de ferramenta, em texto, para quem decide (os juízes). Módulo-folha.
 *
 * Os juízes de qualidade e de resultado do passo viam só a SAÍDA da ferramenta ("atualizado") e relataram, no campo `faltou`, que
 * não conseguiam conferir o conteúdo gravado — que estava nos argumentos da chamada. Uma pessoa que audita o passo veria o que foi
 * pedido à ferramenta. Valores de texto muito longos (ex.: o conteúdo de um arquivo grande) são cortados POR VALOR, com o corte
 * declarado com os números — nunca em silêncio e nunca a ponto de estourar o prompt.
 */
const LIMITE_POR_VALOR = 2000;

export function descreverArgumentos(args: unknown, limitePorValor: number = LIMITE_POR_VALOR): string | undefined {
    if (args === undefined || args === null) return undefined;
    // Os rastros guardam os argumentos já como texto JSON: lê de volta para cortar POR VALOR (texto puro segue como está).
    if (typeof args === 'string') { try { args = JSON.parse(args); } catch { /* texto puro */ } }
    const cortar = (v: unknown): unknown => {
        if (typeof v === 'string') {
            return v.length > limitePorValor
                ? `${v.slice(0, limitePorValor)}[… trecho: primeiros ${limitePorValor} de ${v.length} caracteres — o corte é do sistema, não do dado]`
                : v;
        }
        if (Array.isArray(v)) return v.map(cortar);
        if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, cortar(x)]));
        return v;
    };
    try {
        const texto = JSON.stringify(cortar(args));
        return texto && texto !== '{}' && texto !== '[]' ? texto : undefined;
    } catch {
        return undefined;
    }
}
