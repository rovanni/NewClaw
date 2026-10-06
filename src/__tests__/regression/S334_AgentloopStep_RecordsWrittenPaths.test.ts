/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S334 (issue 057, Sprint G3)
 *
 * Steps agentloop não registravam os arquivos que gravavam: na validação real do F3 (05/10/2026) o
 * StepSemanticValidator recebia "Ferramentas chamadas: read, write" mas nenhum arquivo. O GoalExecutionLoop passa a
 * extrair do trace do sub-turno os caminhos gravados com sucesso (write/edit) em `subToolWrites` — campo SEPARADO de
 * `producedArtifactPaths`, que decide qual arquivo enviar.
 *
 * Execução: npx ts-node src/__tests__/regression/S334_AgentloopStep_RecordsWrittenPaths.test.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { writesFromTrace } from '../../loop/GoalExecutionLoop';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}
const call = (tool: string, input: Record<string, unknown>) => ({ type: 'tool_call', data: { tool, input } });
const result = (tool: string, success: boolean) => ({ type: 'tool_result', data: { tool, success } });

console.log('\n=== S334-1 — writesFromTrace ===');
{
    const steps = [
        call('read', { path: 'notas_aula.md' }), result('read', true),
        call('write', { path: 'resumo_seguranca.md', content: '...' }), result('write', true),
        call('write', { path: 'falhou.md' }), result('write', false),
        call('edit', { file_path: 'aulas/aula_06.md' }), result('edit', true),
        call('exec_command', { command: 'echo x > y.txt' }), result('exec_command', true),
    ];
    assert(JSON.stringify(writesFromTrace(steps)) === '["resumo_seguranca.md","aulas/aula_06.md"]', 'só write/edit com SUCESSO, path ou file_path', writesFromTrace(steps));
    // Pareamento estrito: o resultado de write sem a chamada de write imediatamente antes não herda args de outra chamada.
    const desalinhado = [call('write', { path: 'a.md' }), call('read', { path: 'b.md' }), result('write', true)];
    assert(writesFromTrace(desalinhado).length === 0, 'chamada anterior de outra ferramenta → não atribui caminho');
    assert(writesFromTrace([]).length === 0, 'trace vazio → []');
    assert(writesFromTrace([call('write', {}), result('write', true)]).length === 0, 'sem path → ignorado');
}

console.log('\n=== S334-2 — estrutural: gravado no attempt, separado de producedArtifactPaths, lido pelo validador ===');
{
    const src = fs.readFileSync(path.join(__dirname, '../../loop/GoalExecutionLoop.ts'), 'utf-8');
    assert(/agentloopSubToolWrites = writesFromTrace\(relatedTrace\.steps\)/.test(src), 'extraído do trace do sub-turno');
    assert(/subToolWrites: agentloopSubToolWrites,/.test(src), 'gravado no attempt como subToolWrites');
    assert(!/producedArtifactPaths: agentloopSubToolWrites/.test(src) && !/producedArtifactPaths:.*subToolWrites/.test(src), 'NÃO alimenta producedArtifactPaths (decisão de envio intocada)');
    assert(/artifacts: lastAttempt\.producedArtifactPaths \?\? lastAttempt\.subToolWrites/.test(src), 'os fatos do validador usam subToolWrites quando não há producedArtifactPaths');
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S334 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;
