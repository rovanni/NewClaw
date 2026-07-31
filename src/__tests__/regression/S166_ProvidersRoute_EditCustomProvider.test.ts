/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S166
 * Dashboard: providers custom (LM Studio/vLLM/llamafile) só podiam ser adicionados ou
 * removidos — corrigir uma URL digitada errada, trocar o modelo, ou desfazer uma adição feita
 * sem querer (ex.: clique duplo) exigia apagar o card inteiro e recriar do zero.
 *
 * ACHADO (feedback direto do usuário, 2026-07-31, na mesma investigação de fallback pra
 * modelos locais via llamafile): "não tem como alterar modelos só adicionar e se a pessoa
 * clicar em adicionar 10 vezes?" / "estou falando de ter opção de alterar".
 *
 * FIX: `PUT /providers/custom/:label` — atualiza baseUrl/apiKey/model de um provider já
 * cadastrado, mantendo a label (chave de identidade no Map do ProviderFactory). apiKey ausente
 * no body (undefined, não string vazia) PRESERVA a chave já salva — o formulário de edição
 * nunca ecoa o segredo de volta pro campo, então "deixar em branco" precisa significar "não
 * mudar", não "apagar". `ProviderFactory.addCustomProvider()` já sobrescreve a instância
 * existente no Map quando a label é a mesma (Map.set() natural) — reaproveitado sem mudança.
 *
 * HTTP real contra um Express real (nada mockado) — mesmo padrão de S137. process.chdir() pra
 * um dir temporário durante o teste: persistConfigToEnv() (chamado pela rota de verdade) escreve
 * um .env real em process.cwd() — sem isolar, o teste escreveria no .env do próprio projeto.
 *
 * REGRESSÃO SE: PUT deixar de existir, passar a aceitar mudar a label, ou apiKey ausente no
 * body parar de preservar a chave já salva (voltando a exigir apagar+recriar pra qualquer
 * edição, ou pior, apagando a chave sempre que o campo ficar em branco).
 *
 * Execução: npx ts-node src/__tests__/regression/S166_ProvidersRoute_EditCustomProvider.test.ts
 */

import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createProvidersRouter } from '../../dashboard/routes/providers';
import { ProviderFactory } from '../../core/ProviderFactory';
import type { DashboardContext } from '../../dashboard/routes/types';
import type { NewClawConfig } from '../../core/AgentController';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  OK ${message}`); passed++; }
    else { console.error(`  FALHOU: ${message}`, detail ?? ''); failed++; }
}

async function withServer(app: express.Express, run: (base: string) => Promise<void>): Promise<void> {
    const server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    const port = (server.address() as { port: number }).port;
    try {
        await run(`http://127.0.0.1:${port}`);
    } finally {
        server.close();
    }
}

function makeApp(config: Partial<NewClawConfig>) {
    const fullConfig = { defaultProvider: 'ollama', language: 'pt-BR', maxIterations: 10, memoryWindowSize: 10, ...config } as NewClawConfig;
    const ctx: DashboardContext = {
        config: fullConfig,
        providerFactory: new ProviderFactory({ defaultProvider: 'ollama', customProviders: fullConfig.customProviders }),
    };
    const app = express();
    app.use(express.json());
    app.use('/api', createProvidersRouter(ctx));
    return { app, ctx };
}

async function main() {
    // Isola persistConfigToEnv() (chamado pela rota real) num dir temporário — nunca escreve no
    // .env do projeto.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'newclaw-s166-'));
    const originalCwd = process.cwd();
    process.chdir(tmpDir);

    try {
        console.log('\n=== S166.1 — PUT atualiza baseUrl mantendo a mesma label ===');
        {
            const { app, ctx } = makeApp({ customProviders: [{ label: 'llamafile', baseUrl: 'http://localhost:8080/v1', apiKey: undefined, model: undefined }] });
            await withServer(app, async (base) => {
                const res = await fetch(`${base}/api/providers/custom/llamafile`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ baseUrl: 'http://localhost:9090/v1' }),
                });
                const data = await res.json() as { success: boolean };
                assert(res.status === 200 && data.success === true, 'PUT retorna 200 success=true', data);
                assert(ctx.config.customProviders?.[0].baseUrl === 'http://localhost:9090/v1', 'baseUrl atualizado na config persistida');
                assert(ctx.config.customProviders?.[0].label === 'llamafile', 'label permanece inalterada');
                assert(ctx.providerFactory!.getAvailableProviders().includes('llamafile'), 'provider continua registrado no ProviderFactory (instância viva atualizada, não perdida)');
            });
        }

        console.log('\n=== S166.2 — apiKey ausente no body PRESERVA a chave já salva ===');
        {
            const { app, ctx } = makeApp({ customProviders: [{ label: 'lmstudio', baseUrl: 'http://localhost:1234/v1', apiKey: 'segredo-real-123', model: undefined }] });
            await withServer(app, async (base) => {
                await fetch(`${base}/api/providers/custom/lmstudio`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ baseUrl: 'http://localhost:1234/v1' }), // apiKey OMITIDO — campo deixado em branco no form
                });
                assert(ctx.config.customProviders?.[0].apiKey === 'segredo-real-123', 'apiKey preservada quando o campo do form é omitido (não apagada)');
            });
        }

        console.log('\n=== S166.3 — apiKey vazia EXPLICITAMENTE no body apaga a chave (usuário limpou de propósito) ===');
        {
            const { app, ctx } = makeApp({ customProviders: [{ label: 'lmstudio', baseUrl: 'http://localhost:1234/v1', apiKey: 'segredo-real-123', model: undefined }] });
            await withServer(app, async (base) => {
                await fetch(`${base}/api/providers/custom/lmstudio`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ baseUrl: 'http://localhost:1234/v1', apiKey: '' }),
                });
                assert(ctx.config.customProviders?.[0].apiKey === undefined, 'apiKey explicitamente vazia é apagada (distinto de omitida)');
            });
        }

        console.log('\n=== S166.4 — PUT em label inexistente retorna 404, não cria um novo ===');
        {
            const { app, ctx } = makeApp({ customProviders: [] });
            await withServer(app, async (base) => {
                const res = await fetch(`${base}/api/providers/custom/nao-existe`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ baseUrl: 'http://localhost:1/v1' }),
                });
                assert(res.status === 404, `PUT em label inexistente retorna 404 (obtido: ${res.status})`);
                assert((ctx.config.customProviders ?? []).length === 0, 'nenhum provider novo foi criado por engano');
            });
        }

        console.log('\n=== S166.5 — model atualizado corretamente ===');
        {
            const { app, ctx } = makeApp({ customProviders: [{ label: 'llamafile', baseUrl: 'http://localhost:8080/v1', apiKey: undefined, model: undefined }] });
            await withServer(app, async (base) => {
                await fetch(`${base}/api/providers/custom/llamafile`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ baseUrl: 'http://localhost:8080/v1', model: 'meu-modelo.gguf' }),
                });
                assert(ctx.config.customProviders?.[0].model === 'meu-modelo.gguf', 'model atualizado');
            });
        }
    } finally {
        process.chdir(originalCwd);
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S166 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    if (failed > 0) process.exit(1);
}

main();
