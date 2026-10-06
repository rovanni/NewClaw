/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S341 (issue 062)
 *
 * `read` anexava a todo arquivo < 50 bytes: "⚠️ [CONTEÚDO SUSPEITO] Arquivo tem apenas N bytes (L linha(s)). O conteúdo pode
 * ser um placeholder. Verifique se o objetivo foi escrito corretamente antes de usar este conteúdo." — julgamento
 * semântico ("é placeholder?") decidido por tamanho, e com contagem de linhas errada (quebra final contada como linha).
 * 06/10/2026, goal_1791309487406_o2k8y (teste pelo painel): lista legítima de 3 itens, 44 bytes, lida com o aviso
 * "(5 linha(s))"; o modelo respondeu "4". Agora o conteúdo vai sem a interpretação; arquivo vazio continua erro.
 *
 * REGRESSÃO SE: arquivo pequeno legítimo voltar a vir com aviso de placeholder; arquivo vazio deixar de ser erro;
 * a contagem de linhas voltar a contar a quebra final (LF ou CRLF).
 *
 * Execução: npx ts-node src/__tests__/regression/S341_ReadTool_SmallFileIsNotPlaceholder.test.ts
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ReadTool } from '../../tools/read_tool';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}

async function main(): Promise<void> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's341-'));
    const tool = new ReadTool();
    const lines: string[] = [];
    const capture = (fn: () => Promise<unknown>) => {
        const orig = process.stdout.write.bind(process.stdout);
        (process.stdout.write as unknown) = (chunk: unknown): boolean => { lines.push(String(chunk)); return true; };
        return fn().finally(() => { process.stdout.write = orig; });
    };
    try {
        console.log('\n=== S341-1 — arquivo pequeno legítimo: conteúdo inteiro, sem aviso de placeholder ===');
        const lista = path.join(dir, 'lista_compras.txt');
        fs.writeFileSync(lista, 'Lista de compras:\n- arroz\n- feijão\n- café\n', 'utf-8');
        const r = await tool.execute({ path: lista });
        assert(r.success === true, 'leitura ok');
        assert(r.output.includes('- arroz') && r.output.includes('- café'), 'conteúdo presente');
        assert(!/CONTEÚDO SUSPEITO|placeholder/i.test(r.output), 'sem aviso de placeholder', r.output);

        console.log('\n=== S341-2 — arquivo vazio continua erro estrutural ===');
        const vazio = path.join(dir, 'vazio.txt');
        fs.writeFileSync(vazio, '');
        const e = await tool.execute({ path: vazio });
        assert(e.success === false && /ARQUIVO VAZIO/.test(e.error ?? ''), 'vazio → erro [ARQUIVO VAZIO]', e);

        console.log('\n=== S341-3 — contagem de linhas não conta a quebra final (LF e CRLF) ===');
        const crlf = path.join(dir, 'crlf.txt');
        fs.writeFileSync(crlf, 'a\r\nb\r\nc\r\n');
        const semFinal = path.join(dir, 'semfinal.txt');
        fs.writeFileSync(semFinal, 'a\nb');
        await capture(async () => { await tool.execute({ path: lista }); await tool.execute({ path: crlf }); await tool.execute({ path: semFinal }); });
        const counts = lines.filter(l => l.includes('[READ-RESULT]')).map(l => (l.match(/lines=(\d+)/) ?? [])[1]);
        assert(JSON.stringify(counts) === '["4","3","2"]', 'lista LF=4, CRLF=3, sem quebra final=2', { counts, lines });
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S341 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    if (failed > 0) process.exitCode = 1;
}
main().catch((err) => { console.error('S341 erro inesperado:', err); process.exitCode = 1; });
