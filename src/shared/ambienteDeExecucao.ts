/**
 * O ambiente em que os comandos do agente rodam — MEDIDO, não escrito à mão — para quem decide (agente) e quem julga (juízes do
 * motor único) saberem se um comando, um caminho ou uma instalação servem a esta máquina.
 *
 * Origem (Telegram, 15/10/2026): o juiz de risco aprovou `py -3 -m pip install … 2>$null; py -3 script.py` (sintaxe de PowerShell)
 * num Windows em que o exec_command roda esse comando no cmd.exe; e o agente ouvia "shell: powershell" — um valor fixo no código.
 * Diretriz da usuária: nada de receita no código ("o 5.1 não aceita &&"), que envelhece quando as versões mudam. O código só sabe
 * PERGUNTAR: as consultas ficam em sondasDoAmbiente.json (dados, uma lista por sistema), um executor genérico as roda sem LLM, e
 * agente e juízes recebem as respostas — o modelo sabe o que cada versão aceita.
 *
 * A única frase que não é medição descreve a PRÓPRIA ferramenta (o exec_command encaminha ao powershell.exe o que tem cmdlet ou
 * utilitário Unix — tools/exec_command.ts, needsPowerShellWrap): o modelo não tem como medir isso. O S409 prende os dois.
 */
import os from 'os';
import { execFile, spawn } from 'child_process';
import SONDAS from './sondasDoAmbiente.json';

export interface Sonda { fato: string; comando: string; argumentos: string[] }

/**
 * A página de código em que os programas de console escrevem quando a saída vai para um pipe — o caso do exec_command. Medida
 * nas MESMAS condições do exec_command (shell do spawn, janela oculta). `altos`: os 128 caracteres dos bytes 0x80–0xFF, na
 * ordem, como o próprio sistema os traduz; ausente quando a página é UTF-8 (65001), tem mais de um byte por caractere, ou a
 * tradução não pôde ser pedida — aí ninguém adivinha a tabela.
 */
export interface PaginaDoConsole { codigo: number; altos?: string }

export interface FatosDoAmbiente {
    plataforma: NodeJS.Platform;
    /** Nome e versão do sistema como o Node os lê (os.version + os.release) — sem subprocesso. */
    versao?: string;
    arquitetura: string;
    /** O shell em que o exec_command roda um comando (o do child_process: ComSpec no Windows, /bin/sh resolvido no Unix). */
    shell: string;
    /** Respostas das consultas de sondasDoAmbiente.json: fato → primeira linha da resposta, ou "não disponível". */
    medidos?: Record<string, string>;
    gerenciadorDePacotes?: string;
    /** Só Windows, depois da medição (medirPaginaDoConsole). Ausente = não medida: a saída é lida como UTF-8, como sempre. */
    paginaDoConsole?: PaginaDoConsole;
}

const PRAZO_POR_SONDA_MS = 5000;
export const NAO_DISPONIVEL = 'não disponível';

/** As consultas deste sistema (vazio se não houver lista para ele). */
export function sondasPara(plataforma: NodeJS.Platform = process.platform): Sonda[] {
    return ((SONDAS as unknown as Record<string, Sonda[]>)[plataforma] ?? []).filter(s => s && s.fato && s.comando);
}

/** Roda uma consulta sem shell (execFile, argumentos em lista) e devolve a primeira linha não vazia da resposta. */
function rodarSonda(s: Sonda): Promise<string> {
    return new Promise(resolve => {
        execFile(s.comando, s.argumentos ?? [], { timeout: PRAZO_POR_SONDA_MS, windowsHide: true, encoding: 'utf8' }, (erro, stdout, stderr) => {
            if (erro) return resolve(NAO_DISPONIVEL);
            // Alguns programas respondem a versão no stderr (ex.: Python 2): vale o que veio.
            const linha = `${stdout ?? ''}\n${stderr ?? ''}`.split(/\r?\n/).map(l => l.trim()).find(Boolean);
            resolve(linha ? linha.slice(0, 200) : NAO_DISPONIVEL);
        });
    });
}

