/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S412
 * O limite de contexto do agente (trava de crescimento, issue 052) vem da janela MEDIDA do modelo do turno, não do num_ctx fixo.
 *
 * ORIGEM (15/10/2026): o teto era sempre OLLAMA_NUM_CTX (32.768 tokens → ~73,7 mil chars), também para modelos de nuvem com janela
 * de 1.048.576 tokens. Experimento aprovado pela usuária: o Ollama Cloud ignora o num_ctx (108.294 tokens processados com
 * num_ctx=32768). A trava encerrava o turno de um modelo de nuvem muito antes do limite real dele. Mesma causa do teto do juiz (S411).
 *
 * REGRESSÃO SE: o turno deixar de medir a janela do modelo; a trava ignorar a capacidade medida; ou, sem medição, deixar de valer o
 * num_ctx (S324 cobre o padrão).
 *
 * Execução: npx ts-node src/__tests__/regression/S412_ContextoDoAgente_JanelaMedida.test.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { AgentLoop } from '../../loop/AgentLoop';
import { ProviderFactory } from '../../core/ProviderFactory';
import { caracteresQueCabem } from '../../core/providerTypes';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}

/** Chama a trava REAL com um tamanho de contexto controlado e, opcionalmente, a capacidade medida do turno. */
function trava(atual: number, capacidade?: number): boolean {
    const loop = Object.create(AgentLoop.prototype) as any;
    loop.ts = () => '';
    const orig = process.stdout.write.bind(process.stdout);
    (process.stdout.write as unknown) = (): boolean => true;
    try {
        const r = loop.checkContextGrowthGuard(
            [{ step: 1, tool: 'read', input: '{}', status: 'success' }], 'analise o calendário', 4, false, '', 15, false, 0,
            () => atual, 13000, [], capacidade,
        );
        return r.dedupAbort === true || r.action === 'continueLoop';
    } finally { process.stdout.write = orig; }
}

async function main(): Promise<void> {
    delete process.env.OLLAMA_NUM_CTX;

    console.log('\n=== S412-1 — a trava usa a capacidade medida do turno ===');
    {
        const nuvem = caracteresQueCabem(1048576);
        assert(!trava(300_000, nuvem), 'modelo de nuvem (janela de 1 M tokens): 300 mil chars de contexto seguem — antes encerrava em ~73,7 mil');
        assert(trava(nuvem + 1, nuvem), 'acima da janela medida, encerra');
        assert(trava(80_000, caracteresQueCabem(32768)), 'modelo local (num_ctx 32.768): 80 mil chars passam da janela real → encerra');
        assert(trava(80_000), 'sem capacidade medida: vale o num_ctx (padrão de sempre)');
    }

    console.log('\n=== S412-2 — o turno mede a janela do modelo escolhido; só o Ollama mede hoje ===');
    {
        const src = fs.readFileSync(path.join(__dirname, '../../loop/AgentLoop.ts'), 'utf-8');
        assert(/janelaMedida\?\.\(chatProfile\.model, chatProfile\.provider\)/.test(src), 'setupTurn mede a janela do modelo e do provedor DESTE turno');
        assert(/loopMessages, capacidadeDeContexto,\s*\)/.test(src), 'e entrega a capacidade à trava');
        const pf = Object.create(ProviderFactory.prototype) as ProviderFactory;
        (pf as any).defaultProvider = 'ollama';
        (pf as any).getOllamaProvider = () => ({ getModel: () => 'glm-5.3-flash:cloud', janelaEfetiva: async (m: string) => ({ tokens: 1048576, origem: `medido ${m}` }) });
        const ollama = await pf.janelaMedida('glm-5.3-flash:cloud');
        assert(ollama?.tokens === 1048576 && /glm-5\.3-flash:cloud/.test(ollama.origem), 'provedor Ollama: a janela medida do modelo pedido', ollama);
        assert(await pf.janelaMedida('gemini-2.5-pro', 'gemini') === undefined, 'outro provedor (sem medição): undefined — cada consumidor usa o próprio padrão');
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S412 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    process.exit(failed > 0 ? 1 : 0);
}
main().catch(err => { console.error('S412 erro inesperado:', err); process.exit(1); });
