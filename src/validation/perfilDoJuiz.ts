/**
 * Perfil de comportamento do modelo COMO JUIZ — aprendido pelo uso, nunca escrito à mão (ADR-016).
 *
 * Os modelos de hoje respondem a um pedido de julgamento de jeitos muito diferentes, e o código não pode (nem deve) saber
 * quem é quem pelo nome: uns raciocinam num canal separado e podem não parar (65–95 mil caracteres, 240 s, nenhum JSON);
 * outros, com o raciocínio desligado, escrevem a análise dentro do conteúdo (7–67 mil caracteres antes do JSON); outros
 * respondem direto em JSON em segundos. O que o código observa de cada chamada — saiu um veredito válido? em quanto tempo?
 * — é o que decide como chamar da próxima vez: o MODO (raciocínio do provedor ou desligado) que funcionou para aquele modelo
 * passa a ser o primeiro; e um modelo que vem falhando seguidamente como juiz deixa de gastar minutos do usuário (disjuntor).
 *
 * Módulo-folha: só dados e aritmética. Persistência opcional num JSON local (dados do uso, fora do código-fonte).
 */
import * as fs from 'fs';
import * as path from 'path';

export type ModoDoJuiz = 'livre' | 'desligado';
const MODOS: readonly ModoDoJuiz[] = ['livre', 'desligado'];

interface EstatisticaDoModo {
    /** Chamadas feitas neste modo. */
    n: number;
    /** Quantas produziram um veredito válido. */
    ok: number;
    /** Tempo típico (média móvel) das chamadas que deram certo. */
    msOk?: number;
    /** Falhas seguidas, até agora (zera no primeiro sucesso). */
    falhasSeguidas: number;
    /** Quando ocorreu a última falha (epoch ms). */
    ultimaFalha?: number;
}

/** Medição padronizada pedida pelo operador na tela (sempre o MESMO caso pequeno): comparável entre modelos, ao contrário do tempo de uso. */
export interface Sondagem {
    /** Quanto o juiz levou para responder ao caso padrão (ms). */
    ms: number;
    /** Chegou a um veredito? */
    ok: boolean;
    /** Quando foi medido (epoch ms). */
    em: number;
}

interface PerfilDoModelo extends Record<ModoDoJuiz, EstatisticaDoModo> {
    sondagem?: Sondagem;
}

/** Acima disto, para um caso pequeno e padronizado, o modelo é lento demais para ser juiz (cada resposta passa por ele). */
export const LIMITE_JUIZ_RAPIDO_MS = 15_000;

const novoModo = (): EstatisticaDoModo => ({ n: 0, ok: 0, falhasSeguidas: 0 });
const novoPerfil = (): PerfilDoModelo => ({ livre: novoModo(), desligado: novoModo() });

/** Falhas seguidas, em TODOS os modos, a partir das quais o modelo é tratado como indisponível para julgar. */
export const FALHAS_PARA_DISJUNTOR = 2;
/** Quanto tempo o disjuntor fica aberto antes de deixar passar uma sondagem. */
export const DISJUNTOR_MS = 5 * 60_000;

/** O que o provedor DECLARA de um modelo (ex.: o Ollama devolve `capabilities`: thinking, tools, vision…). */
export interface CapacidadesDeclaradas {
    /** O modelo tem um canal de raciocínio que dá para ligar/desligar. Falso = não há o que alternar. */
    raciocinio: boolean;
}
export type ResolvedorDeCapacidades = (modelo: string) => Promise<CapacidadesDeclaradas | undefined>;

export class PerfilDoJuiz {
    private readonly porModelo = new Map<string, PerfilDoModelo>();
    private arquivo?: string;
    private resolvedor?: ResolvedorDeCapacidades;

