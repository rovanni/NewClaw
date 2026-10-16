/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S426
 * ADR-024 etapa 6 (EXPERIMENTAL): o limite de 30 min do objetivo pode virar AVISO — com LIMITE_DO_OBJETIVO_COMO_AVISO=1, o
 * objetivo que chega ao limite não é cortado: o usuário é avisado (e de como interromper) e o trabalho continua até o LIMITE
 * DURO configurável. Desligado (padrão): exatamente como antes. O limite em si é configurável (LIMITE_DO_OBJETIVO_MIN).
 *
 * ORIGEM: operadora, 16/10/2026 — "é muito injusto o modelo estar trabalhando, vencer o tempo e tudo ser cancelado".
 * Pedido explícito: não remover os limites nesta etapa — transformá-los em alertas experimentais, com proteção configurável
 * e estratégia de cancelamento.
 *
 * REGRESSÃO SE: o padrão mudar; o modo de aviso não avisar ou não prorrogar; prorrogar além do limite duro; o teto dos
 * comandos (ADR-023) não acompanhar a prorrogação.
 *
 * Execução: npx ts-node src/__tests__/regression/S426_LimiteDoObjetivoComoAviso.test.ts
 */
import { GOAL_LIMITS, limiteDuroDoObjetivoMs } from '../../loop/GoalLimits';
import { GoalExecutionLoop } from '../../loop/GoalExecutionLoop';
import { executarComPrazo, prazoDoTurno } from '../../shared/turnCancellation';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}
const MIN = 60_000;

async function main(): Promise<void> {
    const limpar = () => { delete process.env.LIMITE_DO_OBJETIVO_COMO_AVISO; delete process.env.LIMITE_DO_OBJETIVO_MIN; delete process.env.LIMITE_DURO_DO_OBJETIVO_MIN; };
    limpar();

    console.log('\n=== S426-1 — padrão: nada muda; o limite é configurável ===');
    assert(GOAL_LIMITS.MAX_GOAL_TTL_MS === 30 * MIN, 'padrão: 30 min');
    process.env.LIMITE_DO_OBJETIVO_MIN = '45';
    assert(GOAL_LIMITS.MAX_GOAL_TTL_MS === 45 * MIN, 'LIMITE_DO_OBJETIVO_MIN=45 → 45 min (lido a cada uso)');
    process.env.LIMITE_DO_OBJETIVO_MIN = 'lixo';
    assert(GOAL_LIMITS.MAX_GOAL_TTL_MS === 30 * MIN, 'valor inválido → o padrão');
    delete process.env.LIMITE_DO_OBJETIVO_MIN;
    assert(limiteDuroDoObjetivoMs() === 90 * MIN, 'limite duro padrão: 3× o limite (90 min)');

    const montar = () => {
        const avisos: Array<{ sessao: string; texto: string }> = [];
        const atualizacoes: any[] = [];
        const falso = { goalStore: { update: (_id: string, patch: any) => atualizacoes.push(patch) }, avisarUsuario: async (sessao: string, texto: string) => { avisos.push({ sessao, texto }); } };
        const prorrogar = (goal: any) => (GoalExecutionLoop.prototype as any).prorrogarPorAviso.call(falso, goal) as boolean;
        return { avisos, atualizacoes, prorrogar };
    };

    console.log('\n=== S426-2 — desligado (padrão): expira como sempre ===');
    {
        const { avisos, prorrogar } = montar();
        const goal = { id: 'g1', sessionKey: 'telegram:1', createdAt: Date.now() - 31 * MIN, expiresAt: Date.now() - MIN };
        assert(prorrogar(goal) === false && avisos.length === 0, 'não prorroga nem avisa');
    }

    console.log('\n=== S426-3 — modo de aviso: prorroga, avisa e diz como interromper ===');
    process.env.LIMITE_DO_OBJETIVO_COMO_AVISO = '1';
    {
        const { avisos, atualizacoes, prorrogar } = montar();
        const goal = { id: 'g2', sessionKey: 'telegram:42', createdAt: Date.now() - 31 * MIN, expiresAt: Date.now() - MIN };
        assert(prorrogar(goal) === true, 'prorrogou (o trabalho continua)');
        assert(atualizacoes.length === 1 && atualizacoes[0].expiresAt > Date.now() && goal.expiresAt === atualizacoes[0].expiresAt, 'o novo prazo é gravado no GoalStore e no objeto', atualizacoes);
        await new Promise(r => setTimeout(r, 10));
        assert(avisos.length === 1 && avisos[0].sessao === 'telegram:42' && /Ainda estou trabalhando/.test(avisos[0].texto) && /\/cancelar/.test(avisos[0].texto), 'o usuário é avisado na mesma conversa, com o jeito de interromper', avisos);
        assert(atualizacoes[0].expiresAt <= goal.createdAt + 90 * MIN, 'nunca além do limite duro');
    }

    console.log('\n=== S426-4 — no limite duro: expira como sempre (proteção) ===');
    {
        const { avisos, prorrogar } = montar();
        const goal = { id: 'g3', sessionKey: 'telegram:7', createdAt: Date.now() - 91 * MIN, expiresAt: Date.now() - MIN };
        assert(prorrogar(goal) === false && avisos.length === 0, 'passou do limite duro: não prorroga');
        process.env.LIMITE_DURO_DO_OBJETIVO_MIN = '120';
        assert(prorrogar({ ...goal }) === true, 'limite duro configurável (LIMITE_DURO_DO_OBJETIVO_MIN=120 → prorroga aos 91 min)');
    }
    limpar();

    console.log('\n=== S426-5 — o teto dos comandos acompanha a prorrogação ===');
    {
        let prazo = Date.now() + 5 * MIN;
        const visto = await executarComPrazo(() => prazo, async () => {
            const antes = prazoDoTurno();
            prazo += 30 * MIN;   // prorrogado
            return { antes, depois: prazoDoTurno() };
        });
        assert(visto.depois! - visto.antes! === 30 * MIN, 'o prazo do turno é o ATUAL (uma função), não uma foto do início');
        const numero = await executarComPrazo(123, async () => prazoDoTurno());
        assert(numero === 123, 'número fixo continua funcionando (compatível)');
    }

    console.log(`\n=== S426: ${passed} passaram, ${failed} falharam ===`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
