/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S486 (os outros leitores de processo filho também leem na página MEDIDA do console)
 *
 * Origem: revisão do PR #59 (S484, 17/11/2026). O exec_command passou a ler a saída na página medida, mas dois leitores do painel
 * continuavam lendo tudo como UTF-8, pedaço por pedaço:
 *  - `dashboard/routes/maintenance.ts`: a atualização pelo painel roda `bin/newclaw update restart`, que repassa (stdio: inherit)
 *    a saída de git, npm e, no Windows, do update.ps1 — este escreve na página do console;
 *  - `dashboard/integracoesOpcionais/dependencias.ts`: o instalador de integrações roda tar.exe, git, npm e scripts.
 * Além da página, decodificar cada pedaço do pipe sozinho estraga um caractere de vários bytes cortado entre dois pedaços.
 * (`core/DirectoryPickerService.ts` não muda: o script dele já força `[Console]::OutputEncoding = UTF8`.)
 *
 * O que é real aqui: o leitor por linhas com pedaços cortados de propósito, o `dependenciasReais().executar/acompanhar`
 * rodando o cmd.exe de verdade com a página medida, e o controle sem a medição.
 *
 * Execução: npx ts-node src/__tests__/regression/S486_LeitoresDeProcessoNaPaginaMedida.test.ts
 */
import * as fs from 'fs';
import * as path from 'path';

/* eslint-disable @typescript-eslint/no-var-requires */
const amb = require('../../shared/ambienteDeExecucao') as typeof import('../../shared/ambienteDeExecucao');
const deps = require('../../dashboard/integracoesOpcionais/dependencias') as typeof import('../../dashboard/integracoesOpcionais/dependencias');
/* eslint-enable @typescript-eslint/no-var-requires */

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