    /**
     * Liga a descoberta de capacidades (o contrato que o provedor declara — o princípio do MCP: o cliente descobre o que o
     * servidor suporta em vez de adivinhar). Quem sabe de onde vêm as capacidades (o catálogo de modelos) injeta aqui.
     */
    definirResolvedorDeCapacidades(r: ResolvedorDeCapacidades | undefined): void { this.resolvedor = r; }

    /**
     * Os modos que fazem sentido tentar para este modelo, em ordem. Capacidade DECLARADA primeiro: um modelo que declara não
     * ter raciocínio não tem o que alternar — um modo só (nada de segunda chamada igual à primeira). Sem declaração, valem os
     * dois, na ordem do que funcionou (comportamento OBSERVADO).
     */
    async modosParaTentar(chave: string, preferido: ModoDoJuiz): Promise<ModoDoJuiz[]> {
        let declaradas: CapacidadesDeclaradas | undefined;
        try { declaradas = this.resolvedor && chave ? await this.resolvedor(chave) : undefined; } catch { declaradas = undefined; }
        if (declaradas && declaradas.raciocinio === false) return ['livre'];
        return this.ordemDosModos(chave, preferido);
    }

    constructor(arquivo?: string, private readonly agora: () => number = Date.now) {
        if (arquivo) this.persistirEm(arquivo);
    }

    /** Este perfil guarda o aprendizado em disco (o do processo, ligado no boot)? */
    get persistente(): boolean { return this.arquivo !== undefined; }

    /** Liga a persistência e carrega o que já foi aprendido. Nunca lança: perfil é conveniência, não requisito. */
    persistirEm(arquivo: string): void {
        this.arquivo = arquivo;
        try {
            if (!fs.existsSync(arquivo)) return;
            const bruto = JSON.parse(fs.readFileSync(arquivo, 'utf8')) as Record<string, Partial<PerfilDoModelo>>;
            for (const [chave, p] of Object.entries(bruto)) {
                const perfil = novoPerfil();
                for (const m of MODOS) if (p?.[m]) perfil[m] = { ...novoModo(), ...p[m] };
                if (p?.sondagem && typeof p.sondagem.ms === 'number') perfil.sondagem = p.sondagem;
                this.porModelo.set(chave, perfil);
            }
        } catch { /* arquivo ilegível: começa do zero */ }
    }

    private perfil(chave: string): PerfilDoModelo {
        let p = this.porModelo.get(chave);
        if (!p) { p = novoPerfil(); this.porModelo.set(chave, p); }
        return p;
    }

    /**
     * Ordem em que tentar os modos para este modelo: o que mais funcionou primeiro. Sem histórico, vale o preferido do tipo
     * (a configuração do operador). A taxa de sucesso é suavizada (Laplace) para um único azar não enterrar um modo; empate
     * desempata por tempo típico e, por fim, pelo preferido.
     */
    ordemDosModos(chave: string, preferido: ModoDoJuiz): ModoDoJuiz[] {
        const p = this.perfil(chave);
        const pontos = (m: ModoDoJuiz): number => (p[m].ok + 1) / (p[m].n + 2) + (m === preferido ? 0.01 : 0);
        return [...MODOS].sort((a, b) => {
            const d = pontos(b) - pontos(a);
            if (Math.abs(d) > 1e-9) return d;
            return (p[a].msOk ?? Infinity) - (p[b].msOk ?? Infinity);
        });
    }

    /** Este modo já provou funcionar para este modelo (amostra mínima e taxa de sucesso alta)? Então merece o tempo todo. */
    confiavel(chave: string, modo: ModoDoJuiz): boolean {
        const s = this.perfil(chave)[modo];
        return s.n >= 2 && s.ok / s.n >= 0.6;
    }

