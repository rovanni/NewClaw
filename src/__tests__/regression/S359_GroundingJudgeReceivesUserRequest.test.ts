/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S359 (Sprint V3 do princípio "Informação Completa para Decidir", 08/10/2026)
 *
 * O juiz de grounding julgava a resposta sem o pedido do usuário. A instrução dizia "o que vem do pedido do usuário,
 * não inclua" — o juiz tinha de adivinhar o que veio do pedido sem ter o pedido. Experimento de 07/10 (caso
 * r2-contexto-do-pedido): bloqueou uma resposta correta que citava o curso informado pelo usuário.
 *
 * REGRESSÃO SE: o pedido deixar de chegar ao juiz (julgamento inicial ou revalidação parcial), virar EVIDÊNCIA, ou
 * deixar de contar no orçamento do prompt.
 *
 * Execução: npx ts-node src/__tests__/regression/S359_GroundingJudgeReceivesUserRequest.test.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { ObserverValidator } from '../../loop/ObserverValidator';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}
const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
    const orig = process.stdout.write.bind(process.stdout);
    (process.stdout.write as unknown) = (): boolean => true;
    try { return await fn(); } finally { process.stdout.write = orig; }
};
function juiz(prompts: string[]) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getBudgetAuxiliar } = require('../../shared/auxTimeout');
    const f = {
        chatWithFallback: async (msgs: Array<{ content: string }>) => { prompts.push(msgs[0].content); return { status: 'success', content: '{"claims":[]}', attempts: [] }; },
        getBudgetAuxiliar: (p: 'classificacao' | 'validacao') => getBudgetAuxiliar(p, null, null),
    } as any;
    return new ObserverValidator(f, 'm');
}

const PEDIDO = 'Crie a apresentação da aula para o curso Instalador e Reparador de Redes de Computadores';
const EV = [{ id: 'E1', tool: 'exec_command', output: 'Apresentação salva: aula_eletricidade.pptx (19 slides)' }];
const RESPOSTA = 'Como você pediu, a aula é para o curso Instalador e Reparador de Redes de Computadores. Gerei aula_eletricidade.pptx com 19 slides.';

async function main(): Promise<void> {
    console.log('\n=== S359-1 — o juiz recebe o pedido, como contexto ===');
    const prompts: string[] = [];
    await quiet(() => juiz(prompts).validateGrounding(RESPOSTA, EV, undefined, { phase: 'initial', userRequest: PEDIDO }));
    const p = prompts[0] ?? '';
    assert(p.includes(`PEDIDO DO USUÁRIO (contexto — NÃO é evidência de ferramenta`) && p.includes(PEDIDO), 'seção de contexto com o pedido íntegro');
    assert(p.indexOf('PEDIDO DO USUÁRIO') < p.indexOf('EVIDÊNCIAS:'), 'o pedido fica fora do bloco de evidências');
    const blocoEvid = p.slice(p.indexOf('EVIDÊNCIAS:'), p.indexOf('RESPOSTA:'));
    assert(!blocoEvid.includes(PEDIDO) && !/\[U1\]|pedido_do_usuario/.test(blocoEvid), 'o pedido NÃO é evidência');
    assert(/o que a resposta só repete\s*do PEDIDO DO USUÁRIO/.test(p), 'a instrução aponta para o pedido recebido, em vez de pedir que o juiz adivinhe');

    console.log('\n=== S359-2 — sem pedido conhecido, o prompt declara a ausência ===');
    const p2: string[] = [];
    await quiet(() => juiz(p2).validateGrounding(RESPOSTA, EV, undefined, { phase: 'initial' }));
    assert(/PEDIDO DO USUÁRIO[^\n]*\n"""\n\(não informado\)\n"""/.test(p2[0] ?? ''), 'pedido ausente → "(não informado)" — nunca um placeholder cru');
    assert(!(p2[0] ?? '').includes('{pedido}'), 'nenhum {pedido} sobra no prompt');

    console.log('\n=== S359-3 — o pedido conta no orçamento do prompt ===');
    const evGrande = [{ id: 'E1', tool: 'arquivo_gerado', output: 'x'.repeat(70_000) }];
    const semPedido = ObserverValidator.evidenceCapForBudget('resposta', evGrande);
    const comPedido = ObserverValidator.evidenceCapForBudget('resposta', evGrande, 'p'.repeat(10_000));
    assert(Number.isFinite(semPedido) && comPedido < semPedido, `pedido de 10 mil chars reduz o espaço da evidência (${semPedido} → ${comPedido})`);

    console.log('\n=== S359-4 — a revalidação da resposta parcial também recebe o pedido ===');
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'loop', 'AgentLoop.ts'), 'utf-8');
    assert(/validateGrounding\(text, evidences, signal, \{ phase: 'partial-revalidation', userRequest: userText \}\)/.test(src), 'AgentLoop passa userText na revalidação parcial');
    assert(/validateGrounding\(response, evidences, signal, \{[^}]*userRequest: userText/.test(src), 'AgentLoop passa userText no julgamento inicial');

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S359 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    if (failed > 0) process.exitCode = 1;
}
main().catch((err) => { console.error('S359 erro inesperado:', err); process.exitCode = 1; });
