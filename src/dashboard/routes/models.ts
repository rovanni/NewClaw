import { Router, Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { spawn, ChildProcess } from 'child_process';
import { errorMessage } from '../../shared/errors';
import { createLogger } from '../../shared/AppLogger';
import { guessCapabilities } from '../../core/modelCapabilityHeuristics';
import { DashboardContext } from './types';

const log = createLogger('ModelsRoute');

/** Extensões de arquivo de modelo local reconhecidas. Minúsculas; a comparação normaliza. */
const LOCAL_MODEL_EXTENSIONS = ['.gguf'];

/** Projetores multimodais acompanham um modelo de visão, mas não são modelos servíveis por si —
 *  listá-los junto faria o usuário escolher um arquivo que nenhum servidor aceita carregar
 *  sozinho. Convenção estável do ecossistema llama.cpp (prefixo "mmproj-"). */
const COMPANION_FILE_PREFIXES = ['mmproj-'];

/** Nomes de servidor local reconhecidos ao varrer a pasta. llamafile distribui um único
 *  executável; llama.cpp compila `llama-server`. Em Windows vêm com .exe, em Linux/macOS sem — o
 *  match é por prefixo justamente para cobrir os dois sem uma lista por sistema operacional. */
const LOCAL_SERVER_BINARY_PREFIXES = ['llamafile', 'llama-server'];

/** Porta do servidor local. 8080 é a convenção do llamafile; configurável porque a porta era fixa
 *  no código e duas instâncias do NewClaw na mesma máquina (ex.: a de produção e uma de teste)
 *  disputavam a mesma porta — a segunda derrubaria o modelo da primeira. */
const LOCAL_SERVER_PORT = parseInt(process.env.LOCAL_SERVER_PORT || '8080', 10) || 8080;

/** Contexto do servidor local. 2048 (padrão de vários binários) é pequeno demais: o prompt do
 *  agente passa de 5k tokens e o servidor devolve HTTP 400 — observado ao vivo em 2026-08-01.
 *  Só é aplicado quando o usuário NÃO define o contexto nas opções do modelo. */
const LOCAL_SERVER_CTX = 16384;

/** Formas de dizer "tamanho do contexto" aceitas pelos servidores — se o usuário já passou uma
 *  delas, não acrescentamos a nossa (duas ocorrências fariam a segunda vencer em silêncio). */
const CTX_FLAGS = ['-c', '--ctx-size', '--context-size'];

/**
 * Quebra a linha de opções do usuário em argumentos, respeitando aspas — nomes de arquivo com
 * espaço (`--mmproj "meu projetor.gguf"`) chegariam partidos ao meio sem isso.
 *
 * Os argumentos vão para `spawn` como ARRAY, nunca por shell: não há interpretação de `;`, `&&`
 * ou redirecionamento, então uma string maliciosa aqui vira apenas um argumento inválido que o
 * servidor recusa.
 */
export function parseServerOptions(raw: string): string[] {
    const out: string[] = [];
    const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(raw)) !== null) {
        out.push(m[1] ?? m[2] ?? m[3]);
    }
    return out;
}

/**
 * Argumentos finais do servidor: o mínimo que o NewClaw precisa controlar, mais as opções que o
 * usuário definiu para AQUELE modelo.
 *
 * O NewClaw controla só o essencial para conseguir falar com o processo (modo servidor, arquivo,
 * host e porta). Todo o resto — `--n-gpu-layers`, `-fit off`, `--mmproj`, `--no-mmap` — é do
 * usuário, porque depende da GPU e da RAM da máquina dele: a divisão de camadas ideal numa placa
 * de 16GB é errada numa de 8GB, e um projetor de visão só existe para alguns modelos. Embutir
 * uma tabela dessas no projeto seria distribuir o ambiente de quem a escreveu.
 */
function buildServerArgs(file: string, port: number, userOptions: string): string[] {
    const extra = parseServerOptions(userOptions || '');
    const args = ['--server', '--model', file, '--port', String(port), '--host', '127.0.0.1'];
    // Contexto padrão só quando o usuário não escolheu um: a nossa escolha é um piso de
    // funcionamento (prompts do agente passam de 5k tokens), não uma preferência a impor.
    if (!extra.some(a => CTX_FLAGS.includes(a))) {
        args.push('-c', String(LOCAL_SERVER_CTX));
    }
    return [...args, ...extra];
}

