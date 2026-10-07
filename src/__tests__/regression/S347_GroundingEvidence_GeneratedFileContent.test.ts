/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S347 (issue 065e)
 *
 * Produção, 06/10/2026, goal ENADE: a etapa 2 (agente) gravou questoes_enade.md (38 KB) por um `write` interno; a
 * etapa 4 respondeu descrevendo o arquivo, e o juiz de grounding REJEITOU "o banco contempla Máquina de Turing" — o
 * arquivo tinha 8 menções a Turing, mas o juiz não o recebeu: a evidência de etapas anteriores levava só as saídas
 * guardadas dos attempts (cortadas — o `read` do arquivo tinha 300 chars) e a etapa do agente só deixa o caminho do
 * arquivo (`subToolWrites`). Agora a evidência inclui o CONTEÚDO ATUAL dos arquivos produzidos, lido do disco, e o
 * validador de conclusão (FIX D) usa a mesma fonte de caminhos.
 *
 * REGRESSÃO SE: arquivo gravado dentro de uma etapa do agente deixar de entrar na evidência; o conteúdo voltar a ser
 * cortado na origem; binário virar texto ilegível; arquivo ausente virar conteúdo inventado.
 *
 * Execução: npx ts-node src/__tests__/regression/S347_GroundingEvidence_GeneratedFileContent.test.ts
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GoalExecutionLoop } from '../../loop/GoalExecutionLoop';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}
const att = (toolName: string, extra: Record<string, unknown> = {}) => ({ id: `a_${toolName}`, planStepId: 's', toolName, args: {}, result: 'success', durationMs: 1, executedAt: 0, ...extra } as any);

console.log('\n=== S347-1 — fonte única dos arquivos produzidos ===');
{
    const paths = GoalExecutionLoop.producedArtifactPaths([
        att('write', { args: { path: 'notas.md' } }),
        att('edit', { args: { file_path: 'notas.md' } }),
        att('agentloop', { subToolWrites: ['questoes_enade.md', 'gerar.py'] }),
        att('write', { args: { path: 'falhou.md' }, result: 'failure' }),
        att('read', { args: { path: 'lido.md' } }),
    ]);
    assert(JSON.stringify(paths) === JSON.stringify(['notas.md', 'questoes_enade.md', 'gerar.py']),
        'write/edit diretos + gravados dentro da etapa do agente; sem duplicata, sem falha, sem leitura', paths);
}

console.log('\n=== S347-2 — conteúdo atual do disco: texto inteiro, binário como fato, ausente fora ===');
{
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's347-'));
    try {
        const md = path.join(dir, 'questoes_enade.md');
        const conteudo = '# Banco de questões\n' + 'Questão sobre autômatos.\n'.repeat(1500) + 'Questão 18: o problema da parada — máquina de Turing.\n';
        fs.writeFileSync(md, conteudo, 'utf-8');
        const bin = path.join(dir, 'aula.pptx');
        fs.writeFileSync(bin, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x14]));
        const ev = GoalExecutionLoop.artifactContentEvidence([md, bin, path.join(dir, 'nao_existe.md')]);
        assert(ev.length === 2, 'dois arquivos existentes → duas evidências; o ausente fica de fora', ev.map(e => e.input));
        assert(ev[0].output === conteudo && conteudo.length > 30_000 && /máquina de Turing/.test(ev[0].output),
            `texto inteiro (${conteudo.length} chars), sem corte na origem — o fim do arquivo chega ao juiz`);
        assert(ev[0].tool === 'arquivo_gerado' && ev[0].input === JSON.stringify({ path: md }), 'rotulada como arquivo gerado, com o caminho');
        assert(/^\[arquivo binário, 7 bytes/.test(ev[1].output), 'binário entra como fato de existência e tamanho, não como texto ilegível', ev[1].output);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

console.log('\n=== S347-3 — os dois consumidores usam a mesma fonte ===');
{
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'loop', 'GoalExecutionLoop.ts'), 'utf-8');
    assert(/const writtenPaths = GoalExecutionLoop\.producedArtifactPaths\(goal\.attempts\);/.test(src), 'validador de conclusão (FIX D) usa producedArtifactPaths');
    assert(/GoalExecutionLoop\.artifactContentEvidence\(GoalExecutionLoop\.producedArtifactPaths\(priorAttempts\)\)/.test(src), 'evidência do juiz inclui o conteúdo dos arquivos produzidos');
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S347 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;
