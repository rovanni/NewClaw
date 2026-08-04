/**
 * exec_command — Execute shell commands (modelo OpenClaw)
 * 
 * Acesso total ao shell com workspace como cwd padrão.
 * Bloqueia apenas comandos explicitamente destrutivos.
 * Suporta execução remota via ssh://host/command.
 */

import { ToolExecutor, ToolResult } from '../loop/agentLoopTypes';
import { exec } from 'child_process';
import fs from 'fs';
import { resolveHost, isDestructive } from './server_config';
import path from 'path';
import { errorMessage } from '../shared/errors';
import { createLogger } from '../shared/AppLogger';
import { resolvePath } from '../utils/crossPlatform';
import { extractVerifiedArtifacts } from '../loop/planning/artifactContract';

const log = createLogger('ExecCommandTool');

// Referência a um "workspace" de outra instalação embutida no texto do comando (ex: o
// GoalPlanner gerou "python /home/<user>/<repo>/workspace/script.py" copiando um path de outra
// máquina/sessão). Só dispara pra tokens com um segmento de path literalmente chamado
// "workspace" — nunca para paths absolutos genéricos (ex: /etc/passwd), que exec_command
// acessa sem sandbox por design ("Acesso total ao shell").
//
// `allowRelativePrefix` corresponde ao antigo `if (!workdir)`: o prefixo relativo "workspace/"
// (sem barra inicial) só faz sentido reescrever quando o cwd do processo É o workspaceDir — se
// um `workdir` customizado foi passado, "workspace/foo" deve continuar relativo A ELE, não virar
// um path absoluto pra raiz do workspace. Já o caso absoluto ("/home/.../workspace/...") não
// depende disso — um path absoluto é inequívoco não importa qual seja o cwd.
function looksLikeForeignWorkspaceReference(token: string, allowRelativePrefix: boolean): boolean {
    if (path.isAbsolute(token) && /[\\/]workspace(?:[\\/]|$)/.test(token)) return true;
    if (allowRelativePrefix && /^workspace\//.test(token)) return true;
    return false;
}

/**
 * Remapeia toda referência a um "workspace" de outra instalação, token por token, delegando a
 * decisão de qual é o path local correto para resolvePath() — a mesma implementação usada por
 * read/write/list_workspace/send_document. Antes, exec_command tinha sua própria reimplementação
 * (regex + path.sep + candidatos manuais) que já divergiu 2x da resolvePath() real (barra errada
 * pro cmd.exe, falso-positivo "workspace2") — delegar elimina essa classe inteira de divergência.
 */
function remapForeignWorkspacePaths(command: string, allowRelativePrefix: boolean): string {
    return command.replace(/\S+/g, (token) => {
        if (!looksLikeForeignWorkspaceReference(token, allowRelativePrefix)) return token;
        const { resolved, error } = resolvePath(token);
        return error ? token : resolved;
    });
}

// Cmdlets do PowerShell seguem a convenção Verbo-Substantivo (Get-ChildItem, Where-Object,
// Remove-Item...). child_process.exec usa cmd.exe como shell padrão no Windows (ComSpec) —
// cmd.exe não reconhece cmdlets do PowerShell, causando "'X' não é reconhecido como um
// comando interno" mesmo quando PowerShell ESTÁ instalado no SO (só não é o shell usado aqui).
const POWERSHELL_CMDLET_PATTERN = /\b[A-Z][a-zA-Z]*-[A-Z][a-zA-Z]+\b/;

// Binários POSIX comuns que o LLM emite (treinado majoritariamente em ambientes Linux/macOS)
// e que o cmd.exe também não reconhece. Mesma lista que já existia em RiskAnalyzer.ts (usada lá
// só para AVISAR no plano) — reproduzido ao vivo em produção (log de auditoria, 02/07): 'ls'
// falhando repetidas vezes com "não é reconhecido como um comando interno" mesmo com o aviso
// do Q2 presente, porque POWERSHELL_CMDLET_PATTERN (só cmdlets Verbo-Substantivo) nunca cobria
// esses binários — o aviso nunca virava correção de fato. Todo o conjunto ainda serve para
// DECIDIR que o comando precisa ser encaminhado ao powershell.exe (needsPowerShellWrap) — mas
// ATENÇÃO: só ls/cat/rm/cp/mv/sort/tee têm alias nativo garantido no PowerShell 5.1. Os demais
// (head, tail, grep, find, which, test, uniq, wc, touch, sed, awk, tr, cut, printf, xargs, sh,
// bash, read, env) dependem de existir um .exe correspondente no PATH do processo (ex: tail.exe
// via Git for Windows) — quando não existe, ou quando o processo (Tarefa Agendada/PM2, PATH
// pode divergir do shell interativo) não o enxerga, o resultado é CommandNotFoundException
// serializada como CLIXML bruto pelo host -NonInteractive. Confirmado ao vivo em produção
// (auditoria, 02/07 e 09/07): comandos com 'ls' e com 'pip ... | tail -5' chegaram ao LLM como
// "#< CLIXML..." ilegível, e o LLM reagiu retentando o MESMO comando repetidas vezes por não
// conseguir interpretar o erro (chegou a aprender "evitar exec_command em PowerShell" como
// estratégia). head/tail (idioma de truncar saída, o caso mais comum) ganham tradução explícita
// abaixo (translateHeadTailForPowerShell) — elimina a dependência de PATH para esse caso
// específico. decodeClixmlError() é a rede de segurança para o resto do conjunto e para
// qualquer CLIXML que ainda vazar por outro motivo (ex: ruído de progress stream).
const POSIX_ONLY_NO_WIN_EQUIVALENT = new Set([
    'ls', 'cat', 'grep', 'find', 'rm', 'cp', 'mv', 'which', 'test',
    'head', 'tail', 'sort', 'uniq', 'wc', 'touch', 'sed', 'awk', 'tr',
    'cut', 'printf', 'tee', 'xargs', 'sh', 'bash', 'read', 'env',
]);

// Operadores usados para separar comandos numa mesma linha (cmdA && cmdB | cmdC). Precisamos
// inspecionar o primeiro token de CADA segmento, não só do comando inteiro — "marp x.md -o
// x.pptx && ls -lh x.pptx" tem 'ls' no segundo segmento, não no primeiro.
const COMMAND_SEPARATOR = /&&|\|\||;|\|/;

/**
 * Invocações de `exec_command` que são leitura-apenas e podem rodar sem autorização humana.
 * Script multi-linha, padrão destrutivo, escrita em arquivo ou pipe para comando destrutivo
 * sempre exigem autorização.
 *
 * Morava como método privado do `AgentLoop` (ADR-005). Foi movido para cá porque este módulo já
 * é o dono da semântica de comando — e porque, enquanto vivia dentro de um dos caminhos de
 * execução, o outro (`GoalExecutionLoop`) não tinha como fazer a mesma pergunta: em modo SAFE,
 * um step de plano com `exec_command` executava sem gate nenhum (reproduzido ao vivo, 04/08/2026).
 * Quem consome é `ToolRegistry.requiresAuthorization()`, ponto único da decisão.
 *
 * Análise estrutural do comando — nunca texto de interface nem mensagem traduzida — então vale
 * igual em Windows, Linux e macOS e em qualquer idioma da interface.
 */
export function isReadOnlyExecCommand(toolName: string, args: Record<string, unknown>): boolean {
    if (toolName !== 'exec_command') return false;
    const cmd = String(args.command || '').trim();

    // Script multi-linha (mais de 3 linhas não vazias) sempre exige autorização
    const nonEmptyLines = cmd.split('\n').filter(l => l.trim().length > 0);
    if (nonEmptyLines.length > 3) return false;

    // Padrões destrutivos sempre exigem autorização
    if (/\brm\s+-r|\brm\s+--?\w*r|\bmkfs\b|drop\s+table|truncate\s+table/i.test(cmd)) return false;

    // Escrita em arquivo sempre exige autorização — ignora redirecionamentos para /dev/null
    const cmdWithoutNullRedirects = cmd.replace(/\d*>>?\/dev\/null/g, '');
    if (/(?<![0-9a-z&|])>>?\s*\/(?!dev\/null)/i.test(cmdWithoutNullRedirects)) return false;

    // Pipe para comando destrutivo sempre exige autorização
    if (/\|\s*(rm|dd|mkfs|shred)\b/.test(cmd)) return false;

    // Checagem de versão/ajuda é leitura-apenas, seja qual for o binário
    if (/^\S+\s+(--version|-v|-V|--help|-h)$/.test(cmd)) return true;

    const SAFE_COMMANDS = new Set([
        'ls', 'cat', 'find', 'pwd', 'echo', 'which', 'command', 'type',
        'head', 'tail', 'grep', 'wc', 'stat', 'file', 'node', 'npm', 'npx',
        'env', 'printenv', 'df', 'du', 'ps', 'uname', 'hostname',
        'id', 'whoami', 'date', 'uptime', 'lsb_release', 'readlink',
        'marp',  // conversor de formato, não destrutivo
    ]);

    // Separa em sub-comandos por && ou ; e ignora os `cd /caminho`: `cd /dir && ls` é seguro se
    // todas as partes que não são `cd` forem seguras.
    const subCmds = cmd.split(/&&|;/).map(s => s.trim()).filter(Boolean);
    const nonCdSubCmds = subCmds.filter(s => !/^cd(\s|$)/.test(s));
    if (nonCdSubCmds.length === 0) return false; // `cd` puro não entrega leitura nenhuma
    return nonCdSubCmds.every(sub => {
        const word = sub.split(/[\s;|&]/)[0].replace(/^\.\//, '');
        // Também confere o basename, para invocação por caminho completo (/usr/local/bin/marp)
        const basename = word.includes('/') ? word.split('/').pop()! : word;
        return SAFE_COMMANDS.has(word) || SAFE_COMMANDS.has(basename);
    });
}

export function needsPowerShellWrap(command: string): boolean {
    if (/^\s*(powershell|pwsh)(\.exe)?\b/i.test(command)) return false; // já encaminhado
    if (POWERSHELL_CMDLET_PATTERN.test(command)) return true;
    return command.split(COMMAND_SEPARATOR).some(segment => {
        const firstToken = segment.trim().split(/\s+/)[0]?.toLowerCase().replace(/^.*[\\/]/, '');
        return firstToken ? POSIX_ONLY_NO_WIN_EQUIVALENT.has(firstToken) : false;
    });
}

// O powershell.exe padrão do Windows é o Windows PowerShell 5.1, que NÃO suporta os
// operadores && / || (só chegaram no PowerShell 7+/pwsh) — um comando encaminhado como
// "cmdA && cmdB" quebraria com erro de parse. Traduz para os equivalentes nativos do 5.1
// ($? = sucesso do último comando). Reconstrói da direita para a esquerda para preservar a
// semântica de curto-circuito em cadeias com mais de 2 comandos.
export function translateChainOperatorsForPowerShell(command: string): string {
    const parts = command.split(/\s(&&|\|\|)\s/);
    if (parts.length === 1) return command;
    let acc = parts[parts.length - 1];
    for (let i = parts.length - 3; i >= 0; i -= 2) {
        const cmd = parts[i];
        const op = parts[i + 1];
        acc = op === '&&'
            ? `${cmd}; if ($?) { ${acc} }`
            : `${cmd}; if (-not $?) { ${acc} }`;
    }
    return acc;
}

// "2>/dev/null" (silenciar stderr) é um idioma POSIX comum no que o LLM gera. O PowerShell
// não tem /dev/null — trata "/dev/null" como um path relativo literal e tenta CRIAR o arquivo
// "<cwd>\dev\null" pra redirecionar stderr, falhando com DirectoryNotFoundException quando a
// pasta "dev" não existe (reproduzido ao vivo: "out-file : Não foi possível localizar uma parte
// do caminho 'D:\dev\null'"). $null é o equivalente nativo do PowerShell — um "buraco negro"
// que não exige nenhum diretório existir.
export function translateDevNullForPowerShell(command: string): string {
    return command.replace(/\/dev\/null\b/g, '$null');
}

// `ls -la`/`ls -lh`/etc. (flags POSIX combinadas de "formato longo, todos os arquivos, tamanho
// legível") não têm equivalente quando encaminhados via alias `ls` do PowerShell — Get-ChildItem
// não aceita essas flags de jeito nenhum, e o erro de parâmetro que ele gera vem serializado como
// CLIXML (ilegível) em vez de mensagem de texto. Reproduzido ao vivo (log de auditoria, 02/07):
// `ls -la <path>` bloqueou um step de goal com "#< CLIXML" como saída inteira do erro, forçando
// um replan não planejado. Todo uso de `ls <flags> <path>` neste projeto é uma checagem simples
// de "o arquivo existe / qual o tamanho", então descartar as flags e mapear para
// `Get-ChildItem <path>` (sem flags) preserva a intenção sem precisar traduzir flag por flag.
export function translateLsFlagsForPowerShell(command: string): string {
    return command.replace(/\bls\s+-[lah]+(?=\s|$)/gi, 'Get-ChildItem');
}

// `head -N`/`tail -N` (e a variante `-n N`) não têm alias no PowerShell — encaminhados
// verbatim, o powershell.exe lança CommandNotFoundException, serializada como CLIXML bruto
// pelo host -NonInteractive (ver comentário de POSIX_ONLY_NO_WIN_EQUIVALENT acima).
// Select-Object -First/-Last é o equivalente quando os dados já vêm de um pipe anterior (o
// caso mais comum: `cmd 2>&1 | tail -N`) — MAS NÃO quando head/tail recebe um arquivo direto
// como argumento (`head -30 arquivo.txt`, sem pipe): "Select-Object -First 30 arquivo.txt"
// não lê o arquivo (Select-Object não tem parâmetro posicional de path) — reproduzido ao vivo
// nesta máquina (30/07/2026): exit code 0, porém output="" (falha silenciosa, sem nenhum erro
// visível pro LLM/validador achar o problema). Precisa envolver em Get-Content explicitamente
// quando há um arquivo depois da flag; só cai no Select-Object "nu" quando não há.
export function translateHeadTailForPowerShell(command: string): string {
    // Forma com arquivo direto — captura o path e envolve em Get-Content. Roda ANTES da forma
    // "nua" abaixo (senão o path ficaria órfão depois de head/tail já ter virado Select-Object).
    // [^\s;&|]+ evita capturar o `; if ($?) { ... }` que translateChainOperatorsForPowerShell
    // já injetou antes deste fixup rodar (ver ordem de composição em wrapForWindowsPowerShell).
    let out = command
        .replace(/\bhead\s+-n\s*(\d+)\s+([^\s;&|]+)/gi, '(Get-Content $2 | Select-Object -First $1)')
        .replace(/\bhead\s+-(\d+)\s+([^\s;&|]+)/gi, '(Get-Content $2 | Select-Object -First $1)')
        .replace(/\btail\s+-n\s*(\d+)\s+([^\s;&|]+)/gi, '(Get-Content $2 | Select-Object -Last $1)')
        .replace(/\btail\s+-(\d+)\s+([^\s;&|]+)/gi, '(Get-Content $2 | Select-Object -Last $1)');
    // Forma via pipe (nada além da flag) — Select-Object já lê do pipe anterior sem precisar
    // de Get-Content.
    out = out
        .replace(/\bhead\s+-n\s*(\d+)/gi, 'Select-Object -First $1')
        .replace(/\bhead\s+-(\d+)\b/gi, 'Select-Object -First $1')
        .replace(/\btail\s+-n\s*(\d+)/gi, 'Select-Object -Last $1')
        .replace(/\btail\s+-(\d+)\b/gi, 'Select-Object -Last $1');
    return out;
}

// `wc -l` não tem alias no PowerShell e — diferente do que o comentário de
// POSIX_ONLY_NO_WIN_EQUIVALENT alerta para o conjunto em geral — NÃO pode depender de um
// wc.exe resolvido via PATH: reproduzido ao vivo em produção (newclaw-audit.log, 29/07/2026,
// goal_1785377727278_guufa) — a máquina de produção roda via Tarefa Agendada, cujo PATH não
// inclui os utilitários GNU do Git for Windows que um shell de desenvolvedor interativo tem
// (por isso o mesmo comando funciona num teste manual mas falha em produção). Só `-l`
// (contagem de linhas) é traduzido — único uso real observado neste projeto.
export function translateWcForPowerShell(command: string): string {
    let out = command.replace(/\bwc\s+-l\s+([^\s;&|]+)/gi, '(Get-Content $1 | Measure-Object -Line).Lines');
    out = out.replace(/\bwc\s+-l\b/gi, 'Measure-Object -Line | Select-Object -ExpandProperty Lines');
    return out;
}

/**
 * Decodifica um payload CLIXML (formato que o powershell.exe usa para serializar streams de
 * erro/warning/verbose quando roda -NonInteractive, sem host para renderizar como texto) em
 * texto plano legível. Sem isso, o LLM recebe "#< CLIXML\n<Objs ...>" como mensagem de erro
 * inteira — ilegível, então não consegue entender o que quebrou e repete o mesmo comando até
 * esgotar o retryBudget. Reproduzido ao vivo (auditoria 02/07 e 09/07): comandos com 'ls' e
 * 'pip ... | tail' voltaram como "#< CLIXML" bruto, e o GoalPlanner chegou a aprender "evitar
 * exec_command em PowerShell" como estratégia de replan — o tool inteiro ficou marcado como
 * não-confiável por causa de um erro que sempre foi só ilegibilidade.
 */
export function decodeClixmlError(output: string): string {
    if (!output.includes('#< CLIXML')) return output;
    // Cada <S S="Error"> é UMA LINHA do console PowerShell e já termina com _x000D__x000A_
    // (CRLF escapado) — decodificar sem trim por fragmento preserva as quebras de linha entre
    // eles; um trim por fragmento aqui colaria a última palavra de uma linha na primeira da
    // próxima (ex: "Verifique a" + "grafia" → "Verifique agrafia").
    const decodeEscapes = (s: string) => s.replace(/_x([0-9A-Fa-f]{4})_/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    const messages = [...output.matchAll(/<S S="Error">([\s\S]*?)<\/S>/g)].map(m => decodeEscapes(m[1]));
    if (messages.length === 0) return output;
    return messages.join('').trim();
}

/**
 * Encaminha o comando para powershell.exe via -EncodedCommand (Base64 UTF-16LE).
 * Evita o inferno de escaping de aspas entre cmd.exe (shell externo) e PowerShell
 * (shell alvo) — Base64 não precisa de escaping algum.
 *
 * $ProgressPreference = 'SilentlyContinue': sem host interativo (-NonInteractive), o
 * PowerShell não tem como desenhar uma barra de progresso — em vez de simplesmente omitir,
 * ele serializa o progress stream como CLIXML bruto na stdout (ex: "Preparando módulos para
 * primeiro uso"). Reproduzido ao vivo: mesmo um `Get-ChildItem` bem-sucedido vinha com
 * "#< CLIXML\n<Objs...>" anexado à saída, poluindo o resultado que volta pro LLM/validador.
 * Setar a preferência ANTES do comando real elimina esse stream na origem.
 *
 * [Console]::OutputEncoding / $OutputEncoding = UTF8: sem host interativo, o powershell.exe
 * escreve stdout redirecionado na code page legada do sistema (cp1252/850 em máquinas pt-BR),
 * não em UTF-8 — mas child_process.exec() decodifica o buffer capturado como UTF-8 (padrão do
 * Node). Qualquer caractere acentuado que o comando (ou um script que ele chama) imprima vira
 * bytes ilegíveis (ex: "não" -> "n?o") do lado do LLM. Reproduzido ao vivo em produção (log de
 * auditoria, 27/07/2026): um `exec_command` de diagnóstico que imprimia "ffmpeg não encontrado"
 * voltou como "ffmpeg n?o encontrado" — no mesmo goal, comandos vizinhos gerados pelo próprio
 * LLM evitavam acento de propósito ("nao disponivel" em vez de "não disponível"), sinal de que
 * o modelo já tinha "aprendido" a evitar acentos como contorno em vez da causa raiz ser
 * corrigida. Mesma classe de problema (mismatch de encoding entre o que o processo filho
 * escreve e o que o Node espera) já resolvida para Python via PYTHONIOENCODING/PYTHONUTF8
 * logo abaixo — aqui é o equivalente para quando o comando é encaminhado ao PowerShell.
 */
export function wrapForWindowsPowerShell(command: string): string {
    const translated = translateWcForPowerShell(translateHeadTailForPowerShell(translateLsFlagsForPowerShell(translateDevNullForPowerShell(translateChainOperatorsForPowerShell(command)))));
    const withoutProgressNoise = `$ProgressPreference = 'SilentlyContinue'; [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $OutputEncoding = [System.Text.Encoding]::UTF8; ${translated}`;
    const encoded = Buffer.from(withoutProgressNoise, 'utf16le').toString('base64');
    return `powershell -NoProfile -NonInteractive -EncodedCommand ${encoded}`;
}

// ── Marp/pandoc — validação e auto-fix de comandos ──────────────────────────
// Movido de RiskAnalyzer.ts: essas checagens só rodavam quando isComplexPlan() no
// GoalExecutionLoop acionava o Q2 (>=3 steps, ou exec_command+write/send juntos). Um plano
// de 1 step só com "exec_command: marp arquivo.md" (o caso mais comum) pulava o Q2 inteiro e
// as correções nunca eram aplicadas — mesma classe de bug do PowerShell acima. exec_command.ts
// roda incondicionalmente pra toda chamada, então é o único lugar que garante a correção sempre.

/**
 * Detecta comandos marp/pandoc sem arquivo de entrada posicionado ANTES das flags.
 * Causa clássica do erro "waiting data from stdin stream" no marp — o processo FICA PRESO
 * esperando stdin até o timeout (60s) em vez de falhar rápido. Por isso este caso vira erro
 * imediato (fail-fast) em vez de auto-fix: não há como adivinhar qual arquivo o LLM queria.
 * Marp aceita apenas .md como entrada; pandoc aceita múltiplos formatos.
 *
 * Regra: o arquivo de entrada deve ser o primeiro argumento não-flag após o binário.
 * Ex correto:   marp entrada.md --no-stdin -o saida.html
 * Ex errado:    marp --no-stdin -o saida.html          (sem arquivo)
 *               marp --pdf slides.md                   (flag antes do arquivo)
 *               npx @marp-team/marp-cli -o output.html (sem arquivo .md)
 */
export function isMarpWithoutInputFile(command: string): boolean {
    if (!/\bmarp\b/.test(command)) return false;
    const tokens = command.trim().split(/\s+/);
    const marpIdx = tokens.findIndex(t => /^(npx|marp)$/.test(t));
    if (marpIdx < 0) return false;
    const start = tokens[marpIdx] === 'npx' ? marpIdx + 2 : marpIdx + 1;
    let beforeFirstFlag = true;
    for (const t of tokens.slice(start)) {
        if (t.startsWith('-')) { beforeFirstFlag = false; continue; }
        if (beforeFirstFlag && (t.endsWith('.md') || t.endsWith('.marp'))) return false;
    }
    return true; // sem arquivo .md antes de qualquer flag
}

/**
 * Detecta marp com arquivo de entrada mas sem --no-stdin.
 * Sem --no-stdin, marp bloqueia esperando stdin mesmo quando recebe um arquivo .md.
 * Deve ser verificado APÓS isMarpWithoutInputFile (que cobre o caso mais grave).
 */
export function isMarpWithoutNoStdin(command: string): boolean {
    if (!/\bmarp\b/.test(command)) return false;
    return !/--no-stdin/.test(command);
}

/**
 * Injeta --no-stdin APÓS o arquivo .md de entrada.
 * REGRA ABSOLUTA (pptx-generator SKILL.md §Passo 3): o arquivo deve preceder qualquer flag.
 * Correto:  marp entrada.md --no-stdin -o saida.pptx
 * ERRADO:   marp --no-stdin entrada.md -o saida.pptx
 */
export function addMarpNoStdin(command: string): string {
    return command.replace(/(\S+\.(?:md|marp))(\s|$)/, '$1 --no-stdin$2');
}

/** Mesma lógica para pandoc: requer arquivo de entrada antes das flags. */
export function isPandocWithoutInputFile(command: string): boolean {
    if (!/\bpandoc\b/.test(command)) return false;
    const tokens = command.trim().split(/\s+/);
    const pandocIdx = tokens.findIndex(t => /^pandoc$/.test(t));
    if (pandocIdx < 0) return false;
    const start = pandocIdx + 1;
    let beforeFirstFlag = true;
    for (const t of tokens.slice(start)) {
        if (t.startsWith('-')) { beforeFirstFlag = false; continue; }
        if (beforeFirstFlag && /\.(md|docx|tex|html|rst|odt|rtf)$/.test(t)) return false;
    }
    return true;
}

/**
 * Detecta pandoc com a flag --no-stdin (que é exclusiva do marp, não existe no pandoc).
 * O GoalPlanner pode generalizar incorretamente o fix de marp para pandoc.
 */
export function hasPandocInvalidNoStdin(command: string): boolean {
    return /\bpandoc\b/.test(command) && /--no-stdin/.test(command);
}

/** Remove --no-stdin do comando pandoc. */
export function removePandocNoStdin(command: string): string {
    return command.replace(/\s*--no-stdin\b/g, '').replace(/\s{2,}/g, ' ').trim();
}

// ── Pipeline de fixups (ARCH-023) ────────────────────────────────────────────
// As transformações de `command` que ANTES eram uma sequência de `if`s soltos dentro de
// execute() — ordem implícita, só documentada em comentário ("Roda por ÚLTIMO, depois de toda
// normalização de path acima"). Agora é uma lista explícita, ordenada, auditável sem precisar
// ler o corpo de execute() inteiro. Escopo consciente (não os ~12 "e tanto" citados no card):
// só as transformações que mutam `command` sequencialmente entram aqui — os 2 gates de
// validação que ABORTAM a execução com erro (isMarpWithoutInputFile, isPandocWithoutInputFile)
// continuam como `if`s diretos em execute(), porque não fazem parte de uma cadeia onde a ordem
// entre eles determina o resultado (cada um só decide "abortar ou não", independente do outro).
interface FixupContext {
    isSsh: boolean;
    /** Corresponde ao antigo `!workdir` — só reescreve prefixo relativo "workspace/" quando o
     *  cwd do processo É o workspaceDir (sem workdir customizado). */
    allowRelativeWorkspacePrefix: boolean;
}

interface CommandFixupStep {
    name: string;
    condition: (command: string, ctx: FixupContext) => boolean;
    transform: (command: string, ctx: FixupContext) => string;
    /** Default true. `remap_foreign_workspace_paths` nunca teve log `[AUTO-FIX]` no código
     *  original (sempre roda, silenciosamente) — preservado aqui para não introduzir uma linha
     *  de log nova que não existia antes. */
    logOnChange?: boolean;
}

// Ordem = ordem real de aplicação em execute() (ver os 2 pontos de chamada de applyFixup() mais
// abaixo — não um `for` batelado, de propósito: os 2 gates de validação (isMarpWithoutInputFile,
// isPandocWithoutInputFile) precisam continuar INTERCALADOS entre os fixups, exatamente como já
// eram, e `wrap_powershell` precisa continuar sendo o ÚLTIMO fixup aplicado, depois que
// `isSearchCommand` já leu o comando original (grep/rg/find) — se rodasse mais cedo,
// `isSearchCommand` veria o comando já embrulhado em PowerShell/Base64 e nunca mais
// reconheceria os binários originais). A lista existe para dar UMA fonte nomeada, legível e
// testável do que cada fixup faz — não para forçar todos a rodar num loop só, o que exigiria
// quebrar a interleaving com os gates ou arriscar essa regressão de `isSearchCommand`.
const COMMAND_FIXUP_PIPELINE: CommandFixupStep[] = [
    {
        name: 'remap_foreign_workspace_paths',
        condition: () => true,
        transform: (command, ctx) => remapForeignWorkspacePaths(command, ctx.allowRelativeWorkspacePrefix),
        logOnChange: false,
    },
    {
        name: 'add_marp_no_stdin',
        condition: (command) => isMarpWithoutNoStdin(command),
        transform: (command) => addMarpNoStdin(command),
    },
    {
        name: 'remove_pandoc_no_stdin',
        condition: (command) => hasPandocInvalidNoStdin(command),
        transform: (command) => removePandocNoStdin(command),
    },
    {
        // Roda por último, depois de toda normalização de path acima — o comando final (já com
        // paths corrigidos) é o que vira Base64, não o texto original ainda com paths errados.
        // Não se aplica a ssh:// — o shell remoto não é necessariamente Windows.
        name: 'wrap_powershell',
        condition: (command, ctx) => !ctx.isSsh && process.platform === 'win32' && needsPowerShellWrap(command),
        transform: (command) => wrapForWindowsPowerShell(command),
    },
];

function applyFixup(stepName: string, command: string, ctx: FixupContext): string {
    const step = COMMAND_FIXUP_PIPELINE.find(s => s.name === stepName);
    if (!step || !step.condition(command, ctx)) return command;
    const next = step.transform(command, ctx);
    if (step.logOnChange !== false) {
        log.info(`[AUTO-FIX] fix=${step.name} original="${command.slice(0, 120)}"`);
    }
    return next;
}

export class ExecCommandTool implements ToolExecutor {
    name = 'exec_command';
    description = 'Execute shell commands. Workspace como cwd padrão. Suporta ssh://host/command para remoto. Timeout padrão: 30s.';
    parameters = {
        type: 'object',
        properties: {
            command: { type: 'string', description: 'Shell command. Use ssh://HOST/cmd para execução remota' },
            timeout: { type: 'number', description: 'Timeout em ms (padrão: 30000)' },
            workdir: { type: 'string', description: 'Diretório de trabalho (padrão: workspace)' }
        },
        required: ['command']
    };

    async execute(args: Record<string, any>): Promise<ToolResult> {
        let command = args.command as string;
        const timeout = (args.timeout as number) || 60000;
        const workdir = args.workdir as string;

        if (!command) {
            return { success: false, output: '', error: 'Command not provided' };
        }

        // Block destructive commands
        if (isDestructive(command)) {
            return { success: false, output: '', error: 'Comando destrutivo bloqueado por segurança' };
        }

        // Handle SSH remote execution: ssh://host/command
        const isSsh = command.startsWith('ssh://');
        if (isSsh) {
            const match = command.match(/^ssh:\/\/([a-zA-Z0-9_-]+)\/(.*)/);
            if (!match) {
                return { success: false, output: '', error: 'Formato SSH inválido. Use: ssh://host/command' };
            }
            const hostAlias = match[1];
            const remoteCmd = match[2];
            const sshTarget = resolveHost(hostAlias);
            // Aspas simples impedem TODA expansão de shell local ($(), backticks, $VAR).
            // Aspas duplas só escapavam ", mas $() continuava sendo interpretado localmente.
            // Se remoteCmd contém ', usamos o idioma '"'"' para escape dentro de single-quote.
            const escapedCmd = remoteCmd.replace(/'/g, "'\\''");
            command = `ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new ${sshTarget} '${escapedCmd}'`;
        }

        // ── Path Resolution ──
        const workspaceDir = path.resolve(process.env.WORKSPACE_DIR || path.join(process.cwd(), 'workspace'));

        // Se workdir for absoluto, resolve em relação ao root; se relativo, em relação ao workspace
        const effectiveWorkdir = workdir ? path.resolve(workspaceDir, workdir) : workspaceDir;

        // Normaliza referências a um "workspace" de outra instalação (ex: o GoalPlanner gerou
        // "python /home/<user>/<repo>/workspace/script.py" copiando um path de outra máquina)
        // delegando para resolvePath() — mesma implementação usada por read/write/list_workspace.
        // "workspace/" relativo só é reescrito quando NÃO há workdir customizado (cwd já é o
        // workspaceDir nesse caso — com workdir custom, "workspace/foo" deve continuar relativo
        // a ele, não virar um path absoluto pra raiz do workspace).
        const fixupCtx: FixupContext = { isSsh, allowRelativeWorkspacePrefix: !workdir };
        command = applyFixup('remap_foreign_workspace_paths', command, fixupCtx);

        // marp/pandoc: falha rápido quando não há arquivo de entrada (evita ficar preso
        // esperando stdin até o timeout), e corrige automaticamente a flag --no-stdin
        // (obrigatória no marp, inválida no pandoc — LLM às vezes generaliza errado entre os dois).
        if (isMarpWithoutInputFile(command)) {
            return {
                success: false, output: '',
                error: 'marp invocado sem arquivo .md de entrada antes das flags — isso trava esperando stdin. ' +
                       'Formato correto: marp entrada.md --no-stdin -o saida.html',
            };
        }
        command = applyFixup('add_marp_no_stdin', command, fixupCtx);
        if (isPandocWithoutInputFile(command)) {
            return {
                success: false, output: '',
                error: 'pandoc invocado sem arquivo de entrada antes das flags. ' +
                       'Formato correto: pandoc entrada.md -o saida.html',
            };
        }
        command = applyFixup('remove_pandoc_no_stdin', command, fixupCtx);

        // windowsHide evita que cada comando abra uma janela de console visível no Windows —
        // o processo do bot roda sem console próprio (PM2/Tarefa Agendada), então sem essa
        // flag o Windows aloca uma janela nova a cada chamada, piscando na tela do usuário.
        const execOptions: { timeout: number; cwd?: string; windowsHide: boolean; env: NodeJS.ProcessEnv } =
            { timeout, windowsHide: true, env: { ...process.env } };
        execOptions.cwd = effectiveWorkdir;

        // Windows: processos lançados via Tarefa Agendada/serviço/PM2 (autostart em background,
        // sem shell interativo) às vezes herdam um env sem SystemRoot/SystemDrive/ComSpec, ou
        // com a chave PATH em outra capitalização — o objeto plano `{ ...process.env }` acima
        // perde a semântica case-insensitive que o Windows dá a process.env nativamente. Sem
        // esses valores, o spawn do PRÓPRIO cmd.exe falha com "spawn ...cmd.exe ENOENT" mesmo
        // com o binário existindo em disco no caminho exato reportado — o erro não aponta pra
        // causa real (env, não o arquivo). Reproduzido ao vivo em produção 29-30/07/2026
        // (goal_1785377727278_guufa, newclaw-audit.log): bloqueou um step válido e custou 2
        // replans extras num goal que já ia estourar o teto de 10min do dashboard web. Fix
        // originalmente escrito em 14/07/2026 (branch investigation/tool-dedup-loop, nunca
        // mergeada) — portado aqui, guardado por platform, sem efeito em Linux/macOS.
        if (process.platform === 'win32') {
            const env = execOptions.env;
            const envKeys = Object.keys(env);
            const pathKey = envKeys.find(k => k.toLowerCase() === 'path');
            if (pathKey && pathKey !== 'PATH') {
                env.PATH = env[pathKey];
                delete env[pathKey];
            }
            if (!env.SystemRoot) env.SystemRoot = process.env.SystemRoot || 'C:\\Windows';
            if (!env.SystemDrive) env.SystemDrive = process.env.SystemDrive || 'C:';
            if (!env.ComSpec) env.ComSpec = process.env.ComSpec || 'C:\\Windows\\system32\\cmd.exe';
        }

        // cwd inexistente derruba o spawn do shell com ENOENT no Windows (CreateProcess não
        // distingue "cwd não existe" de "executável não existe" — o erro sempre aponta pro
        // shell). Garantir que o diretório existe antes do spawn evita esse falso-diagnóstico;
        // fallback para o workspace raiz (que sempre existe) se a criação falhar.
        if (execOptions.cwd && !fs.existsSync(execOptions.cwd)) {
            try {
                fs.mkdirSync(execOptions.cwd, { recursive: true });
            } catch {
                log.warn(`[CWD-FALLBACK] workdir "${execOptions.cwd}" não existe e não pôde ser criado — usando workspace raiz`);
                execOptions.cwd = workspaceDir;
            }
        }

        // Scripts Python gerados pelo LLM usam print() com emojis/box-drawing (✅, 📊, ─...) por
        // hábito estilístico — o modelo foi treinado majoritariamente em ambientes Linux/macOS,
        // onde stdout já é UTF-8 por padrão. Quando o stdout é redirecionado (sempre o caso aqui,
        // via child_process.exec — nunca é um console real), o Python no Windows cai para a code
        // page legada (cp1252/mbcs) em vez de UTF-8, e QUALQUER caractere fora do cp1252 num
        // print() derruba o script inteiro com UnicodeEncodeError. Reproduzido ao vivo 5x em
        // produção ao longo de dias diferentes (30/06, 02/07, 05/07 x2, 09/07) — sempre o mesmo
        // erro, sempre scripts e emojis diferentes, porque a causa nunca foi o conteúdo do script
        // e sim o ambiente de execução. PYTHONIOENCODING/PYTHONUTF8 forçam UTF-8
        // incondicionalmente (não fazem nada em processos não-Python), eliminando a classe
        // inteira sem depender do LLM lembrar de evitar emoji em cada script novo que gerar.
        execOptions.env.PYTHONIOENCODING = 'utf-8';
        execOptions.env.PYTHONUTF8 = '1';

        // Comandos de busca retornam exit code 1 quando não há resultados — isso é um
        // resultado válido ("nenhum match"), não um erro. grep, rg, find -quit, etc.
        const isSearchCommand = /^\s*(grep|rg|find)\b/.test(command.replace(/^ssh[^\s]+\s+/, ''));

        // Encaminha cmdlets PowerShell para powershell.exe quando o processo local é Windows.
        // Roda por ÚLTIMO, depois de toda normalização de path acima — o comando final (já com
        // paths corrigidos) é o que vira Base64, não o texto original ainda com paths errados.
        // Não se aplica a ssh:// — o shell remoto não é necessariamente Windows, e o cmdlet
        // ali dentro pertence ao ambiente remoto, não a este processo local.
        // process.platform é sempre conhecido de forma síncrona, sem depender de nenhum probe
        // cacheado — diferente de uma versão anterior deste fix que vivia no RiskAnalyzer e só
        // rodava para planos "complexos" (isComplexPlan(): >=3 steps, ou exec_command+write/send
        // juntos). Um plano de 1 step só com exec_command — o caso mais comum — pulava essa
        // análise inteira e o fix nunca era aplicado.
        command = applyFixup('wrap_powershell', command, fixupCtx);

        try {
            const output = await new Promise<string>((resolve, reject) => {
                exec(command, execOptions, (error, stdout, stderr) => {
                    const combined = decodeClixmlError((stdout ? stdout.toString() : '') + (stderr ? stderr.toString() : ''));
                    if (error) {
                        const exitCode = error.code ?? 'unknown';
                        // Exit code 1 em comandos de busca = "nenhum resultado encontrado" (válido).
                        // Apenas exit code 2+ indica erro real no grep/rg/find.
                        if (isSearchCommand && exitCode === 1) {
                            resolve('Nenhum resultado encontrado.');
                            return;
                        }
                        // Non-zero exit is a failure — reject so the caller sees success: false.
                        // Preserve stdout/stderr in combinedOutput so GoalEvaluator can classify it.
                        // exitCode também propagado como dado estruturado (ToolResult.exitCode) —
                        // GoalEvaluator não precisa mais fazer regex sobre "[exit code: N]" no texto.
                        const fullOutput = (combined.trim() || error.message) + `\n[exit code: ${exitCode}]`;
                        reject(Object.assign(error, {
                            combinedOutput: fullOutput.trim(),
                            exitCode: typeof exitCode === 'number' ? exitCode : undefined,
                        }));
                    } else {
                        resolve(combined);
                    }
                });
            });

            // Contrato de artefato (docs/sprints-r1-r7-2026-07-13/REVISAO_ARQUITETURAL_SPRINT_R7_2026-07-13.md): scripts
            // podem declarar o(s) arquivo(s) que produziram via linha "ARTIFACT: <path>" no
            // stdout — declarativo (opt-in do script), nunca varredura do workspace. Cada
            // declaração é verificada contra o disco antes de virar evidência confiável.
            const artifactPaths = extractVerifiedArtifacts(output, (raw) => resolvePath(raw));

            return {
                success: true,
                output: output.trim().slice(0, 16000),
                ...(artifactPaths.length > 0 ? { artifactPaths } : {}),
            };
        } catch (err) {
            const e = err as NodeJS.ErrnoException & { combinedOutput?: string; exitCode?: number };
            const msg = (e.combinedOutput || errorMessage(err)).slice(0, 16000);
            return { success: false, output: msg, error: msg, ...(e.exitCode !== undefined ? { exitCode: e.exitCode } : {}) };
        }
    }
}