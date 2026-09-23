/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S294
 *
 * CONTEXTO (log de auditoria, 23/09/2026): após um reboot o Ollama se fechou sozinho (atualização
 * silenciosa que falhou com "Acesso negado"). O NewClaw ficou sem provider e o usuário, no
 * dashboard, recebeu só "Erro ao processar sua mensagem." — sem saber que o provedor estava fora
 * do ar. Duas causas no código, ambas confirmadas no log:
 *
 *  1. Circuito aberto (`ALL_PROVIDERS_CIRCUIT_OPEN`): o retorno tinha `content` informativo, mas
 *     nenhum `fallbackMessage`; o AgentLoop devolve `fallbackMessage || 'Erro ao processar...'`,
 *     então o texto era descartado (log: `Provider error at step 1: undefined`).
 *  2. Falha de conexão (`fetch failed`, 4 ms): recebia "O modelo demorou mais que o esperado",
 *     falso — nada estava lento, nada respondia.
 *
 * REGRESSÃO SE: uma resposta de erro do ProviderFactory voltar sem `fallbackMessage`, ou uma falha
 * que não é timeout voltar a alegar lentidão.
 *
 * Execução: npx ts-node src/__tests__/regression/S294_ProviderFactory_UnreachableProviderMessage.test.ts
 */

import * as net from 'net';
import { ProviderFactory } from '../../core/ProviderFactory';

let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string, detail?: unknown): void {
    if (cond) { console.log(`  OK ${msg}`); passed++; }
    else { console.error(`  FALHOU: ${msg}`, detail ?? ''); failed++; }
}

/** Porta livre e fechada: reproduz "nada escutando", como o Ollama parado. */
function closedPort(): Promise<number> {
    return new Promise(resolve => {
        const s = net.createServer();
        s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
    });
}

async function main(): Promise<void> {
    const port = await closedPort();
    const pf = new ProviderFactory({ defaultProvider: 'ollama', ollamaUrl: `http://127.0.0.1:${port}`, ollamaModel: 'x' } as any);

    console.log('\n=== S294.1 — provider inalcançável: mensagem não alega lentidão e nomeia o provedor ===');
    let last: any;
    for (let i = 0; i < 4 && (!last || last.fallbackReason !== 'unavailable'); i++) {
        last = await pf.chatWithFallback([{ role: 'user', content: 'oi' }], undefined, undefined, 5000);
        if (i === 0) {
            assert(last.status === 'error', `status error (obtido ${last.status})`);
            assert(!!last.fallbackMessage, 'fallbackMessage presente', last);
            assert(!/demorou mais que o esperado/.test(last.fallbackMessage || ''), 'não diz que o modelo "demorou"', last.fallbackMessage);
            assert(/ollama/.test(last.fallbackMessage || ''), 'nomeia o provedor', last.fallbackMessage);
        }
    }

    console.log('\n=== S294.2 — circuito aberto: fallbackMessage/fallbackReason presentes (senão o AgentLoop descarta) ===');
    assert(last.fallbackReason === 'unavailable', `fallbackReason unavailable (obtido ${last.fallbackReason})`, last);
    assert(!!last.fallbackMessage && last.fallbackMessage.length > 31, 'fallbackMessage informativo, não o genérico', last.fallbackMessage);

    console.log(`\nS294 RESULTADO: ${passed} passou | ${failed} falhou`);
    process.exit(failed > 0 ? 1 : 0);
}
main().catch(e => { console.error('ERRO NÃO TRATADO:', e); process.exit(1); });
