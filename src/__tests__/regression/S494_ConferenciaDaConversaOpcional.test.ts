/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S494 (19/11/2026, ADR-042, revisão da noite)
 *
 * A operadora decidiu que a conferência da conversa direta contra a evidência é OPCIONAL, escolhida no painel
 * (Configurações → Validadores, "Conferir as respostas da conversa"), e DESLIGADA por padrão:
 *   - desligada (ou sem a variável): a resposta sai sem a marca "Conferindo…" e o juiz não é chamado, nem antes nem depois;
 *   - ligada: o caminho da A3 de antes (marca + juiz depois da entrega);
 *   - passo de objetivo: sempre conferido (o veredito alimenta o replanejamento), com ou sem a opção;
 *   - o painel grava a escolha no .env (CONFERENCIA_DA_CONVERSA) e ela vale na hora (process.env, lido a cada turno).
 *
 * REGRESSÃO SE: a conversa direta voltar a chamar o juiz (ou a pôr a marca) com a opção desligada; a opção ligada deixar de
 * conferir; o passo de objetivo deixar de ser conferido; ou o painel não gravar / não valer na hora.
 *
 * Execução: npx ts-node src/__tests__/regression/S494_ConferenciaDaConversaOpcional.test.ts
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import { AgentLoop } from '../../loop/AgentLoop';
import type { MemoryManager } from '../../memory/MemoryManager';
import type { ChannelContext } from '../../loop/agentLoopTypes';
import { createConfigRouter } from '../../dashboard/routes/config';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}

const MARCA = AgentLoop.TEXTOS_DO_JUIZ_DEPOIS['pt-BR'].marca;

/** AgentLoop real, com o `commitResponse()` real; o juiz conta as chamadas e aprova. */
function montar() {
    const providerFactory = {
        chatWithFallback: async () => ({ status: 'success', content: 'x', attempts: [] }),
        getProvider: () => ({ name: 'fake' }),
        getProviderWithModel: () => ({ chat: async () => ({ status: 'success', content: '{}' }) }),
    } as unknown as import('../../core/ProviderFactory').ProviderFactory;
    const db = new (Database as any)(':memory:');
    const memory = { semanticSearch: async () => [], addMessage: async () => {}, getDatabase: () => db } as unknown as MemoryManager;
    const loop = new AgentLoop(
        providerFactory, memory, { languageDirective: 'pt-BR', systemPrompt: 'teste S494' } as any,
        { recordPattern: () => {}, getPatterns: () => [] } as any,
        { getSkillContextForQuery: async () => '', getAllSkills: () => [], loadAll: () => [] } as any,
        { store: () => {} } as any, { store: () => {}, getStats: () => ({}) } as any,
    );
    const chamadas = { juiz: 0 };
    (loop as any).observer = {
        validateResponseCommit: async () => ({ valid: true, hallucinationRisk: 0, blocked: false, validationMs: 1 }),
        validateGrounding: async () => { chamadas.juiz++; return { state: 'VALIDATED', claims: [], reason: 'ok', elapsedMs: 1, budgetMs: 30000, budgetOrigin: 'padrao' }; },
    };
    (loop as any).reflectionMemory = { record: () => {}, findToolFailures: () => null };
    (loop as any).avisarUsuario = async () => {};
    const commit = async (cid: string, ctx: ChannelContext): Promise<string> => {
        (loop as any).getTurnState(cid).lastToolExecution = { toolName: 'read', toolOutput: 'conteúdo lido', intent: 'x', category: 'information' };
        const trace = { id: `trace-${cid}`, steps: [{ type: 'tool_call', data: { tool: 'read', input: { path: 'a.md' } } }, { type: 'tool_result', data: { tool: 'read', success: true, output: 'conteúdo lido' } }] };
        return (loop as any).commitResponse('O arquivo diz: conteúdo lido.', 'pedido', trace, cid, undefined, 0, ctx);
    };
    return { chamadas, commit };
}

const esperar = (ms: number) => new Promise(r => setTimeout(r, ms));
const direto = (cid: string) => ({ channel: 'telegram', chatId: cid } as ChannelContext);
const passo = (cid: string) => ({ channel: 'telegram', chatId: cid, goalTrace: { goalId: 'g1', stepId: 's1' } } as ChannelContext);

