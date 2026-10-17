/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S431
 * ADR-024: o prazo da vez do juiz NÃO corta um modelo que AINDA ESTÁ GERANDO e não passou do orçamento em tokens.
 *
 * INCIDENTE REAL (Windows, 16/10/2026, reteste "instalar o GenOffice"): a revisão de risco foi cortada aos 59 s com 2,3 mil
 * tokens — o orçamento medido para esse juiz era 7,3 mil. Não era trabalho demais: a nuvem estava lenta (~40 tok/s contra
 * 238 medidos). O relógio cortou um modelo que trabalhava.
 *
 * REGRESSÃO SE: um modelo gerando for cortado no prazo da vez; um modelo PARADO (sem pedaços) não for cortado; quem passou
 * do orçamento de tokens não for cortado; ou o teto do objetivo deixar de valer.
 *
 * Execução: npx ts-node src/__tests__/regression/S431_JuizNaoCortaQuemGera.test.ts
 */
import { PerfilDoJuiz } from '../../validation/perfilDoJuiz';
import { ValidationEngine } from '../../validation/ValidationEngine';
import { criarRegistroPadrao } from '../../validation/motorPadrao';
import { executarComPrazo } from '../../shared/turnCancellation';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}
const VEREDITO = JSON.stringify({ estado: 'aprovado', itens: [{ item: 'x', confere: 'sim' }], tipo_de_falha: 'none' });

/**
 * Provedor simulado com streaming: um pedaço a cada `intervaloMs` durante `geraPorMs`; responde ao fim de `respondeEmMs`
 * (Infinity = nunca). Preenche a telemetria AO VIVO como o OllamaProvider.
 */
function fabrica(cfg: { geraPorMs: number; respondeEmMs: number; intervaloMs?: number; medido?: any }) {
    return {
        getBudgetAuxiliar: () => ({ timeoutMs: 1000, origem: 'padrao', latenciaTipicaMs: null }),
        ...(cfg.medido ? { orcamentoPeloTrabalho: () => cfg.medido } : {}),
        chatWithFallback: (_m: unknown, _t: unknown, _p: unknown, _timeout: number, sinal: AbortSignal | undefined, _mo: unknown, opts: any) =>
            new Promise((res) => {
                const tele: any = { provider: 'falso', model: 'm', startedAt: new Date().toISOString(), pedacosAteAgora: 0 };
                opts.telemetry?.attempts.push(tele);
                const t0 = Date.now();
                const pedaco = setInterval(() => {
                    if (Date.now() - t0 > cfg.geraPorMs) return;
                    tele.pedacosAteAgora++; tele.ultimoPedacoEm = Date.now();
                }, cfg.intervaloMs ?? 100);
                const fim = Number.isFinite(cfg.respondeEmMs) ? setTimeout(() => { clearInterval(pedaco); res({ status: 'success', content: VEREDITO, attempts: [] }); }, cfg.respondeEmMs) : undefined;
                sinal?.addEventListener('abort', () => { clearInterval(pedaco); if (fim) clearTimeout(fim); res({ status: 'cancelled', content: '', attempts: [] }); });
            }),
    } as any;
}

async function main(): Promise<void> {
    const registro = criarRegistroPadrao();
    const tipo = 'risco_do_plano';
    const entradas = Object.fromEntries((registro.obter(tipo)?.entradas ?? []).filter(e => e.obrigatoria).map(e => [e.nome, 'conteúdo']));
    const julgar = (cfg: Parameters<typeof fabrica>[0]) => {
        const perfil = new PerfilDoJuiz();
        perfil.definirResolvedorDeCapacidades(async () => ({ raciocinio: false }));   // um modo só: o prazo da vez é o orçamento inteiro
        return new ValidationEngine(fabrica(cfg), registro, () => 'modelo-x', perfil).validar(tipo, entradas);
    };

    console.log('\n=== S431-1 — prazo de 1 s, modelo gerando até concluir em 3 s: NÃO é cortado ===');
    let t0 = Date.now();
    const r1 = await julgar({ geraPorMs: 3000, respondeEmMs: 3000 });
    assert(r1.semVeredito === false && r1.desfecho === 'veredito', `deu veredito em ${Date.now() - t0} ms (antes: cortado em 1 s)`, r1.desfecho);

    console.log('\n=== S431-2 — modelo PAROU de gerar e não responde: cortado depois da janela sem pedaços ===');
    t0 = Date.now();
    const r2 = await julgar({ geraPorMs: 300, respondeEmMs: Infinity });
    const ms2 = Date.now() - t0;
    assert(r2.semVeredito === true && ms2 >= 1000 && ms2 < 15_000, `cortado (${ms2} ms): sem pedaços há mais de 10 s não é "trabalhando"`, r2.desfecho);

    console.log('\n=== S431-3 — passou do orçamento em tokens: cortado no prazo ===');
    t0 = Date.now();
    const r3 = await julgar({ geraPorMs: 60_000, respondeEmMs: Infinity, intervaloMs: 10, medido: { modelo: 'm', tokens: 50, prazoMs: 1000, amostras: 9, geracao: 100 } });
    const ms3 = Date.now() - t0;
    assert(r3.semVeredito === true && ms3 < 4000, `cortado logo após o prazo (${ms3} ms) — já tinha passado dos 50 tokens do orçamento`, r3.desfecho);

    console.log('\n=== S431-4 — dentro de um objetivo: o teto é o que resta a ele ===');
    t0 = Date.now();
    const r4 = await executarComPrazo(Date.now() + 6000, () => julgar({ geraPorMs: 60_000, respondeEmMs: Infinity, medido: { modelo: 'm', tokens: 1_000_000, prazoMs: 1000, amostras: 9, geracao: 100 } }));
    const ms4 = Date.now() - t0;
    assert(r4.semVeredito === true && ms4 >= 4000 && ms4 < 9000, `gerando sem parar e abaixo do orçamento: cortado no teto do objetivo (${ms4} ms ≈ 6 s)`, r4.desfecho);

    console.log(`\n=== S431: ${passed} passaram, ${failed} falharam ===`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
