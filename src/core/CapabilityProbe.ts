/**
 * CapabilityProbe — Sondas leves do ambiente de execução.
 *
 * Executa verificações reais e não-destrutivas usando Node.js built-ins
 * (fs, child_process, dns) — sem passar pela camada de ferramentas do LLM.
 * Isso garante que as capabilities sejam detectadas antes de qualquer
 * planejamento, sem consumir tokens nem depender do ToolRegistry.
 *
 * Escopo: workspace (fs), rede (dns), execução (shell).
 * Detecção de ferramentas do sistema é delegada ao EnvironmentProbe
 * (que usa exec_command com suporte a SSH remoto).
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import dns from 'dns';
import os from 'os';
import { promisify } from 'util';
import { CapabilityStatus, WorkspaceCapabilities, NetworkCapabilities, ExecutionCapabilities, OSCapabilities, HardwareCapabilities, RuntimeCapabilities } from './CapabilityTypes';
import { createLogger } from '../shared/AppLogger';

const log = createLogger('CapabilityProbe');
const dnsLookup = promisify(dns.lookup);

// ── Utilitários internos ────────────────────────────────────────────────────

function runSafe(cmd: string, timeoutMs = 3000): string | null {
    try {
        return execSync(cmd, {
            timeout: timeoutMs,
            stdio: ['ignore', 'pipe', 'ignore'],
            encoding: 'utf8',
        }).trim();
    } catch {
        return null;
    }
}

function makeStatus(available: boolean, details?: string): CapabilityStatus {
    return {
        available,
        confidence: 0.99,
        source: 'probe',
        checkedAt: Date.now(),
        details,
    };
}

// ── CapabilityProbe ─────────────────────────────────────────────────────────

export class CapabilityProbe {

    /**
     * Verifica acesso real ao diretório do workspace via fs.
     *
     * - Lê entradas da raiz para detectar tamanho e subpastas
     * - Não tenta listar recursivamente (seria lento em workspace grande)
     * - restrictedPaths reflete os bloqueios do sandbox das ferramentas
     */
    probeWorkspace(): WorkspaceCapabilities {
        const root = process.env.WORKSPACE_DIR || path.join(process.cwd(), 'workspace');
        const now = Date.now();

        let canRead = false;
        let canWrite = false;
        let entryCount = 0;
        const knownSubdirs: string[] = [];

        try {
            fs.accessSync(root, fs.constants.R_OK);
            canRead = true;

            const entries = fs.readdirSync(root, { withFileTypes: true });
            entryCount = entries.length;
            for (const e of entries) {
                if (e.isDirectory()) {
                    knownSubdirs.push(e.name);
                    if (knownSubdirs.length >= 20) break;
                }
            }
        } catch (err) {
            log.warn(`[CapabilityProbe] workspace read probe: ${err}`);
        }

        try {
            fs.accessSync(root, fs.constants.W_OK);
            canWrite = true;
        } catch {
            // not writable — silently record
        }

        // Paths bloqueados pelas ferramentas (sandbox). Espelha a lógica de
        // edit_tool.ts / write_tool.ts para que o agente saiba antes de tentar.
        const projectRoot = process.cwd();
        const restrictedPaths = [
            path.join(projectRoot, 'src'),
            path.join(projectRoot, '.env'),
            path.join(projectRoot, 'node_modules'),
            path.join(projectRoot, 'dist'),
        ];

        return { root, canRead, canWrite, entryCount, knownSubdirs, restrictedPaths, checkedAt: now };
    }

    /**
     * Verifica acesso à internet via DNS lookup (leve, sem criar conexão HTTP).
     * Verifica localhost via curl para detectar API local do NewClaw.
     */
    async probeNetwork(): Promise<NetworkCapabilities> {
        const now = Date.now();

        // Outbound: DNS lookup é mais rápido e seguro que uma requisição HTTP
        let outbound = false;
        try {
            await Promise.race([
                dnsLookup('google.com'),
                new Promise<never>((_, rej) =>
                    setTimeout(() => rej(new Error('dns timeout')), 2500)
                ),
            ]);
            outbound = true;
        } catch {
            // sem internet
        }

        // Localhost: testa a API interna do NewClaw se estiver rodando
        const port = process.env.PORT ?? '3090';
        const localOut = runSafe(
            `curl -s -o /dev/null -w "%{http_code}" http://localhost:${port}/health --max-time 1`,
            2000,
        );
        const localhostOk = localOut !== null && localOut !== '' && localOut !== '000';

        return {
            outboundHttp: makeStatus(outbound),
            localhostHttp: makeStatus(localhostOk),
            checkedAt: now,
        };
    }

    /**
     * Verifica gerenciadores de pacotes e privilégios de execução.
     * Usa comandos passivos (--version, -n) sem efeitos colaterais.
     */
    probeExecution(): ExecutionCapabilities {
        const now = Date.now();

        const pipOut  = runSafe('pip3 --version');
        const npmOut  = runSafe('npm --version');
        // sudo -n true: testa sudo sem senha; falha silenciosamente se não permitido
        const sudoOut = runSafe('sudo -n true 2>/dev/null && echo yes || echo no');

        return {
            pip:  makeStatus(pipOut !== null, pipOut ?? undefined),
            npm:  makeStatus(npmOut !== null, npmOut ?? undefined),
            sudo: makeStatus(sudoOut?.trim() === 'yes'),
            checkedAt: now,
        };
    }

    /**
     * Detecta sistema operacional, shell e gerenciador de pacotes.
     * Usa process.platform + os module — sem execuções externas pesadas.
     */
    probeOS(): OSCapabilities {
        const plat = process.platform;
        const architecture = process.arch;
        const now = Date.now();

        let platform: 'windows' | 'linux' | 'macos';
        let shell: string;
        let tempDirectory: string;
        let pathSeparator: string;
        let executableExtension: string;
        let distro: string | undefined;
        let packageManager: string | undefined;

        if (plat === 'win32') {
            platform = 'windows';
            shell = 'powershell';
            tempDirectory = process.env['TEMP'] ?? process.env['TMP'] ?? 'C:\\Windows\\Temp';
            pathSeparator = '\\';
            executableExtension = '.exe';
            packageManager = runSafe('choco --version', 2000) ? 'choco'
                           : runSafe('winget --version', 2000) ? 'winget'
                           : undefined;
        } else if (plat === 'darwin') {
            platform = 'macos';
            shell = process.env['SHELL'] ?? '/bin/zsh';
            tempDirectory = '/tmp';
            pathSeparator = '/';
            executableExtension = '';
            packageManager = runSafe('which brew', 1000) ? 'brew' : undefined;
        } else {
            platform = 'linux';
            shell = process.env['SHELL'] ?? '/bin/bash';
            tempDirectory = '/tmp';
            pathSeparator = '/';
            executableExtension = '';

            // Detecção de distro: lsb_release → /etc/os-release
            const lsb = runSafe('lsb_release -si 2>/dev/null', 2000);
            if (lsb) {
                distro = lsb.toLowerCase().trim();
            } else {
                const rel = runSafe('cat /etc/os-release 2>/dev/null | grep "^ID=" | cut -d= -f2', 2000);
                if (rel) distro = rel.replace(/"/g, '').toLowerCase().trim();
            }

            // Gerenciador de pacotes
            if      (runSafe('which apt-get 2>/dev/null', 1000)) packageManager = 'apt';
            else if (runSafe('which yum 2>/dev/null', 1000))     packageManager = 'yum';
            else if (runSafe('which pacman 2>/dev/null', 1000))  packageManager = 'pacman';
            else if (runSafe('which apk 2>/dev/null', 1000))     packageManager = 'apk';
        }

        return { platform, architecture, shell, tempDirectory, pathSeparator, executableExtension, distro, packageManager, checkedAt: now };
    }

    /**
     * Detecta recursos de hardware: CPU, RAM, disco, GPU.
     * Usa os module para CPU/RAM (sem execução), execSync para disco e GPU.
     */
    probeHardware(): HardwareCapabilities {
        const now = Date.now();
        const cpuCores     = os.cpus().length;
        const totalMemoryMB = Math.round(os.totalmem()  / 1024 / 1024);
        const freeMemoryMB  = Math.round(os.freemem()  / 1024 / 1024);

        // Disco: df para Unix, wmic para Windows
        let diskFreeMB = 0;
        if (process.platform === 'win32') {
            const out = runSafe('wmic logicaldisk where drivetype=3 get freespace /value 2>nul', 3000);
            const m   = out?.match(/FreeSpace=(\d+)/);
            if (m) diskFreeMB = Math.round(parseInt(m[1]) / 1024 / 1024);
        } else {
            const out = runSafe("df -m / 2>/dev/null | awk 'NR==2{print $4}'", 2000);
            if (out) diskFreeMB = parseInt(out.trim()) || 0;
        }

        // GPU: nvidia-smi (Linux/Win); fallback wmic no Windows
        let gpuAvailable = false;
        let gpuName: string | undefined;
        let gpuMemoryMB: number | undefined;

        const nvidiaOut = runSafe('nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits 2>/dev/null', 3000);
        if (nvidiaOut?.trim()) {
            const parts = nvidiaOut.split(',').map(s => s.trim());
            if (parts[0]) {
                gpuAvailable = true;
                gpuName      = parts[0];
                gpuMemoryMB  = parseInt(parts[1] ?? '0') || undefined;
            }
        }

        if (!gpuAvailable && process.platform === 'win32') {
            const wmicOut = runSafe('wmic path win32_videocontroller get name /value 2>nul', 2000);
            const m = wmicOut?.match(/Name=(.+)/);
            if (m && m[1] && !/Microsoft Basic|Standard VGA/i.test(m[1])) {
                gpuAvailable = true;
                gpuName      = m[1].trim();
            }
        }

        return { cpuCores, totalMemoryMB, freeMemoryMB, diskFreeMB, gpuAvailable, gpuName, gpuMemoryMB, checkedAt: now };
    }

    /**
     * Detecta ambiente de runtime: container, virtualização, versão do Node.
     * Usa fs.existsSync + execSync passivo — sem efeitos colaterais.
     */
    probeRuntime(): RuntimeCapabilities {
        const now = Date.now();
        let containerized = false;
        let virtualization: string | undefined;

        if (process.platform !== 'win32') {
            // Presença de /.dockerenv é o sinal mais confiável para Docker
            try {
                if (fs.existsSync('/.dockerenv')) {
                    containerized = true;
                    virtualization = 'docker';
                }
            } catch { /* sem permissão — assume não-container */ }

            if (!containerized) {
                const cgroup = runSafe('cat /proc/1/cgroup 2>/dev/null | head -5', 1000) ?? '';
                if      (cgroup.includes('docker') || cgroup.includes('containerd')) { containerized = true; virtualization = 'docker'; }
                else if (cgroup.includes('kubepods'))                                  { containerized = true; virtualization = 'kubernetes'; }
                else if (cgroup.includes('lxc'))                                       { containerized = true; virtualization = 'lxc'; }
            }
        }

        return {
            containerized,
            virtualization,
            nodeVersion: process.version,
            maxFileSizeMB: 100,
            checkedAt: now,
        };
    }
}
