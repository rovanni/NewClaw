/**
 * Instalador genérico de integrações opcionais (ADR-030, Etapa 5; ADR-031, nota de 30/10/2026).
 *
 * Lê o manifesto da integração, baixa o pacote para uma pasta na pasta do usuário, roda os comandos declarados (sem
 * shell, dentro da pasta da integração) e controla o processo dela no PM2. Não sabe qual integração é: tudo vem do
 * manifesto. Rede, processos e PM2 entram por injeção, para os testes rodarem sem nada disso.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CATALOGO, HOSTS_PERMITIDOS } from './catalogo';
import {
    argumentosDasEscolhas, daPlataforma, Manifesto, ManifestoInvalido, montarComando, Opcao, validarManifesto,
} from './manifesto';

export interface Resultado { codigo: number; saida: string; erro: string }

export interface Dependencias {
    /** Baixa um endereço (HTTPS). Devolve o endereço final (depois de redirecionamentos) e o conteúdo. */
    baixar(url: string): Promise<{ urlFinal: string; status: number; corpo: Buffer }>;
    /** Roda um comando até o fim. */
    executar(programa: string, args: string[], pasta?: string): Promise<Resultado>;
    /** Roda um comando longo, entregando cada linha de saída. */
    acompanhar(programa: string, args: string[], pasta: string, aoLer: (linha: string) => void): Promise<number>;
    /** Comando do PM2 (ex.: [node, pm2/bin/pm2]); null quando o PM2 não foi encontrado. */
    pm2: string[] | null;
    /** O `tar` que extrai o pacote (no Windows, o do próprio sistema — ver dependencias.ts). */
    tar: string;
    home: string;
    plataforma: NodeJS.Platform;
    /** Endereço deste NewClaw para a integração usar (sempre o HTTP local). */
    newclawUrl: string;
    agora?: () => number;
}

export interface Andamento {
    id: string;
    integracao: string;
    estado: 'rodando' | 'concluida' | 'falhou';
    linhas: string[];
    codigo?: number;
    erro?: string;
    inicio: number;
    fim?: number;
}

const MARCADOR = '.newclaw-integracao.json';
const LINHAS_GUARDADAS = 400;
const CACHE_MS = 5 * 60 * 1000;

export class ErroDaIntegracao extends Error {
    constructor(message: string, readonly status = 400) { super(message); }
}

export class GerenciadorDeIntegracoes {
    private cache = new Map<string, { manifesto: Manifesto; em: number }>();
    private andamentos = new Map<string, Andamento>();
    private agora: () => number;

    constructor(private readonly d: Dependencias) {
        this.agora = d.agora ?? Date.now;
    }

    // ─── manifesto ───────────────────────────────────────────────────────────

    catalogo() { return CATALOGO; }

    async manifesto(id: string): Promise<Manifesto> {
        const item = CATALOGO.find((c) => c.id === id);
        if (!item) throw new ErroDaIntegracao(`integração '${id}' não está no catálogo`, 404);
        const guardado = this.cache.get(id);
        if (guardado && this.agora() - guardado.em < CACHE_MS) return guardado.manifesto;
        const r = await this.baixarPermitido(item.manifesto);
        let bruto: unknown;
        try { bruto = JSON.parse(r.toString('utf-8')); } catch { throw new ErroDaIntegracao('o manifesto não é JSON válido', 502); }
        let m: Manifesto;
        try { m = validarManifesto(bruto, HOSTS_PERMITIDOS); } catch (e) {
            throw new ErroDaIntegracao(`manifesto recusado: ${(e as Error).message}`, 502);
        }
        if (m.id !== id) throw new ErroDaIntegracao(`o manifesto diz ser '${m.id}', mas o catálogo pediu '${id}'`, 502);
        this.cache.set(id, { manifesto: m, em: this.agora() });
        return m;
    }

    private async baixarPermitido(url: string): Promise<Buffer> {
        const r = await this.d.baixar(url);
        const host = new URL(r.urlFinal).hostname;
        if (new URL(r.urlFinal).protocol !== 'https:' || !(HOSTS_PERMITIDOS as readonly string[]).includes(host)) {
            throw new ErroDaIntegracao(`o download foi redirecionado para ${host}, fora dos hosts permitidos`, 502);
        }
        if (r.status !== 200) throw new ErroDaIntegracao(`download de ${url} respondeu HTTP ${r.status}`, 502);
        return r.corpo;
    }

    // ─── pasta e pacote ──────────────────────────────────────────────────────

    pasta(m: Manifesto): string { return path.join(this.d.home, m.pasta); }

