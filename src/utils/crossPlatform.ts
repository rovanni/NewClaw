/**
 * crossPlatform.ts — Utilitários cross-platform para Windows, Linux e macOS.
 *
 * Substitui chamadas Unix-only (which, ps aux, df, /tmp, etc.) por
 * equivalentes Node.js portáveis. Importe daqui em vez de usar execSync
 * com comandos de shell específicos de plataforma.
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
