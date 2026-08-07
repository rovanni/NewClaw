/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S206
 * A busca só vai para a instância SearXNG que o usuário declarou. Nunca para um servidor público.
 *
 * CONTEXTO: até 06/08/2026, `web_search.searXNG()` tentava `http://localhost:8888/search` e, se
 * falhasse, mandava a MESMA consulta para `https://searx.be/search` — um servidor público de
 * terceiros. Quem sobe uma instância local faz isso justamente para que suas buscas não saiam da
 * máquina; encontrá-la fora do ar e recorrer à Internet inverte a intenção inteira, em silêncio.
 *
 * Foi o achado mais grave do levantamento da `RFC-005` (Fase 0) e o único cuja implicação é
 * privacidade, não disponibilidade — por isso a Sprint 023 saiu na frente das Sprints de política:
 * não dependia de nada que elas fossem construir.
 *
 * REGRESSÃO SE: qualquer destino de busca voltar a ser embutido no código; o endereço de loopback
 * voltar como padrão implícito (ausência de configuração não é declaração —
 * `SOBERANIA_DA_CONFIGURACAO.md` §1.1); ou uma falha da instância declarada passar a ser
 * compensada por outra instância que o usuário não escolheu.
 *
 * Execução: npx ts-node src/__tests__/regression/S206_SearXNG_NoPublicMirrorFallback.test.ts
 */

import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { WebSearchTool } from '../../tools/web_search';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

const SRC_BRUTO = fs.readFileSync(path.join(process.cwd(), 'src', 'tools', 'web_search.ts'), 'utf-8');

/**
 * Fonte sem comentários — a invariante é sobre o código que EXECUTA, não sobre o texto.
 *
 * O comentário do próprio `searXNG()` nomeia o espelho público e o loopback para registrar o que
 * foi removido e por quê; essa documentação é valiosa e não pode fazer o teste falhar. Removidos
 * apenas blocos `/* *​/` e linhas iniciadas por `//` — nunca `//` no meio de uma linha, que é o que
 * aparece dentro de uma URL em string, exatamente o caso que este teste precisa enxergar.
 */
const SRC = SRC_BRUTO
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

interface Espiao { url: string; caminhos: string[]; pedidos: number; fechar(): Promise<void>; }

/** Instância SearXNG de mentira — responde no formato real e anota o que recebeu. */
async function subirEspiao(): Promise<Espiao> {
    const caminhos: string[] = [];
    const server = http.createServer((req, res) => {
        caminhos.push(String(req.url || '').split('?')[0]);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            results: [{ title: 'Resultado da instância declarada', url: 'https://exemplo.test/a', content: 'trecho' }],
        }));
    });
    server.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const porta = (server.address() as { port: number }).port;
    return {
        url: `http://127.0.0.1:${porta}`,
        caminhos,
        get pedidos() { return caminhos.length; },
        fechar: () => new Promise<void>((r) => server.close(() => r())),
    };
}

/** Chama só o provedor SearXNG — o resto de `execute()` faria rede de verdade. */
async function buscarViaSearxng(tool: WebSearchTool, query: string, maxResults = 3): Promise<unknown[]> {
    return (tool as unknown as {
        searXNG(q: string, n: number): Promise<unknown[]>;
    }).searXNG(query, maxResults);
}

