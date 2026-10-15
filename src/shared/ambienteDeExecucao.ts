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
import { execFile } from 'child_process';
import SONDAS from './sondasDoAmbiente.json';

export interface Sonda { fato: string; comando: string; argumentos: string[] }

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
}

const PRAZO_POR_SONDA_MS = 5000;
const NAO_DISPONIVEL = 'não disponível';

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

const NOME: Partial<Record<NodeJS.Platform, string>> = { win32: 'Windows', linux: 'Linux', darwin: 'macOS' };

/** Os fatos em poucas frases, para o prompt de quem julga. Sem regra sobre o que cada shell/versão aceita — isso o modelo sabe. */
export function descreverAmbienteDeExecucao(f: FatosDoAmbiente = fatosDoAmbiente()): string {
    const partes = [`Sistema operacional: ${NOME[f.plataforma] ?? f.plataforma}${f.versao ? ` (${f.versao})` : ''}, ${f.arquitetura}.`];
    partes.push(`Shell em que o exec_command roda os comandos: ${f.shell}.`);
    if (f.plataforma === 'win32') partes.push('Comandos com cmdlet do PowerShell ou utilitário Unix são encaminhados pelo exec_command ao powershell.exe.');
    const medidos = Object.entries(f.medidos ?? {});
    if (medidos.length) partes.push(`Medido no início (comando de consulta → resposta): ${medidos.map(([k, v]) => `${k}: ${v}`).join('; ')}.`);
    if (f.gerenciadorDePacotes) partes.push(`Gerenciador de pacotes detectado: ${f.gerenciadorDePacotes}.`);
    return partes.join(' ');
}
