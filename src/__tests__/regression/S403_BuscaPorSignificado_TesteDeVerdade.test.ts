/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S403
 * Busca por significado para quem não sabe o que é "embedding": a escolha do modelo só vale depois de um TESTE de verdade.
 *
 * ORIGEM (15/10/2026, navegação como leiga no painel): o campo aceitava qualquer nome e só gravava no Salvar geral; nada
 * dizia se o modelo existia, estava baixado ou servia para isso. Pior: `isAvailable()` comparava por PEDAÇO do nome — o
 * erro de digitação `nomic-embed-tex` passava por disponível (é pedaço de `nomic-embed-text:v1.5`) e todo vetor falhava em
 * silêncio. E quem conversa só por Gemini/Anthropic não sabia que a busca por significado precisa do Ollama.
 *
 * REGRESSÃO SE: o teste deixar de distinguir Ollama fora do ar / modelo não baixado / modelo de conversa / sucesso; um nome
 * parecido voltar a passar por disponível; ou ativar gravar um modelo que não passou no teste.
 *
 * Ollama FALSO em HTTP real (o teste não depende de um Ollama instalado); rotas reais do painel num Express real, com o
 * .env isolado numa pasta temporária.
 *
 * Execução: npx ts-node src/__tests__/regression/S403_BuscaPorSignificado_TesteDeVerdade.test.ts
 */
import express from 'express';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import * as dotenv from 'dotenv';
import { EmbeddingService, nomeNoOllama } from '../../memory/EmbeddingService';
import { createConfigRouter } from '../../dashboard/routes/config';
import type { DashboardContext } from '../../dashboard/routes/types';
import type { NewClawConfig } from '../../core/AgentController';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}

/** Ollama falso: o que a lista (/api/tags) declara e o que a geração de vetor (/api/embeddings) responde. */
function ollamaFalso(): Promise<{ url: string; fechar: () => void }> {
    const modelos = [
        { name: 'nomic-embed-text:v1.5', capabilities: ['embedding'] },
        { name: 'gemma4:e2b', capabilities: ['completion', 'vision', 'tools'] },
        { name: 'antigo-sem-capacidades:latest' },                       // Ollama antigo: não informa capacidades
        { name: 'quebrado:latest', capabilities: ['embedding'] },
    ];
    const server = http.createServer((req, res) => {
        let corpo = '';
        req.on('data', d => { corpo += d; });
        req.on('end', () => {
            res.setHeader('Content-Type', 'application/json');
            if (req.url === '/api/tags') return res.end(JSON.stringify({ models: modelos }));
            if (req.url === '/api/embeddings') {
                const { model } = JSON.parse(corpo || '{}') as { model: string };
                if (model === 'quebrado') { res.statusCode = 500; return res.end('{"error":"falha ao carregar o modelo"}'); }
                if (model === 'antigo-sem-capacidades') return res.end('{"embedding":[]}');
                return res.end(JSON.stringify({ embedding: [0.1, 0.2, 0.3] }));
            }
            res.statusCode = 404; res.end('{}');
        });
    });
    return new Promise(r => server.listen(0, '127.0.0.1', () =>
        r({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, fechar: () => server.close() })));
}

function bancoDeTeste(): Database.Database {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE memory_nodes (id TEXT PRIMARY KEY, name TEXT, content TEXT)');
    db.prepare('INSERT INTO memory_nodes VALUES (?, ?, ?)').run('n1', 'gmail', 'acesso via himalaya');
    db.prepare('INSERT INTO memory_nodes VALUES (?, ?, ?)').run('n2', 'clima', 'cidade padrão');
    return db;
}

