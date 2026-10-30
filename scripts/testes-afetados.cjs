/**
 * Seleção dos testes de regressão AFETADOS por um conjunto de arquivos alterados — usada por
 * `node scripts/run-regression-tests.cjs --afetados` durante o trabalho e pelo CI em todo pull request (desde 30/10/2026); a suíte
 * COMPLETA roda no CI a cada push no main, e é ela que grava o mapa observado que os PRs restauram do cache.
 *
 * A seleção é CONSERVADORA: na dúvida, o teste roda. Um teste é afetado quando:
 *   1. ele próprio mudou;
 *   2. importa — direta ou transitivamente, por `import`/`require`/`import()` relativos — um arquivo alterado;
 *   3. importava um arquivo que foi removido;
 *   4. cita o arquivo alterado pelo NOME entre aspas (`'GoalExecutionLoop.ts'`, `'ModelosView.js'`, `'run-regression-tests.cjs'`):
 *      é como os testes que leem o código-fonte como texto, carregam por caminho montado (`path.join(process.cwd(), …)`) ou abrem
 *      um documento de registro alcançam o que verificam.
 *   5. LEU o arquivo na última suíte completa (mapa observado — ver ARQUIVO_DO_MAPA);
 *   6. VARREU uma pasta que contém o arquivo na última suíte completa (leu ≥ FRACAO_PARA_VARREDURA dos arquivos dela, recursivamente)
 *      — pega também arquivo NOVO;
 *   7. LISTA PASTAS (recenseamento: arquivo sem consumidor, chamadas ao LLM, endereço privado) e algum arquivo foi CRIADO ou REMOVIDO.
 * E qualquer mudança em `MUDA_TUDO` (o próprio executor, a compilação, as dependências instaladas) seleciona a suíte inteira.
 *
 * Por que as regras 5 e 6: conferidas contra o que cada teste REALMENTE lê em execução, as regras 1–4 sozinhas omitiam ~10% dos pares
 * (teste, arquivo lido) — testes que varrem pastas inteiras. Ver docs/testes/TESTES_AFETADOS.md.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const RAIZ = path.join(__dirname, '..');

/** Mudanças que podem alterar o resultado de QUALQUER teste. */
const MUDA_TUDO = [
    'scripts/run-regression-tests.cjs',
    'scripts/regression-preload.cjs',
    'scripts/testes-afetados.cjs',
    'tsconfig.json',
    'package.json',
    'package-lock.json',
    // O CI decide aqui quais testes rodam em cada PR: mudar o workflow roda a suíte inteira.
    '.github/workflows/regressao.yml',
];

