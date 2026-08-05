/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S194 (issue 020)
 *
 * Achado no teste de uso como usuário leigo (05/08/2026), pedido "faça uma apresentação de 3
 * slides": o laço de entrega (`AgentLoop.runDeliveryGuardPhase`) repetiu o MESMO comando,
 * falhando toda vez:
 *
 *     [AUTO-FIX] fix=wrap_powershell original="bash scripts/html2pdf.sh tmp/reciclagem.md"
 *     [DELIVERY] exec_command -> ✗
 *     ... 22 vezes, ~1 por segundo
 *
 * O usuário esperou 10 minutos e recebeu `Timeout aguardando resposta do agente`, sem arquivo e
 * sem explicação.
 *
 * A regra "não repita chamada idêntica que já falhou" JÁ EXISTIA em dois lugares — o
 * `GoalEvaluator` (`repeated_tool_call`: "mesma chamada não vai produzir resultado diferente") e
 * o dedup do protocolo JSON no AgentLoop. Faltava exatamente na fase de entrega, que não tem
 * contador próprio. Quarta política de "não repita", cada uma num caminho — mesma forma do que a
 * `ADR-005` §5.1 encontrou para o gate de autorização.
 *
 * Junto, um achado estrutural: `ProactiveRecovery` tinha função de chave PRÓPRIA enquanto o resto
 * do projeto usa `computeToolInputKey`, e as duas conviviam no MESMO `Set` de inputs usados — uma
 * chamada registrada por um caminho era invisível para o dedup do outro.
 *
 * Execução: npx ts-node src/__tests__/regression/S194_NoIdenticalFailedRepeat.test.ts
 */

import { ProactiveRecovery } from '../../loop/ProactiveRecovery';
import { computeToolInputKey } from '../../loop/planning/computeToolInputKey';
import { permissionRegistry } from '../../core/PermissionRegistry';
import { OperationalMode } from '../../core/CapabilityMode';

let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string, detail?: unknown): void {
    if (cond) { console.log(`  OK ${msg}`); passed++; }
    else { console.error(`  FALHOU: ${msg}`, detail ?? ''); failed++; }
}

/** Tool que conta execuções — o número de chamadas reais é o que está sob teste. */
function toolQueSempreFalha() {
    let execucoes = 0;
    return {
        tool: { execute: async () => { execucoes++; return { success: false, output: '', error: 'comando não encontrado' }; } },
        vezes: () => execucoes,
    };
}

async function main() {
    console.log('\n=== S194 — chamada idêntica que já falhou não é repetida (issue 020) ===');
    permissionRegistry.setMode(OperationalMode.GOD, 'test-s194', true);   // gate de auth fora do caminho

    console.log('\n--- S194.1 — o caso do usuário: mesmo comando, mesmas falhas ---');
    {
        const r = new ProactiveRecovery();
        const usados = new Set<string>();
        const alvo = toolQueSempreFalha();
        const args = { command: 'bash scripts/html2pdf.sh tmp/reciclagem.md' };

        const primeira = await r.execute('exec_command', args, () => alvo.tool, usados);
        const execucoesApos1 = alvo.vezes();
        assert(primeira.result.success === false, 'a primeira tentativa roda de verdade e falha', primeira.result);
        assert(execucoesApos1 >= 1, 'a tool foi executada na primeira tentativa', execucoesApos1);

        // O laço de entrega chamava isto de novo, e de novo, e de novo...
        for (let i = 0; i < 5; i++) {
            await r.execute('exec_command', args, () => alvo.tool, usados);
        }
        assert(alvo.vezes() === execucoesApos1,
            'nenhuma execução nova: as 5 repetições idênticas foram bloqueadas', { antes: execucoesApos1, depois: alvo.vezes() });

        const bloqueada = await r.execute('exec_command', args, () => alvo.tool, usados);
        assert(/repetir não produz resultado diferente/i.test(String(bloqueada.result.error)),
            'o motivo devolvido ao modelo diz o que fazer: mudar a abordagem', bloqueada.result.error);
    }

    console.log('\n--- S194.2 — argumentos diferentes continuam passando ---');
    {
        const r = new ProactiveRecovery();
        const usados = new Set<string>();
        const alvo = toolQueSempreFalha();

        await r.execute('exec_command', { command: 'comando-a' }, () => alvo.tool, usados);
        await r.execute('exec_command', { command: 'comando-b' }, () => alvo.tool, usados);
        assert(alvo.vezes() >= 2,
            'tentar OUTRA coisa depois de falhar é exatamente o que se quer — não é bloqueado', alvo.vezes());
    }

    console.log('\n--- S194.3 — sucesso não vira bloqueio ---');
    {
        const r = new ProactiveRecovery();
        const usados = new Set<string>();
        let execucoes = 0;
        const tool = { execute: async () => { execucoes++; return { success: true, output: 'ok' }; } };
        const args = { path: 'arquivo.txt' };

        await r.execute('read', args, () => tool, usados);
        const segunda = await r.execute('read', args, () => tool, usados);
        assert(segunda.result.success === true && execucoes === 2,
            'reler um arquivo depois de um write é legítimo — só a repetição que JÁ FALHOU é bloqueada', { execucoes });
    }

    console.log('\n--- S194.4 — a chave de identidade é a mesma do resto do projeto ---');
    {
        // Antes, ProactiveRecovery tinha chave própria e as duas conviviam no mesmo Set: o que um
        // caminho registrava, o outro não enxergava.
        const r = new ProactiveRecovery();
        const usados = new Set<string>();
        const alvo = toolQueSempreFalha();
        const args = { command: 'algo-que-falha' };
        await r.execute('exec_command', args, () => alvo.tool, usados);

        const chaveCanonica = computeToolInputKey('exec_command', args);
        const temChaveCanonica = [...usados].some(k => k.includes(chaveCanonica));
        assert(temChaveCanonica,
            'o Set compartilhado guarda a chave canônica (computeToolInputKey), visível para os outros caminhos', [...usados].slice(0, 3));
    }

    permissionRegistry.setMode(OperationalMode.SAFE, 'test-s194-restore');
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S194 RESULTADO: ${passed} passou | ${failed} falhou`);
    if (failed > 0) process.exit(1);
    process.exit(0);
}

main().catch(err => { console.error('Erro no teste S194:', err); process.exit(1); });
