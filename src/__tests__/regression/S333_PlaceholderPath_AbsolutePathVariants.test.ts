/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S333 (issue 057, Sprint G2)
 *
 * Validação real de 05/10/2026 (modelo local): `read` em "/caminho_absoluto_workspace/aulas/aula_06.md" — um
 * caminho-exemplo — passou pelo padrão de placeholder e só falhou como "arquivo não encontrado", sem a mensagem
 * que diz ao modelo que aquilo é um placeholder. O padrão único (shared/placeholderPatterns, usado por read, write e
 * planejador) ganha as variantes de "caminho absoluto/completo", sem pegar nomes de arquivo legítimos.
 *
 * Execução: npx ts-node src/__tests__/regression/S333_PlaceholderPath_AbsolutePathVariants.test.ts
 */
process.env.WORKSPACE_DIR = process.env.WORKSPACE_DIR || require('path').join(require('os').tmpdir(), 's333-workspace');
import { PLACEHOLDER_ARG_PATTERN } from '../../shared/placeholderPatterns';
import { ReadTool } from '../../tools/read_tool';

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

async function main(): Promise<void> {

console.log('\n=== S333-1 — variantes de caminho-exemplo reconhecidas ===');
for (const p of ['/caminho_absoluto_workspace/aulas/aula_06.md', 'C:/caminho_completo/arquivo.txt', '/absolute_path/to/x', 'full_path/doc.md', 'path_absoluto/a.md']) {
    assert(PLACEHOLDER_ARG_PATTERN.test(p), `placeholder: ${p}`);
}

console.log('\n=== S333-2 — nomes legítimos NÃO viram placeholder ===');
for (const p of ['aulas/aula_06.md', 'docs/caminhos_absolutos.md', 'fullpath.txt', 'tmp/absolutepath_notes.md', 'relatorio_completo.md', 'scripts/full_paths.py', 'C:/Users/lucia/workspace/resumo.md']) {
    assert(!PLACEHOLDER_ARG_PATTERN.test(p), `legítimo: ${p}`);
}

console.log('\n=== S333-3 — padrões antigos continuam ===');
for (const p of ['/path/to/file', '<arquivo>.txt', '{output_step_1}', 'nome_do_arquivo']) {
    assert(PLACEHOLDER_ARG_PATTERN.test(p), `continua: ${p}`);
}

console.log('\n=== S333-4 — o read real devolve a mensagem de placeholder para o caso de 05/10 ===');
{
    const r = await quiet(() => new ReadTool().execute({ path: '/caminho_absoluto_workspace/aulas/aula_06.md' }));
    assert(r.success === false && String(r.error).startsWith('[PATH-PLACEHOLDER]'), 'erro [PATH-PLACEHOLDER], não "arquivo não encontrado"', r);
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S333 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;
}

main().catch((err) => { console.error('S333 erro inesperado:', err); process.exitCode = 1; });
