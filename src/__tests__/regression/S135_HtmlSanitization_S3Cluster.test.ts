/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S135 (CodeQL #7-11, cluster de sanitização HTML incompleta)
 *
 * Cobre as partes testáveis sem DOM/rede do cluster S3:
 *  - shared/stripHtmlTags.ts (js/incomplete-multi-character-sanitization) — DiscordAdapter,
 *    TelegramPollingSupervisor, agentOutputParser delegam pra cá agora.
 *  - shared/htmlEntities.ts decodeHtmlEntities() (js/double-escaping) — web_navigate/web_search
 *    delegam pra cá agora; ordem de decodificação corrigida (&amp; por último).
 *  - web_navigate.ts extractReadableText() / web_search.ts extractReadableContent()
 *    (js/bad-tag-filter) — `</script >` com espaço agora é reconhecido como fechamento válido.
 *
 * ModelDropdown.js (#14, js/xss-through-dom) não tem cobertura automatizada aqui — é DOM de
 * navegador (createElement/addEventListener), sem jsdom configurado neste projeto; validado por
 * leitura de código (eliminação de innerHTML/onclick-string, não por escaping).
 *
 * Execução: npx ts-node src/__tests__/regression/S135_HtmlSanitization_S3Cluster.test.ts
 */

import { stripHtmlTags } from '../../shared/stripHtmlTags';
import { decodeHtmlEntities } from '../../shared/htmlEntities';
import { WebNavigateTool } from '../../tools/web_navigate';
import { WebSearchTool } from '../../tools/web_search';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  OK ${message}`); passed++; }
    else { console.error(`  FALHOU: ${message}`, detail ?? ''); failed++; }
}

async function main() {
    console.log('\n=== S135.1 — stripHtmlTags resiste a tags aninhadas/sobrepostas ===');
    {
        assert(stripHtmlTags('<b>ok</b>') === 'ok', 'caso simples continua funcionando');
        assert(!stripHtmlTags('<scr<script>ipt>alert(1)</scr<script>ipt>').includes('<'), 'tags aninhadas não deixam "<" sobrando após o strip', stripHtmlTags('<scr<script>ipt>alert(1)</scr<script>ipt>'));
        assert(stripHtmlTags('texto normal sem tags') === 'texto normal sem tags', 'texto sem tags não é alterado');
    }

    console.log('\n=== S135.2 — decodeHtmlEntities: &amp; decodifica por ÚLTIMO, não reconstrói tag a partir de entidade dupla ===');
    {
        const doubleEncoded = '&amp;lt;script&amp;gt;';
        const result = decodeHtmlEntities(doubleEncoded);
        assert(result === '&lt;script&gt;', 'entidade duplamente escapada decodifica pra "&lt;script&gt;" literal (o que um navegador mostraria), NÃO reconstrói "<script>"', result);
        assert(result !== '<script>', 'nunca reconstrói uma tag real a partir de &amp;-duplo (ANTES: reconstruía)', result);

        assert(decodeHtmlEntities('&amp;') === '&', 'decodificação simples de &amp; continua correta');
        assert(decodeHtmlEntities('&lt;div&gt;') === '<div>', 'decodificação simples de &lt;/&gt; continua correta');
        assert(decodeHtmlEntities('&#65;&#x42;') === 'AB', 'entidades numéricas (decimal e hex) continuam corretas');
    }

    console.log('\n=== S135.3 — web_navigate.extractReadableText: "</script >" (com espaço) agora remove o conteúdo do script ===');
    {
        const marker = 'XSS_MARKER_LEAKED_INTO_OUTPUT_1234567890';
        const html = `<script>${marker}();</script ><p>Texto legitimo da pagina que tem mais de trinta caracteres aqui.</p>`;
        const tool = new WebNavigateTool();
        const result: string = (tool as any).extractReadableText(html, 4000);
        assert(!result.includes(marker), 'conteúdo do script (fechado com espaço antes do ">") não aparece no texto extraído', result);
        assert(result.includes('Texto legitimo'), 'texto legítimo do parágrafo continua sendo extraído normalmente', result);
    }

    console.log('\n=== S135.4 — web_search.extractReadableContent: mesma proteção ===');
    {
        const marker = 'XSS_MARKER_LEAKED_INTO_OUTPUT_ABCDEFGHIJ';
        const html = `<script>${marker}();</script ><p>Outro texto legitimo da pagina com mais de quarenta caracteres aqui.</p>`;
        const tool = new WebSearchTool();
        const result: { title: string; content: string } = (tool as any).extractReadableContent(html);
        assert(!result.content.includes(marker), 'conteúdo do script não aparece no content extraído', result.content);
        assert(result.content.includes('Outro texto legitimo'), 'texto legítimo continua sendo extraído normalmente', result.content);
    }

    console.log(`\n=== RESULTADO: ${passed} passou, ${failed} falhou ===`);
    if (failed > 0) process.exit(1);
}

main().catch(err => { console.error(err); process.exit(1); });
