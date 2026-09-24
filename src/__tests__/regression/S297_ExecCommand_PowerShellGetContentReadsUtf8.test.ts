/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S297
 *
 * CONTEXTO (log de auditoria, 23/09/2026): o `Get-Content` de um arquivo UTF-8 sem BOM, executado
 * pelo wrapper do PowerShell 5.1, devolvia "# Consolidado das Aulas â€” OperaÃ§Ãµes" ao LLM. O
 * arquivo estava correto; a leitura decodificava como ANSI. Reproduzido com o wrapper real.
 *
 * REGRESSÃO SE: o wrapper deixar de fixar UTF-8 como padrão do Get-Content, ou passar a sobrepor
 * um `-Encoding` explícito do comando.
 *
 * Só executa no Windows (o wrapper só é aplicado lá); nas demais plataformas verifica apenas o texto.
 *
 * Execução: npx ts-node src/__tests__/regression/S297_ExecCommand_PowerShellGetContentReadsUtf8.test.ts
 */
import { exec } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { wrapForWindowsPowerShell } from '../../tools/exec_command';

let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string, detail?: unknown): void {
    if (cond) { console.log(`  OK ${msg}`); passed++; }
    else { console.error(`  FALHOU: ${msg}`, detail ?? ''); failed++; }
}

const run = (c: string) => new Promise<string>(resolve =>
    exec(wrapForWindowsPowerShell(c), (_e, out, err) => resolve(String(out) + String(err))));

async function main(): Promise<void> {
    const texto = '# Aula \u2014 Opera\u00e7\u00f5es';

    console.log('\n=== S297.1 — o wrapper fixa UTF-8 como padrão do Get-Content ===');
    const decoded = Buffer.from(wrapForWindowsPowerShell('x').split('-EncodedCommand ')[1], 'base64').toString('utf16le');
    assert(decoded.includes("$PSDefaultParameterValues['Get-Content:Encoding'] = 'UTF8'"), 'script embrulhado define o padrão', decoded);

    if (process.platform === 'win32') {
        const file = path.join(os.tmpdir(), `s297_${Date.now()}.md`);
        fs.writeFileSync(file, texto, 'utf8'); // sem BOM
        try {
            console.log('\n=== S297.2 — execução real: arquivo UTF-8 sem BOM volta com os acentos corretos ===');
            const out = (await run(`Get-Content '${file}'`)).trim();
            assert(out === texto, `saída idêntica ao arquivo (obtido: ${out})`);

            console.log('\n=== S297.3 — -Encoding explícito continua valendo (controle) ===');
            const out2 = (await run(`Get-Content -Encoding UTF8 '${file}'`)).trim();
            assert(out2 === texto, `-Encoding UTF8 explícito também correto (obtido: ${out2})`);
        } finally {
            try { fs.unlinkSync(file); } catch { /* ignore */ }
        }
    }

    console.log(`\nS297 RESULTADO: ${passed} passou | ${failed} falhou`);
    process.exit(failed > 0 ? 1 : 0);
}
main().catch(e => { console.error('ERRO NÃO TRATADO:', e); process.exit(1); });
