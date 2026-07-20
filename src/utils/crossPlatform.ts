/**
 * crossPlatform.ts — Utilitários cross-platform para Windows, Linux e macOS.
 *
 * Substitui chamadas Unix-only (which, ps aux, df, /tmp, etc.) por
 * equivalentes Node.js portáveis. Importe daqui em vez de usar execSync
 * com comandos de shell específicos de plataforma.
 *
 * Também exporta resolvePath() — resolução unificada de caminhos para todos os
 * tools de arquivo (write, read, edit, send_document, list_workspace).
 * Usa apenas APIs nativas do Node.js: path.*, os.homedir(), os.tmpdir().
 *
 * ── Filosofia de implementação ────────────────────────────────────────────
 *
 * O NewClaw mantém uma única implementação de resolução de caminhos
 * para Linux, Windows e macOS.
 *
 * Regras de decisão (nessa ordem):
 *   1. O Node.js já resolve? Use path.*, os.*, fs.* — não reimplemente.
 *   2. Já existe função equivalente no projeto? Reutilize.
 *   3. O comportamento realmente difere entre plataformas? Só então use
 *      process.platform — e documente por que é necessário.
 *
 * Diferenças reais de plataforma (aceitáveis com process.platform):
 *   bash vs CMD/PowerShell, chmod, executáveis .exe, /dev/null vs NUL.
 *
 * Problemas de dados NÃO são problemas de plataforma:
 *   paths absolutos vindos de memória persistida, caminhos gerados pelo
 *   LLM, paths de outra instalação — devem ser tratados na origem do dado,
 *   não com detecção de SO.
 *
 * Compatibilidade histórica permanece isolada e marcada como temporária.
 * ──────────────────────────────────────────────────────────────────────────
 */

import { execSync, execFileSync, execFile } from 'child_process';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

export const isWindows = process.platform === 'win32';
export const isMac     = process.platform === 'darwin';
export const isLinux   = process.platform === 'linux';

const BASH_PROBE_TIMEOUT_MS = 3000;

/**
 * Verifica se `bash` é REALMENTE executável — não apenas presente no PATH.
 *
 * Por quê: no Windows, `where bash` frequentemente encontra o launcher stub do WSL
 * (`C:\Windows\System32\bash.exe` ou o da Microsoft Store) mesmo quando nenhuma distro
 * Linux está instalada/registrada. `commandExists('bash')`/`which('bash')` reportam esse
 * stub como "presente", mas invocá-lo falha com
 * "WSL (10 - Relay) ERROR: CreateProcessCommon:818: execvpe(/bin/bash) failed: No such
 * file or directory" — um falso positivo. Evidência real (2026-07-12, instalação Windows):
 * o agente tentou `bash scripts/html2pdf.sh` 4 vezes, sempre com esse erro, queimando um
 * ciclo de replan inteiro antes de trocar de estratégia — porque EnvironmentProbe nunca
 * checava `bash` (nem via `where`, que teria dado o mesmo falso positivo). Este probe
 * executa `bash -c "exit 0"` de verdade e decide só pelo exit code, igual a
 * `probePython3Runtime` — sem isso, qualquer skill que dependa de bash no Windows sem WSL
 * configurado só descobre o problema empiricamente, em runtime, depois de já ter tentado.
 * Em Linux/macOS, bash é o shell nativo — `commandExists` já é confiável e não precisa do
 * probe de execução real.
 */
export function isBashFunctional(): Promise<boolean> {
    if (!isWindows) return Promise.resolve(commandExists('bash'));
    return new Promise((resolve) => {
        execFile('bash', ['-c', 'exit 0'], { timeout: BASH_PROBE_TIMEOUT_MS, windowsHide: true }, (error) => resolve(!error));
    });
}

/** Cross-platform equivalent of `which` / `where`. Returns full path or null. */
export function which(cmd: string): string | null {
    try {
        const bin    = isWindows ? 'where.exe' : 'which';
        const result = execFileSync(bin, [cmd], {
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
            timeout: 3000,
            windowsHide: true,
        }).trim().split(/\r?\n/)[0].trim();
        return result || null;
    } catch {
        return null;
    }
}

