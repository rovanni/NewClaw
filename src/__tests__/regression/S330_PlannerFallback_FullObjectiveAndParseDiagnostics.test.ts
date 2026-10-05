/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S330 (issue 056, Sprints F1 e F2)
 *
 * Validação real de 05/10/2026 (modelo local): o planejador devolveu plano completo e plano mínimo, os dois
 * descartados como "vazios" sem motivo no log (o parse engolia o erro); o goal caiu no plano direto, cuja
 * tarefa levava o pedido CORTADO em 100 chars ("...pasta aulas/ do workspace: u"); o modelo fez só a parte que
 * estava na tarefa (listar e ler), não gravou o arquivo pedido, e o goal foi dado como concluído.
 *
 * F1: o erro de JSON e o FIM da resposta passam a ir para o log. F2: o plano direto leva o pedido inteiro.
 *
 * Execução: npx ts-node src/__tests__/regression/S330_PlannerFallback_FullObjectiveAndParseDiagnostics.test.ts
 */
import { GoalPlanner } from '../../loop/GoalPlanner';
import type { Goal } from '../../loop/GoalTypes';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}

async function captureLogs<T>(fn: () => Promise<T>): Promise<{ value: T; text: string }> {
    const lines: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    (process.stdout.write as unknown) = (chunk: string | Uint8Array): boolean => { lines.push(String(chunk)); return true; };
    try { return { value: await fn(), text: lines.join('').replace(/\x1b\[[0-9;]*m/g, '') }; } finally { process.stdout.write = orig; }
}

const PEDIDO = 'Analise as aulas que estão na pasta aulas/ do workspace: use exec_command para listar a pasta e depois exec_command para mostrar o conteúdo de cada arquivo, um comando por arquivo. Depois proponha a aula 06, seguindo o mesmo padrão, e grave em aulas/aula_06.md.';

async function main(): Promise<void> {
const planner = Object.create(GoalPlanner.prototype) as GoalPlanner;

console.log('\n=== S330-1 (F2) — o plano direto leva o pedido inteiro na tarefa da etapa ===');
{
    const plan = (planner as any).fallbackPlan({ objective: PEDIDO } as Goal);
    const desc: string = plan.steps[0].description;
    assert(PEDIDO.length > 100, 'pré-condição: pedido maior que o antigo corte de 100', PEDIDO.length);
    assert(desc === `Executar diretamente: ${PEDIDO}`, 'descrição = pedido completo', desc);
    assert(desc.includes('grave em aulas/aula_06.md'), 'a parte final do pedido (a entrega) está na tarefa');
    assert(plan.steps[0].id === 'step_direct' && plan.steps.length === 1, 'continua um único passo direto');
}

console.log('\n=== S330-2 (F1) — plano com JSON inválido: o motivo e o fim da resposta vão para o log ===');
{
    const raw = '{"steps":[{"id":"step_1","description":"Listar a pasta","toolName":"exec_command"}],"strategy":"x"}\n\nObservação: o plano acima cobre tudo.';
    const { value, text } = await captureLogs(() => (planner as any).parsePlanResponse(raw));
    assert((value as { steps: unknown[] }).steps.length === 0, 'resultado continua vazio (comportamento de decisão inalterado)');
    assert(text.includes('plan JSON inválido'), 'o descarte é registrado', text.slice(0, 200));
    assert(/Unexpected|JSON/i.test(text), 'com o motivo do parse', text.slice(0, 300));
    assert(text.includes('o plano acima cobre tudo'), 'com o FIM da resposta (onde estava o texto extra)', text.slice(0, 400));
    assert(text.includes(`chars=${raw.length}`), 'com o tamanho da resposta');
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S330 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;
}

main().catch((err) => { console.error('S330 erro inesperado:', err); process.exitCode = 1; });