const RE_IMPORT = /(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)['"](\.{1,2}\/[^'"]*)['"]/g;
/** Teste que lista pastas (recenseamento). */
const LISTA_PASTAS = /readdirSync|readdir\(|opendirSync|\.walk\(|globSync|fs\.promises\.readdir/;
const EXTENSOES = ['', '.ts', '.tsx', '.js', '.cjs', '.mjs', '.json', '/index.ts', '/index.js'];
const SEM_EXTENSAO = /\.(ts|tsx|js|cjs|mjs|json)$/;

const relativo = (abs) => path.relative(RAIZ, abs).split(path.sep).join('/');

/**
 * Mapa OBSERVADO: o que cada teste leu na última execução COMPLETA (o runner grava a cada suíte completa — custo medido nulo). Cobre
 * o que análise estática não enxerga: testes que VARREM uma pasta (procuram endereço privado em todo o código, recenseiam as chamadas
 * ao LLM, carregam todas as skills de `skills/`). Fica no cache local do node_modules — por máquina, nunca versionado; sem ele a
 * seleção é só estática e avisa.
 */
const ARQUIVO_DO_MAPA = path.join(RAIZ, 'node_modules', '.cache', 'newclaw-regressao', 'mapa-de-leituras.json');
/**
 * Um teste VARRE uma pasta (inclusive recursivamente: `src/`, `skills/`) quando leu pelo menos esta fração dos arquivos rastreados
 * nela, e no mínimo LEITURAS_MINIMAS — então qualquer arquivo novo ou alterado sob ela o seleciona. Medido (10/2026): quem varre lê
 * 90–100% (S195 em src/, S118 em skills/); um teste comum lê 1–20% de uma pasta.
 */
const FRACAO_PARA_VARREDURA = 0.75;
const LEITURAS_MINIMAS = 3;

let rastreadosCache = null;
function arquivosRastreados() {
    if (rastreadosCache) return rastreadosCache;
    try {
        rastreadosCache = execFileSync('git', ['ls-files'], { cwd: RAIZ, encoding: 'utf-8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] })
            .split('\n').filter(Boolean);
    } catch { rastreadosCache = []; }
    return rastreadosCache;
}

const ancestrais = (f) => { const r = []; let d = path.posix.dirname(f); while (d && d !== '.') { r.push(d); d = path.posix.dirname(d); } return r; };

function carregarMapa(arquivo = ARQUIVO_DO_MAPA) {
    try { return JSON.parse(fs.readFileSync(arquivo, 'utf-8')); } catch { return null; }
}

function gravarMapa(conteudo, arquivo = ARQUIVO_DO_MAPA) {
    fs.mkdirSync(path.dirname(arquivo), { recursive: true });
    fs.writeFileSync(arquivo, JSON.stringify(conteudo));
}

/**
 * Pastas (e ancestrais) que o teste varreu, segundo o que ele leu. Duas chaves por pasta: `pasta` (qualquer arquivo) e `pasta|.ext`
 * (só aquela extensão) — um recenseamento que lê TODO o TypeScript de produção, mas não o JavaScript do painel, varre `src/dashboard|.ts`.
 */
const extensao = (f) => path.posix.extname(f) || '(sem)';
const chaves = (f) => ancestrais(f).flatMap((d) => [d, `${d}|${extensao(f)}`]);
const totalPorChaveCache = new Map();
function totalNaChave(k) {
    if (!totalPorChaveCache.size) for (const f of arquivosRastreados()) for (const c of chaves(f)) totalPorChaveCache.set(c, (totalPorChaveCache.get(c) || 0) + 1);
    return totalPorChaveCache.get(k) || 0;
}
function pastasVarridas(leituras) {
    const lidos = new Map();
    for (const f of leituras) for (const c of chaves(f)) lidos.set(c, (lidos.get(c) || 0) + 1);
    const varridas = new Set();
    for (const [c, n] of lidos) {
        const total = totalNaChave(c);
        if (n >= LEITURAS_MINIMAS && total > 0 && n / total >= FRACAO_PARA_VARREDURA) varridas.add(c);
    }
    return varridas;
}
const varreduraQueCobre = (arquivo, varridas) => chaves(arquivo).find((c) => varridas.has(c)) || null;

function ehArquivo(p) {
    try { return fs.statSync(p).isFile(); } catch { return false; }
}

/** Dependências DIRETAS de um arquivo: resolvidas (caminhos relativos à raiz) e não resolvidas (base sem extensão — arquivo removido). */
const cacheDiretas = new Map();
function dependenciasDiretas(abs) {
    if (cacheDiretas.has(abs)) return cacheDiretas.get(abs);
    const r = { resolvidas: [], naoResolvidas: [] };
    let texto = '';
    try { texto = fs.readFileSync(abs, 'utf-8'); } catch { /* removido */ }
    for (const m of texto.matchAll(RE_IMPORT)) {
        const base = path.resolve(path.dirname(abs), m[1]);
        const achado = EXTENSOES.map((e) => base + e).find(ehArquivo);
        if (achado) { if (!achado.includes(`${path.sep}node_modules${path.sep}`)) r.resolvidas.push(achado); }
        else r.naoResolvidas.push(relativo(base).replace(SEM_EXTENSAO, ''));
    }
    cacheDiretas.set(abs, r);
    return r;
}

/** Fechamento transitivo dos imports relativos de um arquivo (inclui o próprio). */
const cacheFechamento = new Map();
function fechamento(abs) {
    if (cacheFechamento.has(abs)) return cacheFechamento.get(abs);
    const arquivos = new Set([relativo(abs)]);
    const removidos = new Set();
    const vistos = new Set([abs]);
    const pilha = [abs];
    while (pilha.length) {
        const atual = pilha.pop();
        const d = dependenciasDiretas(atual);
        for (const n of d.naoResolvidas) removidos.add(n);
        for (const prox of d.resolvidas) {
            if (vistos.has(prox)) continue;
            vistos.add(prox);
            arquivos.add(relativo(prox));
            pilha.push(prox);
        }
    }
    const r = { arquivos, removidos };
    cacheFechamento.set(abs, r);
    return r;
}

const escapar = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** O teste cita o arquivo pelo nome entre aspas (inteiro, ou como o fim de um caminho). */
function citaPeloNome(textoDoTeste, arquivo) {
    const nome = path.posix.basename(arquivo);
    return new RegExp(`['"\`/\\\\]${escapar(nome)}['"\`]`).test(textoDoTeste);
}

/**
 * @param {string[]} testes  caminhos absolutos dos arquivos de teste
 * @param {string[]} alterados caminhos relativos à raiz, com `/`
 * @param {{ mapa?: Record<string, string[]|null> | null }} [fontes] mapa observado (nome do teste → arquivos lidos); null = só estático
 * @returns {{ tudo: string|null, selecionados: Array<{ arquivo: string, motivos: string[] }> }}
 */
function selecionar(testes, alterados, { mapa = null, criadosOuRemovidos = [] } = {}) {
    const infra = alterados.filter((a) => MUDA_TUDO.includes(a));
    if (infra.length) {
        return { tudo: infra.join(', '), selecionados: testes.map((t) => ({ arquivo: t, motivos: [`muda tudo: ${infra.join(', ')}`] })) };
    }
    const removidos = alterados.filter((a) => !ehArquivo(path.join(RAIZ, a)));
    const selecionados = [];
    for (const t of testes) {
        const motivos = [];
        const rt = relativo(t);
        const f = fechamento(t);
        let texto = '';
        try { texto = fs.readFileSync(t, 'utf-8'); } catch { /* teste removido: não é selecionável */ }
        const lidos = mapa && Array.isArray(mapa[path.basename(t)]) ? mapa[path.basename(t)] : null;
        const lidosSet = lidos ? new Set(lidos) : null;
        const varridas = lidos ? pastasVarridas(lidos) : null;
        for (const a of alterados) {
            if (a === rt) motivos.push('o próprio teste mudou');
            else if (f.arquivos.has(a)) motivos.push(`importa ${a}`);
            else if (removidos.includes(a) && f.removidos.has(a.replace(SEM_EXTENSAO, ''))) motivos.push(`importava ${a} (removido)`);
            else if (texto && citaPeloNome(texto, a)) motivos.push(`cita ${path.posix.basename(a)}`);
            else if (lidosSet && lidosSet.has(a)) motivos.push(`leu ${a} na última suíte completa`);
            else if (varridas && varreduraQueCobre(a, varridas)) motivos.push(`varre ${varreduraQueCobre(a, varridas).split('|').join('/*')}`);   // todas as "|" (CodeQL #113)
        }
        // Regra 7: arquivo CRIADO ou REMOVIDO muda o que um teste de recenseamento encontra ao listar pastas (S384: arquivo novo sem
        // consumidor; S356: chamada nova ao LLM; S195: endereço privado em arquivo novo) — esses rodam sempre que a estrutura muda.
        if (!motivos.length && criadosOuRemovidos.length && texto && LISTA_PASTAS.test(texto)) {
            motivos.push(`lista pastas e ${criadosOuRemovidos.length} arquivo(s) foram criados/removidos`);
        }
        if (motivos.length) selecionados.push({ arquivo: t, motivos });
    }
    return { tudo: null, selecionados };
}

/**
 * Arquivos alterados em relação a `base` (padrão: o ponto em que a branch saiu de origin/main — exatamente o que um push levaria):
 * commits da branch + mudanças ainda não commitadas (preparadas ou não) + arquivos novos não rastreados.
 */
function arquivosAlterados({ base } = {}) {
    const git = (...args) => execFileSync('git', args, { cwd: RAIZ, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    let ref = base;
    if (!ref) {
        try { ref = git('merge-base', 'HEAD', 'origin/main'); } catch { ref = 'HEAD'; }
    }
    const status = git('diff', '--name-status', '--no-renames', ref).split('\n').map((l) => l.split('\t')).filter((p) => p.length >= 2);
    const novos = git('ls-files', '--others', '--exclude-standard').split('\n').map((s) => s.trim()).filter(Boolean);
    const alterados = [...new Set([...status.map((p) => p[1].trim()), ...novos])].sort();
    const criadosOuRemovidos = [...new Set([...status.filter((p) => p[0] === 'A' || p[0] === 'D').map((p) => p[1].trim()), ...novos])].sort();
    return { base: ref, alterados, criadosOuRemovidos };
}

module.exports = { MUDA_TUDO, ARQUIVO_DO_MAPA, selecionar, arquivosAlterados, fechamento, citaPeloNome, carregarMapa, gravarMapa, pastasVarridas };