    /**
     * Disjuntor: este modelo vem falhando como juiz em TODOS os modos? Enquanto aberto, o motor nem chama (o usuário não
     * espera minutos por um veredito que não vem); passado o tempo, deixa passar uma sondagem.
     */
    estadoDoDisjuntor(chave: string): { aberto: boolean; reabreEmMs: number } {
        const p = this.perfil(chave);
        const todosFalhando = MODOS.every(m => p[m].falhasSeguidas >= FALHAS_PARA_DISJUNTOR);
        if (!todosFalhando) return { aberto: false, reabreEmMs: 0 };
        const ultima = Math.max(...MODOS.map(m => p[m].ultimaFalha ?? 0));
        const resta = DISJUNTOR_MS - (this.agora() - ultima);
        return resta > 0 ? { aberto: true, reabreEmMs: resta } : { aberto: false, reabreEmMs: 0 };
    }

    registrar(chave: string, modo: ModoDoJuiz, ok: boolean, ms: number): void {
        const s = this.perfil(chave)[modo];
        s.n++;
        if (ok) {
            s.ok++;
            s.falhasSeguidas = 0;
            s.msOk = s.msOk === undefined ? ms : Math.round(s.msOk * 0.7 + ms * 0.3);
        } else {
            s.falhasSeguidas++;
            s.ultimaFalha = this.agora();
        }
        this.salvar();
    }

    /**
     * O que se MEDIU deste modelo como juiz, para a tela de escolha: tempo típico do melhor modo (o que funcionou) e quantas
     * vezes foi testado. Sem nenhuma chamada registrada devolve `undefined` — a tela não inventa número.
     */
    desempenho(chave: string): { msTipico?: number; amostras: number; sucessos: number; disjuntorAberto: boolean; sondagem?: Sondagem; classe: 'rapido' | 'lento' | 'sem_medicao' } | undefined {
        if (!this.porModelo.has(chave)) return undefined;
        const p = this.perfil(chave);
        const amostras = MODOS.reduce((a, m) => a + p[m].n, 0);
        if (amostras === 0 && !p.sondagem) return undefined;
        const tempos = MODOS.map(m => p[m].msOk).filter((v): v is number => v !== undefined);
        return {
            msTipico: tempos.length ? Math.min(...tempos) : undefined,
            amostras,
            sucessos: MODOS.reduce((a, m) => a + p[m].ok, 0),
            disjuntorAberto: this.estadoDoDisjuntor(chave).aberto,
            sondagem: p.sondagem,
            classe: this.classeDoJuiz(chave),
        };
    }

    /**
     * Rápido ou lento COMO JUIZ — decidido só pela medição padronizada (a capacidade que o provedor declara não separa: hoje
     * quase todo modelo declara raciocínio, inclusive os que respondem em 2 s). Modelo que vem falhando em todos os modos é lento.
     */
    classeDoJuiz(chave: string): 'rapido' | 'lento' | 'sem_medicao' {
        if (this.estadoDoDisjuntor(chave).aberto) return 'lento';
        const s = this.porModelo.get(chave)?.sondagem;
        if (!s) return 'sem_medicao';
        return s.ok && s.ms <= LIMITE_JUIZ_RAPIDO_MS ? 'rapido' : 'lento';
    }

    registrarSondagem(chave: string, ok: boolean, ms: number): void {
        this.perfil(chave).sondagem = { ms: Math.round(ms), ok, em: this.agora() };
        this.salvar();
    }

    /** Fotografia para log e testes. */
    resumo(chave: string): PerfilDoModelo {
        return JSON.parse(JSON.stringify(this.perfil(chave))) as PerfilDoModelo;
    }

    private salvar(): void {
        if (!this.arquivo) return;
        try {
            fs.mkdirSync(path.dirname(this.arquivo), { recursive: true });
            fs.writeFileSync(this.arquivo, JSON.stringify(Object.fromEntries(this.porModelo), null, 2));
        } catch { /* observabilidade/conveniência nunca derruba o julgamento */ }
    }
}

/** O perfil do processo: um só, compartilhado por todos os motores (o aprendizado vale para todos os tipos de validação). */
export const perfilDoJuizDoProcesso = new PerfilDoJuiz();
