/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S484 (a saída do exec_command é lida na página de código MEDIDA do console)
 *
 * Origem: produção Windows, 03–16/11/2026 — em 52 de 104 julgamentos do juiz contra a evidência a saída do exec_command tinha "�"
 * ("Teoria da Computa��o", "n�o tem nome"). O cmd.exe e os programas que ele chama escrevem no pipe na página do console (850
 * numa máquina pt-BR) e o Node lia tudo como UTF-8. O agente lia o texto quebrado e o juiz rebaixava citações corretas (15 das 20
 * que não conferiram), o que custava uma reescrita e um segundo julgamento.
 *
 * O que é real aqui: a medição (`chcp` nas condições do exec_command + a tradução dos bytes pedida ao próprio Windows) e o
 * `ExecCommandTool` rodando comandos de verdade no cmd.exe. Fora do Windows, a medição devolve "não medida" e a leitura continua
 * UTF-8 — conferido também.
 *
 * Execução: npx ts-node src/__tests__/regression/S484_SaidaDoConsoleNaPaginaMedida.test.ts
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 's484-'));
process.env.WORKSPACE_DIR = WS;

/* eslint-disable @typescript-eslint/no-var-requires */
const amb = require('../../shared/ambienteDeExecucao') as typeof import('../../shared/ambienteDeExecucao');
const exec = require('../../tools/exec_command') as typeof import('../../tools/exec_command');
/* eslint-enable @typescript-eslint/no-var-requires */

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