/** Tempo máximo esperando o modelo carregar antes de desistir. Modelos grandes lidos de disco
 *  lento levam minutos; abaixo disso o usuário veria "falhou" num carregamento que ia dar certo. */
const LOCAL_SERVER_READY_TIMEOUT_MS = 5 * 60_000;

/**
 * Processo do servidor local em execução. Um por vez, de propósito: cada processo carrega um
 * modelo inteiro na memória, e subir dois é a receita para esgotar a RAM da máquina do usuário.
 * Trocar de modelo = encerrar o atual e subir o novo, que é exatamente como o usuário pensa a
 * ação ("agora quero usar aquele outro").
 */
let localServer: { child: ChildProcess | null; file: string; port: number; startedAt: number } | null = null;

/** Onde o estado do servidor local é anotado entre reinícios do NewClaw. Fica em ./data (mesma
 *  base do banco), que já é por instância — duas instâncias isoladas não se confundem. */
const SERVER_STATE_FILE = path.join(process.cwd(), 'data', 'local-model-server.json');

function persistServerState(state: { pid?: number; file: string; port: number } | null): void {
    try {
        if (!state) { fs.rmSync(SERVER_STATE_FILE, { force: true }); return; }
        fs.mkdirSync(path.dirname(SERVER_STATE_FILE), { recursive: true });
        fs.writeFileSync(SERVER_STATE_FILE, JSON.stringify({ ...state, startedAt: Date.now() }), 'utf-8');
    } catch (err) {
        // Não é motivo para falhar o carregamento do modelo: sem o arquivo o servidor continua no
        // ar, só perde-se a capacidade de descarregá-lo pela UI após um restart.
        log.warn(`Não foi possível anotar o estado do servidor local: ${errorMessage(err)}`);
    }
}

function readServerState(): { pid?: number; file: string; port: number } | null {
    try {
        return JSON.parse(fs.readFileSync(SERVER_STATE_FILE, 'utf-8'));
    } catch { return null; }
}

/**
 * Último modelo local que o usuário mandou carregar, esteja ele no ar ou não.
 *
 * Serve para o dashboard poder dizer "o modelo X não está carregado — carregar agora?" depois de
 * um reinício da máquina, em vez de deixar o provedor padrão apontando para uma porta muda (foi
 * exatamente a falha vivida em 02/08/2026). Deliberadamente NÃO religa nada sozinho: o servidor
 * ocupa a GPU, e alguém que reiniciou o computador para jogar não quer o modelo subindo por conta
 * própria. Só leitura de arquivo — sem I/O de rede, seguro no caminho do polling do dashboard.
 */
export function getLastKnownLocalServer(): { file: string; port: number } | null {
    const saved = readServerState();
    return saved ? { file: saved.file, port: saved.port } : null;
}

/**
 * Reencontra um servidor local que sobreviveu a um restart do NewClaw. Confia no que é
 * verificável: o processo anotado ainda existe E a porta responde. Se qualquer um dos dois falhar,
 * o registro é descartado em vez de virar uma promessa falsa na tela.
 */
async function adoptRunningServer(): Promise<void> {
    if (localServer) return;
    const saved = readServerState();
    if (!saved) return;
    // Processo morto (a máquina reiniciou, alguém encerrou) NÃO apaga o registro: ele é a única
    // memória de qual modelo o usuário escolheu, e é com ela que o dashboard consegue oferecer
    // "carregar agora" em vez de deixar o sistema apontando para uma porta muda. O registro só sai
    // num descarregamento explícito (stopLocalServer) — ver getLastKnownLocalServer().
    if (saved.pid) {
        try {
            process.kill(saved.pid, 0); // sinal 0 = só testa existência, não encerra nada
        } catch {
            return;
        }
    }
    try {
        const r = await fetch(`${localServerUrl(saved.port)}/models`, { signal: AbortSignal.timeout(2000) });
        if (!r.ok) return;
    } catch { return; }
    localServer = { child: null, file: saved.file, port: saved.port, startedAt: Date.now() };
    log.info(`Servidor local reencontrado após restart: ${saved.file} (pid ${saved.pid ?? '?'})`);
}

