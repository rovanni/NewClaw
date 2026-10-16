/**
 * Atividade da árvore de processos de um comando — CPU e E/S (disco + rede) — para responder "ainda está trabalhando?"
 * (ADR-023). Só MEDE; quem decide o que fazer com a medição é o exec_command.
 *
 * Medido em 16/10/2026 (Windows e Linux): quem trabalha calado (npm, pip, git, cálculo, disco) nunca ficou mais de 2 s sem
 * CPU nem E/S; quem travou ficou sem nada o tempo todo. O custo decide o jeito de medir:
 *   - Linux: ler /proc (grupo de processos do comando) — 7–8 ms por amostra;
 *   - Windows: funções do próprio sistema (CreateToolhelp32Snapshot, GetProcessTimes, GetProcessIoCounters) num PowerShell
 *     aberto UMA vez por processo do NewClaw — ~34 ms por amostra (uma consulta CIM custava 470 ms; um PowerShell novo
 *     por amostra, 2,5 s);
 *   - demais sistemas (ex.: macOS, ainda não medido): sem amostrador — `null`, e o chamador declara que só a saída contou.
 * Nunca inventa um sinal: falhou a medição, a amostra é `null`.
 */
import * as fs from 'fs';
import { spawn, ChildProcess } from 'child_process';
import { createLogger } from '../shared/AppLogger';

const log = createLogger('AtividadeDoProcesso');

export interface AmostraDeAtividade {
    /** Tempo de CPU acumulado da árvore (ms). */
    cpuMs: number;
    /** Bytes lidos + escritos acumulados pela árvore (disco, rede, dispositivos). */
    ioBytes: number;
    /** Processos encontrados na árvore. */
    processos: number;
}

export interface Amostrador {
    /** De onde vem a medição — vai para o resultado e para o log. */
    readonly fonte: string;
    amostrar(pidRaiz: number): Promise<AmostraDeAtividade | null>;
}

// ── Linux: /proc ────────────────────────────────────────────────────────────────────────────────────────────────────
// O comando nasce num grupo próprio (detached) cujo id é o pid do shell: todos os processos do grupo são a árvore.
const amostradorLinux: Amostrador = {
    fonte: '/proc (CPU e E/S do grupo de processos)',
    async amostrar(pidRaiz: number): Promise<AmostraDeAtividade | null> {
        let processos = 0, ticks = 0, io = 0;
        let nomes: string[];
        try { nomes = fs.readdirSync('/proc'); } catch { return null; }
        for (const d of nomes) {
            if (!/^\d+$/.test(d)) continue;
            try {
                const st = fs.readFileSync(`/proc/${d}/stat`, 'utf8');
                const campos = st.slice(st.lastIndexOf(')') + 2).split(' ');
                if (Number(campos[2]) !== pidRaiz) continue;   // pgrp
                processos++;
                ticks += Number(campos[11]) + Number(campos[12]);   // utime + stime
                const ioTxt = fs.readFileSync(`/proc/${d}/io`, 'utf8');
                io += Number(/rchar: (\d+)/.exec(ioTxt)?.[1] ?? 0) + Number(/wchar: (\d+)/.exec(ioTxt)?.[1] ?? 0);
            } catch { /* o processo saiu entre a listagem e a leitura */ }
        }
        return processos > 0 ? { cpuMs: ticks * 10, ioBytes: io, processos } : null;
    },
};

// ── Windows: funções nativas num PowerShell persistente ─────────────────────────────────────────────────────────────
const CODIGO_CS = `using System; using System.Collections.Generic; using System.Runtime.InteropServices;
public static class NcAtividade {
  [StructLayout(LayoutKind.Sequential)] public struct IO { public ulong ro, wo, oo, rb, wb, ob; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] public struct PE32 {
    public uint dwSize, cntUsage, th32ProcessID; public IntPtr th32DefaultHeapID; public uint th32ModuleID, cntThreads, th32ParentProcessID; public int pcPriClassBase; public uint dwFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile; }
  [DllImport("kernel32.dll")] static extern IntPtr CreateToolhelp32Snapshot(uint f, uint pid);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32FirstW(IntPtr s, ref PE32 e);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32NextW(IntPtr s, ref PE32 e);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint a, bool h, int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] static extern bool GetProcessIoCounters(IntPtr h, out IO io);
  [DllImport("kernel32.dll")] static extern bool GetProcessTimes(IntPtr h, out long c, out long e, out long k, out long u);
  public static string Medir(int raiz) {
    var filhos = new Dictionary<uint, List<uint>>();
    var s = CreateToolhelp32Snapshot(2, 0); var e = new PE32(); e.dwSize = (uint)Marshal.SizeOf(typeof(PE32));
    if (Process32FirstW(s, ref e)) do { List<uint> l; if (!filhos.TryGetValue(e.th32ParentProcessID, out l)) { l = new List<uint>(); filhos[e.th32ParentProcessID] = l; } l.Add(e.th32ProcessID); } while (Process32NextW(s, ref e));
    CloseHandle(s);
    var arv = new List<int> { raiz };
    for (int i = 0; i < arv.Count; i++) { List<uint> l; if (filhos.TryGetValue((uint)arv[i], out l)) foreach (var f in l) if (f != 0 && !arv.Contains((int)f)) arv.Add((int)f); }
    double cpu = 0, io = 0; int n = 0;
    foreach (var p in arv) { var h = OpenProcess(0x1000, false, p); if (h == IntPtr.Zero) continue; n++;
      long c, x1, k, u; if (GetProcessTimes(h, out c, out x1, out k, out u)) cpu += k + u;
      IO x; if (GetProcessIoCounters(h, out x)) io += x.rb + x.wb + x.ob; CloseHandle(h); }
    return n + " " + cpu + " " + io; }
}`;
const FIM = '@@NC_FIM@@';