async function main(): Promise<void> {
    const envOriginal = process.env.SEARXNG_URL;
    const tool = new WebSearchTool();

    try {
        console.log('\n=== S206-1 — nenhum destino de busca embutido no código ===');
        {
            assert(!/searx\.be/i.test(SRC), 'o espelho público `searx.be` não existe mais no fonte');

            const inicio = SRC.indexOf('private searxngEndpoint');
            const fim = SRC.indexOf('private deduplicateCandidates');
            const bloco = SRC.slice(inicio, fim);
            assert(inicio > 0 && fim > inicio, 'bloco do SearXNG localizado para inspeção', { inicio, fim });
            assert(
                !/(['"`])https?:\/\/[^'"`]+\1/.test(bloco),
                'nenhuma URL absoluta literal no caminho do SearXNG — todo destino vem da configuração',
                bloco.match(/(['"`])https?:\/\/[^'"`]+\1/)?.[0],
            );
            assert(
                !/localhost:8888|127\.0\.0\.1:8888/.test(SRC),
                'o loopback:8888 não volta como padrão implícito',
            );
        }

        console.log('\n=== S206-2 — sem configuração, a fonte não é consultada ===');
        {
            const espiao = await subirEspiao();
            try {
                delete process.env.SEARXNG_URL;
                const r = await buscarViaSearxng(tool, 'consulta privada do usuário');
                assert(Array.isArray(r) && r.length === 0, 'devolve vazio em vez de procurar um destino', r);
                assert(espiao.pedidos === 0, 'nenhuma requisição sai da máquina', espiao.pedidos);
            } finally { await espiao.fechar(); }
        }

        console.log('\n=== S206-3 — com instância declarada, é ela que responde ===');
        {
            const espiao = await subirEspiao();
            try {
                process.env.SEARXNG_URL = espiao.url;
                const r = await buscarViaSearxng(tool, 'consulta privada do usuário');
                assert(Array.isArray(r) && r.length === 1, 'resultados vêm da instância declarada', r);
                assert(espiao.pedidos === 1, 'exatamente uma requisição, ao destino declarado', espiao.pedidos);
                assert(
                    espiao.caminhos[0] === '/search',
                    'origem sem caminho recebe `/search` — caminho fixo da API, não palpite',
                    espiao.caminhos,
                );
            } finally { await espiao.fechar(); }
        }

        console.log('\n=== S206-4 — endpoint completo é respeitado como escrito ===');
        {
            const espiao = await subirEspiao();
            try {
                process.env.SEARXNG_URL = `${espiao.url}/search`;
                await buscarViaSearxng(tool, 'consulta');
                assert(espiao.caminhos[0] === '/search', 'não duplica o caminho já informado', espiao.caminhos);
            } finally { await espiao.fechar(); }
        }

        console.log('\n=== S206-5 — instância declarada fora do ar NÃO é substituída ===');
        {
            const espiao = await subirEspiao();
            const urlMorta = espiao.url;
            await espiao.fechar(); // porta agora muda

            const testemunha = await subirEspiao(); // faria as vezes de "outra instância qualquer"
            try {
                process.env.SEARXNG_URL = urlMorta;
                const r = await buscarViaSearxng(tool, 'consulta privada do usuário');
                assert(Array.isArray(r) && r.length === 0, 'falha da instância declarada devolve vazio', r);
                assert(
                    testemunha.pedidos === 0,
                    'e a consulta NÃO é redirecionada para nenhum outro servidor — era o defeito',
                    testemunha.pedidos,
                );
            } finally { await testemunha.fechar(); }
        }

        console.log('\n=== S206-6 — valor inválido não vira tentativa às cegas ===');
        {
            process.env.SEARXNG_URL = 'isto não é uma url';
            const r = await buscarViaSearxng(tool, 'consulta');
            assert(Array.isArray(r) && r.length === 0, 'configuração ilegível devolve vazio, sem exceção', r);
        }

        console.log(`\nS206 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
        console.log(`\nCOBERTURA:`);
        console.log(`  Espelho público removido do fonte: testado`);
        console.log(`  Sem configuração, nenhuma requisição sai: testado`);
        console.log(`  Instância declarada é a consultada (origem e endpoint completo): testado`);
        console.log(`  Instância fora do ar não é substituída por outra: testado`);
        console.log(`  Configuração inválida não vira tentativa às cegas: testado`);
    } finally {
        if (envOriginal === undefined) delete process.env.SEARXNG_URL;
        else process.env.SEARXNG_URL = envOriginal;
    }

    if (failed > 0) process.exit(1);
}

main().catch(err => { console.error('Erro inesperado:', err); process.exit(1); });