function localServerUrl(port: number): string {
    return `http://127.0.0.1:${port}/v1`;
}

/** Encerra o servidor local em execução, se houver. Idempotente. */
function stopLocalServer(): boolean {
    const saved = readServerState();
    if (!localServer && !saved) return false;
    const file = localServer?.file ?? saved?.file ?? '?';
    const child = localServer?.child ?? null;
    localServer = null;
    persistServerState(null);
    try {
        // child quando fomos nós que subimos nesta execução; PID anotado quando o servidor
        // sobreviveu a um restart e não temos mais o handle do processo.
        if (child) child.kill();
        else if (saved?.pid) process.kill(saved.pid);
        log.info(`Servidor local encerrado (${file})`);
    } catch (err) {
        log.warn(`Falha ao encerrar servidor local: ${errorMessage(err)}`);
    }
    return true;
}

/** Procura um executável de servidor local dentro da pasta de modelos. */
function findLocalServerBinary(dir: string): string | null {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
    const match = entries
        .filter(e => e.isFile())
        .map(e => e.name)
        .filter(name => {
            const lower = name.toLowerCase();
            if (!LOCAL_SERVER_BINARY_PREFIXES.some(p => lower.startsWith(p))) return false;
            // Windows exige .exe; em Unix o executável costuma não ter extensão. Aceitar ambos
            // sem ramificar por process.platform mantém o comportamento igual nos três sistemas.
            const ext = path.extname(lower);
            return ext === '.exe' || ext === '';
        })
        .sort();
    return match.length > 0 ? path.join(dir, match[0]) : null;
}

/**
 * Catálogo de modelos (Model Registry) — GET /api/models/catalog.
 * Camada HTTP fina: toda a lógica de discovery/cache vive em ModelRegistryService;
 * esta rota só traduz query params e devolve JSON.
 */