    private lerMarcador(m: Manifesto): { id: string; instalada_em?: string } | null {
        try { return JSON.parse(fs.readFileSync(path.join(this.pasta(m), MARCADOR), 'utf-8')); } catch { return null; }
    }

    private gravarMarcador(m: Manifesto, extra: Record<string, unknown>): void {
        const atual = this.lerMarcador(m) ?? {};
        fs.writeFileSync(path.join(this.pasta(m), MARCADOR), JSON.stringify({ ...atual, id: m.id, pacote: m.pacote, ...extra }, null, 2));
    }

    /**
     * Baixa e extrai o pacote na pasta da integração. Por cima de uma instalação anterior, só substitui os arquivos do
     * pacote (ambiente, modelos e configuração ficam). Nunca escreve numa pasta que já existe sem ter sido criada aqui.
     */
    async preparar(m: Manifesto, forcar = false): Promise<void> {
        const pasta = this.pasta(m);
        const marcador = this.lerMarcador(m);
        if (marcador && marcador.id !== m.id) throw new ErroDaIntegracao(`a pasta ${pasta} é de outra integração`, 409);
        if (!marcador && fs.existsSync(pasta) && fs.readdirSync(pasta).length > 0) {
            throw new ErroDaIntegracao(`a pasta ${pasta} já existe e não foi criada pelo NewClaw; mova-a ou apague-a antes`, 409);
        }
        if (marcador && !forcar) return;
        const pacote = await this.baixarPermitido(m.pacote);
        fs.mkdirSync(pasta, { recursive: true });
        const arquivo = path.join(os.tmpdir(), `newclaw-integracao-${m.id}-${process.pid}.tar.gz`);
        fs.writeFileSync(arquivo, pacote);
        try {
            const r = await this.d.executar(this.d.tar, ['-xzf', arquivo, '-C', pasta, '--strip-components=1']);
            if (r.codigo !== 0) throw new ErroDaIntegracao(`não consegui extrair o pacote: ${r.erro || r.saida}`.trim(), 500);
        } finally {
            fs.rmSync(arquivo, { force: true });
        }
        this.gravarMarcador(m, { preparada_em: new Date(this.agora()).toISOString() });
    }

    // ─── requisitos, opções e licenças ───────────────────────────────────────

    private valores(m: Manifesto, escolhas: string[] = []) {
        return { python: daPlataforma(m.python, this.d.plataforma), newclaw_url: this.d.newclawUrl, pasta: this.pasta(m), escolhas };
    }

    async requisitos(m: Manifesto) {
        const lista = [];
        for (const r of m.precisa) {
            const [programa, ...args] = montarComando(r.comando, this.valores(m));
            let ok = false;
            try { ok = (await this.d.executar(programa, args)).codigo === 0; } catch { ok = false; }
            lista.push({ nome: r.nome, ok, como_instalar: daPlataforma(r.como_instalar, this.d.plataforma) });
        }
        return lista;
    }

    private async rodarJson(m: Manifesto, modelo: string[], escolhas: string[] = []): Promise<unknown> {
        const [programa, ...args] = montarComando(modelo, this.valores(m, escolhas));
        const r = await this.d.executar(programa, args, this.pasta(m));
        if (r.codigo !== 0) throw new ErroDaIntegracao(`o comando da integração falhou (código ${r.codigo}): ${(r.erro || r.saida).trim().slice(-500)}`, 502);
        try { return JSON.parse(r.saida); } catch { throw new ErroDaIntegracao('a integração respondeu algo que não é JSON', 502); }
    }

    async opcoes(m: Manifesto): Promise<Opcao[]> {
        await this.preparar(m);
        const lista = await this.rodarJson(m, m.opcoes);
        if (!Array.isArray(lista)) throw new ErroDaIntegracao('as opções da integração não são uma lista', 502);
        return lista as Opcao[];
    }

    async licencas(m: Manifesto, escolhas: Record<string, unknown>): Promise<unknown> {
        const args = this.conferir(await this.opcoes(m), escolhas);
        return this.rodarJson(m, m.licencas, args);
    }

    private conferir(oferecidas: Opcao[], escolhas: Record<string, unknown>): string[] {
        try { return argumentosDasEscolhas(oferecidas, escolhas); } catch (e) {
            if (e instanceof ManifestoInvalido) throw new ErroDaIntegracao(e.message, 400);
            throw e;
        }
    }

    // ─── instalar ────────────────────────────────────────────────────────────

