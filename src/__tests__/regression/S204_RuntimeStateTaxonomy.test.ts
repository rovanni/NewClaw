/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S204
 * Taxonomia de estados de indisponibilidade do runtime local (`RFC-005`, Sprint 020).
 *
 * CONTEXTO: até esta Sprint o sistema tinha um único conceito de indisponibilidade — "falhou". Um
 * servidor de modelo local que o usuário desligou (estado normal, esperado, reversível com um
 * clique) era contabilizado como avaria, exatamente como um provider quebrado. Efeito medido em
 * produção: `CIRCUIT-OPEN: Skipping 'Modelo local' (failures: 72)` — setenta e duas falhas
 * registradas contra um recurso que nunca esteve com defeito.
 *
 * A `RFC-005` separou os estados; a `ADR-006` colocou o diagnóstico numa camada que o
 * `ProviderFactory` alcança. Este teste cobre os três estados que a classificação de provider pode
 * produzir. A preservação do comportamento antigo, onde não há sinal de ciclo de vida, é o S205 —
 * são testes distintos de propósito: este prova que o comportamento MUDOU onde devia, aquele prova
 * que NÃO mudou onde não devia.
 *
 * REGRESSÃO SE: um runtime declarado e desligado voltar a incrementar o circuito; um runtime
 * declarado e EM EXECUÇÃO que falha deixar de incrementá-lo (aí o circuit breaker vira decoração);
 * ou um registro ilegível passar a ser interpretado como uma causa específica em vez de
 * indeterminação (`NUNCA_ADIVINHAR.md`).
 *
 * Isolamento: o teste faz `chdir` para uma pasta temporária ANTES de importar os módulos, porque
 * `LOCAL_RUNTIME_STATE_FILE` é resolvido a partir de `process.cwd()` no carregamento. Sem isso, ele
 * escreveria no `data/local-model-server.json` real — que é a única memória de qual modelo o
 * usuário escolheu (`ADR-002` §2.4). Um teste jamais pode destruir isso.
 *
 * Execução: npx ts-node src/__tests__/regression/S204_RuntimeStateTaxonomy.test.ts
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

/** PID que não existe. Alto o bastante para não colidir com processo real desta máquina. */
const PID_MORTO = 999_999;
const PORTA_LOCAL = 8080;

