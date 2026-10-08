/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S352 (ADR-013, gravador de voo dos avaliadores)
 *
 * Investigação de 07/10/2026: para entender por que o juiz de grounding levava 240 s, foi preciso reconstruir
 * evidência cortada em 2000 caracteres, ligar chamada e julgamento pelo horário, e não houve como saber no que o
 * modelo gastou o tempo — o raciocínio de uma geração abortada era descartado sem registro.
 *
 * REGRESSÃO SE:
 *  - o raciocínio de uma chamada abortada pelo prazo deixar de chegar à telemetria;
 *  - um julgamento (juiz de grounding, validador de qualidade) deixar de gerar registro antes/durante/depois;
 *  - conteúdo (prompt, resposta, raciocínio) for gravado sem TRACE_CONTENT=true;
 *  - o veredito deixar de carregar o id do registro (o consumidor precisa dele para gravar o efeito);
 *  - arquivos mais velhos que a retenção não forem apagados.
 *
 * Execução: npx ts-node src/__tests__/regression/S352_EvaluatorFlightRecorder.test.ts
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ProviderFactory } from '../../core/ProviderFactory';
import { ObserverValidator } from '../../loop/ObserverValidator';
import { gravarEfeito } from '../../shared/evaluatorFlightRecorder';
import type { CallTelemetry } from '../../core/providerTypes';
import { RiskAnalyzer } from '../../loop/RiskAnalyzer';
import { ToolRegistry } from '../../core/ToolRegistry';
import { ReadTool } from '../../tools/read_tool';
import type { Goal, PlanStep } from '../../loop/GoalTypes';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}
const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
    const orig = process.stdout.write.bind(process.stdout);
    (process.stdout.write as unknown) = (): boolean => true;
    try { return await fn(); } finally { process.stdout.write = orig; }
};

/** Servidor que só "pensa" até a requisição ser abortada. */
function fetchQueSoPensa(): typeof fetch {
    return (async (_url: string, init?: { body?: string; signal?: AbortSignal }) => {
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                const t = setInterval(() => {
                    try { controller.enqueue(new TextEncoder().encode(JSON.stringify({ message: { thinking: 'relendo a evidência E9... ' } }) + '\n')); } catch { clearInterval(t); }
                }, 20);
                init?.signal?.addEventListener('abort', () => { clearInterval(t); try { controller.error(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })); } catch { /* já encerrado */ } });
            },
        });
        return { ok: true, status: 200, body: stream } as unknown as Response;
    }) as unknown as typeof fetch;
}

function fakeFactory(conteudo: string) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getBudgetAuxiliar } = require('../../shared/auxTimeout');
    return {
        chatWithFallback: async (_m: unknown, _t: unknown, _p: unknown, _ms: unknown, _s: unknown, _mo: unknown, opts?: { telemetry?: CallTelemetry }) => {
            opts?.telemetry?.attempts.push({ provider: 'ollama', model: 'modelo-de-teste', startedAt: new Date().toISOString(), status: 'success', thinkingChars: 12, thinkingText: 'pensei aqui.', contentChars: conteudo.length });
            return { status: 'success', content: conteudo, attempts: [] };
        },
        getBudgetAuxiliar: (perfil: 'classificacao' | 'validacao') => getBudgetAuxiliar(perfil, null, null),
    } as unknown as ProviderFactory;
}

const lerRegistros = (pasta: string, prefixo: string): Array<Record<string, any>> => {
    if (!fs.existsSync(pasta)) return [];
    return fs.readdirSync(pasta).filter(n => n.startsWith(prefixo)).flatMap(n =>
        fs.readFileSync(path.join(pasta, n), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)));
};

