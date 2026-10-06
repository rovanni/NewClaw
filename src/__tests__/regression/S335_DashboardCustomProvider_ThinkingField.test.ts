/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S335 (issue 057, Sprint G4)
 *
 * A opção `thinking` do provedor customizado (issue 054, D3 — num modelo local de 27B, plano em 23 s sem raciocínio
 * contra 218 s sem resposta com ele) só podia ser configurada à mão no .env. O painel passa a ter o campo, e as rotas
 * de criar/editar/listar provedor o gravam e devolvem.
 *
 * Roda as ROTAS REAIS (createProvidersRouter) num express efêmero, com o processo dentro de uma pasta temporária: a
 * rota grava o .env no diretório de trabalho e o teste nunca pode tocar no .env do repositório.
 *
 * Execução: npx ts-node src/__tests__/regression/S335_DashboardCustomProvider_ThinkingField.test.ts
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import express from 'express';
import type { AddressInfo } from 'net';
import { createProvidersRouter } from '../../dashboard/routes/providers';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}

async function main(): Promise<void> {
    const repoRoot = process.cwd();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 's335-'));
    process.chdir(tmp);
    const live: Array<Record<string, unknown>> = [];
    const ctx: any = {
        config: {
            defaultProvider: 'ollama', language: 'pt-BR', ollamaModel: '', ollamaUrl: 'http://localhost:11434',
            maxIterations: 10, memoryWindowSize: 10, telegramAllowedUserIds: [], modelRouter: {}, customProviders: [],
        },
        providerFactory: { addCustomProvider: (e: Record<string, unknown>) => { live.push(e); }, getCurrentModel: () => '' },
    };
    const app = express();
    app.use(express.json());
    app.use('/api', createProvidersRouter(ctx));
    const server = app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
    const send = (method: string, url: string, body?: unknown) =>
        fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then(r => r.json() as Promise<Record<string, any>>);
    const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
        const orig = process.stdout.write.bind(process.stdout);
        (process.stdout.write as unknown) = (): boolean => true;
        try { return await fn(); } finally { process.stdout.write = orig; }
    };

    try {
        console.log('\n=== S335-1 — criar com thinking=off grava no config, no .env e na instância viva ===');
        {
            const r = await quiet(() => send('POST', '/providers/custom', { label: 'bonsai', baseUrl: 'http://127.0.0.1:8080/v1', thinking: 'off' }));
            assert(r.success === true, 'criado', r);
            assert(ctx.config.customProviders[0]?.thinking === 'off', 'config.customProviders[0].thinking = off', ctx.config.customProviders);
            assert(live[0]?.thinking === 'off', 'a instância viva (addCustomProvider) recebe a opção', live);
            const env = fs.existsSync(path.join(tmp, '.env')) ? fs.readFileSync(path.join(tmp, '.env'), 'utf8') : '';
            assert(/CUSTOM_PROVIDERS=.*"thinking":"off"/.test(env), 'persistido no .env (CUSTOM_PROVIDERS)', env.slice(0, 300));
        }

        console.log('\n=== S335-2 — valor inválido ou vazio = padrão do modelo (campo ausente) ===');
        {
            await quiet(() => send('POST', '/providers/custom', { label: 'outro', baseUrl: 'http://127.0.0.1:8081/v1', thinking: 'talvez' }));
            assert(ctx.config.customProviders[1]?.thinking === undefined, "'talvez' → ausente", ctx.config.customProviders[1]);
        }

        console.log('\n=== S335-3 — editar: ausente preserva, enviado substitui ===');
        {
            await quiet(() => send('PUT', '/providers/custom/bonsai', { baseUrl: 'http://127.0.0.1:8080/v1' }));
            assert(ctx.config.customProviders[0]?.thinking === 'off', 'PUT sem thinking preserva off');
            await quiet(() => send('PUT', '/providers/custom/bonsai', { baseUrl: 'http://127.0.0.1:8080/v1', thinking: 'on' }));
            assert(ctx.config.customProviders[0]?.thinking === 'on', 'PUT com thinking=on substitui');
            await quiet(() => send('PUT', '/providers/custom/bonsai', { baseUrl: 'http://127.0.0.1:8080/v1', thinking: '' }));
            assert(ctx.config.customProviders[0]?.thinking === undefined, "PUT com '' volta ao padrão do modelo");
        }

        console.log('\n=== S335-4 — a listagem devolve o campo (o painel preenche o modo de edição) ===');
        {
            await quiet(() => send('PUT', '/providers/custom/bonsai', { baseUrl: 'http://127.0.0.1:8080/v1', thinking: 'off' }));
            const r = await quiet(() => send('GET', '/providers'));
            const bonsai = (r.customProviders || []).find((p: { label: string }) => p.label === 'bonsai');
            assert(bonsai?.thinking === 'off', 'GET /providers inclui thinking', r.customProviders);
        }

        console.log('\n=== S335-5 — painel: seletor, envio e as 5 chaves nos 3 idiomas ===');
        {
            const view = fs.readFileSync(path.join(repoRoot, 'src/dashboard/public/config/views/ModelosView.js'), 'utf8');
            assert(/id="ml-newProvThinking"/.test(view) && /value="off"/.test(view) && /value="on"/.test(view), 'seletor com padrão/off/on');
            assert(/editCustomProvider\(editingProviderLabel, \{[^}]*thinking \}\)/.test(view) && /addCustomProvider\(\{[^}]*thinking: thinking \|\| undefined \}\)/.test(view), 'enviado ao criar e ao editar');
            assert(/thinkingInput\.value = p\.thinking \|\| ''/.test(view), 'modo de edição preenche o valor salvo');
            const shared = fs.readFileSync(path.join(repoRoot, 'src/dashboard/public/shared.js'), 'utf8');
            for (const k of ['ml_provider_thinking_label', 'ml_provider_thinking_default', 'ml_provider_thinking_off', 'ml_provider_thinking_on', 'ml_provider_thinking_hint']) {
                assert((shared.match(new RegExp(`\\b${k}:`, 'g')) || []).length === 3, `${k} nos 3 idiomas`);
            }
        }
    } finally {
        server.close();
        process.chdir(repoRoot);
        fs.rmSync(tmp, { recursive: true, force: true });
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S335 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    if (failed > 0) process.exitCode = 1;
}

main().catch((err) => { console.error('S335 erro inesperado:', err); process.exitCode = 1; });
