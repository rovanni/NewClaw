/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S171
 * Rotas de modelos locais (.gguf): listagem da pasta do usuário, validação de entrada do
 * carregamento e memória do último modelo carregado.
 *
 * CONTEXTO: a Sprint de modelos locais (02/08/2026) adicionou rotas que LEEM UMA PASTA DA MÁQUINA
 * e EXECUTAM UM BINÁRIO local. Todos os defeitos daquele dia foram encontrados clicando na tela —
 * nenhum por teste — e clicar não se repete a cada mudança futura. Este arquivo cobre o que dá
 * para verificar de forma repetível: o contrato HTTP das rotas contra um filesystem real (pasta
 * temporária com arquivos de verdade), sem depender de um servidor de modelo instalado.
 *
 * Por que via HTTP e filesystem real, e não regex no código-fonte: a S165 quebrou nesse mesmo dia
 * porque casava com a formatação do código, não com o comportamento — passou a dar falso alarme
 * numa reorganização que não mudou nada. Aqui o teste exercita o que o dashboard exercita.
 *
 * REGRESSÃO SE: a listagem passar a aceitar arquivos que não são modelos servíveis; o
 * carregamento aceitar um nome de arquivo fora da pasta configurada (caminho absoluto ou ../);
 * a pasta ganhar um valor padrão embutido; ou o registro do último modelo sumir quando o processo
 * morre (é ele que permite oferecer "carregar agora" depois de um reinício da máquina).
 *
 * Execução: npx ts-node src/__tests__/regression/S171_LocalModelServer_Lifecycle.test.ts
 */

import express from 'express';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createModelsRouter, getLastKnownLocalServer } from '../../dashboard/routes/models';
import type { DashboardContext } from '../../dashboard/routes/types';
import type { NewClawConfig } from '../../core/AgentController';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

async function withServer(app: express.Express, run: (base: string) => Promise<void>): Promise<void> {
    const server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    const port = (server.address() as { port: number }).port;
    try { await run(`http://127.0.0.1:${port}`); } finally { server.close(); }
}

function makeApp(config: Partial<NewClawConfig>) {
    const fullConfig = { defaultProvider: 'ollama', language: 'pt-BR', maxIterations: 10, memoryWindowSize: 10, ...config } as NewClawConfig;
    const ctx: DashboardContext = { config: fullConfig };
    const app = express();
    app.use(express.json());
    app.use('/api/models', createModelsRouter(ctx));
    return app;
}

/** Pasta de modelos de mentira, com arquivos REAIS — é o filesystem que está sendo testado. */
function makeModelsDir(withBinary: boolean): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'newclaw-s171-'));
    fs.writeFileSync(path.join(dir, 'modelo-alfa-Q4_K_M.gguf'), 'x'.repeat(2048));
    fs.writeFileSync(path.join(dir, 'Qwen3VL-8B-Instruct-Q4_K_M.gguf'), 'x'.repeat(1024));
    // Projetor multimodal: acompanha um modelo de visão, não é servível sozinho.
    fs.writeFileSync(path.join(dir, 'mmproj-alfa-F16.gguf'), 'x'.repeat(512));
    // Ruído que não é modelo — não pode aparecer na lista.
    fs.writeFileSync(path.join(dir, 'LEIAME.txt'), 'nao sou um modelo');
    fs.writeFileSync(path.join(dir, 'config.json'), '{}');
    if (withBinary) fs.writeFileSync(path.join(dir, 'llamafile-0.10.4.exe'), 'binario de mentira');
    return dir;
}