/** Executor genérico: roda todas as consultas do sistema em paralelo, cada uma com prazo. Nunca lança. */
export async function medirSondas(sondas: Sonda[] = sondasPara()): Promise<Record<string, string>> {
    const respostas = await Promise.all(sondas.map(async s => [s.fato, await rodarSonda(s)] as const));
    return Object.fromEntries(respostas);
}

/** Roda um comando como o exec_command roda (shell do spawn, janela oculta, entrada fechada) e devolve os bytes da saída. */
function bytesNoShellDoExec(comando: string): Promise<Buffer | undefined> {
    return new Promise(resolve => {
        let filho;
        try { filho = spawn(comando, { shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); } catch { return resolve(undefined); }
        const partes: Buffer[] = [];
        const prazo = setTimeout(() => { filho.kill(); resolve(undefined); }, PRAZO_POR_SONDA_MS);
        filho.stdout?.on('data', (b: Buffer) => partes.push(b));
        filho.on('error', () => { clearTimeout(prazo); resolve(undefined); });
        filho.on('close', code => { clearTimeout(prazo); resolve(code === 0 ? Buffer.concat(partes) : undefined); });
    });
}

/**
 * Mede a página de código da saída do exec_command no Windows (produção, 03–16/11/2026: em 52 de 104 julgamentos do juiz contra
 * a evidência a saída do exec_command tinha "�" — o cmd.exe escreve no pipe na página do console, 850 nesta máquina, e o Node lia
 * como UTF-8). Duas perguntas ao sistema, nenhuma tabela no código: (1) o `chcp`, nas condições do exec_command, diz o número;
 * (2) o .NET do próprio Windows traduz os bytes 0x80–0xFF dessa página. Fora do Windows, ou sem resposta: undefined.
 */
export async function medirPaginaDoConsole(plataforma: NodeJS.Platform = process.platform): Promise<PaginaDoConsole | undefined> {
    if (plataforma !== 'win32') return undefined;
    const chcp = await bytesNoShellDoExec('chcp');
    // O número é a única parte em ASCII da resposta ("Página de código ativa: 850") — o resto está na própria página.
    const numeros = chcp ? chcp.toString('latin1').match(/\d{3,5}/g) ?? [] : [];
    const codigo = numeros.length === 1 ? Number(numeros[0]) : NaN;   // mais de um número: resposta que não se sabe ler — não escolhe
    if (!Number.isInteger(codigo)) return undefined;
    if (codigo === 65001) return { codigo };
    const pergunta = `[Console]::OutputEncoding=[Text.Encoding]::UTF8; $e=[Text.Encoding]::GetEncoding(${codigo}); ` +
        `if (-not $e.IsSingleByte) { 'varios-bytes'; exit }; ($e.GetString([byte[]](128..255)).ToCharArray() | ForEach-Object { [int]$_ }) -join ','`;
    const resposta = await new Promise<string>(resolve => {
        execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', pergunta], { timeout: PRAZO_POR_SONDA_MS, windowsHide: true, encoding: 'utf8' },
            (erro, stdout) => resolve(erro ? '' : (stdout ?? '').trim()));
    });
    const codigos = resposta.split(',').map(Number);
    if (codigos.length !== 128 || !codigos.every(c => Number.isInteger(c) && c > 0)) return { codigo };
    return { codigo, altos: String.fromCharCode(...codigos) };
}

let registrados: FatosDoAmbiente | undefined;

/** O CapabilityRegistry registra aqui o que mediu (refreshOS); agente e juízes leem a mesma medição. */
export function registrarAmbiente(fatos: FatosDoAmbiente): void {
    registrados = fatos;
}

/** O que o Node já sabe sem rodar nada — usado até a primeira medição completa. */
export function fatosBasicos(plataforma: NodeJS.Platform = process.platform): FatosDoAmbiente {
    return {
        plataforma,
        versao: `${os.version()} ${os.release()}`.trim(),
        arquitetura: process.arch,
        shell: plataforma === 'win32' ? (process.env.ComSpec || 'cmd.exe') : '/bin/sh',
    };
}