async function main(): Promise<void> {
    console.log('\n=== S484-1 — leitura byte a byte: UTF-8 fica, o resto vai pela tabela ===');
    // Tabela de teste (dados, não a do sistema): 0x87 → 'ç', 0xC6 → 'ã', 0xA0 → 'á'; o resto, '?'.
    const altos = Array.from({ length: 128 }, (_, k) => ({ 0x07: 'ç', 0x46: 'ã', 0x20: 'á' } as Record<number, string>)[k] ?? '?').join('');
    const pagina = { codigo: 850, altos };
    const legado = Buffer.from([0x6E, 0xC6, 0x6F, 0x20, 0x61, 0x87, 0xC6, 0x6F]);   // "não ação" em 850
    assert(amb.decodificarSaidaDoConsole(legado, pagina) === 'não ação', 'bytes da página viram os caracteres da tabela', amb.decodificarSaidaDoConsole(legado, pagina));
    const utf8 = Buffer.from('Computação — ok 🙂', 'utf8');
    assert(amb.decodificarSaidaDoConsole(utf8, pagina) === 'Computação — ok 🙂', 'UTF-8 bem formado fica intacto (inclusive 3 e 4 bytes)');
    const misto = Buffer.concat([legado, Buffer.from(' | ', 'utf8'), utf8]);
    assert(amb.decodificarSaidaDoConsole(misto, pagina) === 'não ação | Computação — ok 🙂', 'saída mista (cmd + Python) no mesmo fluxo: cada parte do seu jeito', amb.decodificarSaidaDoConsole(misto, pagina));
    assert(amb.decodificarSaidaDoConsole(legado, undefined) === legado.toString('utf8') && amb.decodificarSaidaDoConsole(legado, { codigo: 65001 }) === legado.toString('utf8'),
        'sem tabela medida (não medida, ou página UTF-8): leitura UTF-8 de sempre — nenhuma tabela adivinhada');
    assert(amb.decodificarSaidaDoConsole(legado, { codigo: 850, altos: 'curta' }) === legado.toString('utf8'), 'tabela com tamanho errado é ignorada');
    const cortado = Buffer.from([0x61, 0xE2, 0x80]);   // começo de "—" sem o último byte
    assert(amb.decodificarSaidaDoConsole(cortado, pagina) === 'a??', 'sequência UTF-8 incompleta no fim não vira caractere inventado (cada byte pela tabela)', amb.decodificarSaidaDoConsole(cortado, pagina));

    const comBom = Buffer.from('﻿olá', 'utf8');
    assert(amb.decodificarSaidaDoConsole(comBom, pagina) === comBom.toString('utf8'), 'atalho UTF-8 válido: mesmo texto do toString, BOM incluído');
    // Limite conhecido, preso aqui para não virar surpresa: bytes da página que por acaso formam UTF-8 válido são lidos como UTF-8.
    assert(amb.decodificarSaidaDoConsole(Buffer.from([0xE4, 0x88, 0x81]), pagina) === '䈁', 'limite documentado: E4 88 81 (em 850, "õêü" colados) é UTF-8 válido e fica "䈁"');
    const fonte = fs.readFileSync(path.join(__dirname, '../../tools/exec_command.ts'), 'utf-8');
    assert(/const pagina = isSsh \? undefined : fatosDoAmbiente\(\)\.paginaDoConsole/.test(fonte), 'ssh://: a saída de outra máquina não passa pela página do console local');

    console.log('\n=== S484-2 — medição real da página ===');
    const medida = await amb.medirPaginaDoConsole();
    assert(await amb.medirPaginaDoConsole('linux') === undefined, 'fora do Windows: não medida (undefined)');
    if (process.platform !== 'win32') {
        assert(medida === undefined, 'nesta máquina (não Windows): não medida, a leitura segue UTF-8', medida);
    } else {
        console.log(`  (página medida: ${medida?.codigo}; tabela: ${medida?.altos ? 'sim' : 'não'})`);
        assert(!!medida && Number.isInteger(medida.codigo), 'Windows: o chcp nas condições do exec_command responde um número', medida);
        if (medida && medida.codigo !== 65001) assert(medida.altos?.length === 128, 'página de 1 byte: a tradução dos 128 bytes altos foi pedida ao sistema', medida);

        console.log('\n=== S484-3 — execução real no cmd.exe ===');
        // Os acentos do teste saem da PÁGINA MEDIDA: o cmd.exe só consegue escrever o que a página dele tem (CI 17/11/2026, página
        // 437 em inglês: não existe "ã", e o próprio cmd escreve "nao" — fato do sistema, não da leitura).
        const candidatos = ['ç', 'é', 'á', 'ã', 'õ', 'ê', 'ü', 'ñ'];
        // Separados por espaço, como em palavras: colados, alguns bytes da página formam UTF-8 válido por acaso (em 850, "õêü" =
        // E4 88 81 = "䈁") — o limite documentado em decodificarSaidaDoConsole, coberto no caso abaixo.
        const acentos = medida?.altos ? candidatos.filter(c => medida.altos!.includes(c)).join(' ') : '';
        console.log(`  (acentos que a página ${medida?.codigo} tem, entre os do teste: "${acentos}")`);
        if (acentos.replace(/ /g, '').length < 2) {
            assert(medida?.codigo === 65001 || !medida?.altos, 'sem acentos comuns na página medida: só aceitável se a página for UTF-8 ou não tiver tabela', medida);
        } else {
            const tool = new exec.ExecCommandTool();
            amb.registrarAmbiente({ ...amb.fatosBasicos(), paginaDoConsole: medida });
            const pasta = path.join(WS, `pasta${acentos}`);
            fs.mkdirSync(pasta);
            fs.writeFileSync(path.join(pasta, `arquivo${acentos}.txt`), 'x');
            const eco = await tool.execute({ command: `echo texto ${acentos} fim`, shell: 'cmd' });
            assert(eco.success && eco.output.includes(`texto ${acentos} fim`) && !eco.output.includes('�'), 'echo do cmd: acentos corretos, sem "�"', eco.output);
            const dir = await tool.execute({ command: `dir /b "${pasta}"`, shell: 'cmd' });
            assert(dir.success && dir.output.trim() === `arquivo${acentos}.txt`, 'dir do cmd: nome de arquivo acentuado correto', dir.output);
            const erro = await tool.execute({ command: `dir "${path.join(WS, 'nao-existe')}"`, shell: 'cmd' });
            assert(!erro.success && !(erro.output + (erro.error ?? '')).includes('�'), 'mensagem de erro do cmd (no idioma do sistema) sem "�"', erro.output || erro.error);
            const py = await tool.execute({ command: `python -c "print('Computação ✓')" & echo ${acentos}`, shell: 'cmd' });
            if (py.success) assert(py.output.includes('Computação ✓') && py.output.includes(acentos), 'Python (UTF-8) e cmd (página) no mesmo comando: os dois corretos', py.output);
            else console.log('  (python não disponível nesta máquina — caso misto real não rodado)');

            // Controle: sem a medição, a MESMA saída volta quebrada — o teste detecta o defeito antigo.
            amb.registrarAmbiente({ ...amb.fatosBasicos() });
            const semMedida = await tool.execute({ command: `echo ${acentos}`, shell: 'cmd' });
            assert(semMedida.output.includes('�'), 'controle: sem a página medida, os acentos voltam como "�" (o defeito que este teste pega)', semMedida.output);
        }
    }

    fs.rmSync(WS, { recursive: true, force: true });
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S484 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
    console.error('S484 erro inesperado:', err);
    process.exitCode = 1;
});
