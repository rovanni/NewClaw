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
import { promisify } from 'util';
import { CapabilityStatus, WorkspaceCapabilities, NetworkCapabilities, ExecutionCapabilities } from './CapabilityTypes';
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
}