export function fatosDoAmbiente(): FatosDoAmbiente {
    return registrados ?? fatosBasicos();
}

/** Atalho: a saída inteira já é UTF-8 (o caso comum) não precisa do laço byte a byte. `ignoreBOM`: o BOM fica, como no toString. */
const UTF8_ESTRITO = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** Tamanho da sequência UTF-8 bem formada que começa em `i` (1–4), ou 0 se ali não começa uma (regras do padrão WHATWG). */
function sequenciaUtf8(b: Buffer, i: number): number {
    const c = b[i];
    if (c < 0x80) return 1;
    let extras: number, min = 0x80, max = 0xBF;
    if (c >= 0xC2 && c <= 0xDF) extras = 1;
    else if (c >= 0xE0 && c <= 0xEF) { extras = 2; if (c === 0xE0) min = 0xA0; if (c === 0xED) max = 0x9F; }
    else if (c >= 0xF0 && c <= 0xF4) { extras = 3; if (c === 0xF0) min = 0x90; if (c === 0xF4) max = 0x8F; }
    else return 0;
    if (i + extras >= b.length || b[i + 1] < min || b[i + 1] > max) return 0;
    for (let k = 2; k <= extras; k++) if (b[i + k] < 0x80 || b[i + k] > 0xBF) return 0;
    return extras + 1;
}

/**
 * Lê a saída de um programa de console. No Windows, o cmd.exe e os programas que ele chama escrevem no pipe na página de código do
 * console (850 numa máquina pt-BR), não em UTF-8 — e a saída era lida sempre como UTF-8: "não" virava "n�o" para o agente e para
 * os juízes (produção, 03–16/11/2026: 52 de 104 julgamentos do juiz contra a evidência com "�"; 15 das 20 citações que não
 * conferiram). Python e o PowerShell encaminhado já escrevem UTF-8, e um mesmo comando pode misturar as duas coisas
 * (`dir & python script.py`). Por isso, byte a byte: o que é UTF-8 bem formado fica como está; um byte que não forma UTF-8 é lido
 * pela página MEDIDA (`medirPaginaDoConsole`). Sem tabela medida (outro sistema, página UTF-8 ou de vários bytes, medição que
 * falhou), a leitura continua sendo UTF-8, como antes — ninguém adivinha a página.
 * Limite conhecido: bytes da página que por acaso formem UTF-8 válido (ex.: "õêü" colados em 850 = E4 88 81) são lidos como UTF-8.
 * Um só lugar para todo leitor de processo filho (exec_command, atualização pelo painel, instalador de integrações).
 */
export function decodificarSaidaDoConsole(bytes: Buffer, pagina: PaginaDoConsole | undefined = fatosDoAmbiente().paginaDoConsole): string {
    const altos = pagina?.altos;
    if (!altos || altos.length !== 128) return bytes.toString('utf8');
    try { return UTF8_ESTRITO.decode(bytes); } catch { /* há byte que não forma UTF-8: segue byte a byte */ }
    let texto = '';
    let inicio = 0;
    let i = 0;
    while (i < bytes.length) {
        const n = sequenciaUtf8(bytes, i);
        if (n > 0) { i += n; continue; }
        texto += bytes.subarray(inicio, i).toString('utf8') + altos[bytes[i] - 0x80];
        i += 1;
        inicio = i;
    }
    return texto + bytes.subarray(inicio).toString('utf8');
}

export interface LeitorDeSaidaDoConsole {
    /** Recebe um pedaço do pipe; devolve o texto até a última quebra de linha que já chegou (ou ''). */
    ler(pedaco: Buffer): string;
    /** Fim do fluxo: devolve o que sobrou sem quebra de linha. */
    terminar(): string;
}