export function createModelsRouter(ctx: DashboardContext): Router {
    const router = Router();

    router.get('/catalog', async (req: Request, res: Response) => {
        if (!ctx.modelRegistryService) {
            return res.json({ success: true, models: [], health: [] });
        }
        try {
            const forceRefresh = req.query.refresh === 'true';
            const models = await ctx.modelRegistryService.getCatalog(forceRefresh);
            res.json({ success: true, models, health: ctx.modelRegistryService.getLastHealth() });
        } catch (err) {
            res.status(500).json({ success: false, error: errorMessage(err) });
        }
    });

    router.get('/cloud-catalog', async (req: Request, res: Response) => {
        if (!ctx.modelRegistryService) {
            return res.json({ success: true, models: [] });
        }
        // getCloudCatalog() já é best-effort internamente (nunca rejeita) — sem try/catch aqui
        // pra não esconder um bug real caso o contrato mude.
        const forceRefresh = req.query.refresh === 'true';
        const models = await ctx.modelRegistryService.getCloudCatalog(forceRefresh);
        res.json({ success: true, models });
    });

    /**
     * Modelos que o usuário já tem em disco — GET /api/models/local[?dir=...].
     *
     * Terceira origem de catálogo, irmã de /catalog (instalados no Ollama) e /cloud-catalog
     * (disponíveis para baixar): arquivos .gguf numa pasta da máquina. A pasta NUNCA tem valor
     * padrão no código — quem instala o NewClaw informa a sua (Windows, Linux e macOS guardam
     * modelos em lugares completamente diferentes, e um caminho embutido só serviria a quem o
     * escreveu). Sem pasta configurada, devolve lista vazia e diz que não está configurada, em
     * vez de tentar adivinhar um local plausível.
     *
     * `served` cruza cada arquivo com o catálogo vivo: servidores de modelo local expõem o nome
     * do arquivo como id do modelo, então dá para dizer com precisão quais já estão no ar — sem
     * inferir nada.
     */
    router.get('/local', async (req: Request, res: Response) => {
        await adoptRunningServer();
        const dir = String(req.query.dir || ctx.config.localModelsDir || '').trim();
        if (!dir) {
            return res.json({ success: true, configured: false, dir: '', models: [] });
        }

        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch (err) {
            // Pasta inexistente/sem permissão é resultado da busca, não erro do dashboard — a UI
            // precisa da mensagem para mostrar ao usuário o que corrigir no caminho digitado.
            return res.json({ success: true, configured: true, dir, models: [], error: errorMessage(err) });
        }

        // Ids que algum provider realmente serve agora (o discovery já roda para Ollama e para
        // cada endpoint OpenAI-Compatible cadastrado) — reaproveitado aqui, sem consulta nova.
        let servedIds = new Set<string>();
        try {
            const catalog = await ctx.modelRegistryService?.getCatalog() ?? [];
            servedIds = new Set(catalog.map(m => m.id));
        } catch { /* catálogo indisponível: nenhum arquivo é marcado como servido */ }

        const models = entries
            .filter(e => e.isFile())
            .filter(e => LOCAL_MODEL_EXTENSIONS.includes(path.extname(e.name).toLowerCase()))
            .filter(e => !COMPANION_FILE_PREFIXES.some(p => e.name.toLowerCase().startsWith(p)))
            .map(e => {
                const full = path.join(dir, e.name);
                let sizeBytes = 0;
                try { sizeBytes = fs.statSync(full).size; } catch { /* arquivo sumiu entre readdir e stat */ }
                return {
                    id: e.name,
                    provider: 'local',
                    label: e.name,
                    // Só o nome do arquivo está disponível — mesma heurística declarada que os
                    // endpoints OpenAI-Compatible já usam, nenhuma regra nova inventada aqui.
                    capabilities: guessCapabilities(e.name),
                    sizeBytes,
                    path: full,
                    served: servedIds.has(e.name),
                    // Opções que o usuário definiu para ESTE modelo (vazio = nenhuma). Vai na
                    // listagem para o campo da UI já abrir preenchido, sem uma segunda requisição.
                    options: (ctx.config.localModelOptions || {})[e.name] || '',
                    status: 'available' as const,
                };
            })
            .sort((a, b) => a.id.localeCompare(b.id));

        res.json({
            success: true, configured: true, dir, models,
            // A UI precisa saber se dá para oferecer o botão "Usar" ou se tem que explicar que
            // falta o executável do servidor — sem isso o usuário só veria "Não carregado" sem
            // nenhuma pista do que fazer, que foi a lacuna real relatada (2026-08-02).
            serverBinary: findLocalServerBinary(dir) ? path.basename(findLocalServerBinary(dir)!) : null,
            running: localServer ? { file: localServer.file, url: localServerUrl(localServer.port) } : null,
        });
    });

    /** Estado do servidor local — GET /api/models/local/server. */
    router.get('/local/server', async (_req: Request, res: Response) => {
        await adoptRunningServer();
        res.json({
            success: true,
            running: localServer ? { file: localServer.file, url: localServerUrl(localServer.port), startedAt: localServer.startedAt } : null,
        });
    });

    /**
     * Carrega um modelo local — POST /api/models/local/serve { file }.
     *
     * Sobe o executável de servidor encontrado NA PRÓPRIA pasta de modelos configurada, com o
     * arquivo escolhido. Limites deliberados, porque isto executa um binário da máquina:
     *  - `file` é só um NOME de arquivo, validado contra a listagem real da pasta configurada —
     *    nunca um caminho vindo do cliente (bloqueia ../ e caminhos absolutos por construção);
     *  - o executável é descoberto pelo servidor, não informado pela requisição;
     *  - os argumentos são montados aqui, fixos; nada do corpo da requisição vira argumento.
     */
    router.post('/local/serve', async (req: Request, res: Response) => {
        const dir = (ctx.config.localModelsDir || '').trim();
        if (!dir) return res.status(400).json({ success: false, error: 'Nenhuma pasta de modelos configurada' });

        const requested = String(req.body?.file || '');
        // Comparação contra a listagem real: só um nome que EXISTE na pasta configurada passa.
        let available: string[];
        try {
            available = fs.readdirSync(dir, { withFileTypes: true })
                .filter(e => e.isFile() && LOCAL_MODEL_EXTENSIONS.includes(path.extname(e.name).toLowerCase()))
                .map(e => e.name);
        } catch (err) {
            return res.status(400).json({ success: false, error: errorMessage(err) });
        }
        const file = available.find(name => name === requested);
        if (!file) return res.status(400).json({ success: false, error: `Modelo "${requested}" não encontrado na pasta configurada` });

        const binary = findLocalServerBinary(dir);
        if (!binary) {
            return res.status(400).json({ success: false, error: 'no_server_binary' });
        }

        if (localServer?.file === file) {
            return res.json({ success: true, alreadyRunning: true, url: localServerUrl(localServer.port), file });
        }
        stopLocalServer(); // um modelo por vez — ver comentário em localServer

        const port = LOCAL_SERVER_PORT;
        // `file` (nome puro) e não o caminho completo, porque o processo roda com cwd na própria
        // pasta: os servidores usam o valor de --model COMO ID do modelo em /v1/models, e passar o
        // caminho fazia o modelo aparecer como "/D/IA/.../arquivo.gguf" no catálogo e quebrava o
        // cruzamento com a listagem da pasta (que casa por nome de arquivo). Visto ao vivo, 02/08.
        const args = buildServerArgs(file, port, (ctx.config.localModelOptions || {})[file] || '');
        log.info(`Subindo servidor local: ${path.basename(binary)} (${file})`);

        let child: ChildProcess;
        try {
            // detached + unref: o servidor NÃO pode ser filho do NewClaw. Era, e o resultado foi
            // um ciclo absurdo relatado pelo usuário (02/08/2026): a própria tela manda clicar em
            // "Salvar & Reiniciar" depois de escolher o modelo, o restart matava o processo filho
            // junto, e o sistema voltava apontando para uma porta vazia — "fetch failed" a cada
            // discovery, sem nenhuma pista do motivo. Carregar um modelo de 16 GB não pode ser
            // desfeito por reiniciar o aplicativo.
            child = spawn(binary, args, { cwd: dir, windowsHide: true, detached: true, stdio: 'ignore' });
            child.unref();
        } catch (err) {
            return res.status(500).json({ success: false, error: `Falha ao iniciar o servidor: ${errorMessage(err)}` });
        }
        // PID em disco para que o dashboard reencontre o servidor depois de um restart — sem isto
        // ele sobreviveria, mas ficaria "órfão": a UI não saberia qual modelo está no ar nem teria
        // como descarregá-lo, e a memória ficaria presa até o usuário matar o processo na mão.
        persistServerState({ pid: child.pid, file, port });

        localServer = { child, file, port, startedAt: Date.now() };
        let exitedEarly = '';
        child.on('error', err => { exitedEarly = errorMessage(err); });
        child.on('exit', code => {
            if (localServer?.child === child) localServer = null;
            if (!exitedEarly) exitedEarly = `o servidor encerrou com código ${code}`;
        });
        child.stderr?.on('data', (d: Buffer) => log.info(`[servidor local] ${d.toString().trim().slice(0, 200)}`));

        // Espera o modelo carregar de verdade: enquanto carrega, o servidor já aceita conexão mas
        // responde 503. Só devolver sucesso quando /v1/models listar algo evita a UI dizer
        // "pronto" antes da hora — o usuário clicaria em conversar e receberia erro.
        const deadline = Date.now() + LOCAL_SERVER_READY_TIMEOUT_MS;
        while (Date.now() < deadline) {
            if (exitedEarly) return res.status(500).json({ success: false, error: exitedEarly });
            try {
                const r = await fetch(`${localServerUrl(port)}/models`, { signal: AbortSignal.timeout(2000) });
                if (r.ok) {
                    const body = await r.json() as { data?: unknown[] };
                    if (body.data?.length) {
                        log.info(`Servidor local pronto: ${file} em ${localServerUrl(port)}`);
                        return res.json({ success: true, url: localServerUrl(port), file, port });
                    }
                }
            } catch { /* ainda subindo */ }
            await new Promise(r => setTimeout(r, 1500));
        }

        stopLocalServer();
        res.status(504).json({ success: false, error: 'O modelo não terminou de carregar a tempo' });
    });

    /** Descarrega o modelo local — POST /api/models/local/stop. Libera a memória da máquina. */
    router.post('/local/stop', (_req: Request, res: Response) => {
        const stopped = stopLocalServer();
        res.json({ success: true, stopped });
    });

    return router;
}
