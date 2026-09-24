/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S298
 *
 * CONTEXTO (log de auditoria, 23/09/2026, 21:50): o LLM respondeu "O script está íntegro — apenas
 * executei com o workdir errado. Executando agora com o caminho absoluto correto:" (110 caracteres)
 * junto com uma chamada de exec_command. Foi a 4ª chamada: `same_tool_limit` encerrou o turno
 * (`dedupAbort`). Como a narração tinha mais de 100 caracteres, `hasGoodContent` a considerou uma
 * conclusão, a síntese honesta de interrupção foi PULADA e a frase saiu como resposta final —
 * uma promessa sem nenhuma execução depois. Mesmo quando a síntese rodava e falhava, o código
 * caía em `lastBestContent`.
 *
 * Chama o método REAL runSynthesisAndFallbackPhase() (não uma reimplementação), com o LLM
 * substituído por um duplo determinístico.
 *
 * REGRESSÃO SE: um turno encerrado por trava entregar a última narração do LLM como resposta.
 *
 * Execução: npx ts-node src/__tests__/regression/S298_AgentLoop_InterruptedTurnNeverDeliversNarration.test.ts
 */
import { AgentLoop, buildInterruptionNotice } from '../../loop/AgentLoop';

let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string, detail?: unknown): void {
    if (cond) { console.log(`  OK ${msg}`); passed++; }
    else { console.error(`  FALHOU: ${msg}`, detail ?? ''); failed++; }
}

const NARRACAO = 'O script está íntegro — apenas executei com o workdir errado. Executando agora com o caminho absoluto correto:';
const cycleHistory = [
    { step: 1, tool: 'exec_command', input: '{"command":"dir"}', status: 'success' },
    { step: 2, tool: 'write', input: '{"path":"tmp/x.py"}', status: 'success' },
    { step: 3, tool: 'exec_command', input: '{"command":"python x.py"}', status: 'error' },
    { step: 4, tool: 'exec_command', input: '{"command":"python tmp/x.py"}', status: 'success' },
];

/** Roda o método real com `this` reduzido ao que ele usa; devolve o texto entregue. */
async function rodar(opts: { dedupAbort: boolean; llmContent: string }): Promise<{ text: string; llmCalls: number }> {
    let llmCalls = 0;
    const fake: any = Object.create((AgentLoop as any).prototype);
    fake.ts = () => 'T';
    fake.getTurnState = () => ({});
    fake.profileRegistry = { getProfileByCategory: () => ({ category: 'execution', model: 'm', provider: 'ollama' }) };
    fake.callLLMWithFallback = async () => { llmCalls++; return { status: 'success', content: opts.llmContent, attempts: [] }; };
    fake.commitResponse = async (text: string) => text;
    fake.persistTrace = () => undefined;
    const trace: any = { id: 't', steps: [], startTime: Date.now() };
    const out = await (AgentLoop as any).prototype.runSynthesisAndFallbackPhase.call(
        fake, 'conv', 'pedido', cycleHistory, [{ role: 'system', content: 's' }, { role: 'user', content: 'pedido' }],
        NARRACAO, opts.dedupAbort, 'exec_command:loop', { category: 'chat', model: 'm' }, new AbortController().signal,
        trace, undefined, 6, 15, 1, () => undefined, true,
    );
    return { text: typeof out === 'string' ? out : String((out as any).text ?? ''), llmCalls };
}

async function main(): Promise<void> {
    console.log('\n=== S298.1 — REPRODUÇÃO: trava + síntese falha → NÃO entrega a narração ===');
    {
        const r = await rodar({ dedupAbort: true, llmContent: '' });
        assert(r.text !== NARRACAO && !r.text.includes('Executando agora'), 'a narração do LLM não é a resposta final', r.text);
        assert(r.text.includes('Execução interrompida'), 'informa que a execução foi interrompida', r.text);
        assert(r.text.includes('exec_command (2 com sucesso, 1 com erro)') && r.text.includes('write (1 com sucesso)'), 'relata só o estado factual (contagem por ferramenta)', r.text);
        assert(/não foi possível concluir/i.test(r.text), 'diz que o pedido não foi concluído', r.text);
    }

    console.log('\n=== S298.2 — trava + síntese OK → a síntese é usada, mesmo com narração > 100 chars ===');
    {
        const sintese = 'Foram listados os arquivos e o script foi gravado; a última execução falhou por caminho incorreto. Para continuar, peça para executar novamente.';
        const r = await rodar({ dedupAbort: true, llmContent: sintese });
        assert(r.llmCalls >= 1, 'a síntese de interrupção foi chamada (antes era pulada)', r.llmCalls);
        assert(r.text === sintese, 'a resposta é a síntese, não a narração', r.text);
    }

    console.log('\n=== S298.3 — CONTROLE NEGATIVO: sem trava, conteúdo longo continua sendo entregue direto ===');
    {
        const longa = 'A'.repeat(150);
        const fake = await (async () => {
            let llmCalls = 0;
            const f: any = Object.create((AgentLoop as any).prototype);
            f.ts = () => 'T'; f.getTurnState = () => ({}); f.profileRegistry = { getProfileByCategory: () => ({ category: 'e', model: 'm' }) };
            f.callLLMWithFallback = async () => { llmCalls++; return { status: 'success', content: 'x', attempts: [] }; };
            f.commitResponse = async (t: string) => t; f.persistTrace = () => undefined;
            const out = await (AgentLoop as any).prototype.runSynthesisAndFallbackPhase.call(
                f, 'c', 'p', cycleHistory, [{ role: 'system', content: 's' }], longa, false, '', { category: 'chat', model: 'm' },
                new AbortController().signal, { id: 't', steps: [], startTime: Date.now() }, undefined, 3, 15, 0, () => undefined, false);
            return { out, llmCalls };
        })();
        assert(fake.out === longa && fake.llmCalls === 0, 'sem dedupAbort o comportamento anterior é mantido (sem chamada extra de LLM)', fake);
    }

    console.log('\n=== S298.4 — buildInterruptionNotice: sem ferramentas concluídas ===');
    {
        const t = buildInterruptionNotice([], 'exec_command:loop');
        assert(t.includes('Nenhuma ferramenta chegou a ser concluída'), 'não inventa progresso', t);
    }

    console.log(`\nS298 RESULTADO: ${passed} passou | ${failed} falhou`);
    process.exit(failed > 0 ? 1 : 0);
}
main().catch(e => { console.error('ERRO NÃO TRATADO:', e); process.exit(1); });
