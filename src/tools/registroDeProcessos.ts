/**
 * Registro dos comandos do exec_command que seguem rodando em SEGUNDO PLANO (ADR-025). Um por processo do NewClaw.
 *
 * Por quê (pesquisa de 16/10/2026 — OpenClaw, Hermes Agent, Claude Code): um comando que demora não é cortado; vai para
 * segundo plano e o agente acompanha (consultar / aguardar / encerrar). O trabalho em andamento não se perde, e o resultado
 * de um comando que terminou fica disponível para quem consultar depois.
 *
 * Proteções: o teto do comando (o que resta ao objetivo — ADR-023) e o "Parar" continuam encerrando a árvore; ao sair, o
 * NewClaw encerra o que ainda estiver rodando (nenhum processo fica órfão). Resultados terminados são mantidos por tempo
 * limitado e em número limitado.
 */
import { execFileSync } from 'child_process';
import type { ToolResult } from '../loop/agentLoopTypes';

export interface ProcessoRegistrado {
    numero: number;
    comando: string;
    inicio: number;
    pid?: number;
    /** Saída acumulada até agora (stdout + stderr, já decodificada). */
    saida: () => string;
    /** Momento do último sinal de atividade (saída, CPU ou E/S). */
    ultimoSinal: () => number;
    /** O resultado final, quando terminar (ou for encerrado). */
    fim: Promise<ToolResult>;
    terminou: boolean;
    resultado?: ToolResult;
    terminouEm?: number;
    encerrar: () => void;
}

/** Quantos resultados terminados ficam guardados, e por quanto tempo. */
const MAX_TERMINADOS = 64;
const RETER_TERMINADOS_MS = 6 * 60 * 60 * 1000;

class RegistroDeProcessos {
    private proximo = 1;
    private processos = new Map<number, ProcessoRegistrado>();
    private ganchoDeSaida = false;

    registrar(p: Omit<ProcessoRegistrado, 'numero' | 'terminou'>): ProcessoRegistrado {
        this.limpar();
        const reg: ProcessoRegistrado = { ...p, numero: this.proximo++, terminou: false };
        this.processos.set(reg.numero, reg);
        // Ao terminar, guarda só o RESULTADO (≤ 16 mil caracteres) — o buffer da saída (até 1 MB) é liberado.
        reg.fim.then((r) => { reg.terminou = true; reg.resultado = r; reg.terminouEm = Date.now(); reg.saida = () => r.output; })
            .catch(() => { reg.terminou = true; reg.terminouEm = Date.now(); reg.saida = () => ''; });
        this.garantirGanchoDeSaida();
        return reg;
    }

    obter(numero: number): ProcessoRegistrado | undefined { return this.processos.get(numero); }

    /** Tira do registro (comando que terminou a tempo, sem ir para segundo plano: ninguém vai consultá-lo). */
    remover(numero: number): void { this.processos.delete(numero); }

    rodando(): ProcessoRegistrado[] { return [...this.processos.values()].filter(p => !p.terminou); }

    private limpar(): void {
        const agora = Date.now();
        const terminados = [...this.processos.values()].filter(p => p.terminou).sort((a, b) => (a.terminouEm ?? 0) - (b.terminouEm ?? 0));
        for (const p of terminados) if (agora - (p.terminouEm ?? agora) > RETER_TERMINADOS_MS) this.processos.delete(p.numero);
        const restantes = [...this.processos.values()].filter(p => p.terminou);
        for (const p of restantes.slice(0, Math.max(0, restantes.length - MAX_TERMINADOS))) this.processos.delete(p.numero);
    }

    /** Ao sair, encerra (de forma síncrona) a árvore de tudo o que ainda roda — nenhum processo órfão. */
    private garantirGanchoDeSaida(): void {
        if (this.ganchoDeSaida) return;
        this.ganchoDeSaida = true;
        process.once('exit', () => {
            for (const p of this.rodando()) {
                if (!p.pid) continue;
                try {
                    if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
                    else process.kill(-p.pid, 'SIGKILL');
                } catch { /* já saiu */ }
            }
        });
    }
}

export const registroDeProcessos = new RegistroDeProcessos();
