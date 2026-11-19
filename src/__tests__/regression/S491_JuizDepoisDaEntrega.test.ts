/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S491 (19/11/2026, ADR-042 / A3)
 *
 * Na conversa direta, a resposta sai antes do juiz contra a evidência, com a marca "conferindo"; o mesmo julgamento roda
 * em segundo plano e o desfecho vira uma 2ª mensagem. Decisões da operadora (19/11/2026):
 *   D1 — aprovado: nada mais chega;
 *   D2 — contradição: os pontos e o trecho da fonte, sem chamada nova; "não avaliável" sem contradição: o aviso da A1-r;
 *        juiz que não concluiu: uma linha dizendo que não pôde conferir;
 *   D3 — pedido novo da conversa durante a conferência: interrompe e diz que ficou "não conferida".
 * Fica de fora: passo de objetivo (o veredito alimenta o replanejamento), contexto sem canal/conversa e
 * JUIZ_DEPOIS_DA_ENTREGA=desligado — nesses o juiz continua na frente, como antes.
 *
 * REGRESSÃO SE: a resposta da conversa direta voltar a esperar o juiz; algum desfecho mandar a mensagem errada (ou mandar
 * algo quando aprovado); a interrupção não avisar; ou o passo de objetivo deixar de ser julgado antes.
 *
 * Execução: npx ts-node src/__tests__/regression/S491_JuizDepoisDaEntrega.test.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { AgentLoop } from '../../loop/AgentLoop';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}

const T = AgentLoop.TEXTOS_DO_JUIZ_DEPOIS['pt-BR'];
const ctxDireto = { channel: 'telegram', chatId: '42', recentMessages: [] } as any;

/** Um AgentLoop só com o que `julgarDepoisDaEntrega` usa; o juiz devolve `veredito` (ou lança). */
function montar(veredito: unknown | (() => Promise<unknown>)) {
    const enviados: Array<{ canal: string; chatId: string; texto: string; tipo?: string }> = [];
    const gravados: unknown[] = [];
    const loop = Object.create(AgentLoop.prototype) as any;
    loop.observer = { validateGrounding: async () => (typeof veredito === 'function' ? (veredito as () => Promise<unknown>)() : veredito) };
    loop.avisarUsuario = async (canal: string, chatId: string, texto: string, tipo?: string) => { enviados.push({ canal, chatId, texto, tipo }); };
    loop.reflectionMemory = { record: (r: unknown) => gravados.push(r) };
    const julgar = (sinal?: AbortSignal) => loop.julgarDepoisDaEntrega({
        response: 'resposta', evidences: [], userText: 'pedido', conversationId: 'conv', traceId: 'tr', channelContext: ctxDireto,
        last: { toolName: 'web_search', toolOutput: 'saída', intent: 'i', category: 'information' }, sinal,
    });
    return { enviados, gravados, julgar };
}
const v = (state: string, claims: unknown[] = [], extra: Record<string, unknown> = {}) => ({ state, claims, reason: 'motivo do juiz', avaliacaoId: 'av1', ...extra });