/** Returns true if a command is available on PATH. */
export function commandExists(cmd: string): boolean {
    return which(cmd) !== null;
}

/**
 * Build a shell one-liner that prints "OK:<tool>" or "MISSING:<tool>".
 * Used when building probe command strings for exec_command.
 */
export function probeToolCmd(tool: string): string {
    if (isWindows) {
        return `where.exe "${tool}" > nul 2>&1 && echo OK:${tool} || echo MISSING:${tool}`;
    }
    return `command -v "${tool}" >/dev/null 2>&1 && echo "OK:${tool}" || echo "MISSING:${tool}"`;
}

// ─── Resolução de runtime Python 3 ───────────────────────────────────────────
//
// Substituiu probePyPkgCmd() (que hardcodava `isWindows ? 'python' : 'python3'`
// e escolhia esse binário sem nunca validar se é realmente Python 3 — se um
// sistema tivesse `python` apontando pra Python 2, o probe antigo nunca teria
// como saber). Contrato mínimo que representa corretamente `python3`, `python`,
// `py -3` (comando + prefixo de argumentos, NÃO uma string única — `py -3` não
// é um executável, é `py` chamado com o argumento `-3`) e um path absoluto com
// espaços, sem exigir shell parsing nenhum.

export interface Python3Runtime {
    command: string;
    argsPrefix: string[];
}

const PYTHON3_PROBE_TIMEOUT_MS = 3000;

/**
 * Roda `<command> <argsPrefix> -c <payload>` via execFile (sem shell — array de
 * args, não string; preserva paths com espaços e `py -3` sem split algum) e
 * decide validade só pelo exit code, nunca por texto de stdout/stderr (evita
 * dependência de localização/encoding). Assíncrona: EnvironmentProbe.probe()
 * já é async, e um candidato inválido pode travar (alias, launcher) — usar
 * execFileSync aqui bloquearia o event loop do processo inteiro por até
 * PYTHON3_PROBE_TIMEOUT_MS a cada candidato testado.
 */
function runPython3Check(runtime: Python3Runtime, payload: string): Promise<boolean> {
    return new Promise((resolve) => {
        execFile(
            runtime.command,
            [...runtime.argsPrefix, '-c', payload],
            { timeout: PYTHON3_PROBE_TIMEOUT_MS, windowsHide: true },
            (error) => resolve(!error),
        );
    });
}

/**
 * Valida que o candidato é um runtime Python 3 real e executável — não apenas
 * presente no PATH (which/where só provam presença de um arquivo, nunca que
 * ele interpreta Python, ver Python3Runtime acima). O payload só termina com
 * exit code 0 se o processo realmente interpretar Python e for a major
 * version 3 — decide por exit code, sem parsear "Python 3.x" de --version.
 */
export function probePython3Runtime(runtime: Python3Runtime): Promise<boolean> {
    return runPython3Check(runtime, 'import sys; raise SystemExit(0 if sys.version_info[0] == 3 else 1)');
}

/** Testa se um pacote é importável no runtime Python 3 já resolvido (reutilizável — não resolve runtime de novo). */
export function runPython3Import(runtime: Python3Runtime, pkg: string): Promise<boolean> {
    return runPython3Check(runtime, `import ${pkg}`);
}

/**
 * Candidatos de runtime Python 3 por plataforma, em ordem de preferência.
 * DECISÃO DE POLÍTICA (não é comportamento histórico do NewClaw): no Windows,
 * `py -3` vem primeiro — é o launcher mantido pelo próprio CPython para
 * desambiguar múltiplas instalações, mas nunca foi usado neste projeto antes
 * desta implementação. Em Linux/macOS, `python3` antes de `python` já refletia
 * a escolha que probePyPkgCmd() fazia (mantido, não é novidade ali).
 */
export function defaultPython3Candidates(): Python3Runtime[] {
    if (isWindows) {
        return [
            { command: 'py', argsPrefix: ['-3'] },
            { command: 'python', argsPrefix: [] },
            { command: 'python3', argsPrefix: [] },
        ];
    }
    return [
        { command: 'python3', argsPrefix: [] },
        { command: 'python', argsPrefix: [] },
    ];
}

