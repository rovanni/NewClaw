/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S467
 *
 * 30/10/2026, pedido da operadora: abrir a interface de voz exigia Config → Integrações → Abrir a cada vez, e o que ela
 * falava na voz parecia não ficar no histórico. Ficava (conversa `voz-633dc7d7`, 55 mensagens), mas o painel a listava
 * com o id cru como título.
 *
 * - Atalhos: toda integração opcional instalada, ligada e com endereço de abrir ganha um link no cabeçalho, em toda
 *   página. A lista é a mesma do cartão (`GET /api/integrations/opcionais`); sem login ou com erro, nada muda.
 * - Título: conversa que só existia no servidor ganha a primeira frase da pessoa como título, e a da voz (`voz-…`), 🎙.
 *
 * REGRESSÃO SE: o atalho aparecer para integração desligada, não instalada ou sem endereço http(s); o nome ou o
 * endereço entrarem no HTML sem escapar; um erro da consulta quebrar o cabeçalho; o título voltar a ser o id cru.
 *
 * Execução: npx ts-node src/__tests__/regression/S467_AtalhosDasIntegracoesEConversasDeVoz.test.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}

const PUBLICO = path.resolve(__dirname, '../../dashboard/public');
const shared = fs.readFileSync(path.join(PUBLICO, 'shared.js'), 'utf-8');
const index = fs.readFileSync(path.join(PUBLICO, 'index.html'), 'utf-8');

/** Recorta `function nome(...) { ... }` (ou `async function`) do código-fonte, pelas chaves. */
function recortar(fonte: string, nome: string): string {
    const inicio = fonte.search(new RegExp(`(?:async )?function ${nome}\\(`));
    if (inicio < 0) throw new Error(`função ${nome} não encontrada`);
    let i = fonte.indexOf('{', inicio);
    let nivel = 0;
    for (; i < fonte.length; i++) {
        if (fonte[i] === '{') nivel++;
        else if (fonte[i] === '}' && --nivel === 0) return fonte.slice(inicio, i + 1);
    }
    throw new Error(`função ${nome} sem fim`);
}

async function main(): Promise<void> {
    console.log('\n=== S467-1 — cabeçalho tem o lugar dos atalhos e os preenche ===');
    const cabecalho = recortar(shared, 'newclawHeader');
    assert(/id="newclaw-atalhos"/.test(cabecalho), 'o cabeçalho tem o contêiner dos atalhos');
    assert(/newclawPreencherAtalhos/.test(cabecalho), 'montar o cabeçalho agenda o preenchimento');

    console.log('\n=== S467-2 — só integração instalada, ligada e com endereço http(s); tudo escapado ===');
    const alvo = { innerHTML: '' };
    const guardado: Record<string, string> = {};
    let resposta: { ok: boolean; json: () => Promise<unknown> } | Error = {
        ok: true,
        json: async () => ({
            integracoes: [
                { id: 'a', nome: 'Voz <b>', instalada: true, ligada: true, abrir: 'http://127.0.0.1:7860/?x="1"' },
                { id: 'b', nome: 'Desligada', instalada: true, ligada: false, abrir: 'http://127.0.0.1:1' },
                { id: 'c', nome: 'Não instalada', instalada: false, ligada: false, abrir: 'http://127.0.0.1:2' },
                { id: 'd', nome: 'Sem endereço', instalada: true, ligada: true },
                { id: 'e', nome: 'Endereço perigoso', instalada: true, ligada: true, abrir: 'javascript:alert(1)' },
                { id: 'f', erro: 'manifesto fora do ar' },
            ],
        }),
    };
    let pedido = '';
    const ctx = vm.createContext({
        NEWCLAW_KEY: 'nc_',
        document: { getElementById: (id: string) => (id === 'newclaw-atalhos' ? alvo : null) },
        sessionStorage: { getItem: (k: string) => guardado[k] ?? null, setItem: (k: string, v: string) => { guardado[k] = v; } },
        newclawGetToken: () => 'tok',
        t: (_k: string, d: { nome: string }) => `Abrir ${d.nome}`,
        fetch: async (url: string) => { pedido = url; if (resposta instanceof Error) throw resposta; return resposta; },
    });
    vm.runInContext(
        `const NEWCLAW_ATALHOS_KEY = NEWCLAW_KEY + 'atalhos';\n${recortar(shared, 'newclawDesenharAtalhos')}\n${recortar(shared, 'newclawPreencherAtalhos')}`,
        ctx,
    );
    await vm.runInContext('newclawPreencherAtalhos()', ctx);
    assert(pedido === '/api/integrations/opcionais', 'consulta a mesma lista do cartão', pedido);
    const links = alvo.innerHTML.match(/<a /g) ?? [];
    assert(links.length === 1, 'um atalho só: a integração ligada com endereço http(s)', alvo.innerHTML);
    assert(alvo.innerHTML.includes('Voz &lt;b&gt;') && !alvo.innerHTML.includes('<b>'), 'nome escapado');
    assert(alvo.innerHTML.includes('&quot;1&quot;'), 'endereço escapado');
    assert(/target="_blank" rel="noopener noreferrer"/.test(alvo.innerHTML), 'abre em aba nova, sem dar acesso à página');
    assert(!/Desligada|Não instalada|Sem endereço|perigoso/.test(alvo.innerHTML), 'as outras ficam de fora');

    console.log('\n=== S467-3 — a última lista aparece já ao trocar de página; erro não apaga nem quebra ===');
    alvo.innerHTML = '';
    resposta = new Error('rede fora');
    let quebrou = false;
    try { await vm.runInContext('newclawPreencherAtalhos()', ctx); } catch { quebrou = true; }
    assert(!quebrou, 'erro de rede não sobe para a página');
    assert((alvo.innerHTML.match(/<a /g) ?? []).length === 1, 'o atalho guardado na aba continua desenhado');

    console.log('\n=== S467-4 — título das conversas que vêm do servidor ===');
    const titulo = vm.runInNewContext(`(${recortar(index, 'tituloPelasMensagens')})`) as (c: unknown) => string | null;
    const msgs = [
        { role: 'bot', content: 'Oi!', timestamp: 1 },
        { role: 'user', content: 'Segunda frase', timestamp: 30 },
        { role: 'user', content: 'Olá, tudo bem?', timestamp: 10 },
    ];
    assert(titulo({ id: 'voz-633dc7d7', messages: msgs }) === '🎙 Olá, tudo bem?', 'voz: 🎙 + a primeira frase da pessoa');
    assert(titulo({ id: 'conv_1', messages: msgs }) === 'Olá, tudo bem?', 'conversa escrita: só a frase');
    assert(titulo({ id: 'conv_2', messages: [{ role: 'user', content: 'x'.repeat(80), timestamp: 1 }] }) === 'x'.repeat(50) + '...', 'corta em 50 como o painel');
    assert(titulo({ id: 'voz-1', messages: [] }) === null, 'sem frase da pessoa: fica o título que já havia');
    assert(/c\.title === c\.id \|\| c\.title === c\.serverId\) c\.title = tituloPelasMensagens\(c\)/.test(index),
        'a sincronização troca o id cru pelo título');

    console.log(`\n${passed} passaram, ${failed} falharam`);
    if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
