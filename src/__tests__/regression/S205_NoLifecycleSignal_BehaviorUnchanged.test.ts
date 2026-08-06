/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S205
 * Sem sinal de ciclo de vida, o comportamento do circuit breaker permanece o de sempre.
 *
 * CONTEXTO: a Sprint 020 (`RFC-005`) fez o `ProviderFactory` classificar falhas antes de
 * contabilizá-las, para parar de acusar de avaria um runtime local que o usuário simplesmente
 * desligou. Toda mudança desse tipo carrega o risco oposto: silenciar falhas legítimas e
 * transformar o circuit breaker em decoração.
 *
 * Este teste é o contrapeso do S204. Aquele prova que o comportamento MUDOU onde devia; este prova
 * que NÃO mudou onde não devia. Foi escrito para FALHAR se a classificação vazar para caminhos que
 * nunca tiveram ciclo de vida gerenciado.
 *
 * A regra que ele trava (`RFC-005`, correção de 06/08/2026): **ausência de registro não é
 * indeterminação — é ausência de gerenciamento.** Um llamafile subido à mão, fora do dashboard, é
 * do ponto de vista do NewClaw indistinguível de um provider de nuvem: foi declarado, logo
 * espera-se que esteja de pé, e falhar é avaria. A primeira redação da RFC classificava esse caso
 * como `indeterminado`, o que teria desligado o circuito de quem nunca usou o dashboard para
 * carregar modelo.
 *
 * REGRESSÃO SE: provider de nuvem, provider nativo, ou endpoint de loopback sem registro deixarem
 * de acumular falhas; ou se um registro corrompido conseguir afetar a contabilidade de um provider
 * que não é o runtime gerenciado (um JSON quebrado não pode desativar o circuito de todo mundo).
 *
 * Isolamento: `chdir` para pasta temporária antes dos imports — ver S204.
 *
 * Execução: npx ts-node src/__tests__/regression/S205_NoLifecycleSignal_BehaviorUnchanged.test.ts
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

const PORTA_LOCAL = 8080;
const LIMIAR_PADRAO = 5; // failureThreshold do CircuitBreaker

async function main(): Promise<void> {
    const cwdOriginal = process.cwd();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'newclaw-s205-'));
    fs.mkdirSync(path.join(tmp, 'data'), { recursive: true });
    process.chdir(tmp);

    try {
        const { LOCAL_RUNTIME_STATE_FILE } = await import('../../core/localRuntimeState');
        const { ProviderFactory } = await import('../../core/ProviderFactory');

        const escreverRegistro = (conteudo: unknown): void => {
            fs.writeFileSync(
                LOCAL_RUNTIME_STATE_FILE,
                typeof conteudo === 'string' ? conteudo : JSON.stringify(conteudo),
                'utf-8',
            );
        };
        const apagarRegistro = (): void => fs.rmSync(LOCAL_RUNTIME_STATE_FILE, { force: true });

        const novaFactory = () => new ProviderFactory({
            defaultProvider: 'gemini',
            geminiKey: 'chave-de-teste-nunca-usada',
            ollamaUrl: 'http://localhost:11434',
            customProviders: [
                { label: 'Modelo local', baseUrl: `http://127.0.0.1:${PORTA_LOCAL}/v1` },
                { label: 'Gateway remoto', baseUrl: 'https://api.exemplo-inexistente.test/v1' },
            ],
        });

        const falhasApos = (pf: InstanceType<typeof ProviderFactory>, provider: string, n: number): number => {
            pf.circuitBreakers.resetAll();
            for (let i = 0; i < n; i++) {
                (pf as unknown as { registrarFalhaSeForAvaria(p: string, m: string): void })
                    .registrarFalhaSeForAvaria(provider, 'erro sintético de teste');
            }
            return pf.circuitBreakers.getOrCreate({ name: provider }).getFailureCount();
        };

        console.log('\n=== S205-1 — provider de nuvem: contabilidade intacta ===');
        {
            apagarRegistro();
            const pf = novaFactory();
            assert(falhasApos(pf, 'gemini', 3) === 3, 'nativo de nuvem acumula falha como sempre acumulou');
            assert(
                falhasApos(pf, 'Gateway remoto', 3) === 3,
                'custom NÃO-loopback acumula falha — ter baseUrl próprio não o torna gerenciado',
            );
        }

        console.log('\n=== S205-2 — loopback SEM registro: ausência de gerenciamento, não indeterminação ===');
        {
            apagarRegistro();
            const pf = novaFactory();
            const falhas = falhasApos(pf, 'Modelo local', 3);
            assert(
                falhas === 3,
                'llamafile subido à mão (sem registro) continua acumulando falha — foi declarado, espera-se de pé',
                falhas,
            );
        }

        console.log('\n=== S205-3 — registro de OUTRA porta não protege este endpoint ===');
        {
            escreverRegistro({ pid: 999_999, file: 'outro.gguf', port: PORTA_LOCAL + 7 });
            const pf = novaFactory();
            const falhas = falhasApos(pf, 'Modelo local', 3);
            assert(
                falhas === 3,
                'registro parado de outra porta não isenta este provider — estado não se herda entre portas',
                falhas,
            );
        }

        console.log('\n=== S205-4 — registro corrompido não desliga o circuito de terceiros ===');
        {
            escreverRegistro('{{{ corrompido');
            const pf = novaFactory();
            assert(falhasApos(pf, 'gemini', 4) === 4, 'nuvem intacta mesmo com registro ilegível no disco');
            assert(
                falhasApos(pf, 'Gateway remoto', 4) === 4,
                'custom remoto intacto — o efeito do registro ilegível fica contido ao loopback',
            );
        }

        console.log('\n=== S205-5 — o circuito ainda ABRE no limiar, para quem deve ===');
        {
            apagarRegistro();
            const pf = novaFactory();
            const falhas = falhasApos(pf, 'gemini', LIMIAR_PADRAO);
            const estado = pf.circuitBreakers.getOrCreate({ name: 'gemini' }).getState();
            assert(falhas === LIMIAR_PADRAO, `${LIMIAR_PADRAO} falhas contabilizadas`, falhas);
            assert(
                estado === 'OPEN',
                'e o circuito abre — a proteção original continua funcionando ponta a ponta',
                estado,
            );
        }

        console.log(`\nS205 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
        console.log(`\nCOBERTURA:`);
        console.log(`  Provider de nuvem e custom remoto: comportamento inalterado`);
        console.log(`  Loopback sem registro: continua contabilizando (ausência ≠ indeterminação)`);
        console.log(`  Registro de outra porta não isenta: testado`);
        console.log(`  Registro corrompido não vaza para outros providers: testado`);
        console.log(`  Circuito ainda abre no limiar: testado`);
    } finally {
        process.chdir(cwdOriginal);
        fs.rmSync(tmp, { recursive: true, force: true });
    }

    if (failed > 0) process.exit(1);
}

main().catch(err => { console.error('Erro inesperado:', err); process.exit(1); });
