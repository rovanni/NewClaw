/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S425
 * ADR-024, etapa 5: a chamada do AGENTE ao modelo também respeita o trabalho medido (tokens ÷ velocidade medida do modelo)
 * — só estende o prazo calibrado na nuvem; sem histórico, nada muda; sem limite de tokens para o agente.
 *
 * REGRESSÃO SE: sem histórico o prazo mudar; com histórico de um modelo lento, o prazo continuar o dinâmico de 45–420 s;
 * a medição encurtar o prazo; ou o agente passar a mandar limite de tokens (cortaria respostas longas legítimas).
 *
 * Execução: npx ts-node src/__tests__/regression/S425_AgentePrazoPeloTrabalhoMedido.test.ts
 */
import { AgentLoop } from '../../loop/AgentLoop';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}

async function main(): Promise<void> {
    const chamar = async (medido: any) => {
        const vistos: Array<{ timeout: number; opts: any; tipo?: string }> = [];
        const pf: any = {
            chatWithFallback: async (_m: unknown, _t: unknown, _p: unknown, timeout: number, _s: unknown, _mo: unknown, opts: any) => {
                vistos.push({ timeout, opts });
                return { status: 'success', content: 'ok', attempts: [] };
            },
        };
        if (medido !== undefined) pf.orcamentoPeloTrabalho = (_m: unknown, _modo: unknown, tipo: string) => { vistos.push({ timeout: -1, opts: null, tipo }); return medido; };
        const falso = { ts: () => '', providerFactory: pf, pushMetric: () => {} };
        await (AgentLoop.prototype as any).callLLMWithFallback.call(falso, [{ role: 'user', content: 'x'.repeat(4000) }], [], { model: 'bonsai', provider: 'local', category: 'execution' }, undefined, 'loop');
        return vistos;
    };

    console.log('\n=== S425-1 — sem a medição (ou sem histórico): o prazo dinâmico de sempre ===');
    const semMetodo = await chamar(undefined);
    const dinamico = semMetodo[0].timeout;
    assert(dinamico >= 45_000 && dinamico <= 420_000, `prazo dinâmico de sempre (${Math.round(dinamico / 1000)} s)`);
    const semHistorico = await chamar(null);
    assert(semHistorico.find(v => v.timeout > 0)!.timeout === dinamico, 'sem histórico (null): o mesmo prazo');
    assert(semHistorico.some(v => v.tipo === 'AgentLoop:loop'), 'pergunta pelo trabalho do tipo AgentLoop:loop');

    console.log('\n=== S425-2 — modelo lento com histórico: estende pelo trabalho medido ===');
    const lento = await chamar({ modelo: 'bonsai', tokens: 20000, prazoMs: 700_000, amostras: 12, geracao: 38 });
    const chamada = lento.find(v => v.timeout > 0)!;
    assert(chamada.timeout === 700_000, `prazo = o do trabalho medido (${Math.round(chamada.timeout / 1000)} s), não o dinâmico`, chamada.timeout);
    assert(chamada.opts.limiteDeSaidaTokens === undefined, 'o agente NÃO manda limite de tokens (respostas longas são legítimas)', chamada.opts);

    console.log('\n=== S425-3 — nunca encurta ===');
    const rapido = await chamar({ modelo: 'nuvem', tokens: 900, prazoMs: 3000, amostras: 40, geracao: 400 });
    assert(rapido.find(v => v.timeout > 0)!.timeout === dinamico, 'medição menor que o prazo dinâmico não reduz nada');

    console.log(`\n=== S425: ${passed} passaram, ${failed} falharam ===`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