/**
 * Testa os candidatos em ordem, parando no primeiro validado por probe() (short-circuit —
 * candidatos após o primeiro sucesso nunca são testados). Não é uma função pura em execução
 * real (o parâmetro probe por padrão executa subprocesso via runPython3Check) — é
 * desacoplada de child_process por injeção de dependência e deterministicamente testável
 * com um probe fake, sem precisar mockar child_process.
 */
export async function resolvePython3Runtime(
    candidates: Python3Runtime[],
    probe: (runtime: Python3Runtime) => Promise<boolean> = probePython3Runtime,
): Promise<Python3Runtime | null> {
    for (const candidate of candidates) {
        if (await probe(candidate)) return candidate;
    }
    return null;
}

/** Cross-platform /dev/null path. */
export const devNull = isWindows ? 'nul' : '/dev/null';

/** Redirect stderr to null (shell fragment). */
export const stderrNull = isWindows ? '2>nul' : '2>/dev/null';

/** Cross-platform temp directory (replaces hardcoded /tmp). */
export function tmpDir(): string {
    return os.tmpdir();
}

/**
 * Cross-platform disk usage percentage for a directory.
 * Returns 0–100, or null on failure.
 */
export function diskUsagePercent(targetPath: string = os.homedir()): number | null {
    try {
        if (isWindows) {
            const resolved = path.resolve(targetPath);
            const drive    = path.parse(resolved).root.replace(/\\/g, '').replace(':', '');
            // targetPath (default os.homedir(), lido de USERPROFILE/HOME) chega aqui derivado
            // de env var — nunca interpolar em string de shell (CodeQL
            // js/shell-command-injection-from-environment). execFileSync com array de args não
            // usa shell; drive validado como letra única fecha também manipulação da mini
            // linguagem de query do próprio wmic (where "DeviceID='...'"), não só shell.
            if (!/^[A-Za-z]$/.test(drive)) return null;
            const out = execFileSync(
                'wmic',
                ['logicaldisk', 'where', `DeviceID='${drive}:'`, 'get', 'Size,FreeSpace', '/value'],
                { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 4000, windowsHide: true }
            );
            const free  = parseInt((out.match(/FreeSpace=(\d+)/)  ?? [])[1] ?? '0');
            const total = parseInt((out.match(/Size=(\d+)/)        ?? [])[1] ?? '0');
            if (total > 0) return Math.round(((total - free) / total) * 100);
        } else {
            const out = execFileSync('df', ['-k', targetPath], { encoding: 'utf-8', timeout: 4000 })
                .split('\n').filter(l => l.trim())[1];
            if (out) {
                const parts = out.trim().split(/\s+/);
                const used  = parseInt(parts[2] ?? '0');
                const avail = parseInt(parts[3] ?? '0');
                if (used + avail > 0) return Math.round((used / (used + avail)) * 100);
            }
        }
    } catch { /* ignore */ }
    return null;
}

/**
 * Count Node.js processes whose command line matches a pattern.
 * Returns a number (≥0) or null on error.
 */
export function countNodeProcesses(pattern: string): number | null {
    try {
        if (isWindows) {
            const out = execSync(
                "wmic process where \"Name='node.exe'\" get CommandLine /value",
                { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 4000, windowsHide: true }
            );
            const lines = out.split('\n').filter(l =>
                l.startsWith('CommandLine=') && l.toLowerCase().includes(pattern.toLowerCase())
            );
            return lines.length;
        } else {
            // Escapar só aspas (\") não bastava: backtick e $() ainda são interpretados dentro
            // de aspas duplas por sh/bash, então `pattern` com "$(comando)" executava comando
            // arbitrário (CodeQL js/incomplete-sanitization). Fix estrutural: sem shell/pipe —
            // roda `ps aux` puro via execFileSync e filtra em JS, igual ao branch do Windows já
            // fazia (também unifica a semântica: substring simples nos dois SOs, em vez de
            // regex do grep só no POSIX).
            const out = execFileSync('ps', ['aux'], { encoding: 'utf-8', timeout: 3000 });
            const needle = pattern.toLowerCase();
            const count = out.split('\n').filter(l => l.toLowerCase().includes(needle)).length;
            return count;
        }
    } catch {
        return null;
    }
}