async function main(): Promise<void> {
    const original = process.env.EMBED_MODEL;
    const ollama = await ollamaFalso();
    const pastaTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'newclaw-s403-'));
    const cwdOriginal = process.cwd();
    try {
        console.log('\n=== S403-1 — o teste distingue cada situação por FATO (lista do Ollama + vetor gerado) ===');
        {
            const svc = new EmbeddingService(bancoDeTeste(), ollama.url, '');
            const ok = await svc.verificar('nomic-embed-text:v1.5');
            assert(ok.ok === true && ok.dimensoes === 3, 'modelo baixado e de busca → funciona', ok);
            const typo = await svc.verificar('nomic-embed-tex');
            assert(!typo.ok && typo.motivo === 'nao_baixado', 'erro de digitação → "não baixado" (antes passava por disponível)', typo);
            const semEtiqueta = await svc.verificar('nomic-embed-text');
            assert(!semEtiqueta.ok && semEtiqueta.motivo === 'nao_baixado' && nomeNoOllama('nomic-embed-text') === 'nomic-embed-text:latest',
                'sem etiqueta é :latest (como o Ollama resolve) — ter só a :v1.5 não conta', semEtiqueta);
            const conversa = await svc.verificar('gemma4:e2b');
            assert(!conversa.ok && conversa.motivo === 'nao_serve', 'modelo que o Ollama declara de conversa → "não serve"', conversa);
            const semVetor = await svc.verificar('antigo-sem-capacidades');
            assert(!semVetor.ok && semVetor.motivo === 'nao_serve', 'Ollama sem capacidades: decide pelo vetor gerado (vazio → não serve)', semVetor);
            const quebrado = await svc.verificar('quebrado');
            assert(!quebrado.ok && quebrado.motivo === 'erro' && /falha ao carregar/.test(quebrado.detalhe || ''), 'falha na geração → erro com o que o Ollama disse', quebrado);
            const vazio = await svc.verificar('  ');
            assert(!vazio.ok && vazio.motivo === 'sem_modelo', 'nome vazio → pede um modelo');
            const fora = await new EmbeddingService(bancoDeTeste(), 'http://127.0.0.1:1', '').verificar('nomic-embed-text:v1.5');
            assert(!fora.ok && fora.motivo === 'sem_ollama', 'Ollama fora do ar → "não encontrei o Ollama"', fora);
            assert(JSON.stringify(await svc.modelosDeBuscaBaixados()) === JSON.stringify(['nomic-embed-text:v1.5', 'quebrado:latest']),
                'sugestões = só os que o Ollama declara de busca');
        }

        console.log('\n=== S403-2 — isAvailable compara o nome EXATO ===');
        {
            assert(await new EmbeddingService(bancoDeTeste(), ollama.url, 'nomic-embed-text:v1.5').isAvailable(), 'nome exato → disponível');
            assert(!(await new EmbeddingService(bancoDeTeste(), ollama.url, 'nomic-embed-tex').isAvailable()), 'pedaço do nome → NÃO disponível');
        }

        console.log('\n=== S403-3 — rotas do painel: ativar só grava o que passou no teste; situação com a contagem ===');
        {
            process.chdir(pastaTemp);   // persistConfigToEnv escreve .env no cwd — nunca no do projeto
            process.env.EMBED_MODEL = '';
            const db = bancoDeTeste();
            const svc = new EmbeddingService(db, ollama.url);
            const config = { defaultProvider: 'ollama', language: 'pt-BR', maxIterations: 10, memoryWindowSize: 10, telegramAllowedUserIds: [], embedModel: '' } as unknown as NewClawConfig;
            const ctx = { config, controller: { getMemory: () => ({ getEmbeddingService: () => svc }) } } as unknown as DashboardContext;
            const app = express();
            app.use(express.json());
            app.use('/api/config', createConfigRouter(ctx));
            const server = app.listen(0);
            await new Promise(r => server.once('listening', r));
            const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/config/embeddings`;
            const lerEnv = () => dotenv.parse(fs.readFileSync(path.join(pastaTemp, '.env'), 'utf-8'));
            const post = async (acao: string, corpo: object = {}) => (await fetch(`${base}/${acao}`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo),
            })).json() as Promise<Record<string, any>>;
            try {
                const ruim = await post('ativar', { modelo: 'nomic-embed-tex' });
                assert(ruim.success === false && ruim.verificacao?.motivo === 'nao_baixado', 'ativar um nome errado: recusa e explica', ruim);
                assert(config.embedModel === '' && !fs.existsSync(path.join(pastaTemp, '.env')), '... e NÃO grava nada');
                assert(Array.isArray(ruim.modelosDeBusca) && ruim.modelosDeBusca.includes('nomic-embed-text:v1.5'), '... e sugere o que já está baixado');

                const teste = await post('testar', { modelo: 'gemma4:e2b' });
                assert(teste.success === true && teste.verificacao?.motivo === 'nao_serve' && config.embedModel === '', 'testar só testa, não muda nada');

                const bom = await post('ativar', { modelo: 'nomic-embed-text:v1.5' });
                assert(bom.success === true && bom.verificacao?.ok === true && bom.pendentes === 2, 'ativar um modelo que funciona: grava e prepara a memória', bom);
                assert(config.embedModel === 'nomic-embed-text:v1.5' && process.env.EMBED_MODEL === 'nomic-embed-text:v1.5', 'a escolha vale na hora');
                assert(lerEnv().EMBED_MODEL === 'nomic-embed-text:v1.5', 'e sobrevive ao reinício (.env)', lerEnv().EMBED_MODEL);

                let s: Record<string, any> = {};
                for (let i = 0; i < 50; i++) {   // a preparação roda em segundo plano (~100 ms por lembrança)
                    s = await (await fetch(`${base}/status`)).json() as Record<string, any>;
                    if (!s.reindexando) break;
                    await new Promise(r => setTimeout(r, 100));
                }
                assert(s.modelo === 'nomic-embed-text:v1.5' && s.total === 2 && s.prontas === 2 && s.reindexando === false && s.ultimaFalha === '',
                    'situação: ligada, 2 de 2 lembranças prontas', s);

                const desligar = await post('desativar');
                assert(desligar.success === true && config.embedModel === '' && process.env.EMBED_MODEL === '', 'desligar volta à busca por palavras');
                assert(lerEnv().EMBED_MODEL === '', '... também no .env', lerEnv().EMBED_MODEL);
            } finally {
                server.close();
            }
        }

        console.log('\n=== S403-4 — a tela explica cada caso, em 3 línguas, e oferece baixar ===');
        {
            const ler = (...p: string[]) => fs.readFileSync(path.join(cwdOriginal, ...p), 'utf-8');
            const tela = ler('src', 'dashboard', 'public', 'config', 'views', 'ModelosView.js');
            for (const motivo of ['sem_modelo', 'sem_ollama', 'nao_baixado', 'nao_serve', 'erro']) {
                assert(new RegExp(`\\b${motivo}:`).test(tela), `a tela tem uma explicação para "${motivo}"`);
            }
            assert(/data-baixar-modelo/.test(tela) && /pullOllamaModel\(modelo\)/.test(tela) && /await testar\(\)/.test(tela),
                'modelo não baixado: botão "Baixar agora", que testa sozinho ao terminar');
            const textos = ler('src', 'dashboard', 'public', 'shared.js');
            for (const k of ['ml_embed_test_btn', 'ml_embed_activate_btn', 'ml_embed_state_on', 'ml_embed_err_no_ollama', 'ml_embed_err_not_downloaded', 'ml_embed_err_not_embedding', 'ml_embed_download_btn']) {
                assert((textos.match(new RegExp(`\\b${k}:`, 'g')) || []).length === 3, `texto "${k}" nas 3 línguas`);
            }
            assert(!/ml_embed_save_first/.test(textos + tela), 'o aviso "salve antes de reindexar" saiu junto com o passo que o exigia');
        }
    } finally {
        process.chdir(cwdOriginal);
        ollama.fechar();
        fs.rmSync(pastaTemp, { recursive: true, force: true });
        if (original === undefined) delete process.env.EMBED_MODEL; else process.env.EMBED_MODEL = original;
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S403 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => { console.error('S403 erro inesperado:', err); process.exit(1); });