async function main(): Promise<void> {
    console.log('\n🧪 S494 — conferência da conversa opcional, desligada por padrão\n');
    const antes = process.env.CONFERENCIA_DA_CONVERSA;
    delete process.env.JUIZ_DEPOIS_DA_ENTREGA;

    console.log('Leitura da opção');
    delete process.env.CONFERENCIA_DA_CONVERSA;
    assert(!AgentLoop.conferenciaDaConversaLigada(), 'sem a variável: desligada (padrão escolhido pela operadora)');
    for (const v of ['desligada', 'sim', 'true', '']) {
        process.env.CONFERENCIA_DA_CONVERSA = v;
        assert(!AgentLoop.conferenciaDaConversaLigada(), `"${v}": desligada (só "ligada" liga)`);
    }
    process.env.CONFERENCIA_DA_CONVERSA = ' Ligada ';
    assert(AgentLoop.conferenciaDaConversaLigada(), '"ligada" (com espaço e maiúscula): ligada');

    console.log('\nDesligada: conversa direta sem marca e sem juiz');
    delete process.env.CONFERENCIA_DA_CONVERSA;
    {
        const m = montar();
        const r = await m.commit('c-off', direto('c-off'));
        await esperar(20);
        assert(r === 'O arquivo diz: conteúdo lido.', 'a resposta sai como foi escrita, sem a marca', r);
        assert(m.chamadas.juiz === 0, 'o juiz não é chamado (nem depois da entrega)', m.chamadas);
    }

    console.log('\nDesligada: passo de objetivo continua conferido');
    {
        const m = montar();
        const r = await m.commit('c-passo', passo('c-passo'));
        assert(m.chamadas.juiz === 1 && !r.includes(MARCA), 'o juiz julga o passo, na frente (sem marca)', { r, ...m.chamadas });
    }

    console.log('\nLigada: o caminho da A3 (marca + juiz depois da entrega)');
    process.env.CONFERENCIA_DA_CONVERSA = 'ligada';
    {
        const m = montar();
        const r = await m.commit('c-on', direto('c-on'));
        await esperar(20);
        assert(r.endsWith(MARCA), 'a resposta sai com a marca', r);
        assert(m.chamadas.juiz === 1, 'o juiz roda depois da entrega', m.chamadas);
    }

    console.log('\nPainel: POST /api/config grava no .env e vale na hora; GET devolve; valor inválido é recusado');
    {
        const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 's494-'));
        const cwd = process.cwd();
        process.chdir(pasta);
        try {
            const ctx = { config: { language: 'pt-BR', defaultProvider: 'ollama', telegramAllowedUserIds: [], maxIterations: 5, memoryWindowSize: 10, conferenciaDaConversa: 'desligada' } } as any;
            const router = createConfigRouter(ctx);
            const rota = (metodo: string) => (router as any).stack.find((l: any) => l.route?.path === '/' && l.route.methods[metodo]).route.stack[0].handle;
            const chamar = (metodo: string, body?: unknown) => new Promise<{ status: number; json: any }>(resolve => {
                const res: any = { statusCode: 200, status(c: number) { this.statusCode = c; return this; }, json(j: unknown) { resolve({ status: this.statusCode, json: j }); } };
                rota(metodo)({ body }, res);
            });
            delete process.env.CONFERENCIA_DA_CONVERSA;
            let r = await chamar('post', { conferenciaDaConversa: 'ligada' });
            assert(r.status === 200 && r.json.success, 'POST ligada: aceito', r);
            assert(process.env.CONFERENCIA_DA_CONVERSA === 'ligada' && AgentLoop.conferenciaDaConversaLigada(), 'vale na hora (process.env)');
            // Lido pelo mesmo dotenv do boot (o envSerializer grava entre aspas).
            const lerEnv = () => require('dotenv').parse(fs.readFileSync(path.join(pasta, '.env'), 'utf8')).CONFERENCIA_DA_CONVERSA;
            assert(lerEnv() === 'ligada', 'gravado no .env (como o boot lê)', lerEnv());
            r = await chamar('get');
            assert(r.json.config.conferenciaDaConversa === 'ligada', 'GET devolve a escolha', r.json.config.conferenciaDaConversa);
            r = await chamar('post', { conferenciaDaConversa: 'desligada' });
            assert(process.env.CONFERENCIA_DA_CONVERSA === 'desligada' && lerEnv() === 'desligada', 'POST desligada: desliga e grava', lerEnv());
            r = await chamar('post', { conferenciaDaConversa: 'talvez' });
            assert(r.status === 400 && process.env.CONFERENCIA_DA_CONVERSA === 'desligada', 'valor inválido: 400, nada muda', r);
        } finally {
            process.chdir(cwd);
            fs.rmSync(pasta, { recursive: true, force: true });
        }
    }

    console.log('\nPainel: a caixa existe na tela Validadores, com os textos nos 3 idiomas');
    {
        const view = fs.readFileSync(path.join(process.cwd(), 'src', 'dashboard', 'public', 'config', 'views', 'ValidadoresView.js'), 'utf8');
        assert(/id="vl-conferencia"/.test(view) && /saveConfig\(\{ conferenciaDaConversa: valor \}\)/.test(view), 'a caixa grava pela mesma rota da configuração');
        const shared = fs.readFileSync(path.join(process.cwd(), 'src', 'dashboard', 'public', 'shared.js'), 'utf8');
        for (const chave of ['validators_check_title', 'validators_check_label', 'validators_check_hint', 'validators_check_on_toast', 'validators_check_off_toast']) {
            const n = (shared.match(new RegExp(`\\b${chave}:`, 'g')) ?? []).length;
            assert(n === 3, `${chave} nos 3 idiomas`, n);
        }
    }

    if (antes === undefined) delete process.env.CONFERENCIA_DA_CONVERSA; else process.env.CONFERENCIA_DA_CONVERSA = antes;
    console.log(`\n${passed} passaram, ${failed} falharam\n`);
    if (failed > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