async function main(): Promise<void> {
    console.log('\n=== S486-1 — leitor por linhas: pedaço cortado no meio do caractere ===');
    // Tabela de teste (dados, não a do sistema): 0x87 → 'ç', 0xC6 → 'ã'; o resto, '?'.
    const altos = Array.from({ length: 128 }, (_, k) => ({ 0x07: 'ç', 0x46: 'ã' } as Record<number, string>)[k] ?? '?').join('');
    const pagina = { codigo: 850, altos };
    const utf8 = Buffer.from('Computação ok\r\nfim', 'utf8');
    const corte = utf8.indexOf(0xA7);   // segundo byte de "ç" (C3 A7): o pedaço termina no meio do caractere
    const leitor = amb.leitorDeSaidaDoConsole(pagina);
    const lido = leitor.ler(utf8.subarray(0, corte)) + leitor.ler(utf8.subarray(corte)) + leitor.terminar();
    assert(lido === 'Computação ok\r\nfim', 'UTF-8 cortado entre dois pedaços sai inteiro', lido);
    const antigo = utf8.subarray(0, corte).toString('utf8') + utf8.subarray(corte).toString('utf8');
    assert(antigo.includes('�'), 'controle: decodificar cada pedaço sozinho (o código antigo) estraga o caractere', antigo);

    const legado = Buffer.from([0x6E, 0xC6, 0x6F, 0x0A, 0x61, 0x87, 0xC6, 0x6F]);   // "não\naçao" na página de teste
    const l2 = amb.leitorDeSaidaDoConsole(pagina);
    const p1 = l2.ler(legado.subarray(0, 2));
    assert(p1 === '', 'sem quebra de linha ainda: nada sai (os bytes esperam)', p1);
    const p2 = l2.ler(legado.subarray(2));
    assert(p2 === 'não\n', 'linha inteira da página sai pela tabela', p2);
    const resto = l2.terminar();
    assert(resto === 'ação', 'terminar devolve o resto sem quebra de linha', resto);
    const l3 = amb.leitorDeSaidaDoConsole(pagina);
    assert(l3.ler(Buffer.from('a\rb', 'utf8')) === 'a\r' && l3.terminar() === 'b', '\\r também fecha um trecho (progresso sem \\n não fica preso)');
    const l4 = amb.leitorDeSaidaDoConsole(undefined);
    assert(l4.ler(Buffer.from([0x6E, 0xC6, 0x6F, 0x0A])) === Buffer.from([0x6E, 0xC6, 0x6F, 0x0A]).toString('utf8'), 'sem página medida: UTF-8 de sempre, nenhuma tabela adivinhada');

    console.log('\n=== S486-2 — os leitores usam a leitura medida (sem toString por pedaço) ===');
    const raiz = path.join(__dirname, '../..');
    const manutencao = fs.readFileSync(path.join(raiz, 'dashboard/routes/maintenance.ts'), 'utf-8');
    const dependencias = fs.readFileSync(path.join(raiz, 'dashboard/integracoesOpcionais/dependencias.ts'), 'utf-8');
    assert(!/\.on\('data', \(d: Buffer\) => [^\n]*d\.toString\(\)/.test(manutencao), 'maintenance.ts: nenhum pedaço decodificado sozinho como UTF-8');
    assert(/leitorDeSaidaDoConsole\(\)/.test(manutencao) && /decodificarSaidaDoConsole\(Buffer\.concat/.test(manutencao), 'maintenance.ts: log ao vivo por linhas e resposta do CLI inteira, na página medida');
    assert(!/pedaco\.toString\('utf-8'\)/.test(dependencias) && /leitorDeSaidaDoConsole\(\)/.test(dependencias), 'dependencias.ts: leitor medido por fluxo');

    console.log('\n=== S486-3 — instalador de integrações rodando o cmd.exe de verdade ===');
    if (process.platform !== 'win32') {
        console.log('  (fora do Windows: a saída é UTF-8 e a página não é medida — caso real só no Windows)');
        assert(await amb.medirPaginaDoConsole() === undefined, 'nesta máquina: página não medida, leitura UTF-8');
    } else {
        const medida = await amb.medirPaginaDoConsole();
        console.log(`  (página medida: ${medida?.codigo})`);
        // Acentos que a página medida tem (CI em inglês usa a 437, sem "ã"), separados por espaço — ver S484-3.
        const acentos = medida?.altos ? ['ç', 'é', 'á', 'ã', 'õ', 'ê', 'ü', 'ñ'].filter(c => medida.altos!.includes(c)) : [];
        if (acentos.length < 2) {
            assert(medida?.codigo === 65001 || !medida?.altos, 'sem acentos comuns na página: só aceitável se ela for UTF-8 ou sem tabela', medida);
        } else {
            amb.registrarAmbiente({ ...amb.fatosBasicos(), paginaDoConsole: medida });
            const d = deps.dependenciasReais('http://127.0.0.1:1');
            const esperado = `texto ${acentos.join(' ')} fim`;
            const r = await d.executar('cmd.exe', ['/d', '/c', 'echo', 'texto', ...acentos, 'fim'], process.cwd());
            assert(r.codigo === 0 && r.saida.trim() === esperado, 'executar: saída do cmd com acentos corretos', r.saida);
            const linhas: string[] = [];
            const codigo = await d.acompanhar('cmd.exe', ['/d', '/c', 'echo', 'um', ...acentos, '&', 'echo', 'dois', '1>&2'], process.cwd(), l => linhas.push(l));
            assert(codigo === 0 && linhas.some(l => l.trim() === `um ${acentos.join(' ')}`), 'acompanhar: linha do stdout inteira e correta', linhas);
            assert(linhas.some(l => l.trim() === 'dois'), 'acompanhar: linha do stderr chega pelo seu próprio fluxo', linhas);
            const erro = await d.executar('cmd.exe', ['/d', '/c', 'dir', path.join(raiz, 'nao-existe-s486')], process.cwd());
            assert(erro.codigo !== 0 && !(erro.saida + erro.erro).includes('�'), 'mensagem de erro do cmd (no idioma do sistema) sem "�"', erro.erro || erro.saida);

            // Controle: sem a medição, a MESMA saída volta quebrada — o teste detecta o defeito antigo.
            amb.registrarAmbiente({ ...amb.fatosBasicos() });
            const semMedida = await d.executar('cmd.exe', ['/d', '/c', 'echo', ...acentos], process.cwd());
            assert(semMedida.saida.includes('�'), 'controle: sem a página medida, os acentos voltam como "�"', semMedida.saida);
        }
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S486 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
    console.error('S486 erro inesperado:', err);
    process.exitCode = 1;
});