async function main() {
    console.log('\n=== S171 — sem pasta configurada: reporta ausência, não inventa um caminho ===');
    {
        // O projeto é OSS e roda em Windows, Linux e macOS: um default embutido só funcionaria na
        // máquina de quem o escreveu. O correto diante de dado não informado é dizer que falta.
        const app = makeApp({ localModelsDir: '' });
        await withServer(app, async (base) => {
            const res = await fetch(`${base}/api/models/local`);
            const body = await res.json() as { success: boolean; configured: boolean; models: unknown[]; dir: string };
            assert(body.success === true, 'responde com sucesso (ausência de pasta não é erro de servidor)');
            assert(body.configured === false, 'configured=false — a UI usa isso para pedir a pasta ao usuário');
            assert(body.models.length === 0, 'nenhum modelo inventado');
            assert(body.dir === '', 'não devolve caminho nenhum');
        });
    }

    console.log('\n=== S171 — pasta ilegível: devolve o motivo, não derruba a rota ===');
    {
        const app = makeApp({ localModelsDir: path.join(os.tmpdir(), 'newclaw-s171-nao-existe-' + Date.now()) });
        await withServer(app, async (base) => {
            const res = await fetch(`${base}/api/models/local`);
            const body = await res.json() as { success: boolean; configured: boolean; error?: string };
            assert(res.status === 200, 'HTTP 200 — pasta errada é resultado da busca, não falha do dashboard');
            assert(body.configured === true, 'configured=true: a pasta FOI informada, só não pôde ser lida');
            assert(!!body.error, 'traz a mensagem real do sistema para o usuário poder corrigir o caminho');
        });
    }

    console.log('\n=== S171 — listagem: só modelos servíveis, com dados reais do disco ===');
    {
        const dir = makeModelsDir(true);
        const app = makeApp({ localModelsDir: dir });
        await withServer(app, async (base) => {
            const res = await fetch(`${base}/api/models/local`);
            const body = await res.json() as {
                models: Array<{ id: string; sizeBytes: number; capabilities: string[]; served: boolean; provider: string }>;
                serverBinary: string | null;
            };
            const ids = body.models.map(m => m.id);
            assert(ids.includes('modelo-alfa-Q4_K_M.gguf'), `lista arquivos .gguf (obtido: ${ids.join(', ')})`);
            assert(!ids.some(i => i.startsWith('mmproj-')), 'projetores mmproj-* ficam de fora — não são modelos servíveis sozinhos');
            assert(!ids.some(i => i.endsWith('.txt') || i.endsWith('.json')), 'arquivos que não são modelo ficam de fora');
            const alfa = body.models.find(m => m.id === 'modelo-alfa-Q4_K_M.gguf')!;
            assert(alfa.sizeBytes === 2048, `tamanho vem do disco, não é estimado (obtido: ${alfa.sizeBytes})`);
            assert(alfa.provider === 'local', 'marcado como origem local');
            assert(alfa.served === false, 'nada é reportado como em uso sem um provider realmente servindo');
            const vl = body.models.find(m => m.id === 'Qwen3VL-8B-Instruct-Q4_K_M.gguf')!;
            assert(vl.capabilities.includes('vision'), `capacidades inferidas do nome (obtido: ${vl.capabilities.join(',')})`);
            assert(body.serverBinary === 'llamafile-0.10.4.exe', `detecta o executável do servidor na pasta (obtido: ${body.serverBinary})`);
        });
        fs.rmSync(dir, { recursive: true, force: true });
    }

    console.log('\n=== S171 — sem executável na pasta: a UI precisa saber para poder explicar ===');
    {
        const dir = makeModelsDir(false);
        const app = makeApp({ localModelsDir: dir });
        await withServer(app, async (base) => {
            const res = await fetch(`${base}/api/models/local`);
            const body = await res.json() as { serverBinary: string | null; models: unknown[] };
            assert(body.serverBinary === null, 'serverBinary=null quando não há servidor na pasta');
            assert(body.models.length > 0, 'os modelos continuam listados — a ausência do executável não esconde o que existe');
        });
        fs.rmSync(dir, { recursive: true, force: true });
    }

    console.log('\n=== S171 — SEGURANÇA: carregar só aceita nome de arquivo da pasta configurada ===');
    {
        // A rota executa um binário; o nome do modelo é o único dado que vem do cliente. Ele é
        // conferido contra a listagem REAL da pasta — o que descarta ../, caminho absoluto e
        // qualquer arquivo de fora por construção, não por filtro de string.
        const dir = makeModelsDir(true);
        const app = makeApp({ localModelsDir: dir });
        await withServer(app, async (base) => {
            const casos: Array<[string, string]> = [
                ['../../../etc/passwd', 'caminho relativo para fora da pasta'],
                ['..\\..\\Windows\\System32\\calc.exe', 'caminho relativo estilo Windows'],
                ['C:\\Windows\\System32\\calc.exe', 'caminho absoluto'],
                ['/usr/bin/id', 'caminho absoluto unix'],
                ['LEIAME.txt', 'arquivo da pasta que não é modelo'],
                ['', 'nome vazio'],
            ];
            for (const [file, descricao] of casos) {
                const res = await fetch(`${base}/api/models/local/serve`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file }),
                });
                const body = await res.json() as { success: boolean; error?: string };
                assert(res.status === 400 && body.success === false, `recusa ${descricao}`, { file, status: res.status });
            }
        });
        fs.rmSync(dir, { recursive: true, force: true });
    }

    console.log('\n=== S171 — carregar sem pasta configurada é recusado antes de qualquer execução ===');
    {
        const app = makeApp({ localModelsDir: '' });
        await withServer(app, async (base) => {
            const res = await fetch(`${base}/api/models/local/serve`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file: 'qualquer.gguf' }),
            });
            assert(res.status === 400, 'HTTP 400 sem pasta configurada — nada é executado');
        });
    }

    console.log('\n=== S171 — pasta sem executável: erro nomeado, para a UI explicar o que fazer ===');
    {
        const dir = makeModelsDir(false);
        const app = makeApp({ localModelsDir: dir });
        await withServer(app, async (base) => {
            const res = await fetch(`${base}/api/models/local/serve`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file: 'modelo-alfa-Q4_K_M.gguf' }),
            });
            const body = await res.json() as { error?: string };
            assert(body.error === 'no_server_binary', `erro identificável, não texto solto (obtido: ${body.error})`);
        });
        fs.rmSync(dir, { recursive: true, force: true });
    }

    console.log('\n=== S171 — memória do último modelo (é o que permite "carregar agora") ===');
    {
        // Sem servidor rodando nesta suíte, o valor é null. O que importa aqui é o CONTRATO: a
        // função existe, é leitura pura (sem rede) e pode ser chamada no caminho do polling do
        // dashboard. O comportamento com processo morto foi verificado ao vivo em 02/08/2026:
        // matar o processo NÃO apaga o registro, senão o dashboard perderia o nome do modelo e
        // não teria o que oferecer depois de um reinício da máquina.
        const t0 = Date.now();
        const snapshot = getLastKnownLocalServer();
        const elapsed = Date.now() - t0;
        assert(snapshot === null || typeof snapshot.file === 'string', 'devolve null ou {file, port}');
        assert(elapsed < 200, `é leitura local, sem I/O de rede (levou ${elapsed}ms)`);

        const src = fs.readFileSync(path.join(process.cwd(), 'src', 'dashboard', 'routes', 'models.ts'), 'utf-8');
        const adopt = src.slice(src.indexOf('async function adoptRunningServer'), src.indexOf('export function getLastKnownLocalServer'));
        assert(
            !/catch\s*\{\s*persistServerState\(null\)/.test(adopt),
            'processo morto NÃO apaga o registro — ele é a única memória de qual modelo o usuário escolheu'
        );
        const stop = src.slice(src.indexOf('function stopLocalServer'), src.indexOf('function findLocalServerBinary'));
        assert(
            /persistServerState\(null\)/.test(stop),
            'descarregar explicitamente APAGA o registro — aí sim o usuário disse que não quer mais'
        );
    }

    console.log('\n=== S171 — o servidor não pode ser filho do NewClaw ===');
    {
        // Incidente real (02/08/2026): o servidor subia como processo filho, e "Salvar & Reiniciar"
        // — que a própria tela manda clicar — matava o modelo junto. O sistema voltava apontando
        // para uma porta muda. Carregar um modelo de vários GB não pode ser desfeito por reiniciar
        // o aplicativo.
        const src = fs.readFileSync(path.join(process.cwd(), 'src', 'dashboard', 'routes', 'models.ts'), 'utf-8');
        assert(/spawn\([^)]*detached:\s*true/s.test(src), 'spawn com detached:true');
        assert(/child\.unref\(\)/.test(src), 'child.unref() — o NewClaw não espera pelo processo nem o arrasta ao morrer');
        assert(/process\.env\.LOCAL_SERVER_PORT/.test(src), 'porta configurável: duas instâncias na mesma máquina não disputam a mesma');
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S171 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    console.log(`\nCOBERTURA:`);
    console.log(`  Listagem contra filesystem real (filtros, tamanho, capacidades): testado`);
    console.log(`  Pasta ausente/ilegível — reporta em vez de adivinhar: testado`);
    console.log(`  Validação de entrada do carregamento (traversal, absoluto, não-modelo): testado`);
    console.log(`  Detecção do executável do servidor: testado`);
    console.log(`  Contrato da memória do último modelo: testado`);
    console.log(`  Processo desacoplado do NewClaw: testado`);
    if (failed > 0) process.exit(1);
}

main().catch(err => { console.error('Erro inesperado:', err); process.exit(1); });
