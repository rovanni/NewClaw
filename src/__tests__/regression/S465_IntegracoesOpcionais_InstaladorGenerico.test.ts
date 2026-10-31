/// <reference types="node" />
/**
 * S465 — Instalador genérico de integrações opcionais (ADR-030, Etapa 5; ADR-031, nota de 30/10/2026).
 *
 * A operadora quis instalar a interface de voz em Configurações → Integrações. Para não quebrar a regra 1 da ADR-031
 * (o núcleo não conhece os harnesses), o núcleo ganhou um instalador genérico guiado por manifesto: a integração publica
 * o manifesto; o núcleo conhece só o formato. Como o núcleo passa a executar comandos descritos num arquivo baixado, a
 * maior parte deste teste é sobre o que ele RECUSA.
 *
 * Cobre:
 *   1 → validação estrita do manifesto (campo desconhecido, http, host fora da lista, espaço reservado desconhecido,
 *       caminho fora da pasta, endereço de abrir fora da máquina, formato novo);
 *   2 → escolhas: só valores da lista que a integração ofereceu; escolha escondida ignorada; montagem do comando;
 *   3 → gerenciador com rede e processos falsos (o `tar` é o de verdade): baixa e extrai; recusa redirecionamento para
 *       outro host e pasta que já existe; sem aceite não instala; instala, liga no PM2 e registra; desinstala só o que
 *       criou;
 *   4 → o ambiente dos comandos da integração não leva os segredos do NewClaw;
 *   5 → regra 1 da ADR-031: nenhum arquivo de src/ além do catálogo cita uma integração do catálogo.
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CATALOGO, HOSTS_PERMITIDOS } from '../../dashboard/integracoesOpcionais/catalogo';
import { ambienteDaIntegracao, localizarTar } from '../../dashboard/integracoesOpcionais/dependencias';
import { Dependencias, ErroDaIntegracao, GerenciadorDeIntegracoes, Resultado } from '../../dashboard/integracoesOpcionais/gerenciador';
import { argumentosDasEscolhas, montarComando, Opcao, validarManifesto } from '../../dashboard/integracoesOpcionais/manifesto';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}
function recusa(fn: () => unknown, trecho: string, message: string): void {
    try { fn(); assert(false, message, 'não recusou'); } catch (e) {
        assert((e as Error).message.includes(trecho), message, (e as Error).message);
    }
}

const ID = CATALOGO[0].id;
const BASE = {
    formato: 1, id: ID, nome: 'Integração de teste', descricao: 'teste',
    site: 'https://github.com/exemplo/integracao',
    pacote: 'https://codeload.github.com/exemplo/integracao/tar.gz/refs/heads/main',
    pasta: 'integracao-teste',
    python: { win32: 'python', outros: 'python3' },
    precisa: [{ nome: 'Python', comando: ['{python}', '--version'], como_instalar: { outros: 'instale o Python' } }],
    opcoes: ['{python}', 'instalar.py', '--opcoes'],
    licencas: ['{python}', 'instalar.py', '--licencas', '{escolhas}'],
    instalar: ['{python}', 'instalar.py', '--sem-perguntas', '--newclaw-url', '{newclaw_url}', '{escolhas}'],
    iniciar: { win32: ['.venv/Scripts/python.exe', '-m', 'app'], outros: ['.venv/bin/python', '-m', 'app'] },
    abrir: 'http://127.0.0.1:7860', saude: 'http://127.0.0.1:7860/saude',
};
const com = (mudanca: Record<string, unknown>) => ({ ...BASE, ...mudanca });

console.log('S465 — Instalador genérico de integrações opcionais\n');

// ── 1. Manifesto ────────────────────────────────────────────────────────────
console.log('1. Validação do manifesto');
const m = validarManifesto(BASE, HOSTS_PERMITIDOS);
assert(m.id === ID && m.instalar.includes('{escolhas}'), 'manifesto bem formado é aceito');
recusa(() => validarManifesto(com({ extra: 1 }), HOSTS_PERMITIDOS), "campo desconhecido: 'extra'", 'campo desconhecido');
recusa(() => validarManifesto(com({ formato: 2 }), HOSTS_PERMITIDOS), 'formato 2', 'formato que este NewClaw não entende');
recusa(() => validarManifesto(com({ pacote: 'http://codeload.github.com/x.tar.gz' }), HOSTS_PERMITIDOS), 'https', 'pacote sem https');
recusa(() => validarManifesto(com({ pacote: 'https://exemplo.com/x.tar.gz' }), HOSTS_PERMITIDOS), 'fora dos hosts', 'pacote de host fora da lista');
recusa(() => validarManifesto(com({ instalar: ['{python}', '{senha}'] }), HOSTS_PERMITIDOS), '{senha}', 'espaço reservado desconhecido');
recusa(() => validarManifesto(com({ instalar: ['{python}', '--x={escolhas}'] }), HOSTS_PERMITIDOS), 'sozinho', '{escolhas} grudado em outro texto');
recusa(() => validarManifesto(com({ instalar: ['bash', '-c', 'rm -rf /'] }), HOSTS_PERMITIDOS), '{python}', 'comando que não começa com {python}');
recusa(() => validarManifesto(com({ iniciar: { outros: ['../../bin/sh'] } }), HOSTS_PERMITIDOS), 'dentro da pasta', 'iniciar fora da pasta');
recusa(() => validarManifesto(com({ iniciar: { outros: ['/usr/bin/sh'] } }), HOSTS_PERMITIDOS), 'dentro da pasta', 'iniciar com caminho absoluto');
recusa(() => validarManifesto(com({ abrir: 'http://192.0.2.10:7860' }), HOSTS_PERMITIDOS), 'desta máquina', 'abrir fora desta máquina');
recusa(() => validarManifesto(com({ python: { outros: '/usr/bin/python3' } }), HOSTS_PERMITIDOS), 'só o nome', 'python com caminho');
recusa(() => validarManifesto(com({ pasta: '../fora' }), HOSTS_PERMITIDOS), "'pasta'", 'pasta com ..');

// ── 2. Escolhas ─────────────────────────────────────────────────────────────
console.log('\n2. Escolhas');
const OFERECIDAS: Opcao[] = [
    { id: 'transcricao', rotulo: 'Ouvir', opcoes: [{ valor: 'local', rotulo: 'aqui' }, { valor: 'desligada', rotulo: 'não' }] },
    { id: 'modelo', rotulo: 'Modelo', visivel_se: { transcricao: 'local' }, opcoes: [{ valor: 'small', rotulo: 'small' }] },
];
const args = argumentosDasEscolhas(OFERECIDAS, { transcricao: 'local', modelo: 'small' });
assert(JSON.stringify(args) === JSON.stringify(['--transcricao', 'local', '--modelo', 'small']), 'escolhas viram --id valor', args);
assert(JSON.stringify(argumentosDasEscolhas(OFERECIDAS, { transcricao: 'desligada' })) === JSON.stringify(['--transcricao', 'desligada']),
    'escolha escondida (visivel_se) é ignorada');
recusa(() => argumentosDasEscolhas(OFERECIDAS, { transcricao: 'local; rm -rf /', modelo: 'small' }), 'fora da lista', 'valor fora da lista oferecida');
recusa(() => argumentosDasEscolhas(OFERECIDAS, { transcricao: 'local', modelo: 'small', outro: 'x' }), "desconhecida: 'outro'", 'escolha que não foi oferecida');
const montado = montarComando(m.instalar, { python: 'python3', newclaw_url: 'http://127.0.0.1:3090', pasta: '/p', escolhas: args });
assert(JSON.stringify(montado) === JSON.stringify(['python3', 'instalar.py', '--sem-perguntas', '--newclaw-url', 'http://127.0.0.1:3090', '--transcricao', 'local', '--modelo', 'small']),
    'comando montado com os espaços reservados preenchidos', montado);

// ── 3. Gerenciador ──────────────────────────────────────────────────────────
async function gerenciadorFalso(opcoes: { redirecionar?: string } = {}) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 's465-home-'));
    // Pacote de verdade (tar.gz com uma pasta raiz, como o do GitHub), para o `tar` de verdade extrair.
    const fonte = fs.mkdtempSync(path.join(os.tmpdir(), 's465-pacote-'));
    fs.mkdirSync(path.join(fonte, 'integracao-main'));
    fs.writeFileSync(path.join(fonte, 'integracao-main', 'instalar.py'), '# falso');
    const tgz = path.join(fonte, 'pacote.tar.gz');
    const TAR = localizarTar();
    const t = spawnSync(TAR, ['-czf', tgz, '-C', fonte, 'integracao-main']);
    if (t.status !== 0) throw new Error(`tar falhou: ${t.stderr}`);
    const executados: { programa: string; args: string[]; pasta?: string }[] = [];
    // O que a integração falsa responde, mudável no meio do teste (licenças de um pacote novo, instalação que falha).
    const falso = { licencas: [{ id: 'x', licenca: 'MIT' }] as unknown[], codigoDaInstalacao: 0 };
    const d: Dependencias = {
        async baixar(url) {
            if (url.endsWith('newclaw-integracao.json')) return { urlFinal: url, status: 200, corpo: Buffer.from(JSON.stringify(BASE)) };
            return { urlFinal: opcoes.redirecionar ?? url, status: 200, corpo: fs.readFileSync(tgz) };
        },
        async executar(programa, a, pasta): Promise<Resultado> {
            executados.push({ programa, args: a, pasta });
            if (programa === TAR) {
                const r = spawnSync(TAR, a);
                return { codigo: r.status ?? 1, saida: String(r.stdout), erro: String(r.stderr) };
            }
            if (a.includes('--opcoes')) return { codigo: 0, saida: JSON.stringify(OFERECIDAS), erro: '' };
            if (a.includes('--licencas')) return { codigo: 0, saida: JSON.stringify({ versao: 1, itens: falso.licencas }), erro: '' };
            if (a.includes('jlist')) return { codigo: 0, saida: JSON.stringify([{ name: `newclaw-integracao-${ID}`, pm2_env: { status: 'online' } }]), erro: '' };
            return { codigo: 0, saida: '', erro: '' };
        },
        async acompanhar(programa, a, pasta, aoLer) {
            executados.push({ programa, args: a, pasta });
            aoLer(JSON.stringify({ texto: '▸ Licenças de terceiros' }));
            aoLer('Collecting pipecat-ai==1.12.0');
            aoLer(JSON.stringify({ fim: true, codigo: falso.codigoDaInstalacao }));
            return falso.codigoDaInstalacao;
        },
        pm2: ['node', 'pm2.js'],
        tar: TAR,
        home,
        plataforma: 'linux',
        newclawUrl: 'http://127.0.0.1:3090',
    };
    return { g: new GerenciadorDeIntegracoes(d), home, executados, falso };
}

async function esperar(cond: () => boolean): Promise<void> {
    for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
}

async function testarGerenciador(): Promise<void> {
    console.log('\n3. Gerenciador (rede e processos falsos; tar de verdade)');
    const { g, home, executados, falso } = await gerenciadorFalso();
    const man = await g.manifesto(ID);
    const pasta = path.join(home, 'integracao-teste');

    const ops = await g.opcoes(man);
    assert(ops.length === 2 && fs.existsSync(path.join(pasta, 'instalar.py')), 'opções: baixou e extraiu o pacote na pasta da integração');
    assert(fs.existsSync(path.join(pasta, '.newclaw-integracao.json')), 'pasta marcada como criada pelo NewClaw');
    const comandoOpcoes = executados.find((e) => e.args.includes('--opcoes'))!;
    assert(comandoOpcoes.programa === 'python3' && comandoOpcoes.pasta === pasta, 'comando rodou com o python da plataforma, dentro da pasta');

    const lic = await g.licencas(man, { transcricao: 'local', modelo: 'small' }) as { itens: unknown[] };
    assert(Array.isArray(lic.itens), 'licenças das escolhas');

    try { await g.instalar(man, { transcricao: 'local', modelo: 'small' }, false); assert(false, 'sem aceite não instala'); } catch (e) {
        assert(e instanceof ErroDaIntegracao && e.status === 400, 'sem aceite das licenças não instala', (e as Error).message);
    }
    try { await g.instalar(man, { transcricao: 'local', modelo: 'outro' }, true); assert(false, 'valor fora da lista'); } catch (e) {
        assert(e instanceof ErroDaIntegracao && e.status === 400, 'escolha fora da lista não instala');
    }

    const a = await g.instalar(man, { transcricao: 'local', modelo: 'small' }, true);
    await esperar(() => a.estado !== 'rodando');
    assert(a.estado === 'concluida', 'instalação concluída', a);
    assert(a.linhas.includes('▸ Licenças de terceiros') && a.linhas.includes('Collecting pipecat-ai==1.12.0'),
        'andamento guarda as linhas (JSON e texto comum), sem a de fim', a.linhas);
    const inst = executados.find((e) => e.args.includes('--sem-perguntas'))!;
    assert(inst.args.join(' ').includes('--newclaw-url http://127.0.0.1:3090 --transcricao local --modelo small'), 'instalar recebeu o endereço e as escolhas conferidas', inst.args);
    const start = executados.find((e) => e.args.includes('start'))!;
    assert(start.args.includes('--interpreter') && start.args.includes(path.join(pasta, '.venv/bin/python')) && start.args.includes(`newclaw-integracao-${ID}`),
        'ligou no PM2 com o programa da pasta da integração', start.args);
    const est = await g.estado(man);
    assert(est.instalada && est.ligada && est.abrir === 'http://127.0.0.1:7860', 'estado: instalada e ligada, com o endereço de abrir', est);

    await testarAtualizar(g, man, pasta, executados, falso);

    await g.desinstalar(man);
    assert(!fs.existsSync(pasta), 'desinstalar apaga a pasta que o NewClaw criou');

    // Pasta que já existe e não foi criada pelo NewClaw: não escreve nem apaga.
    fs.mkdirSync(pasta);
    fs.writeFileSync(path.join(pasta, 'meu-arquivo.txt'), 'da pessoa');
    try { await g.opcoes(man); assert(false, 'pasta alheia'); } catch (e) {
        assert(e instanceof ErroDaIntegracao && e.status === 409, 'pasta que já existe sem ter sido criada aqui: recusa', (e as Error).message);
    }
    try { await g.desinstalar(man); assert(false, 'desinstalar alheia'); } catch (e) {
        assert(e instanceof ErroDaIntegracao && fs.existsSync(path.join(pasta, 'meu-arquivo.txt')), 'desinstalar não apaga pasta alheia');
    }
    fs.rmSync(home, { recursive: true, force: true });

    const redirecionado = await gerenciadorFalso({ redirecionar: 'https://exemplo.com/pacote.tar.gz' });
    try { await redirecionado.g.opcoes(await redirecionado.g.manifesto(ID)); assert(false, 'redirecionamento'); } catch (e) {
        assert((e as Error).message.includes('fora dos hosts permitidos'), 'download redirecionado para outro host: recusa', (e as Error).message);
    }
    fs.rmSync(redirecionado.home, { recursive: true, force: true });
}

// ── 3b. Atualizar ───────────────────────────────────────────────────────────
// Mesmas escolhas e mesmo aceite; só reaproveita o aceite se a lista de licenças for idêntica; desliga durante e religa no fim.
async function testarAtualizar(
    g: GerenciadorDeIntegracoes, man: ReturnType<typeof validarManifesto>, pasta: string,
    executados: { programa: string; args: string[]; pasta?: string }[], falso: { licencas: unknown[]; codigoDaInstalacao: number },
): Promise<void> {
    console.log('\n3b. Atualizar');
    const lerMarcador = () => JSON.parse(fs.readFileSync(path.join(pasta, '.newclaw-integracao.json'), 'utf-8'));
    const marcador = lerMarcador();
    assert(JSON.stringify(marcador.escolhas) === JSON.stringify({ transcricao: 'local', modelo: 'small' }) && typeof marcador.licencas_aceitas === 'string',
        'a instalação guarda as escolhas e o resumo da lista de licenças aceita', marcador);

    const antes = executados.length;
    const a = await g.atualizar(man);
    await esperar(() => a.estado !== 'rodando');
    const depois = executados.slice(antes);
    const iParar = depois.findIndex((e) => e.args.includes('stop'));
    const iInstalar = depois.findIndex((e) => e.args.includes('--sem-perguntas'));
    const iLigar = depois.findIndex((e) => e.args.includes('start'));
    assert(a.estado === 'concluida', 'atualização concluída', a);
    assert(iParar > -1 && iParar < iInstalar && iInstalar < iLigar, 'desliga antes de instalar e religa depois', depois.map((e) => e.args.join(' ')));
    assert(depois[iInstalar].args.join(' ').includes('--transcricao local --modelo small'), 'repete as escolhas guardadas', depois[iInstalar].args);
    assert(depois.some((e) => e.programa === localizarTar()), 'baixa e extrai o pacote mais novo');
    assert(!!(await g.estado(man)).atualizada_em, 'estado mostra quando foi atualizada');

    // Instalação que falha na atualização: a integração volta a ligar como estava.
    falso.codigoDaInstalacao = 1;
    const antesDaFalha = executados.length;
    const f = await g.atualizar(man);
    await esperar(() => f.estado !== 'rodando' && f.fim !== undefined);
    assert(f.estado === 'falhou' && executados.slice(antesDaFalha).some((e) => e.args.includes('start')),
        'atualização que falha religa a integração', f);
    falso.codigoDaInstalacao = 0;

    // Lista de licenças diferente no pacote novo: não reaproveita o aceite, nem desliga nada.
    falso.licencas = [{ id: 'x', licenca: 'MIT' }, { id: 'nova', licenca: 'GPL-3.0' }];
    const antesDaRevisao = executados.length;
    try { await g.atualizar(man); assert(false, 'licenças mudaram'); } catch (e) {
        assert(e instanceof ErroDaIntegracao && e.status === 409 && e.motivo === 'revisar', 'licenças mudaram: pede revisão (motivo revisar)', (e as Error).message);
    }
    assert(!executados.slice(antesDaRevisao).some((e) => e.args.includes('stop') || e.args.includes('--sem-perguntas')),
        'com revisão pendente, não desliga nem instala');
    falso.licencas = [{ id: 'x', licenca: 'MIT' }];

    // Instalação de antes deste botão (sem escolhas guardadas): pede revisão.
    const semEscolhas = lerMarcador();
    delete semEscolhas.escolhas;
    fs.writeFileSync(path.join(pasta, '.newclaw-integracao.json'), JSON.stringify(semEscolhas));
    try { await g.atualizar(man); assert(false, 'sem escolhas'); } catch (e) {
        assert(e instanceof ErroDaIntegracao && e.motivo === 'revisar', 'instalação sem escolhas guardadas: pede revisão', (e as Error).message);
    }
}

// ── 4. Ambiente ─────────────────────────────────────────────────────────────
function testarAmbiente(): void {
    console.log('\n4. Ambiente dos comandos da integração');
    const env = ambienteDaIntegracao({
        PATH: '/usr/bin', HOME: '/home/x', DASHBOARD_PASSWORD: 'segredo', TELEGRAM_BOT_TOKEN: 't', OPENAI_API_KEY: 'k', NEWCLAW_TOKEN: 'n',
    });
    assert(env.PATH === '/usr/bin' && env.HOME === '/home/x', 'passa o que um programa comum precisa');
    // Em caso de falha, mostra só os NOMES que vazaram: o valor de um segredo nunca vai para o log.
    const vazaram = ['DASHBOARD_PASSWORD', 'TELEGRAM_BOT_TOKEN', 'OPENAI_API_KEY', 'NEWCLAW_TOKEN'].filter((k) => k in env);
    assert(vazaram.length === 0, 'não passa senha, tokens nem chaves do NewClaw', vazaram.join(', '));
}

// ── 5. Regra 1 da ADR-031 ───────────────────────────────────────────────────
function testarRegra1(): void {
    console.log('\n5. ADR-031, regra 1: só o catálogo cita as integrações');
    const raiz = path.join(__dirname, '..', '..');
    const catalogo = path.join(raiz, 'dashboard', 'integracoesOpcionais', 'catalogo.ts');
    const achados: string[] = [];
    const varrer = (dir: string) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) { if (e.name !== '__tests__' && e.name !== 'node_modules') varrer(p); continue; }
            if (p === catalogo || !/\.(ts|js|html)$/.test(e.name)) continue;
            const texto = fs.readFileSync(p, 'utf-8');
            for (const item of CATALOGO) if (texto.includes(item.id)) achados.push(`${path.relative(raiz, p)} cita ${item.id}`);
        }
    };
    varrer(raiz);
    assert(achados.length === 0, 'nenhum arquivo de src/ além do catálogo cita uma integração opcional', achados);
}

(async () => {
    await testarGerenciador();
    testarAmbiente();
    testarRegra1();
    console.log(`\nS465: ${passed} ok, ${failed} falha(s)`);
    process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
