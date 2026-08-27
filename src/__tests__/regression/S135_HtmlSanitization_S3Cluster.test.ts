/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S135 (CodeQL #7-11, cluster de sanitização HTML incompleta)
 *
 * Cobre as partes testáveis sem DOM/rede do cluster S3:
 *  - shared/stripHtmlTags.ts (js/incomplete-multi-character-sanitization) — DiscordAdapter,
 *    TelegramPollingSupervisor, agentOutputParser delegam pra cá agora.
 *  - shared/htmlEntities.ts decodeHtmlEntities() (js/double-escaping) — web_navigate/web_search
 *    delegam pra cá agora; ordem de decodificação corrigida (&amp; por último).
 *  - extractStaticContent() (js/bad-tag-filter) — `</script >` com espaço agora é reconhecido
 *    como fechamento válido; S135.5 cobre a variante achada depois (2026-07-21, alertas #85/#86):
 *    `</script\t\n bar>` (lixo/atributos arbitrários antes do ">", não só espaço) também é uma
 *    end-tag válida pra parsers HTML reais e não casava com o regex anterior (`\s*>`, só espaço).
 *
 *    ATUALIZAÇÃO (Sprint 4, campanha "Web Search Coverage & Evidence Quality", 26/08/2026): esta
 *    proteção vivia duplicada em `web_navigate.ts` (`extractReadableText`) e `web_search.ts`
 *    (`extractReadableContent`) — unificada em `shared/pageContentReader.ts`
 *    (`extractStaticContent`), autoridade única agora usada pelos dois. Os métodos antigos não
 *    existem mais nas ferramentas; o teste passou a chamar a função compartilhada diretamente —
 *    mesma cobertura de segurança, sem duplicar o teste por consumidor (não há mais lógica própria
 *    de extração em nenhum dos dois para testar separadamente).
 *
 * ModelDropdown.js (#14, js/xss-through-dom) não tem cobertura automatizada aqui — é DOM de
 * navegador (createElement/addEventListener), sem jsdom configurado neste projeto; validado por
 * leitura de código (eliminação de innerHTML/onclick-string, não por escaping).
 *
 * Execução: npx ts-node src/__tests__/regression/S135_HtmlSanitization_S3Cluster.test.ts
 */

import { stripHtmlTags } from '../../shared/stripHtmlTags';
import { decodeHtmlEntities } from '../../shared/htmlEntities';
import { extractStaticContent } from '../../shared/pageContentReader';

const EXTRACT_OPTS = { maxChars: 4000, minLineLength: 30, maxLines: 40 };

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

    console.log('\n=== S135.3 — extractStaticContent: "</script >" (com espaço) agora remove o conteúdo do script ===');
    {
        const marker = 'XSS_MARKER_LEAKED_INTO_OUTPUT_1234567890';
        const html = `<script>${marker}();</script ><p>Texto legitimo da pagina que tem mais de trinta caracteres aqui.</p>`;
        const result = extractStaticContent(html, EXTRACT_OPTS);
        assert(!result.includes(marker), 'conteúdo do script (fechado com espaço antes do ">") não aparece no texto extraído', result);
        assert(result.includes('Texto legitimo'), 'texto legítimo do parágrafo continua sendo extraído normalmente', result);
    }

    console.log('\n=== S135.4 — mesma função, chamada por ambas as ferramentas antes (web_search.ts/web_navigate.ts) — proteção continua valendo para as duas agora que é uma autoridade só ===');
    {
        const marker = 'XSS_MARKER_LEAKED_INTO_OUTPUT_ABCDEFGHIJ';
        const html = `<script>${marker}();</script ><p>Outro texto legitimo da pagina com mais de quarenta caracteres aqui.</p>`;
        const result = extractStaticContent(html, EXTRACT_OPTS);
        assert(!result.includes(marker), 'conteúdo do script não aparece no content extraído', result);
        assert(result.includes('Outro texto legitimo'), 'texto legítimo continua sendo extraído normalmente', result);
    }

    console.log('\n=== S135.5 — "</script\\t\\n bar>" (lixo antes do ">", não só espaço) também remove o script (CodeQL #85/#86) ===');
    {
        const marker = 'XSS_MARKER_TRAILING_GARBAGE_END_TAG_KLMNOP';
        const evasive = '</script\t\n bar>';
        const html = `<script>${marker}();${evasive}<p>Texto legitimo da pagina que tem mais de trinta caracteres aqui.</p>`;
        const result = extractStaticContent(html, EXTRACT_OPTS);
        assert(!result.includes(marker), 'conteúdo do script (fechado com lixo antes do ">") não aparece no texto extraído', result);
        assert(result.includes('Texto legitimo'), 'texto legítimo continua sendo extraído', result);

        // Garante que a tag continua exigindo o NOME exato "script" — "</scriptx>" não deve
        // fechar o script real (senão \b[^>]*> viraria permissivo demais e apagaria conteúdo
        // legítimo por engano).
        const notATag = extractStaticContent(
            `<script>${marker}();</scriptx><p>Texto legitimo da pagina que tem mais de trinta caracteres aqui.</p>`,
            EXTRACT_OPTS
        );
        assert(notATag.includes(marker), '"</scriptx>" (nome de tag diferente) NÃO fecha o script real — \\b continua exigindo o nome exato', notATag);
    }

    console.log(`\n=== RESULTADO: ${passed} passou, ${failed} falhou ===`);
    if (failed > 0) process.exit(1);
}

main().catch(err => { console.error(err); process.exit(1); });
