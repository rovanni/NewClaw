/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S454 (28/10/2026)
 *
 * Provedor de modelos fora do ar avisa UMA vez, não a cada varredura. A falha repetida (mesmo erro) vai para debug; um
 * erro diferente avisa de novo; a volta do provedor é registrada.
 *
 * ORIGEM: instalação Windows, 25–28/10/2026. Com o llamafile e o Strata desligados, cada varredura do catálogo gravava o
 * mesmo aviso: 118 "llamafile discovery failed: fetch failed" e 118 "Strata discovery failed" em 3 dias — o ruído
 * escondia os avisos que importavam na leitura dos logs.
 *
 * REGRESSÃO SE: a mesma falha voltar a avisar a cada varredura; um erro novo deixar de avisar; ou a volta não aparecer.
 *
 * Execução: npx ts-node src/__tests__/regression/S454_DiscoverySemAvisoRepetido.test.ts
 */
import { ModelRegistryService } from '../../core/ModelRegistryService';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}

async function capturando(fn: () => Promise<unknown>): Promise<string> {
    const out = process.stdout.write.bind(process.stdout);
    const err = process.stderr.write.bind(process.stderr);
    let saida = '';
    const grava = (chunk: unknown): boolean => { saida += String(chunk); return true; };
    (process.stdout.write as unknown) = grava;
    (process.stderr.write as unknown) = grava;
    try { await fn(); } finally { process.stdout.write = out; process.stderr.write = err; }
    return saida;
}

async function main(): Promise<void> {
    console.log('\n=== S454 — discovery sem aviso repetido ===\n');

    const roteiro: Array<string | null> = ['fetch failed', 'fetch failed', 'fetch failed', 'ECONNREFUSED', null, 'fetch failed'];
    let i = 0;
    const ollama = {
        getBaseUrl: () => 'http://fake-ollama.invalid',
        discoverModels: async () => { const e = roteiro[i++]; if (e) throw new Error(e); return []; },
    };
    const pf = { getOllamaProvider: () => ollama, getNativeProvider: () => undefined } as any;
    const registro = new ModelRegistryService(pf);

    const saidas: string[] = [];
    for (let n = 0; n < roteiro.length; n++) saidas.push(await capturando(() => registro.discoverAll()));
    const avisos = saidas.map(s => (s.match(/Ollama discovery failed: /g) ?? []).length);
    const voltas = saidas.map(s => /Ollama discovery voltou a responder/.test(s));

    assert(avisos[0] === 1, 'a primeira falha avisa', avisos);
    assert(avisos[1] === 0 && avisos[2] === 0, 'a mesma falha repetida não avisa de novo', avisos);
    assert(avisos[3] === 1, 'um erro diferente avisa', avisos);
    assert(voltas[4] && avisos[4] === 0, 'a volta do provedor é registrada', voltas);
    assert(avisos[5] === 1, 'depois da volta, a falha avisa outra vez', avisos);
    const saude = registro.getLastHealth().find(h => h.provider === 'ollama');
    assert(saude?.online === false && saude.error === 'fetch failed', 'a saúde do provedor segue registrando a falha (só o log mudou)', saude);

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S454 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    process.exit(failed > 0 ? 1 : 0);
}
main().catch((err) => { console.error('S454 erro inesperado:', err); process.exit(1); });
