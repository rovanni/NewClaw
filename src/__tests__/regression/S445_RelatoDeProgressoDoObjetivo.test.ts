/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S445 (ADR-027)
 * Sem relógio que encerre o objetivo, quem espera precisa ver o que está acontecendo: a cada RELATO_DE_PROGRESSO_MIN (padrão
 * 5; 0 desliga), uma mensagem no mesmo canal — há quanto tempo roda, o que concluiu desde o último relato, o passo atual e
 * como interromper. Texto montado de FATOS do goal (sem modelo, sem cota), sem jargão interno e sem valores do cofre.
 *
 * ORIGEM: operadora, 23/10/2026 — "você vai relatando passo a passo o que está sendo feito; como colocar esse relato no
 * NewClaw, ou pelo menos de 5 em 5 minutos?". Os eventos de cada passo já existiam (onProgress), mas só iam ao log.
 *
 * REGRESSÃO SE: o relato não sair enquanto o objetivo roda; continuar depois que ele termina; mostrar marcadores internos
 * ("[ATENÇÃO —", "SEM toolName") ou um segredo; ou o padrão/desligamento mudar.
 *
 * Execução: npx ts-node src/__tests__/regression/S445_RelatoDeProgressoDoObjetivo.test.ts
 */
// Antes de qualquer import: a lista de segredos do processo fica em cache (5 s) desde a primeira linha de log.
process.env.SEGREDO_S445 = 'senhaSecreta-S445-9f3';
import { ToolRegistry } from '../../core/ToolRegistry';
import { permissionRegistry } from '../../core/PermissionRegistry';
import { OperationalMode } from '../../core/CapabilityMode';
import { intervaloDoRelatoMs, descricaoParaOUsuario, montarRelatoDeProgresso } from '../../loop/relatoDeProgresso';
import { makeLoop, makeGoal, channelContext } from './_fixtures/goalLoopHarness';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}
const esperar = (ms: number) => new Promise(r => setTimeout(r, ms));

async function main(): Promise<void> {
    console.log('\n=== S445-1 — intervalo: padrão 5 min; 0 desliga; inválido = padrão ===');
    delete process.env.RELATO_DE_PROGRESSO_MIN;
    assert(intervaloDoRelatoMs() === 5 * 60_000, 'padrão: 5 min');
    process.env.RELATO_DE_PROGRESSO_MIN = '0';
    assert(intervaloDoRelatoMs() === 0, '0 desliga');
    process.env.RELATO_DE_PROGRESSO_MIN = 'lixo';
    assert(intervaloDoRelatoMs() === 5 * 60_000, 'inválido → o padrão (não desliga sem querer)');
    process.env.RELATO_DE_PROGRESSO_MIN = '2';
    assert(intervaloDoRelatoMs() === 2 * 60_000, 'configurável');

    console.log('\n=== S445-2 — o texto: fatos do goal, sem jargão interno nem segredo ===');
    const d = descricaoParaOUsuario('AgentLoop (step SEM toolName): instalar o mod no servidor com senhaSecreta-S445-9f3 [ATENÇÃO — tentativa anterior retornou output irrelevante]');
    assert(d.startsWith('instalar o mod no servidor'), 'sem o prefixo de roteamento interno', d);
    assert(!/ATENÇÃO|SEM toolName|AgentLoop/.test(d), 'sem marcadores internos', d);
    assert(!d.includes('senhaSecreta-S445-9f3'), 'valor do cofre mascarado', d);
    const agora = Date.now();
    const goal: any = {
        currentPlan: [
            { id: 's1', description: 'baixar o mod', status: 'completed' },
            { id: 's2', description: 'SEM toolName (AgentLoop executa a skill x): habilitar o mod no mundo', status: 'completed' },
            { id: 's3', description: 'reiniciar o servidor e conferir a porta', status: 'pending' },
        ],
        attempts: [
            { planStepId: 's1', result: 'success', executedAt: agora - 9 * 60_000 },   // antes do último relato: não repete
            { planStepId: 's2', result: 'success', executedAt: agora - 2 * 60_000 },
            { planStepId: 's3', result: 'failure', executedAt: agora - 60_000 },
        ],
    };
    const texto = montarRelatoDeProgresso(goal, agora - 12 * 60_000, agora - 5 * 60_000, agora);
    assert(/^⏳ Ainda estou trabalhando no seu pedido \(há 12 min\)\./.test(texto), 'diz há quanto tempo roda', texto);
    assert(/Concluído desde o último aviso: habilitar o mod no mundo\./.test(texto) && !/baixar o mod/.test(texto), 'só o concluído DESDE o último relato', texto);
    assert(/▶ Agora: reiniciar o servidor e conferir a porta\./.test(texto), 'o passo atual', texto);
    assert(/\/cancelar/.test(texto), 'como interromper', texto);
    const nada = montarRelatoDeProgresso({ currentPlan: [], attempts: [] } as any, agora - 60_000, agora - 30_000, agora);
    assert(/Nenhum passo novo concluído/.test(nada), 'sem novidade, diz isso (não inventa progresso)', nada);
    delete process.env.SEGREDO_S445;

    console.log('\n=== S445-3 — no laço real: relata enquanto roda e para quando termina ===');
    process.env.RELATO_DE_PROGRESSO_MIN = '0.02';   // 1,2 s
    permissionRegistry.setMode(OperationalMode.DEVELOPER, 'test-s445', true);
    try {
        const TOOL = '__s445_demorado__';
        ToolRegistry.register({ name: TOOL, description: 'test', parameters: {}, execute: async () => { await esperar(3000); return { success: true, output: 'mod instalado' }; } });
        const { loop, goalStore } = makeLoop({ achieved: true, summary: 'mod instalado' }, { formatoDoMotor: true });
        const avisos: Array<{ sessao: string; texto: string }> = [];
        loop.setAvisoAoUsuario(async (sessao, texto) => { avisos.push({ sessao, texto }); });
        const g = makeGoal(goalStore, [{ id: 's1', description: 'instalar o mod no servidor', toolName: TOOL, toolArgs: {}, status: 'pending', fallbackSteps: [] } as any], { toolsTried: [TOOL] });
        const emAndamento: boolean[] = [];
        const vigia = setInterval(() => emAndamento.push(loop.estaExecutando(g.id)), 200);
        const res: any = await (loop as any).runLoop(g, channelContext, undefined, 0, 0);
        clearInterval(vigia);
        const nofim = avisos.length;
        await esperar(2500);
        assert(res.success === true, 'o objetivo conclui', res.finalOutput);
        assert(nofim >= 1, `pelo menos um relato enquanto o passo de 3 s rodava (${nofim})`, avisos);
        assert(avisos.every(a => a.sessao === 'test:harness'), 'no mesmo canal/conversa do pedido');
        assert(/▶ Agora: instalar o mod no servidor\./.test(avisos[0]?.texto ?? ''), 'o relato diz o passo em andamento', avisos[0]?.texto);
        assert(avisos.length === nofim, 'nenhum relato depois que o objetivo terminou', avisos.length);
        assert(emAndamento.includes(true) && loop.estaExecutando(g.id) === false, 'no registro de execução enquanto roda; fora dele ao terminar');
    } finally {
        permissionRegistry.setMode(OperationalMode.SAFE, 'test-s445-restore');
        delete process.env.RELATO_DE_PROGRESSO_MIN;
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S445 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    process.exit(failed > 0 ? 1 : 0);
}
main().catch((err) => { console.error('S445 erro inesperado:', err); process.exit(1); });
