/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S221
 *
 * Origem: investigação do incidente "River" #2 (2026-08-11 19:21-19:24, goal
 * goal_1786486892822_kkfit — distinto do incidente River de 08/08/2026 já coberto por S215).
 * O log de auditoria real mostrava, em toda falha de GoalPlanner.plan()/replan() contra o
 * modelo offline:
 *
 *   [GoalPlanner] plan failed: model=gemma4:e4b-it-qat status=error raw=""
 *
 * `raw=""` sempre — a causa real (rede recusada? resposta malformada do llamafile? modelo não
 * carregado?) nunca sobrevivia ao log — tornando o problema #1 do relato do usuário ("por que o
 * modelo offline está falhando") impossível de diagnosticar sem reproduzir o incidente.
 *
 * Sprint 1 de 4 do plano de correção (S221-S224). ATUALIZADO após S222: a implementação original
 * desta sprint (try/catch em torno de um único provider fixo, logando `String(err)`) foi
 * SUBSTITUÍDA por S222, que trocou o mecanismo de chamada inteiro para `chatWithFallback` — a
 * mesma cadeia de resiliência multi-provider já usada pelo AgentLoop. A preocupação original desta
 * sprint continua válida (o erro real não pode mais ser descartado), só o mecanismo mudou: agora
 * é `chatWithFallback` quem relata o erro por tentativa (`attempts[].errorMessage`), e
 * `callPlannerLLM` loga o último antes de devolver `{status, content}`. Este teste foi reescrito
 * para verificar o mecanismo ATUAL, não o que existiu por uma sprint.
 *
 * Execução: npx ts-node src/__tests__/regression/S221_GoalPlanner_LogsRealProviderError.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { GoalPlanner } from '../../loop/GoalPlanner';
import type { LLMMessage, ProviderFactory } from '../../core/ProviderFactory';
import type { ReflectionMemory } from '../../memory/ReflectionMemory';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

async function main(): Promise<void> {

console.log('\n=== S221-1 — estrutural: callPlannerLLM loga o erro real de attempts[], não fica silencioso ===');
{
    const source = fs.readFileSync(path.join(__dirname, '../../loop/GoalPlanner.ts'), 'utf-8');
    const start = source.indexOf('private async callPlannerLLM');
    const end = source.indexOf('\n    }\n', start);
    assert(start > 0 && end > start, 'pré-condição: callPlannerLLM localizado no arquivo', { start, end });
    const body = source.slice(start, end);

    assert(/if \(result\.status !== 'success'\)/.test(body), 'callPlannerLLM verifica falha antes de retornar (não descarta silenciosamente)');
    assert(
        /log\.warn\(`\[GoalPlanner\] callPlannerLLM failed:[^`]*lastAttempt\?\.errorMessage/.test(body),
        'o log.warn interpola lastAttempt?.errorMessage (o erro real da última tentativa), não um texto fixo',
        body,
    );
}

console.log('\n=== S221-2 — funcional: o erro real de um provider que falha chega ao log ===');
{
    const MARKER = 'fake-test-marker-ECONNREFUSED-127.0.0.1';
    const fakeProviderFactory = {
        getProviderWithModel: () => {
            throw new Error('S221: callPlannerLLM não deve mais chamar getProviderWithModel diretamente (ver S222)');
        },
        chatWithFallback: async () => ({
            status: 'error',
            content: '',
            attempts: [{ provider: 'fake', model: 'fake', duration: 1, status: 'error' as const, errorMessage: MARKER }],
        }),
    } as unknown as ProviderFactory;
    const fakeReflectionMemory = {} as unknown as ReflectionMemory;

    const planner = new GoalPlanner(fakeProviderFactory, fakeReflectionMemory);
    planner.setModel('modelo-de-teste-offline');

    const chunks: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    (process.stdout as unknown as { write: typeof process.stdout.write }).write = ((chunk: unknown, ...rest: unknown[]) => {
        chunks.push(String(chunk));
        return (originalWrite as unknown as (...a: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stdout.write;

    let result: { status: string; content: string };
    try {
        const messages: LLMMessage[] = [{ role: 'user', content: 'teste' }];
        result = await (planner as unknown as { callPlannerLLM: (m: LLMMessage[], t: number) => Promise<{ status: string; content: string }> })
            .callPlannerLLM(messages, 5000);
    } finally {
        process.stdout.write = originalWrite;
    }

    const logged = chunks.join('');
    assert(result.status === 'error', 'contrato de retorno preservado: status=error (não muda comportamento de plan/replan)', result.status);
    assert(result.content === '', 'contrato de retorno preservado: content vazio em erro', result.content);
    assert(logged.includes(MARKER), 'a mensagem REAL do provider chega ao log — não mais raw="" sem explicação', logged.includes(MARKER) ? '(encontrado)' : logged.slice(-300));
    assert(logged.includes('modelo-de-teste-offline'), 'o log identifica QUAL modelo falhou');
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S221 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;

}

main().catch((err) => {
    console.error('S221 erro inesperado:', err);
    process.exitCode = 1;
});