/**
 * Read /etc/os-release to detect Linux distro (Linux only).
 * Returns lowercase distro ID (e.g. "ubuntu", "debian") or undefined.
 */
export function linuxDistro(): string | undefined {
    if (!isLinux) return undefined;
    try {
        const content = fs.readFileSync('/etc/os-release', 'utf-8');
        const m = content.match(/^ID="?([^"\n]+)"?/m);
        return m ? m[1].toLowerCase().trim() : undefined;
    } catch { return undefined; }
}

/**
 * Synchronous sleep using Atomics — no busy-wait, no setTimeout quirks.
 */
export function sleepSync(ms: number): void {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// ─── Resolução de caminhos de arquivo ────────────────────────────────────────
//
// Implementação única compartilhada por write_tool, read_tool, edit_tool,
// send_document e list_workspace. Usa apenas APIs nativas do Node.js.
//
// Estratégia multi-candidato:
//   1. Path absoluto como fornecido (se existir no disco)
//   2. Path relativo ao workspaceDir (strip da barra inicial)
//   3. Fallback /workspace/ → workspaceDir (evita nesting workspace/workspace/)
//   Retorna o primeiro candidato (a) permitido pelo sandbox E (b) existente,
//   ou o primeiro permitido quando o arquivo ainda não existe (operações de escrita).

/**
 * Resolve e valida um caminho dentro do sandbox do workspace.
 *
 * @param inputPath  Caminho bruto recebido do LLM (absoluto, relativo, com ~, com workspace/).
 * @param extraRoots Roots adicionais a permitir no sandbox (ex: ['/custom/dir']).
 * @returns { resolved } ou { resolved, error } quando fora do sandbox.
 */
export function resolvePath(
    inputPath: string,
    { extraRoots = [] }: { extraRoots?: string[] } = {}
): { resolved: string; error?: string } {
    const workspaceDir = path.resolve(process.env.WORKSPACE_DIR ?? path.join(process.cwd(), 'workspace'));
    const homeDir      = os.homedir();
    const tmpDirectory = os.tmpdir();

    let expanded = Array.isArray(inputPath) ? String((inputPath as string[])[0] ?? '') : String(inputPath ?? '');

    // Strip prefixo relativo 'workspace/' (sem barra inicial)
    if (!expanded.startsWith('/') && !expanded.startsWith('\\') && expanded.startsWith('workspace/')) {
        expanded = expanded.slice(10);
    }

    // Expansão ~/
    if (expanded.startsWith('~/')) {
        expanded = path.join(homeDir, expanded.slice(2));
    } else if (expanded.startsWith('@')) {
        expanded = expanded.slice(1);
    }

    /**
     * COMPATIBILIDADE LEGADA
     *
     * Esta lógica existe apenas para suportar caminhos absolutos
     * gerados por versões antigas do NewClaw ou persistidos em
     * memória de sessões anteriores em outra máquina.
     *
     * Origem dos dados afetados:
     * - memórias persistidas com paths da VPS (/home/X/Y/workspace/)
     * - memórias com paths de macOS (/Users/X/Y/workspace/)
     * - paths canônicos históricos (/workspace/Z)
     *
     * Esta NÃO é a lógica principal de resolução de caminhos.
     * A lógica principal usa WORKSPACE_DIR + APIs nativas do Node.js.
     *
     * Garantia de não-regressão (Ubuntu/Linux):
     * Quando o path já pertence ao workspaceDir atual, alreadyLocal=true
     * e nenhuma transformação ocorre — o path é retornado sem alteração.
     *
     * QUANDO REMOVER:
     * Quando a memória persistida não contiver mais nenhum nó com
     * paths do tipo /home/.../workspace/ ou /Users/.../workspace/.
     * Verificação: memory_admin + busca por conteúdo com '/workspace/'.
     *
     * Regex em vez de lastIndexOf('/workspace/'): o lastIndexOf exigia "/workspace/" com barra
     * final, então um path SEM nada depois de "workspace" (ex: "/home/x/y/workspace", uma
     * referência ao diretório em si, sem arquivo) não casava — caía no fallback genérico mais
     * abaixo e virava "<workspaceDir>/home/x/y/workspace" (pasta aninhada de verdade dentro do
     * workspace real). Reproduzido ao vivo via exec_command em 01/07 (mesmo bug, correção já
     * validada lá — replicada aqui na fonte canônica). `.*` guloso preserva o comportamento de
     * lastIndexOf de pegar a ÚLTIMA ocorrência de "/workspace". O grupo `(?:\/(.*))?$` só casa
     * quando o que segue "/workspace" é "/resto" ou fim de string — isso sozinho já evita casar
     * dentro de "workspace2" (nome de pasta diferente, não é o workspace real): nem "/" nem fim
     * de string vêm logo depois do "e" de "workspace2".
     */
    const wsMatch = expanded.match(/^(.*)\/workspace(?:\/(.*))?$/);
    const alreadyLocal = expanded.startsWith(workspaceDir + path.sep) || expanded === workspaceDir;
    if (wsMatch && !alreadyLocal) {
        expanded = path.join(workspaceDir, wsMatch[2] ?? '');
    }

    const allowedRoots = [
        workspaceDir,
        tmpDirectory,
        path.join(process.cwd(), 'workspace'),
        path.join(process.cwd(), 'logs'),
        path.join(process.cwd(), 'data'),
        homeDir,
        ...extraRoots,
    ];

    const checkAllowed = (p: string): boolean =>
        allowedRoots.some(root => {
            const rel = path.relative(root, p);
            return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
        });

    // "slice(1)" assume um path estilo Unix (/etc/passwd → etc/passwd, tentado dentro do
    // sandbox). Um path Windows com drive letter (D:\...) NÃO deve gerar esse candidato:
    // slice(1) cortaria a letra do drive (não a barra), produzindo "​:\resto\do\path" — que
    // path.resolve(workspaceDir, ...) junta como se fosse relativo, criando um candidato
    // absurdo mas que cai (por acidente) dentro do workspaceDir e passa no checkAllowed.
    // Isso permitia que um path absoluto real apontando para fora do sandbox (ex: o próprio
    // src/ do NewClaw) escapasse tanto da rejeição de sandbox quanto do selfEditError, que só
    // inspeciona o path resolvido — nunca alcançado porque o candidato errado "resolvia" antes.
    const hasWindowsDriveLetter = /^[a-zA-Z]:/.test(expanded);
    const candidates: string[] = path.isAbsolute(expanded)
        ? [
            path.normalize(expanded),
            ...(hasWindowsDriveLetter ? [] : [path.resolve(workspaceDir, expanded.slice(1))]),
            ...(expanded.startsWith('/workspace/')
                ? [path.resolve(workspaceDir, expanded.slice(11))]
                : []),
          ]
        : [path.resolve(workspaceDir, expanded)];

    const unique = [...new Set(candidates)];

    // Fase 1: candidato permitido que já existe no disco
    for (const c of unique) {
        if (checkAllowed(c) && fs.existsSync(c)) return { resolved: c };
    }
    // Fase 2: candidato permitido (arquivo ainda não existe — operações de escrita)
    for (const c of unique) {
        if (checkAllowed(c)) return { resolved: c };
    }

    return {
        resolved: unique[0] ?? inputPath,
        error: `⛔ Caminho fora do sandbox: ${inputPath} → tentados: ${unique.join(', ')}`,
    };
}

/**
 * Verifica se o caminho resolvido aponta para o código-fonte do próprio NewClaw.
 * Retorna string de erro se bloqueado, null se permitido.
 * Usado por write_tool e edit_tool para impedir auto-edição.
 */
export function selfEditError(resolved: string): string | null {
    const root = process.cwd();
    const blocked = [
        path.join(root, 'src'),
        path.join(root, 'dist'),
        path.join(root, 'bin'),
        path.join(root, '.env'),
    ];
    if (blocked.some(b => resolved === b || resolved.startsWith(b + path.sep))) {
        return `⛔ BLOCKED: Não pode modificar código próprio do NewClaw (${resolved})`;
    }
    return null;
}
