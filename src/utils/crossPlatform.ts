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

import { execSync, execFileSync } from 'child_process';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

export const isWindows = process.platform === 'win32';
export const isMac     = process.platform === 'darwin';
export const isLinux   = process.platform === 'linux';

/** Cross-platform equivalent of `which` / `where`. Returns full path or null. */
export function which(cmd: string): string | null {
    try {
        const bin    = isWindows ? 'where.exe' : 'which';
        const result = execFileSync(bin, [cmd], {
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
            timeout: 3000,
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

/**
 * Build a Python package probe one-liner.
 * Prints "PYPKG_OK:<pkg>" or "PYPKG_MISSING:<pkg>".
 */
export function probePyPkgCmd(pkg: string): string {
    const py = isWindows ? 'python' : 'python3';
    if (isWindows) {
        return `${py} -c "import ${pkg}" 2>nul && echo PYPKG_OK:${pkg} || echo PYPKG_MISSING:${pkg}`;
    }
    return `${py} -c "import ${pkg}" 2>/dev/null && echo "PYPKG_OK:${pkg}" || echo "PYPKG_MISSING:${pkg}"`;
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
            const out = execSync(
                `wmic logicaldisk where "DeviceID='${drive}:'" get Size,FreeSpace /value`,
                { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 4000 }
            );
            const free  = parseInt((out.match(/FreeSpace=(\d+)/)  ?? [])[1] ?? '0');
            const total = parseInt((out.match(/Size=(\d+)/)        ?? [])[1] ?? '0');
            if (total > 0) return Math.round(((total - free) / total) * 100);
        } else {
            const out = execSync(`df -k "${targetPath}"`, { encoding: 'utf-8', timeout: 4000 })
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
                { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 4000 }
            );
            const lines = out.split('\n').filter(l =>
                l.startsWith('CommandLine=') && l.toLowerCase().includes(pattern.toLowerCase())
            );
            return lines.length;
        } else {
            const result = execSync(
                `ps aux | grep -c "${pattern.replace(/"/g, '\\"')}" || echo 0`,
                { encoding: 'utf-8', timeout: 3000 }
            );
            return parseInt(result.trim()) || 0;
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
     */
    const wsIdx = expanded.lastIndexOf('/workspace/');
    const alreadyLocal = expanded.startsWith(workspaceDir + path.sep) || expanded === workspaceDir;
    if (wsIdx !== -1 && !alreadyLocal) {
        expanded = path.join(workspaceDir, expanded.slice(wsIdx + '/workspace/'.length));
    } else if (expanded === '/workspace') {
        expanded = workspaceDir;
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

    const candidates: string[] = path.isAbsolute(expanded)
        ? [
            path.normalize(expanded),
            path.resolve(workspaceDir, expanded.slice(1)),
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