async function main(): Promise<void> {
    const cwdOriginal = process.cwd();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'newclaw-s204-'));
    fs.mkdirSync(path.join(tmp, 'data'), { recursive: true });
    process.chdir(tmp);

    try {
        // Import dinâmico DEPOIS do chdir — ver nota de isolamento no cabeçalho.
        const { getLocalRuntimeLifecycle, readLocalRuntimeRecord, LOCAL_RUNTIME_STATE_FILE } =
            await import('../../core/localRuntimeState');
        const { ProviderFactory } = await import('../../core/ProviderFactory');

        assert(
            LOCAL_RUNTIME_STATE_FILE.startsWith(tmp),
            'o teste está isolado — não escreve no registro real do usuário',
            LOCAL_RUNTIME_STATE_FILE,
        );

        const escreverRegistro = (conteudo: unknown): void => {
            fs.writeFileSync(
                LOCAL_RUNTIME_STATE_FILE,
                typeof conteudo === 'string' ? conteudo : JSON.stringify(conteudo),
                'utf-8',
            );
        };
        const apagarRegistro = (): void => fs.rmSync(LOCAL_RUNTIME_STATE_FILE, { force: true });

        const novaFactory = () => new ProviderFactory({
            defaultProvider: 'Modelo local',
            geminiKey: 'chave-de-teste-nunca-usada',
            customProviders: [
                { label: 'Modelo local', baseUrl: `http://127.0.0.1:${PORTA_LOCAL}/v1` },
            ],
        });

        /** Falhas acumuladas por um provider depois de N falhas reportadas. */
        const falhasApos = (pf: InstanceType<typeof ProviderFactory>, provider: string, n: number): number => {
            pf.circuitBreakers.resetAll();
            for (let i = 0; i < n; i++) {
                // Método privado invocado de propósito: é o ponto ÚNICO onde a classificação
                // acontece (`ProviderFactory`, sítio de recordFailure). Exercitá-lo direto testa a
                // regra sem precisar de rede, LLM ou provider de verdade — e é comportamento
                // observável, não formatação de código-fonte (a S165 quebrou por casar com
                // formatação; ver cabeçalho da S171).
                (pf as unknown as { registrarFalhaSeForAvaria(p: string, m: string): void })
                    .registrarFalhaSeForAvaria(provider, 'erro sintético de teste');
            }
            return pf.circuitBreakers.getOrCreate({ name: provider }).getFailureCount();
        };

        console.log('\n=== S204-1 — leitura do registro distingue ausência de ilegibilidade ===');
        {
            apagarRegistro();
            assert(readLocalRuntimeRecord().kind === 'absent', 'sem arquivo → `absent`');

            escreverRegistro('{ isto não é json');
            assert(readLocalRuntimeRecord().kind === 'unreadable', 'JSON inválido → `unreadable`');

            escreverRegistro({ file: 'modelo.gguf' });
            assert(
                readLocalRuntimeRecord().kind === 'unreadable',
                'registro sem porta é inútil para casar com provider → `unreadable`',
            );

            escreverRegistro({ pid: PID_MORTO, file: 'modelo.gguf', port: PORTA_LOCAL });
            assert(readLocalRuntimeRecord().kind === 'record', 'registro válido → `record`');
        }

        console.log('\n=== S204-2 — ciclo de vida por porta ===');
        {
            escreverRegistro({ pid: process.pid, file: 'modelo.gguf', port: PORTA_LOCAL });
            assert(
                getLocalRuntimeLifecycle(PORTA_LOCAL) === 'em_execucao',
                'registro com PID vivo → `em_execucao`',
            );
            assert(
                getLocalRuntimeLifecycle(PORTA_LOCAL + 1) === 'nao_gerenciado',
                'porta diferente da registrada → `nao_gerenciado` (não herda o estado alheio)',
            );

            escreverRegistro({ pid: PID_MORTO, file: 'modelo.gguf', port: PORTA_LOCAL });
            assert(getLocalRuntimeLifecycle(PORTA_LOCAL) === 'parado', 'registro com PID morto → `parado`');

            escreverRegistro({ file: 'modelo.gguf', port: PORTA_LOCAL });
            assert(
                getLocalRuntimeLifecycle(PORTA_LOCAL) === 'indeterminado',
                'registro sem PID → `indeterminado`, nunca um palpite',
            );

            escreverRegistro('{ quebrado');
            assert(getLocalRuntimeLifecycle(PORTA_LOCAL) === 'indeterminado', 'registro ilegível → `indeterminado`');
        }

        console.log('\n=== S204-3 — parado_por_decisao NÃO alimenta o circuito ===');
        {
            escreverRegistro({ pid: PID_MORTO, file: 'modelo.gguf', port: PORTA_LOCAL });
            const pf = novaFactory();
            const falhas = falhasApos(pf, 'Modelo local', 10);
            assert(
                falhas === 0,
                'runtime declarado e desligado: 10 falhas, contador em zero (era o defeito das 72)',
                falhas,
            );
            assert(
                pf.circuitBreakers.getOrCreate({ name: 'Modelo local' }).getState() === 'CLOSED',
                'e o circuito permanece fechado — desligar não é avariar',
            );
        }

        console.log('\n=== S204-4 — avariado ALIMENTA o circuito ===');
        {
            escreverRegistro({ pid: process.pid, file: 'modelo.gguf', port: PORTA_LOCAL });
            const pf = novaFactory();
            const falhas = falhasApos(pf, 'Modelo local', 3);
            assert(
                falhas === 3,
                'runtime de pé que falha É avaria — sem isto o circuit breaker viraria decoração',
                falhas,
            );
        }

        console.log('\n=== S204-5 — indeterminado NÃO alimenta o circuito ===');
        {
            escreverRegistro('{ ilegível');
            const pf = novaFactory();
            const falhas = falhasApos(pf, 'Modelo local', 5);
            assert(
                falhas === 0,
                'sinal ilegível não vira acusação de avaria (`NUNCA_ADIVINHAR`)',
                falhas,
            );
        }

        console.log(`\nS204 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
        console.log(`\nCOBERTURA:`);
        console.log(`  Ausência × ilegibilidade do registro distinguidas: testado`);
        console.log(`  Ciclo de vida por porta (em_execucao/parado/indeterminado/nao_gerenciado): testado`);
        console.log(`  parado_por_decisao não incrementa o circuito: testado`);
        console.log(`  avariado incrementa o circuito: testado`);
        console.log(`  indeterminado não incrementa o circuito: testado`);
    } finally {
        process.chdir(cwdOriginal);
        fs.rmSync(tmp, { recursive: true, force: true });
    }

    if (failed > 0) process.exit(1);
}

main().catch(err => { console.error('Erro inesperado:', err); process.exit(1); });
