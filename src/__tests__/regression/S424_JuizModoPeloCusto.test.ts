/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S424
 * ADR-024, etapa 4: entre os modos de raciocínio que JÁ provaram dar veredito para o modelo, o juiz prefere o mais BARATO em
 * tokens naquele tipo de trabalho — em SOMBRA por padrão (só registra) e de verdade com JUIZ_MODO_PELO_CUSTO=1.
 *
 * ORIGEM: 16/10/2026 — sem raciocínio, o Bonsai deu veredito nos 5 casos reais com ~10× menos tokens (19–66 s) e o mesmo
 * veredito da nuvem nos 2 comparáveis. Poucos casos para trocar a qualidade às cegas: por isso a sombra.
 *
 * REGRESSÃO SE: a ordem mudar sem a configuração ligada; com ela ligada, o modo caro continuar primeiro; ou um modo SEM
 * histórico de veredito (não confiável) for escolhido só por ser barato.
 *
 * Execução: npx ts-node src/__tests__/regression/S424_JuizModoPeloCusto.test.ts
 */
import { PerfilDoJuiz } from '../../validation/perfilDoJuiz';
import { ValidationEngine } from '../../validation/ValidationEngine';
import { criarRegistroPadrao } from '../../validation/motorPadrao';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}
const VEREDITO = JSON.stringify({ estado: 'aprovado', itens: [{ item: 'x', confere: 'sim' }], tipo_de_falha: 'none' });

async function main(): Promise<void> {
    const registro = criarRegistroPadrao();
    const tipo = 'risco_do_plano';
    const entradas = Object.fromEntries((registro.obter(tipo)?.entradas ?? []).filter(e => e.obrigatoria).map(e => [e.nome, 'conteúdo']));
    const medido = (modo: string) => modo === 'livre'
        ? { modelo: 'bonsai', tokens: 12900, prazoMs: 300_000, amostras: 8, geracao: 38 }
        : { modelo: 'bonsai', tokens: 1300, prazoMs: 40_000, amostras: 8, geracao: 38 };
    const rodar = async (perfil: PerfilDoJuiz) => {
        const modos: string[] = [];
        const pf = {
            getBudgetAuxiliar: () => ({ timeoutMs: 1000, origem: 'padrao', latenciaTipicaMs: null }),
            orcamentoPeloTrabalho: (_m: unknown, modo: string) => medido(modo),
            chatWithFallback: async (_a: unknown, _b: unknown, _c: unknown, _f: number, _s: unknown, _mo: unknown, opts: any) => { modos.push(opts.raciocinio); return { status: 'success', content: VEREDITO, attempts: [] }; },
        } as any;
        await new ValidationEngine(pf, registro, () => 'bonsai', perfil).validar(tipo, entradas);
        return modos;
    };
    const perfilComOsDoisConfiaveis = () => {
        const p = new PerfilDoJuiz();
        for (let i = 0; i < 4; i++) { p.registrar('bonsai', 'livre', true, 200_000, tipo); p.registrar('bonsai', 'desligado', true, 40_000, tipo); }
        for (let i = 0; i < 3; i++) p.registrar('bonsai', 'livre', true, 200_000, tipo);   // "livre" com mais acertos: vem primeiro hoje
        return p;
    };

    console.log('\n=== S424-1 — sombra (padrão): a ordem de hoje não muda ===');
    delete process.env.JUIZ_MODO_PELO_CUSTO;
    const sombra = await rodar(perfilComOsDoisConfiaveis());
    assert(sombra[0] === 'livre', 'sem a configuração, o juiz segue chamando o modo de hoje (livre) — só registra o mais barato', sombra);

    console.log('\n=== S424-2 — JUIZ_MODO_PELO_CUSTO=1: o mais barato que já dá veredito vai primeiro ===');
    process.env.JUIZ_MODO_PELO_CUSTO = '1';
    const ativo = await rodar(perfilComOsDoisConfiaveis());
    assert(ativo[0] === 'desligado', 'com a configuração, o modo de 1,3 mil tokens vem antes do de 12,9 mil', ativo);

    console.log('\n=== S424-3 — modo barato SEM histórico de veredito não é escolhido só por ser barato ===');
    const soLivre = new PerfilDoJuiz();
    for (let i = 0; i < 5; i++) soLivre.registrar('bonsai', 'livre', true, 200_000, tipo);
    const naoConfiavel = await rodar(soLivre);
    assert(naoConfiavel[0] === 'livre', 'o desligado nunca deu veredito para este modelo: a ordem segue o que funciona', naoConfiavel);
    delete process.env.JUIZ_MODO_PELO_CUSTO;

    console.log(`\n=== S424: ${passed} passaram, ${failed} falharam ===`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