class AmostradorWindows implements Amostrador {
    readonly fonte = 'funções do Windows (CPU e E/S da árvore de processos)';
    private ps?: ChildProcess;
    private pronto?: Promise<boolean>;
    private buffer = '';
    private fila: Array<(linha: string | null) => void> = [];
    private desligado = false;

    private iniciar(): Promise<boolean> {
        if (this.pronto) return this.pronto;
        this.pronto = new Promise<boolean>((resolve) => {
            try {
                const ps = spawn('powershell.exe', ['-NoProfile', '-NoLogo', '-NonInteractive', '-Command', '-'], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
                this.ps = ps;
                // Não segura o NewClaw vivo: é um auxiliar, morre sozinho quando a entrada dele fecha (fim do processo pai).
                ps.unref();
                (ps.stdin as unknown as { unref?: () => void })?.unref?.();
                (ps.stdout as unknown as { unref?: () => void })?.unref?.();
                ps.stdout?.setEncoding('utf8');
                ps.stdout?.on('data', (d: string) => {
                    this.buffer += d;
                    let i: number;
                    while ((i = this.buffer.indexOf(FIM)) >= 0) {
                        const linha = this.buffer.slice(0, i).trim();
                        this.buffer = this.buffer.slice(i + FIM.length);
                        this.fila.shift()?.(linha);
                    }
                });
                const morreu = () => { this.ps = undefined; this.pronto = undefined; for (const f of this.fila.splice(0)) f(null); };
                ps.on('exit', morreu);
                ps.on('error', () => { morreu(); resolve(false); });
                const fonteB64 = Buffer.from(CODIGO_CS, 'utf8').toString('base64');
                this.perguntar(`Add-Type -TypeDefinition ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${fonteB64}'))); 'ok'`, 30_000)
                    .then((r) => {
                        const ok = r === 'ok';
                        if (!ok) { log.warn(`[ATIVIDADE] amostrador do Windows indisponível (resposta: ${String(r).slice(0, 120)}) — só a saída do comando será observada`); this.desligado = true; }
                        resolve(ok);
                    });
            } catch (e) {
                log.warn(`[ATIVIDADE] amostrador do Windows não iniciou: ${String(e).slice(0, 120)} — só a saída do comando será observada`);
                this.desligado = true;
                resolve(false);
            }
        });
        return this.pronto;
    }

    private perguntar(cmd: string, prazoMs: number): Promise<string | null> {
        return new Promise((resolve) => {
            if (!this.ps?.stdin) { resolve(null); return; }
            let feito = false;
            const responder = (linha: string | null) => { if (!feito) { feito = true; clearTimeout(t); resolve(linha); } };
            const t = setTimeout(() => {
                // Sem resposta no prazo: a resposta atrasada não pode ser entregue à pergunta seguinte — descarta a sessão.
                const i = this.fila.indexOf(responder);
                if (i >= 0) this.fila.splice(i, 1);
                try { this.ps?.kill(); } catch { /* já saiu */ }
                responder(null);
            }, prazoMs);
            t.unref();
            this.fila.push(responder);
            this.ps.stdin.write(`${cmd}; '${FIM}'\n`);
        });
    }

    async amostrar(pidRaiz: number): Promise<AmostraDeAtividade | null> {
        if (this.desligado) return null;
        if (!(await this.iniciar())) return null;
        const r = await this.perguntar(`[NcAtividade]::Medir(${Math.trunc(pidRaiz)})`, 5000);
        if (!r) return null;
        const [n, cpu100ns, io] = r.split(/\s+/).map(Number);
        if (![n, cpu100ns, io].every(Number.isFinite) || n === 0) return null;
        return { cpuMs: cpu100ns / 1e4, ioBytes: io, processos: n };
    }
}

const semAmostrador: Amostrador = { fonte: 'nenhuma (só a saída do comando)', async amostrar() { return null; } };

let doProcesso: Amostrador | undefined;
/** O amostrador desta plataforma (um por processo do NewClaw). */
export function amostradorDaPlataforma(): Amostrador {
    if (!doProcesso) {
        doProcesso = process.platform === 'linux' ? amostradorLinux
            : process.platform === 'win32' ? new AmostradorWindows()
            : semAmostrador;
    }
    return doProcesso;
}