async function main(): Promise<void> {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 's352-'));
    const pasta = path.join(base, 'avaliadores');
    const logOriginal = process.env.LOG_FILE, conteudoOriginal = process.env.TRACE_CONTENT;
    process.env.LOG_FILE = path.join(base, 'newclaw-audit.log');

    console.log('\n=== S352-1 — raciocínio de uma chamada abortada pelo prazo chega à telemetria ===');
    const original = global.fetch;
    global.fetch = fetchQueSoPensa();
    const tele: CallTelemetry = { attempts: [] };
    try {
        const pf = new ProviderFactory({ defaultProvider: 'ollama', ollamaUrl: 'http://fake-ollama.invalid', ollamaModel: 'modelo-que-pensa' } as any);
        await quiet(() => pf.chatWithFallback([{ role: 'user', content: 'julgue' }], undefined, 'ollama', 400, undefined, undefined, { telemetry: tele }));
    } finally { global.fetch = original; }
    const a = tele.attempts[0];
    assert(tele.attempts.length === 1, `uma tentativa registrada (obtido ${tele.attempts.length})`);
    assert(a?.status === 'timeout' || a?.status === 'error', `desfecho da tentativa registrado (${a?.status})`);
    assert((a?.thinkingText ?? '').includes('relendo a evidência E9'), 'o TEXTO do raciocínio abortado foi preservado (antes: descartado)');
    assert((a?.thinkingChars ?? 0) > 0 && a?.contentChars === 0, `fatos do streaming: ${a?.thinkingChars} chars de raciocínio, ${a?.contentChars} de conteúdo`);
    assert(a?.firstChunkType === 'thinking' && typeof a?.firstChunkMs === 'number', `primeiro trecho: ${a?.firstChunkType} em ${a?.firstChunkMs} ms`);
    assert(typeof a?.durationMs === 'number' && a.model === 'modelo-que-pensa', `duração (${a?.durationMs} ms) e modelo da tentativa registrados`);

    console.log('\n=== S352-2 — juiz de grounding: registro antes/durante/depois, SEM conteúdo por padrão ===');
    delete process.env.TRACE_CONTENT;
    const juiz = new ObserverValidator(fakeFactory('{"claims":[{"claim":"faz 27 °C","evidence":["E1"],"verdict":"NOT_SUPPORTED"}]}'), 'modelo-de-teste');
    const v = await quiet(() => juiz.validateGrounding('Faz 27 °C em Curitiba.', [{ id: 'E1', tool: 'weather', output: 'Curitiba: 18.4 °C' }], undefined, { phase: 'initial', goalId: 'goal_x', stepId: 'step_2' }));
    const regs = lerRegistros(pasta, 'juiz_grounding-');
    const r = regs.find(x => x.tipo === 'avaliacao');
    assert(!!r, 'registro do julgamento gravado em logs/avaliadores/juiz_grounding-AAAA-MM-DD.jsonl');
    assert(v.state === 'REJECTED' && r?.depois?.estado === 'REJECTED', `veredito no registro (${r?.depois?.estado})`);
    assert(!!v.avaliacaoId && r?.id === v.avaliacaoId, 'o veredito carrega o id do registro, para o consumidor gravar o efeito');
    assert(/^[0-9a-f]{8}$/.test(r?.antes?.versaoPrompt ?? '') && r?.antes?.promptChars > 0, `versão do prompt (${r?.antes?.versaoPrompt}) e tamanho do prompt registrados`);
    assert(r?.contexto?.goalId === 'goal_x' && r?.contexto?.stepId === 'step_2', 'contexto (goal/step) registrado');
    assert(r?.durante?.tentativas?.[0]?.thinkingChars === 12, 'telemetria das tentativas registrada (DURANTE)');
    assert(r?.antes?.conteudo === undefined && r?.depois?.conteudo === undefined && r?.durante?.tentativas?.[0]?.thinkingText === undefined,
        'sem TRACE_CONTENT: nenhum conteúdo (prompt, resposta, raciocínio, saída) gravado');

    console.log('\n=== S352-3 — com TRACE_CONTENT=true: conteúdo completo, inclusive evidência sem corte ===');
    process.env.TRACE_CONTENT = 'true';
    const evidenciaGrande = 'linha de questão ENADE\n'.repeat(2000);
    const v2 = await quiet(() => juiz.validateGrounding('Faz 27 °C em Curitiba.', [{ id: 'E1', tool: 'arquivo_gerado', output: evidenciaGrande }], undefined, { phase: 'initial' }));
    const r2 = lerRegistros(pasta, 'juiz_grounding-').find(x => x.id === v2.avaliacaoId);
    assert(r2?.antes?.conteudo?.evidencias?.[0]?.output === evidenciaGrande, `evidência gravada INTEIRA (${evidenciaGrande.length} chars; o [GROUNDING-TRACE] corta em 2000)`);
    assert(typeof r2?.antes?.conteudo?.prompt === 'string' && r2.antes.conteudo.prompt.includes('Faz 27 °C'), 'prompt exato enviado gravado');
    assert(r2?.durante?.tentativas?.[0]?.thinkingText === 'pensei aqui.', 'texto do raciocínio gravado');
    assert(typeof r2?.depois?.conteudo?.saidaBruta === 'string', 'saída bruta do juiz gravada');

    console.log('\n=== S352-4 — efeito do veredito vai para o mesmo arquivo, ligado pelo id ===');
    gravarEfeito({ avaliacaoId: v2.avaliacaoId, avaliador: 'juiz_grounding', efeito: 'resposta_bloqueada', detalhe: { estado: 'REJECTED' } });
    const ef = lerRegistros(pasta, 'juiz_grounding-').find(x => x.tipo === 'efeito');
    assert(ef?.avaliacaoId === v2.avaliacaoId && ef?.efeito === 'resposta_bloqueada', 'efeito gravado com o id da avaliação');

    console.log('\n=== S352-5 — validador de qualidade também grava; pulos não ===');
    const qual = new ObserverValidator(fakeFactory('{"approved": false, "reason": "não atende", "confidence": 0.8, "failure_type": "other"}'), 'modelo-de-teste');
    const q = await quiet(() => qual.validate('qual a previsão?', 'question', 'edit', 'Conteúdo adicionado: questoes.md', 'Resposta completa ao usuário, com a tabela inteira.'));
    const pulo = await quiet(() => qual.validate('qual a previsão?', 'question', 'edit', 'Conteúdo adicionado: questoes.md', ''));
    const rq = lerRegistros(pasta, 'validador_qualidade-');
    assert(rq.length === 1 && rq[0].id === q.avaliacaoId && rq[0].depois?.estado === 'reprovado', `julgamento do validador gravado (${rq.length} registro)`);
    assert(pulo.validationSkipped === true && pulo.avaliacaoId === undefined, 'validação pulada (sem resposta ainda) não gera registro');

    console.log('\n=== S352-6 — análise de risco grava a revisão do plano (real) ===');
    try { ToolRegistry.register(new ReadTool()); } catch { /* já registrado */ }
    const risco = new RiskAnalyzer(fakeFactory('{"risks": ["o passo 2 não usa o resultado do passo 1"], "plan": null}'), ToolRegistry,
        { findHardConstraints: () => [], findToolFailures: () => '' } as never);
    const agora = Date.now();
    const goal = { id: 'goal_risco', sessionKey: 't', conversationId: 'c', userIntent: 'ler e resumir', objective: 'ler e resumir notas.txt', status: 'planning',
        currentPlan: [], attempts: [], blockers: [], toolsTried: [], strategiesTried: [], successCriteria: [], retryBudget: 3, replanBudget: 5,
        confidence: 0.9, requiresAuth: false, authorizationScope: [], createdAt: agora, updatedAt: agora, expiresAt: agora + 3_600_000 } as unknown as Goal;
    const plano: PlanStep[] = [{ id: 'step_1', description: 'ler notas.txt', toolName: 'read', toolArgs: { path: 'notas.txt' }, fallbackSteps: [], status: 'pending' }];
    await quiet(() => risco.analyze(goal, plano, []));
    const rr = lerRegistros(pasta, 'analise_risco-').find(x => x.tipo === 'avaliacao');
    assert(!!rr && rr.contexto?.goalId === 'goal_risco' && rr.contexto?.phase === 'real', 'revisão de risco gravada com o goal e o modo (real)');
    assert(rr?.depois?.estado === 'plano_mantido' && rr?.depois?.desfecho === 'confirmed' && rr?.depois?.fatos?.riscos === 1, `desfecho da revisão (${rr?.depois?.estado}/${rr?.depois?.desfecho}, riscos=${rr?.depois?.fatos?.riscos})`);
    assert(rr?.antes?.fatos?.passosRecebidos === 1 && /^[0-9a-f]{8}$/.test(rr?.antes?.versaoPrompt ?? ''), 'plano recebido e versão do prompt registrados');
    assert(Array.isArray(rr?.depois?.conteudo?.riscos) && typeof rr?.antes?.conteudo?.prompt === 'string', 'com TRACE_CONTENT: riscos e prompt gravados');

    console.log('\n=== S352-7 — sem LOG_FILE nada é gravado; retenção apaga os antigos ===');
    const antigo = path.join(pasta, 'juiz_grounding-2020-01-01.jsonl');
    fs.writeFileSync(antigo, '{}\n');
    // a limpeza roda na primeira gravação de cada dia do processo — força um "novo dia" reimportando o módulo
    delete require.cache[require.resolve('../../shared/evaluatorFlightRecorder')];
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const rec = require('../../shared/evaluatorFlightRecorder');
    rec.gravarEfeito({ avaliador: 'juiz_grounding', efeito: 'teste_retencao' });
    assert(!fs.existsSync(antigo), 'arquivo mais velho que a retenção (14 dias) foi apagado');
    delete process.env.LOG_FILE;
    const antes = fs.readdirSync(pasta).map(n => fs.statSync(path.join(pasta, n)).size).reduce((x, y) => x + y, 0);
    rec.gravarEfeito({ avaliador: 'juiz_grounding', efeito: 'sem_log_file' });
    const depois = fs.readdirSync(pasta).map(n => fs.statSync(path.join(pasta, n)).size).reduce((x, y) => x + y, 0);
    assert(antes === depois, 'sem LOG_FILE (log de auditoria desligado), o gravador não grava nada');

    if (logOriginal === undefined) delete process.env.LOG_FILE; else process.env.LOG_FILE = logOriginal;
    if (conteudoOriginal === undefined) delete process.env.TRACE_CONTENT; else process.env.TRACE_CONTENT = conteudoOriginal;
    fs.rmSync(base, { recursive: true, force: true });

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S352 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    if (failed > 0) process.exitCode = 1;
}
main().catch((err) => { console.error('S352 erro inesperado:', err); process.exitCode = 1; });