async function main(): Promise<void> {
    console.log('\n🧪 S491 — juiz depois da entrega (ADR-042)\n');

    console.log('Quem passa pelo caminho novo');
    delete process.env.JUIZ_DEPOIS_DA_ENTREGA;
    assert(AgentLoop.juizDepoisDaEntrega(ctxDireto, true), 'conversa direta com canal e conversa: sim');
    assert(!AgentLoop.juizDepoisDaEntrega({ ...ctxDireto, goalTrace: { goalId: 'g', stepId: 's' } }, true), 'passo de objetivo: não (o veredito alimenta o replanejamento)');
    assert(!AgentLoop.juizDepoisDaEntrega({ channel: 'web' } as any, true), 'sem chatId: não (sem para onde mandar a correção)');
    assert(!AgentLoop.juizDepoisDaEntrega(undefined, true), 'sem contexto de canal: não');
    assert(!AgentLoop.juizDepoisDaEntrega(ctxDireto, false), 'sem aviso ao usuário ligado: não');
    process.env.JUIZ_DEPOIS_DA_ENTREGA = 'desligado';
    assert(!AgentLoop.juizDepoisDaEntrega(ctxDireto, true), 'JUIZ_DEPOIS_DA_ENTREGA=desligado: não (reversão sem código)');
    delete process.env.JUIZ_DEPOIS_DA_ENTREGA;

    console.log('\nA resposta sai na hora, com a marca');
    assert(AgentLoop.comMarcaConferindo('Oi.') === `Oi.\n\n${T.marca}`, 'marca no fim da resposta', AgentLoop.comMarcaConferindo('Oi.'));
    for (const idioma of ['pt-BR', 'en-US', 'es-ES']) {
        const t = AgentLoop.TEXTOS_DO_JUIZ_DEPOIS[idioma];
        assert(!!t && [t.marca, t.naoConferida, t.semVeredito, t.correcao, t.fonte].every(s => s.length > 0), `textos completos em ${idioma}`);
    }

    console.log('\nD1 — aprovado: nada chega');
    for (const estado of ['VALIDATED', 'NOT_APPLICABLE']) {
        const m = montar(v(estado));
        await m.julgar();
        assert(m.enviados.length === 0 && m.gravados.length === 0, `${estado}: nenhuma mensagem, nada gravado como falha`, m.enviados);
    }

    console.log('\nD2 — contradição: pontos e trecho da fonte, como entrega');
    {
        const m = montar(v('REJECTED', [
            { claim: 'O preço é US$ 0,90', verdict: 'NOT_SUPPORTED', trecho: 'price: 0.815' },
            { claim: 'Volume de 2M', verdict: 'NOT_SUPPORTED' },
            { claim: 'É uma moeda', verdict: 'SUPPORTED' },
        ]));
        await m.julgar();
        const msg = m.enviados[0];
        assert(m.enviados.length === 1 && msg.tipo === 'entrega' && msg.canal === 'telegram' && msg.chatId === '42', 'uma mensagem, tipo entrega, na conversa certa', m.enviados);
        assert(!!msg && msg.texto.startsWith(T.correcao) && msg.texto.includes('O preço é US$ 0,90') && msg.texto.includes('fonte: "price: 0.815"') && msg.texto.includes('Volume de 2M'),
            'lista os pontos que não conferem e o trecho que o juiz citou', msg?.texto);
        assert(!msg.texto.includes('É uma moeda'), 'o que conferiu não entra na correção');
        assert(m.gravados.length === 1, 'grava a falha na ReflectionMemory, como no caminho síncrono');
    }
    {
        const m = montar(v('NOT_EVALUABLE', [{ claim: 'Veio de X', verdict: 'NOT_EVALUABLE', contradicaoApontada: true }]));
        await m.julgar();
        assert(m.enviados.length === 1 && m.enviados[0].texto.startsWith(T.correcao), 'contradição apontada (mesmo rebaixada a não avaliável) vira correção', m.enviados);
    }

    console.log('\nD2 — "não avaliável" sem contradição: o aviso da A1-r');
    {
        const m = montar(v('NOT_EVALUABLE', [{ claim: 'Fica aberto até 22h', verdict: 'NOT_EVALUABLE' }, { claim: 'Fica em SP', verdict: 'SUPPORTED' }]));
        await m.julgar();
        const titulo = AgentLoop.AVISO_NAO_CONFIRMADO['pt-BR'].titulo;
        assert(m.enviados.length === 1 && m.enviados[0].texto.startsWith(titulo) && m.enviados[0].texto.includes('Fica aberto até 22h'), 'aviso com os pontos não confirmados', m.enviados[0]?.texto);
    }

    console.log('\nD2 — juiz que não concluiu ou falhou: uma linha');
    {
        const m = montar(v('UNVALIDATED'));
        await m.julgar();
        assert(m.enviados.length === 1 && m.enviados[0].texto === T.semVeredito, 'UNVALIDATED: "não consegui conferir"', m.enviados);
        assert(m.gravados.length === 0, 'UNVALIDATED não grava falha da ferramenta (S453)');
        const f = montar(async () => { throw new Error('provedor caiu'); });
        await f.julgar();
        assert(f.enviados.length === 1 && f.enviados[0].texto === T.semVeredito, 'exceção no julgamento: a mesma linha, sem derrubar nada', f.enviados);
    }

    console.log('\nD3 — pedido novo interrompe e avisa');
    {
        const ac = new AbortController();
        const m = montar(async () => { ac.abort(); throw new Error('aborted'); });
        await m.julgar(ac.signal);
        assert(m.enviados.length === 1 && m.enviados[0].texto === T.naoConferida, 'interrompido no meio: "ficou sem conferência"', m.enviados);
        const ac2 = new AbortController();
        const m2 = montar(async () => { ac2.abort(); return v('REJECTED', [{ claim: 'x', verdict: 'NOT_SUPPORTED' }]); });
        await m2.julgar(ac2.signal);
        assert(m2.enviados.length === 1 && m2.enviados[0].texto === T.naoConferida, 'veredito que chega depois da interrupção não é entregue fora de contexto', m2.enviados);
    }

    console.log('\nNo AgentLoop: o desvio vem antes do julgamento síncrono e só para a conversa direta');
    {
        const fonte = fs.readFileSync(path.join(process.cwd(), 'src', 'loop', 'AgentLoop.ts'), 'utf-8');
        const iDesvio = fonte.indexOf('if (AgentLoop.juizDepoisDaEntrega(channelContext, !!this.avisarUsuario)) {');
        const iSincrono = fonte.indexOf("const g = await this.observer.validateGrounding(response, evidences, signal, { traceId: trace.id, conversationId, phase: 'initial'");
        assert(iDesvio > -1 && iSincrono > iDesvio, 'o desvio fica antes do juiz síncrono');
        const bloco = fonte.slice(iDesvio, iSincrono);
        assert(/void this\.julgarDepoisDaEntrega\(/.test(bloco) && /return AgentLoop\.comMarcaConferindo\(response\)/.test(bloco), 'dispara o julgamento sem esperar e devolve a resposta com a marca');
        assert(/validacoesEmSegundoPlano\?\.signal/.test(bloco), 'preso ao sinal da conversa (ADR-027), que o pedido seguinte aborta');
        const controller = fs.readFileSync(path.join(process.cwd(), 'src', 'core', 'AgentController.ts'), 'utf-8');
        assert(/tipo === 'progresso'/.test(controller) && /recordAssistantMessage\(\{ channel: tipoDoCanal, userId: chatId \}, texto/.test(controller),
            'AgentController: entrega vai para a fila do canal (sem `progresso`) e para o histórico da conversa');
    }

    console.log(`\n${passed} passaram, ${failed} falharam\n`);
    if (failed > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
