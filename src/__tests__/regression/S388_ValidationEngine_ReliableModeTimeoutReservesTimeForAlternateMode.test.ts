/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S388 (Campanha 2 — Sprint J2)
 *
 * Incidente real (12/10/2026 07:46):
 * O modelo `glm-5.3-flash:cloud` no modo `livre` entrou em espiral de raciocínio (107k chars de thinking)
 * e sofreu timeout de 205s em `saida_contra_evidencia`. Como o perfil acumulava histórico positivo (172/182),
 * `confiavel()` retornava true e a 1ª chamada recebia 100% do orçamento (fatia = restante).
 * Ao sofrer timeout, não sobrava tempo para o segundo modo (`desligado`), que nunca recebia a chance de rodar,
 * mesmo sendo 2x mais rápido no histórico (41s vs 85s).
 *
 * Correção J2:
 * 1. Em orçamentos de produção (>= 15s), mesmo um modo considerado confiável recebe no máximo 75% da fatia,
 *    garantindo que se sofrer timeout, sobrem 25% para o modo alternativo rodar e entregar o veredito.
 * 2. `ordemDosModos` penaliza modos com falhas seguidas recentes, dando prioridade ao modo alternativo.
 * 3. `confiavel` exige `falhasSeguidas < FALHAS_PARA_DISJUNTOR`.
 *
 * Execução: npx ts-node src/__tests__/regression/S388_ValidationEngine_ReliableModeTimeoutReservesTimeForAlternateMode.test.ts
 */

import { ValidationEngine } from '../../validation/ValidationEngine';
import { PerfilDoJuiz } from '../../validation/perfilDoJuiz';
import { criarRegistroPadrao } from '../../validation/motorPadrao';

let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string, extra?: unknown): void {
    if (cond) { console.log(`  ✅ ${msg}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${msg}`, extra ?? ''); failed++; }
}

const VEREDITO = JSON.stringify({ estado: 'aprovado', itens: [{ item: 'x', confere: 'sim' }], tipo_de_falha: 'none' });

interface Chamada { modo: string; fatiaMs: number; reasoningIntensive: boolean }

function fabrica(chamadas: Chamada[], orcamentoMs = 60_000) {
    return {
        getBudgetAuxiliar: () => ({ timeoutMs: orcamentoMs, origem: 'padrao', latenciaTipicaMs: null }),
        chatWithFallback: async (
            _m: unknown, _t: unknown, _p: unknown, timeoutMs: number, sinal: AbortSignal | undefined, _modelo: unknown,
            opts: { raciocinio: string; reasoningIntensive?: boolean }
        ) => {
            chamadas.push({ modo: opts.raciocinio, fatiaMs: timeoutMs, reasoningIntensive: !!opts.reasoningIntensive });
            if (opts.raciocinio === 'livre') {
                return new Promise(res => {
                    const t = setTimeout(() => res({ status: 'timeout', content: '' }), 5);
                    sinal?.addEventListener('abort', () => { clearTimeout(t); res({ status: 'cancelled', content: '' }); });
                });
            }
            return { status: 'success', content: VEREDITO, duration: 10 };
        },
    } as any;
}

const ENTRADAS = { pedido: 'p', resposta: 'r' };
const motorCom = (pf: any, perfil: PerfilDoJuiz, modelo = 'modelo-real') =>
    new ValidationEngine(pf, criarRegistroPadrao(), () => modelo, perfil);

async function main(): Promise<void> {
    console.log('\n=== S388-1 — orçamento real (>= 15s): modo confiável não monopoliza 100% do orçamento ===');
    {
        const perfil = new PerfilDoJuiz();
        for (let i = 0; i < 5; i++) perfil.registrar('modelo-real', 'livre', true, 5000);
        assert(perfil.confiavel('modelo-real', 'livre'), 'modo com 5 sucessos é confiável');

        const chamadas: Chamada[] = [];
        const pf = fabrica(chamadas, 60_000);
        const engine = motorCom(pf, perfil, 'modelo-real');

        const res = await engine.validar('qualidade_da_resposta', ENTRADAS);

        assert(chamadas.length === 2, 'após timeout do modo livre, o segundo modo foi chamado (não abortou sem tentar)', chamadas);
        assert(Math.abs(chamadas[0].fatiaMs - 45_000) < 500, '1ª chamada recebeu ~75% da fatia (45s de 60s), não 100%', chamadas[0]);
        assert(chamadas[1].modo === 'desligado' && chamadas[1].fatiaMs > 0, '2ª chamada recebeu o tempo restante para rodar', chamadas[1]);
        assert(res.veredito.estado === 'aprovado', 'o veredito foi entregue pelo segundo modo');
    }

    console.log('\n=== S388-2 — falha recente reduz a pontuação em ordemDosModos para tentar o modo alternativo ===');
    {
        const perfil = new PerfilDoJuiz();
        for (let i = 0; i < 5; i++) perfil.registrar('m', 'livre', true, 5000);
        for (let i = 0; i < 2; i++) perfil.registrar('m', 'desligado', true, 4000);

        assert(perfil.ordemDosModos('m', 'livre')[0] === 'livre', 'antes da falha: livre é o primeiro');

        // Modo livre sofre uma falha recente
        perfil.registrar('m', 'livre', false, 30000);

        const novaOrdem = perfil.ordemDosModos('m', 'livre');
        assert(novaOrdem[0] === 'desligado', 'após falha recente no livre: desligado assume o 1º lugar na ordem', novaOrdem);
    }

    console.log('\n=== S388-3 — duas falhas seguidas suspendem a confiança até nova recuperação ===');
    {
        const perfil = new PerfilDoJuiz();
        for (let i = 0; i < 10; i++) perfil.registrar('m2', 'livre', true, 5000);
        assert(perfil.confiavel('m2', 'livre'), 'com 10 sucessos: confiável');

        perfil.registrar('m2', 'livre', false, 30000);
        perfil.registrar('m2', 'livre', false, 30000);
        assert(!perfil.confiavel('m2', 'livre'), 'com 2 falhas seguidas: não é mais confiável (entra em modo dividido)');
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(failed === 0 ? `✅ S388 passou (${passed} verificações)` : `❌ S388: ${failed} falha(s) de ${passed + failed}`);
    process.exitCode = failed === 0 ? 0 : 1;
}

main().catch(err => {
    console.error('Erro em S388:', err);
    process.exit(1);
});
