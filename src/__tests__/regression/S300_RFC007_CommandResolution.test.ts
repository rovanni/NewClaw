/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S300 (RFC-007)
 * Resolução de comando multi-candidato: o motor genérico devolve evidência factual
 * (quem funcionou, quem falhou), sem interpretar nem reescrever comandos.
 *
 *   1-5  → resolveWorkingCommand (short-circuit, exaustivo, nenhum, contrato)
 *   6-7  → o fato "python funciona / python3 inválido" chega ao texto do Planner
 *          (PromptComposer.buildCompactEnv), sem ordem nem reescrita
 *
 * Execução: npx ts-node src/__tests__/regression/S300_RFC007_CommandResolution.test.ts
 */
process.env.WORKSPACE_DIR = process.env.WORKSPACE_DIR || 'D:/IA/newclaw/workspace';

import { CommandCandidate, resolveWorkingCommand, commandCandidateLabel } from '../../utils/crossPlatform';
import { PromptComposer } from '../../core/PromptComposer';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}
const cand = (command: string, ...argsPrefix: string[]): CommandCandidate => ({ command, argsPrefix });
const winCandidates = [cand('py', '-3'), cand('python'), cand('python3')];
const fake = (ok: Set<string>) => {
    const calls: string[] = [];
    return { calls, probe: async (c: CommandCandidate) => { calls.push(c.command); return ok.has(c.command); } };
};

async function main(): Promise<void> {
    console.log('\n=== S300-1 — short-circuit: só testados até o vencedor ===');
    {
        const { probe, calls } = fake(new Set(['python']));
        const r = await resolveWorkingCommand(winCandidates, probe);
        assert(r.resolved?.command === 'python', 'python resolvido', r.resolved);
        assert(JSON.stringify(calls) === '["py","python"]', 'python3 não testado (sem veredito inventado)', calls);
        assert(r.tested.length === 2 && r.tested[0].ok === false && r.tested[1].ok === true, 'tested = [py falhou, python ok]', r.tested);
    }
    console.log('\n=== S300-2 — exaustivo: veredito de todos os nomes; resolved segue a ordem ===');
    {
        const { probe, calls } = fake(new Set(['python']));
        const r = await resolveWorkingCommand(winCandidates, probe, { exhaustive: true });
        assert(calls.length === 3, 'todos testados', calls);
        assert(r.resolved?.command === 'python', 'resolved = primeiro válido na ordem', r.resolved);
        assert(r.tested.find(t => t.candidate.command === 'python3')?.ok === false, 'python3 registrado como falho', r.tested);
    }
    console.log('\n=== S300-3 — controle negativo: nenhum funciona → null ===');
    {
        const r = await resolveWorkingCommand(winCandidates, fake(new Set()).probe, { exhaustive: true });
        assert(r.resolved === null && r.tested.every(t => !t.ok), 'null e todos falhos', r);
    }
    console.log('\n=== S300-4 — contrato genérico: candidato não-Python, rótulo com argsPrefix ===');
    {
        const r = await resolveWorkingCommand([cand('bash')], async () => true);
        assert(r.resolved?.command === 'bash', 'motor não é específico de Python', r);
        assert(commandCandidateLabel(cand('py', '-3')) === 'py -3', 'rótulo py -3', null);
    }
    console.log('\n=== S300-5 — Linux: python3 falha, python funciona ===');
    {
        const r = await resolveWorkingCommand([cand('python3'), cand('python')], fake(new Set(['python'])).probe);
        assert(r.resolved?.command === 'python', 'fallback funciona', r.resolved);
    }
    console.log('\n=== S300-6/7 — texto ao Planner: fato, não ordem ===');
    {
        const ctx = [
            '[CAPACIDADES DO AMBIENTE — detectadas automaticamente]',
            '• Ferramentas: node, python',
            '• Indisponíveis (não usar): python3',
            '• Comando validado (python3): python | falharam: py -3, python3',
        ].join('\n');
        const env = PromptComposer.buildCompactEnv(ctx, 'criar apresentação pptx');
        assert(/commands_validated:/.test(env), 'bloco commands_validated presente', env);
        assert(/python3: python \| failed: py -3, python3/.test(env), 'nome validado e candidatos falhos entregues', env);
        const factLine = env.split('commands_validated:')[1].split('\n')[1] ?? '';
        assert(!/(NÃO use|não use|substitu|reescrev)/i.test(factLine), 'sem ordem nem reescrita no fato', factLine);
        assert(/blocked: \[python3\]/.test(env), 'blocked continua factual', env);
        const none = PromptComposer.buildCompactEnv('• Ferramentas: node', 'x');
        assert(!/commands_validated/.test(none), 'sem evidência → sem bloco (controle negativo)', none);
    }
    console.log(`\nS300 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    if (failed > 0) process.exitCode = 1;
}
main().catch(e => { console.error(e); process.exitCode = 1; });