    /** Começa a instalação em segundo plano. `aceito`: a pessoa marcou "Li e aceito" no painel. */
    async instalar(m: Manifesto, escolhas: Record<string, unknown>, aceito: boolean): Promise<Andamento> {
        if (aceito !== true) throw new ErroDaIntegracao('as licenças de terceiros precisam ser aceitas antes de instalar', 400);
        for (const a of this.andamentos.values()) {
            if (a.estado === 'rodando') throw new ErroDaIntegracao('já há uma instalação em andamento', 409);
        }
        await this.preparar(m, true);  // pacote atualizado a cada instalação
        const args = this.conferir(await this.opcoes(m), escolhas);
        const andamento: Andamento = {
            id: `${m.id}-${this.agora().toString(36)}`, integracao: m.id, estado: 'rodando', linhas: [], inicio: this.agora(),
        };
        this.andamentos.set(andamento.id, andamento);
        const [programa, ...resto] = montarComando(m.instalar, this.valores(m, args));
        const aoLer = (linha: string) => {
            let texto = linha;
            try {
                const o = JSON.parse(linha);
                if (o && o.fim === true) return;  // o fim vem pelo código de saída
                if (o && typeof o.texto === 'string') texto = o.texto;
            } catch { /* linha comum (pip, npm, download) */ }
            if (!texto.trim()) return;
            andamento.linhas.push(texto);
            if (andamento.linhas.length > LINHAS_GUARDADAS) andamento.linhas.splice(0, andamento.linhas.length - LINHAS_GUARDADAS);
        };
        void this.d.acompanhar(programa, resto, this.pasta(m), aoLer)
            .then(async (codigo) => {
                andamento.codigo = codigo;
                if (codigo !== 0) { andamento.estado = 'falhou'; return; }
                this.gravarMarcador(m, { instalada_em: new Date(this.agora()).toISOString() });
                await this.ligar(m);
                andamento.estado = 'concluida';
            })
            .catch((e: Error) => { andamento.estado = 'falhou'; andamento.erro = e.message; })
            .finally(() => { andamento.fim = this.agora(); });
        return andamento;
    }

    andamento(id: string): Andamento | undefined { return this.andamentos.get(id); }

    // ─── processo (PM2) ──────────────────────────────────────────────────────

    nomeNoPm2(m: Manifesto): string { return `newclaw-integracao-${m.id}`; }

    private async pm2(args: string[]): Promise<Resultado> {
        if (!this.d.pm2) throw new ErroDaIntegracao('PM2 não encontrado; ele é preciso para manter a integração ligada', 500);
        const [programa, ...base] = this.d.pm2;
        return this.d.executar(programa, [...base, ...args]);
    }

    async estado(m: Manifesto) {
        const marcador = this.lerMarcador(m);
        const instalada = !!marcador?.instalada_em;
        let ligada = false;
        if (instalada && this.d.pm2) {
            const r = await this.pm2(['jlist']);
            try {
                const lista = JSON.parse(r.saida) as { name: string; pm2_env?: { status?: string } }[];
                ligada = lista.some((p) => p.name === this.nomeNoPm2(m) && p.pm2_env?.status === 'online');
            } catch { ligada = false; }
        }
        return { instalada, ligada, pasta: this.pasta(m), abrir: m.abrir, instalada_em: marcador?.instalada_em ?? null };
    }

    async ligar(m: Manifesto): Promise<void> {
        const [programa, ...args] = daPlataforma(m.iniciar, this.d.plataforma);
        const pasta = this.pasta(m);
        await this.pm2(['delete', this.nomeNoPm2(m)]);  // pode não existir; o resultado não importa
        const r = await this.pm2([
            'start', path.join(pasta, programa), '--name', this.nomeNoPm2(m), '--cwd', pasta, '--interpreter', 'none', '--', ...args,
        ]);
        if (r.codigo !== 0) throw new ErroDaIntegracao(`o PM2 não ligou a integração: ${(r.erro || r.saida).trim().slice(-300)}`, 500);
        await this.pm2(['save']);
    }

    async desligar(m: Manifesto): Promise<void> {
        await this.pm2(['stop', this.nomeNoPm2(m)]);
        await this.pm2(['save']);
    }

    /** Tira do PM2 e apaga a pasta — só se ela tiver sido criada aqui (marcador desta integração). */
    async desinstalar(m: Manifesto): Promise<void> {
        const marcador = this.lerMarcador(m);
        if (!marcador || marcador.id !== m.id) throw new ErroDaIntegracao(`${this.pasta(m)} não foi instalada pelo NewClaw; não apago`, 409);
        if (this.d.pm2) { await this.pm2(['delete', this.nomeNoPm2(m)]); await this.pm2(['save']); }
        fs.rmSync(this.pasta(m), { recursive: true, force: true });
    }
}