/**
 * Para quem lê a saída aos pedaços (log ao vivo, linha a linha): um pedaço do pipe pode cortar um caractere de vários bytes ao
 * meio, e decodificar cada pedaço sozinho estragaria as duas metades. Guarda os bytes até a última quebra de linha (\n ou \r —
 * nenhum dos dois aparece dentro de um caractere, nem em UTF-8 nem numa página de 1 byte) e decodifica só o que está inteiro.
 */
export function leitorDeSaidaDoConsole(pagina: PaginaDoConsole | undefined = fatosDoAmbiente().paginaDoConsole): LeitorDeSaidaDoConsole {
    let pendente: Buffer = Buffer.alloc(0);
    return {
        ler(pedaco) {
            const junto = pendente.length ? Buffer.concat([pendente, pedaco]) : pedaco;
            const fim = Math.max(junto.lastIndexOf(0x0A), junto.lastIndexOf(0x0D));
            if (fim < 0) { pendente = junto; return ''; }
            pendente = Buffer.from(junto.subarray(fim + 1));
            return decodificarSaidaDoConsole(junto.subarray(0, fim + 1), pagina);
        },
        terminar() {
            const resto = pendente;
            pendente = Buffer.alloc(0);
            return resto.length ? decodificarSaidaDoConsole(resto, pagina) : '';
        },
    };
}

/**
 * ADR-026 (etapa 1): os shells que o `exec_command` aceita no parâmetro `shell`. Só o que foi MEDIDO nesta máquina: o shell
 * padrão do sistema (o do child_process) e os shells que as sondas de sondasDoAmbiente.json encontraram. Antes da primeira
 * medição, só o padrão — nada é presumido.
 */
export type ShellDeclaravel = 'cmd' | 'powershell' | 'pwsh' | 'bash' | 'sh' | 'zsh';
const SHELLS_DECLARAVEIS: readonly ShellDeclaravel[] = ['cmd', 'powershell', 'pwsh', 'bash', 'sh', 'zsh'];

export function shellsDisponiveis(f: FatosDoAmbiente = fatosDoAmbiente()): ShellDeclaravel[] {
    const padrao: ShellDeclaravel[] = f.plataforma === 'win32'
        ? (/(^|[\\/])cmd(\.exe)?$/i.test(f.shell) ? ['cmd'] : [])
        : ['sh'];
    const medidos = Object.entries(f.medidos ?? {})
        .filter(([fato, resposta]) => (SHELLS_DECLARAVEIS as readonly string[]).includes(fato) && !!resposta && resposta !== NAO_DISPONIVEL)
        .map(([fato]) => fato as ShellDeclaravel);
    return [...new Set([...padrao, ...medidos])];
}

const NOME: Partial<Record<NodeJS.Platform, string>> = { win32: 'Windows', linux: 'Linux', darwin: 'macOS' };

/** Os fatos em poucas frases, para o prompt de quem julga. Sem regra sobre o que cada shell/versão aceita — isso o modelo sabe. */
export function descreverAmbienteDeExecucao(f: FatosDoAmbiente = fatosDoAmbiente()): string {
    const partes = [`Sistema operacional: ${NOME[f.plataforma] ?? f.plataforma}${f.versao ? ` (${f.versao})` : ''}, ${f.arquitetura}.`];
    partes.push(`Shell em que o exec_command roda os comandos: ${f.shell}.`);
    if (f.plataforma === 'win32') partes.push('Comandos com cmdlet do PowerShell ou utilitário Unix são encaminhados pelo exec_command ao powershell.exe.');
    partes.push(`Com o parâmetro shell (${shellsDisponiveis(f).join(', ')}), o exec_command roda o comando exatamente no shell declarado, sem tradução nem encaminhamento.`);
    const medidos = Object.entries(f.medidos ?? {});
    if (medidos.length) partes.push(`Medido no início (comando de consulta → resposta): ${medidos.map(([k, v]) => `${k}: ${v}`).join('; ')}.`);
    if (f.gerenciadorDePacotes) partes.push(`Gerenciador de pacotes detectado: ${f.gerenciadorDePacotes}.`);
    return partes.join(' ');
}
