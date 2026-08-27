/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S273
 *
 * Campanha "Web Search Coverage & Evidence Quality", Sprint 4 — decisão arquitetural (26/08/2026):
 * "Código determina disponibilidade/estrutura. LLM determina significado/qualidade."
 *
 * ANTES: `web_search.ts` (`readPage`) e `web_navigate.ts` (`getTextView`) decidiam, cada um com
 * seu próprio limiar de caracteres JÁ DIVERGENTE (`>=200` vs `>=300`), se a extração estática era
 * "boa o bastante" ou se deveria cair para o Jina AI Reader — contagem de caracteres como proxy de
 * qualidade semântica, violando "Determinismo valida / LLM interpreta". Cada arquivo também tinha
 * sua própria cópia de `fetchViaJina()` (limiares de "Jina utilizável" divergentes: `>50` vs
 * `>=100`), extração estática (`extractReadableContent`/`extractReadableText`, listas de
 * boilerplate divergentes: 8 termos vs 7) e extração de título (duplicada byte-a-byte).
 *
 * DEPOIS: `shared/pageContentReader.ts` é a autoridade única. A escolha entre extração estática e
 * Jina passa a ser puramente ESTRUTURAL — Jina só é tentado quando a extração estática não produziu
 * NADA (vazia após limpeza), nunca por decisão de tamanho/qualidade. A interpretação de qualidade
 * do conteúdo entregue passa a ser responsabilidade exclusiva das camadas que já a têm (grounding,
 * síntese) — não um julgador semântico novo (explicitamente NÃO implementado nesta sprint).
 *
 * Este teste cobre: (1) ausência estrutural dos limiares de qualidade removidos; (2) fonte única
 * compartilhada pelos dois consumidores; (3) o contrato comportamental do módulo compartilhado —
 * Jina só é tentado quando o estático é estruturalmente vazio, nunca por tamanho.
 *
 * Execução: npx ts-node src/__tests__/regression/S273_PageContentReader_StructuralAuthorityUnified.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { extractStaticContent, extractTitle, readPageContent } from '../../shared/pageContentReader';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  OK ${message}`); passed++; }
    else { console.error(`  FALHOU: ${message}`, detail ?? ''); failed++; }
}

function mockFetchSequence(responses: Array<{ ok?: boolean; contentType?: string; body: string }>) {
    const original = global.fetch;
    let i = 0;
    (global as any).fetch = async () => {
        const r = responses[Math.min(i, responses.length - 1)];
        i++;
        return {
            ok: r.ok ?? true,
            status: (r.ok ?? true) ? 200 : 500,
            headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? (r.contentType ?? 'text/html') : null) },
            text: async () => r.body,
        };
    };
    return { restore: () => { (global as any).fetch = original; }, callCount: () => i };
}

async function main(): Promise<void> {

console.log('\n=== S273-1 — os limiares de "qualidade" (200/300 chars) removidos das duas ferramentas ===');
{
    const webSearchSrc = fs.readFileSync(path.join(process.cwd(), 'src', 'tools', 'web_search.ts'), 'utf-8');
    const webNavigateSrc = fs.readFileSync(path.join(process.cwd(), 'src', 'tools', 'web_navigate.ts'), 'utf-8');
    assert(!/content\.length >= 200/.test(webSearchSrc), 'web_search.ts não decide mais "estático bom o bastante" por >=200 chars');
    assert(!/\.length >= 100/.test(webSearchSrc), 'web_search.ts não decide mais "Jina bom o bastante" por >=100 chars');
    assert(!/content\.length >= 300/.test(webNavigateSrc), 'web_navigate.ts não decide mais "navegador/estático bom o bastante" por >=300 chars');
    assert(!/\.length < 300/.test(webNavigateSrc), 'web_navigate.ts não decide mais fallback para Jina por "<300 chars"');
}

console.log('\n=== S273-2 — Single Authoritative Knowledge: os dois consumidores importam do módulo único ===');
{
    const webSearchSrc = fs.readFileSync(path.join(process.cwd(), 'src', 'tools', 'web_search.ts'), 'utf-8');
    const webNavigateSrc = fs.readFileSync(path.join(process.cwd(), 'src', 'tools', 'web_navigate.ts'), 'utf-8');
    assert(/from '\.\.\/shared\/pageContentReader'/.test(webSearchSrc), 'web_search.ts importa de shared/pageContentReader');
    assert(/from '\.\.\/shared\/pageContentReader'/.test(webNavigateSrc), 'web_navigate.ts importa de shared/pageContentReader');
    // As implementações duplicadas não existem mais nos consumidores — só no módulo compartilhado.
    assert(!/private (async )?fetchViaJina/.test(webSearchSrc), 'web_search.ts não tem mais fetchViaJina própria');
    assert(!/private (async )?fetchViaJina/.test(webNavigateSrc), 'web_navigate.ts não tem mais fetchViaJina própria');
    assert(!/private extractReadableContent/.test(webSearchSrc), 'web_search.ts não tem mais extractReadableContent própria');
    assert(!/private extractReadableText/.test(webNavigateSrc), 'web_navigate.ts não tem mais extractReadableText própria');
    assert(!/private extractTitle/.test(webNavigateSrc), 'web_navigate.ts não tem mais extractTitle própria (duplicata byte-a-byte removida)');
}

console.log('\n=== S273-3 — extractStaticContent(): estrutural, não julga qualidade — devolve vazio quando não sobra nada, texto quando sobra algo (qualquer tamanho) ===');
{
    const htmlVazio = '<html><head><script>var x=1;</script></head><body><nav>Menu</nav><footer>© 2026</footer></body></html>';
    const vazio = extractStaticContent(htmlVazio, { maxChars: 3500, minLineLength: 40, maxLines: 18 });
    assert(vazio === '', 'HTML sem conteúdo real (só script/nav/footer) devolve string vazia — sinal estrutural para o chamador tentar Jina');

    const htmlComPouco = '<html><body><p>' + 'x'.repeat(45) + '</p></body></html>'; // 45 chars, bem menos que os antigos limiares de 200/300
    const pouco = extractStaticContent(htmlComPouco, { maxChars: 3500, minLineLength: 40, maxLines: 18 });
    assert(pouco.length > 0, 'conteúdo curto (45 chars — abaixo dos antigos limiares de "qualidade" 200/300) NÃO é descartado só por ser curto', pouco);
}

console.log('\n=== S273-4 — readPageContent(): Jina só é tentado quando o estático é ESTRUTURALMENTE vazio, nunca por tamanho ===');
{
    // Estático curto (bem abaixo dos antigos 200/300) mas NÃO vazio — Jina não deve ser chamado.
    const htmlCurtoNaoVazio = '<html><body><p>' + 'Conteúdo real muito curto porém presente. '.repeat(2) + '</p></body></html>';
    const { restore, callCount } = mockFetchSequence([{ body: htmlCurtoNaoVazio }]);
    try {
        const page = await readPageContent('https://exemplo.com/curto', { minLineLength: 5, maxLines: 18, maxChars: 3500 });
        assert(page !== null && page.content.length > 0, 'conteúdo estático curto e não-vazio é aceito', page);
        assert(callCount() === 1, 'Jina NÃO foi chamado — apenas 1 fetch (o HTML estático), não 2 (estático + Jina)', callCount());
    } finally {
        restore();
    }
}
{
    // Estático estruturalmente vazio (só nav/footer) — Jina DEVE ser tentado como aquisição alternativa.
    const htmlVazio = '<html><body><nav>Menu</nav><footer>© 2026</footer></body></html>';
    const jinaBody = 'Title: Página Real\nURL Source: https://exemplo.com/vazio\n\nMarkdown Content:\nConteúdo de verdade obtido via Jina.';
    const { restore, callCount } = mockFetchSequence([{ body: htmlVazio }, { body: jinaBody }]);
    try {
        const page = await readPageContent('https://exemplo.com/vazio', { minLineLength: 40, maxLines: 18, maxChars: 3500 });
        assert(page !== null, 'quando o estático é estruturalmente vazio, Jina resgata o conteúdo', page);
        assert(!!page?.content.includes('Conteúdo de verdade'), 'conteúdo retornado é o do Jina', page);
        assert(callCount() === 2, 'Jina FOI chamado — 2 fetches (estático vazio + Jina)', callCount());
    } finally {
        restore();
    }
}

console.log('\n=== S273-5 — extractTitle(): fonte única de extração de <title> ===');
{
    const html = '<html><head><title>  Título de Teste  </title></head><body></body></html>';
    assert(extractTitle(html) === 'Título de Teste', 'extrai e limpa o título corretamente');
    assert(extractTitle('<html><body>sem title</body></html>') === '', 'HTML sem <title> devolve vazio, sem inventar um título');
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S273 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exit(1);

}

main().catch(err => { console.error('ERRO NÃO TRATADO:', err); process.exit(1); });
