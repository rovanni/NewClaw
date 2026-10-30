#!/usr/bin/env node
/**
 * Executa toda a suíte de regressão (src/__tests__/regression/*.test.ts) via subprocesso real, um por arquivo, e decide
 * PASSOU/FALHOU pelo exit code de cada processo — não por inspeção de texto na última linha de saída.
 *
 * Gate S4.5: a verificação usada até aqui (grep de texto tipo "❌ Falhou: [1-9]" na última linha) não detecta exceção não
 * tratada (o processo encerra com stack trace, não com a string esperada) nem teste que segue rodando/imprimindo depois de uma
 * assertion falhar sem chamar process.exit(1). Isso permitiu falso verde em S12_RiskAnalyzer_SanitizePlanSteps.test.ts (mock
 * desatualizado causando TypeError não tratado) e S5_FundamentalTools_Q2Skip.test.ts (2 assertions falhando sem abortar o
 * processo). Este script corrige isso: cada arquivo roda em subprocesso próprio, só o exit code decide passa/falha.
 *
 * Integridade do resultado (auditoria de 10/10/2026 — o verde precisa significar "rodou e passou"):
 *  - ZERO testes descobertos, ou pasta de testes ausente, é FALHA (exit 1) — antes saía 0 ("0/0 passaram"). A exceção explícita
 *    é `--allow-empty`.
 *  - Todo teste descoberto tem de ter resultado contabilizado (descobertos == executados).
 *  - Teste que fica pendurado é morto por TIMEOUT (padrão 10 min, `--timeout`) e conta como falha.
 *  - IGNORADO é um estado explícito e contabilizado, nunca um verde: o teste que não pode rodar neste ambiente (ex.: depende do pacote
 *    opcional `newclaw-kernel-adapter`, que só existe com o repositório irmão) imprime `SKIP: <motivo>` e sai com 77. Sem o motivo, 77
 *    é FALHA. Ignorado não conta como aprovado e aparece em "IGNORADOS" no resumo e no relatório; `--strict-skips` transforma
 *    qualquer ignorado em falha (para quem tem todas as dependências opcionais).
 *  - Teste que sai com 0 MAS imprimiu "FALHOU:" (a mensagem do assert() dos testes) é INCONSISTENTE e conta como falha: o limite
 *    documentado acima (teste que detecta falha e não chama process.exit(1)) deixa de ser um falso verde silencioso. O marcador é
 *    estreito de propósito ("FALHOU:" em maiúsculas, com dois-pontos): não casa com linhas de resumo como "❌ Falhou: 0".
 *
 * Medição: duração por teste (processo inteiro) e a divisão aproximada início × corpo — tempo até a primeira saída (boot do
 * Node + compilação do ts-node + importações do topo) × o resto — via scripts/regression-preload.cjs, que só observa.
 *
 * Uso:
 *   node scripts/run-regression-tests.cjs                         → roda a suíte real
 *   node scripts/run-regression-tests.cjs --report out.json       → grava também o relatório estruturado
 *   node scripts/run-regression-tests.cjs --filter S37            → só os arquivos cujo nome contém o texto (diagnóstico)
 *   node scripts/run-regression-tests.cjs --timeout 120000        → timeout por teste, em ms
 *   node scripts/run-regression-tests.cjs --dir <pasta>           → outra pasta de testes (usado pelo autoteste)
 *   node scripts/run-regression-tests.cjs --allow-empty           → zero testes não é falha (exceção explícita)
 *   node scripts/run-regression-tests.cjs --strict-skips          → qualquer teste IGNORADO conta como falha
 *   node scripts/run-regression-tests.cjs --selftest              → prova (fixtures descartáveis) que o harness detecta tudo isso
 *   node scripts/run-regression-tests.cjs --afetados              → só os testes afetados pelas mudanças desde que a branch saiu de
 *                                                                   origin/main (commits + não commitadas + novos); seleção em
 *                                                                   scripts/testes-afetados.cjs. Para o dia a dia — NÃO substitui a
 *                                                                   completa antes do push (o relatório diz `modo: "afetados"`)
 *   node scripts/run-regression-tests.cjs --base <ref>            → idem, comparando com outra referência (implica --afetados)
 *   node scripts/run-regression-tests.cjs --mapa-de-leituras m.json → registra os arquivos do repositório que cada teste lê de fato
 *                                                                   (serve para conferir a seleção por módulo)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// Resolve o binário do ts-node e invoca via `node` diretamente (spawnSync(process.execPath, ...)),
// em vez de `npx`/`npx.cmd`. No Windows, spawnSync de um `.cmd` sem shell:true falha com EINVAL
// (o processo nem chega a rodar), e com shell:true o array de args é apenas concatenado pelo
// cmd.exe (childprocess emite até DEP0190 por causa disso), o que se mostrou não confiável em
// teste manual (exit code do processo real não propagava corretamente). Chamar o .js do ts-node
// via node é o caminho padrão, sem shell, sem shim de plataforma.
const tsNodeBin = require.resolve('ts-node/dist/bin.js');
const PRELOAD = path.join(__dirname, 'regression-preload.cjs');
// Todo teste roda na raiz do repositório, não no diretório de quem chamou o runner: o ts-node procura o tsconfig a partir do cwd e
// vários testes leem arquivos por `process.cwd()` (S381-4).
const RAIZ_DO_REPOSITORIO = path.join(__dirname, '..');
const TIMEOUT_PADRAO_MS = 10 * 60 * 1000;
/** A mensagem do assert() dos testes: "❌ FALHOU: <texto>". Estreito de propósito (ver o cabeçalho). */
const MARCADOR_DE_FALHA = /FALHOU:/g;
/** Código de saída de um teste IGNORADO (convenção do automake: 77 = "skipped"). Só vale acompanhado de uma linha `SKIP: <motivo>`. */
const CODIGO_DE_TESTE_IGNORADO = 77;
const LINHA_DE_MOTIVO = /^SKIP:\s*(.+)$/m;

function lerArgumentos(argv) {
    const opcoes = { selftest: false, allowEmpty: false, strictSkips: false, dir: null, report: null, filter: null, timeoutMs: TIMEOUT_PADRAO_MS,
        afetados: false, base: null, mapaDeLeituras: null };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const valor = () => (a.includes('=') ? a.slice(a.indexOf('=') + 1) : argv[++i]);
        if (a === '--selftest') opcoes.selftest = true;
        else if (a === '--afetados') opcoes.afetados = true;
        else if (a === '--base' || a.startsWith('--base=')) { opcoes.base = valor(); opcoes.afetados = true; }
        else if (a === '--mapa-de-leituras' || a.startsWith('--mapa-de-leituras=')) opcoes.mapaDeLeituras = valor();
        else if (a === '--allow-empty') opcoes.allowEmpty = true;
        else if (a === '--strict-skips') opcoes.strictSkips = true;
        else if (a === '--dir' || a.startsWith('--dir=')) opcoes.dir = valor();
        else if (a === '--report' || a.startsWith('--report=')) opcoes.report = valor();
        else if (a === '--filter' || a.startsWith('--filter=')) opcoes.filter = valor();
        else if (a === '--timeout' || a.startsWith('--timeout=')) {
            const n = Number(valor());
            if (!Number.isFinite(n) || n <= 0) { console.error(`--timeout inválido: ${argv[i]}`); process.exit(2); }
            opcoes.timeoutMs = n;
        } else { console.error(`Argumento desconhecido: ${a}`); process.exit(2); }
    }
    return opcoes;
}

let sequencia = 0;
/** `--mapa-de-leituras`: o preload registra os arquivos do repositório que cada teste lê (só observação). */
let registrarLeituras = false;

function runOne(filePath, timeoutMs = TIMEOUT_PADRAO_MS) {
    const arquivoDeMedicao = path.join(os.tmpdir(), `nc-regressao-${process.pid}-${sequencia++}.json`);
    const nodeOptionsOriginal = process.env.NODE_OPTIONS ?? '';
    const env = {
        ...process.env,
        NC_TIMING_FILE: arquivoDeMedicao,
        ...(registrarLeituras ? { NC_REGISTRAR_LEITURAS: '1' } : {}),
        NC_ORIG_NODE_OPTIONS: nodeOptionsOriginal,
        // Barras normais: o NODE_OPTIONS trata a barra invertida como escape (no Windows o caminho chegava corrompido).
        NODE_OPTIONS: `${nodeOptionsOriginal} --require "${PRELOAD.replace(/\\/g, '/')}"`.trim(),
    };
    const t0 = process.hrtime.bigint();
    const result = spawnSync(process.execPath, [tsNodeBin, filePath], { encoding: 'utf-8', env, cwd: RAIZ_DO_REPOSITORIO, timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024 });
    const durationMs = Math.round(Number(process.hrtime.bigint() - t0) / 1e6);

    let medicao = null;
    try { medicao = JSON.parse(fs.readFileSync(arquivoDeMedicao, 'utf-8')); } catch { /* teste morto antes de sair: sem divisão início/corpo */ }
    try { fs.rmSync(arquivoDeMedicao, { force: true }); } catch { /* resíduo em tmp não importa */ }

    const stdout = result.stdout || '';
    const stderr = result.stderr || '';
    const marcadores = ((stdout + '\n' + stderr).match(MARCADOR_DE_FALHA) || []).length;
    const motivoIgnorado = ((stdout + '\n' + stderr).match(LINHA_DE_MOTIVO) || [])[1] || null;
    const timedOut = result.error != null && result.error.code === 'ETIMEDOUT';
    const crashed = result.error != null && !timedOut;
    const exitCode = timedOut || crashed ? null : result.status;
    let status;
    if (timedOut) status = 'timeout';
    else if (crashed) status = 'crashed';
    else if (exitCode === CODIGO_DE_TESTE_IGNORADO && motivoIgnorado) status = 'skipped';
    else if (exitCode !== 0) status = 'failed';
    else if (marcadores > 0) status = 'inconsistent';
    else status = 'passed';

    return {
        file: filePath,
        ok: status === 'passed',
        status,
        exitCode,
        crashed,
        timedOut,
        durationMs,
        startupMs: medicao && medicao.primeiraSaidaMs != null ? Math.round(Math.min(medicao.primeiraSaidaMs, durationMs)) : null,
        rssMB: medicao ? medicao.rssMB : null,
        failMarkers: marcadores,
        motivoIgnorado: status === 'skipped' ? motivoIgnorado : null,
        leituras: medicao && Array.isArray(medicao.leituras) ? medicao.leituras : null,
        stdout,
        stderr,
    };
}

function discover(dir, filter) {
    if (!fs.existsSync(dir)) return null;
    return fs.readdirSync(dir)
        .filter((f) => f.endsWith('.test.ts'))
        .filter((f) => !filter || f.includes(filter))
        .sort()
        .map((f) => path.join(dir, f));
}

const segundos = (ms) => (ms / 1000).toFixed(1) + 's';

/**
 * 0xC0000409 (STATUS_STACK_BUFFER_OVERRUN): o PRÓPRIO processo do Node abortou — não é asserção, exceção nem process.exit do
 * teste. Medido no CI (30 execuções por versão, 01–22/10/2026): Windows + Node 22.22.2, 0 vezes; Windows + Node 24.15.0, 3
 * vezes (S365, S166, S294 — testes curtos que acabaram de fazer chamadas de rede), sempre passando na repetição; Node 24.20
 * local, nunca. Uma repetição, só neste código e só no Windows; ela PRECISA passar, e fica registrada no teste e no resumo.
 */
const CRASH_NATIVO_DO_NODE_NO_WINDOWS = 3221226505;
const ehCrashNativo = (r) => process.platform === 'win32' && r.exitCode === CRASH_NATIVO_DO_NODE_NO_WINDOWS;

function runSuite(files, timeoutMs) {
    const results = [];
    for (const file of files) {
        let r = runOne(file, timeoutMs);
        if (ehCrashNativo(r)) {
            console.error(`  CRASH NATIVO DO NODE (0xC0000409) em ${path.basename(file)} — repetindo uma vez`);
            const primeira = { durationMs: r.durationMs, stderrFinal: (r.stderr || '').split('\n').slice(-8).join('\n') };
            r = runOne(file, timeoutMs);
            r.repetidoPorCrashNativo = primeira;
        }
        results.push(r);
        const label = path.basename(r.file);
        const inicio = r.startupMs != null ? ` (início ${segundos(r.startupMs)})` : '';
        if (r.ok) {
            console.log(`  OK   ${label}  ${segundos(r.durationMs)}${inicio}`);
        } else if (r.status === 'skipped') {
            console.log(`  SKIP ${label}  ${segundos(r.durationMs)} (IGNORADO: ${r.motivoIgnorado})`);
        } else {
            const motivo = r.timedOut ? `TIMEOUT após ${segundos(r.durationMs)}` :
                r.status === 'inconsistent' ? `INCONSISTENTE: exit 0, mas imprimiu "FALHOU:" ${r.failMarkers}x` :
                `exitCode=${r.exitCode}, crashed=${r.crashed}`;
            console.error(`  FAIL ${label}  ${segundos(r.durationMs)} (${motivo})`);
            const tail = (r.stderr || r.stdout).split('\n').slice(-15).join('\n');
            console.error(tail);
        }
    }
    return results;
}

function montarRelatorio(results, descobertos, duracaoTotalMs, opcoes) {
    const contar = (s) => results.filter((r) => r.status === s).length;
    // O relatório precisa dizer EXATAMENTE o que foi testado: o commit completo, se a árvore estava limpa (e, se não, quais
    // arquivos diferiam) e a versão do próprio runner — para nunca misturar resultados de versões diferentes.
    const git = (args) => { try { return require('child_process').execFileSync('git', args, { cwd: path.join(__dirname, '..'), encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } };
    // Sem .git (ex.: a árvore foi enviada com \`git archive\`), o commit testado vem de NC_COMMIT_TESTADO — o relatório nunca fica sem dizer
    // o que foi testado (a primeira execução em Linux saiu com commit nulo). \`arvoreLimpa\` só é afirmado quando o git pode conferir.
    const commitDoGit = git(['rev-parse', 'HEAD']);
    const commit = commitDoGit || process.env.NC_COMMIT_TESTADO || null;
    const sujos = (git(['status', '--porcelain']) || '').split('\n').filter(Boolean);
    const versaoDoRunner = require('crypto').createHash('sha1')
        .update(fs.readFileSync(__filename)).update(fs.readFileSync(PRELOAD)).digest('hex').slice(0, 12);
    return {
        versaoDoRelatorio: 2,
        versaoDoRunner,
        iniciadoEm: new Date(Date.now() - duracaoTotalMs).toISOString(),
        no: process.version,
        plataforma: `${process.platform}-${process.arch}`,
        commit,
        arvoreLimpa: commitDoGit ? sujos.length === 0 : null,
        arquivosAlterados: sujos.slice(0, 40),
        comando: `node scripts/run-regression-tests.cjs ${process.argv.slice(2).join(' ')}`.trim(),
        // "completa" | "filtrada" | "afetados": um relatório parcial nunca se passa pelo da suíte inteira.
        modo: opcoes.selecao ? 'afetados' : opcoes.filter ? 'filtrada' : 'completa',
        ...(opcoes.selecao ? { selecao: opcoes.selecao } : {}),
        timeoutPorTesteMs: opcoes.timeoutMs,
        totais: {
            descobertos: descobertos,
            executados: results.length,
            aprovados: contar('passed'),
            falhos: contar('failed') + contar('crashed'),
            inconsistentes: contar('inconsistent'),
            timeouts: contar('timeout'),
            ignorados: contar('skipped'),
            pendentes: 0,
            // Testes que o Node abortou (0xC0000409) na 1ª execução e foram repetidos — o status acima é o da repetição.
            repetidosPorCrashNativo: results.filter((r) => r.repetidoPorCrashNativo).length,
        },
        duracaoTotalMs,
        testes: results.map((r) => ({
            arquivo: path.basename(r.file), status: r.status, exitCode: r.exitCode, duracaoMs: r.durationMs,
            inicioMs: r.startupMs, corpoMs: r.startupMs != null ? r.durationMs - r.startupMs : null,
            memoriaMB: r.rssMB, marcadoresDeFalha: r.failMarkers, motivoIgnorado: r.motivoIgnorado,
            ...(r.repetidoPorCrashNativo ? { repetidoPorCrashNativo: r.repetidoPorCrashNativo } : {}),
        })),
    };
}

/** Roda a suíte de `dir` e devolve { relatorio, exitCode } — a ÚNICA fonte da decisão passa/falha. */
function executar(opcoes) {
    const dir = opcoes.dir || path.join(__dirname, '..', 'src', '__tests__', 'regression');
    const files = discover(dir, opcoes.filter);
    if (files === null) {
        console.error(`Pasta de testes de regressão ausente: ${dir}. Sem testes não há verde — isto é uma FALHA${opcoes.allowEmpty ? ' (ignorada por --allow-empty)' : ''}.`);
        return { relatorio: null, exitCode: opcoes.allowEmpty ? 0 : 1 };
    }
    if (files.length === 0) {
        console.error(`Nenhum teste (*.test.ts) descoberto em ${dir}${opcoes.filter ? ` com o filtro "${opcoes.filter}"` : ''}. Zero testes não é sucesso${opcoes.allowEmpty ? ' (ignorado por --allow-empty)' : ''}.`);
        return { relatorio: null, exitCode: opcoes.allowEmpty ? 0 : 1 };
    }
    let aRodar = files;
    if (opcoes.afetados) {
        // Seleção por módulo (scripts/testes-afetados.cjs). Zero afetados é um resultado LEGÍTIMO aqui (ex.: só documentação mudou) e é
        // dito com todas as letras — diferente de zero testes DESCOBERTOS, que continua sendo falha.
        const { arquivosAlterados, selecionar, carregarMapa } = require('./testes-afetados.cjs');
        let mudancas;
        try { mudancas = arquivosAlterados({ base: opcoes.base }); } catch (e) {
            console.error(`--afetados: não foi possível obter os arquivos alterados pelo git (${e.message.split('\n')[0]}). Rode a suíte completa.`);
            return { relatorio: null, exitCode: 1 };
        }
        const observado = carregarMapa();
        const s = selecionar(files, mudancas.alterados, { mapa: observado ? observado.mapa : null, criadosOuRemovidos: mudancas.criadosOuRemovidos });
        console.log(`MODO AFETADOS — base ${mudancas.base.slice(0, 12)}: ${mudancas.alterados.length} arquivo(s) alterado(s)`);
        if (observado) console.log(`Dependências observadas: mapa da suíte completa de ${observado.geradoEm || '?'} (commit ${String(observado.commit || '?').slice(0, 7)}).`);
        else console.log('AVISO: sem mapa de dependências observadas (ele é gravado por toda suíte completa). A seleção será só estática e pode\n'
            + '       omitir testes que varrem pastas inteiras — rode `npm run test:regression` uma vez nesta máquina.');
        for (const a of mudancas.alterados.slice(0, 25)) console.log(`  · ${a}`);
        if (mudancas.alterados.length > 25) console.log(`  · … e mais ${mudancas.alterados.length - 25}`);
        if (s.tudo) console.log(`Mudança que afeta todos os testes (${s.tudo}) → a suíte inteira será executada.`);
        else for (const x of s.selecionados) console.log(`  → ${path.basename(x.arquivo)}: ${x.motivos.slice(0, 3).join('; ')}${x.motivos.length > 3 ? ` (+${x.motivos.length - 3})` : ''}`);
        console.log(`${s.selecionados.length} de ${files.length} testes selecionados. ISTO NÃO SUBSTITUI A SUÍTE COMPLETA antes de enviar ao GitHub.\n`);
        opcoes.selecao = { base: mudancas.base, alterados: mudancas.alterados, testesNaSuite: files.length,
            selecionados: s.selecionados.map((x) => ({ arquivo: path.basename(x.arquivo), motivos: x.motivos })) };
        if (s.selecionados.length === 0) {
            console.log('Nenhum teste afetado pelas mudanças — nada a executar.');
            if (opcoes.report) {
                fs.mkdirSync(path.dirname(path.resolve(opcoes.report)), { recursive: true });
                fs.writeFileSync(opcoes.report, JSON.stringify(montarRelatorio([], 0, 0, opcoes), null, 2));
            }
            return { relatorio: null, exitCode: 0 };
        }
        aRodar = s.selecionados.map((x) => x.arquivo);
    }
    // A suíte completa (pasta padrão, sem filtro nem seleção) sempre registra o que cada teste lê e atualiza o mapa observado usado por
    // --afetados. Custo medido: nenhum (1533 s com registro × 1539 s sem, mesma suíte).
    const suiteCompletaPadrao = !opcoes.dir && !opcoes.filter && !opcoes.afetados;
    registrarLeituras = !!opcoes.mapaDeLeituras || suiteCompletaPadrao;
    const t0 = process.hrtime.bigint();
    const results = runSuite(aRodar, opcoes.timeoutMs);
    const duracaoTotalMs = Math.round(Number(process.hrtime.bigint() - t0) / 1e6);
    const relatorio = montarRelatorio(results, aRodar.length, duracaoTotalMs, opcoes);
    const t = relatorio.totais;
    if (registrarLeituras) {
        const mapa = {};
        for (const r of results) mapa[path.basename(r.file)] = r.leituras;
        const conteudo = { commit: relatorio.commit, plataforma: relatorio.plataforma, geradoEm: new Date().toISOString(), mapa };
        if (opcoes.mapaDeLeituras) {
            fs.mkdirSync(path.dirname(path.resolve(opcoes.mapaDeLeituras)), { recursive: true });
            fs.writeFileSync(opcoes.mapaDeLeituras, JSON.stringify(conteudo, null, 1));
            console.log(`Mapa de leituras: ${opcoes.mapaDeLeituras} (${results.filter((r) => r.leituras).length}/${results.length} testes registrados)`);
        }
        if (suiteCompletaPadrao) {
            try { require('./testes-afetados.cjs').gravarMapa(conteudo); } catch (e) { console.error(`(mapa de dependências não gravado: ${e.message})`); }
        }
    }

    console.log('');
    const ignorados = results.filter((r) => r.status === 'skipped');
    if (ignorados.length) {
        console.log(`IGNORADOS (${ignorados.length}) — NÃO contam como aprovados:`);
        for (const r of ignorados) console.log(`  ${path.basename(r.file)}: ${r.motivoIgnorado}`);
        console.log('');
    }
    const lentos = [...results].sort((a, b) => b.durationMs - a.durationMs).slice(0, 10);
    console.log('Mais lentos:');
    for (const r of lentos) console.log(`  ${segundos(r.durationMs).padStart(7)}  ${path.basename(r.file)}`);
    console.log('');
    const repetidos = results.filter((r) => r.repetidoPorCrashNativo);
    if (repetidos.length) {
        console.log(`REPETIDOS POR CRASH NATIVO DO NODE (0xC0000409) (${repetidos.length}): ${repetidos.map((r) => `${path.basename(r.file)} → ${r.status}`).join(', ')}`);
        console.log('');
    }
    const rotulo = opcoes.selecao ? `AFETADOS (${t.descobertos} de ${opcoes.selecao.testesNaSuite} — não é a suíte completa)` : 'SUÍTE';
    console.log(`${rotulo}: ${t.aprovados}/${t.descobertos} passaram | executados=${t.executados} falhos=${t.falhos} inconsistentes=${t.inconsistentes} timeouts=${t.timeouts} ignorados=${t.ignorados} pendentes=${t.pendentes} | duração ${segundos(duracaoTotalMs)}`);

    if (opcoes.report) {
        fs.mkdirSync(path.dirname(path.resolve(opcoes.report)), { recursive: true });
        fs.writeFileSync(opcoes.report, JSON.stringify(relatorio, null, 2));
        console.log(`Relatório: ${opcoes.report}`);
    }
    const integro = t.executados === t.descobertos;
    if (!integro) console.error(`INTEGRIDADE: ${t.descobertos} descobertos, ${t.executados} executados — o resultado não é confiável.`);
    const ruim = t.falhos + t.inconsistentes + t.timeouts > 0 || !integro || (opcoes.strictSkips && t.ignorados > 0);
    if (opcoes.strictSkips && t.ignorados > 0) console.error(`--strict-skips: ${t.ignorados} teste(s) ignorado(s) contam como FALHA.`);
    return { relatorio, exitCode: ruim ? 1 : 0 };
}

function selfTest() {
    // Os fixtures PRECISAM viver dentro de src/ (mesmo que descartáveis): ts-node resolve
    // tsconfig.json subindo a partir do diretório do arquivo-alvo. Um arquivo fora da árvore
    // do projeto (ex: em os.tmpdir()) pode acabar herdando um tsconfig.json completamente
    // alheio ao projeto (ex: um global no perfil do usuário), causando comportamento
    // imprevisível — no caso observado, execução silenciosa sem rodar o conteúdo real do
    // arquivo (nem stdout, nem stderr, exit 0), o que mascarava justamente os casos de
    // falha que este selftest existe para provar. Subpasta temporária de src/__tests__/, removida no fim.
    const tmpDir = fs.mkdtempSync(path.join(__dirname, '..', 'src', '__tests__', 'selftest_scratch_'));
    // Limite por arquivo no cenário misto. Vale para TODOS os fixtures, não só o pendurado: é o tempo que um arquivo
    // normal pode levar numa máquina lenta. Com 6 s, o fixture da exceção estourou no Windows do CI (PR #28, 30/10/2026:
    // ~1,9 s por fixture no resto do cenário; 1 falha em 60 execuções). 20 s = ~10x o normal medido no CI; o fixture
    // pendurado espera 10x isso, então só ele chega ao limite. Custo: o autoteste espera 20 s pelo pendurado.
    const LIMITE_DOS_FIXTURES_MS = 20000;
    let ok = true;
    const verifica = (cond, msg, detalhe) => { if (!cond) { console.error(`SELFTEST FALHOU: ${msg}`, detalhe ?? ''); ok = false; } };
    // Roda ESTE runner como um processo à parte, sobre uma pasta de fixtures (cenário controlado e isolado).
    const rodarRunner = (pasta, extra = []) => {
        const relatorio = path.join(pasta, '..', `relatorio-${path.basename(pasta)}.json`);
        const r = spawnSync(process.execPath, [__filename, '--dir', pasta, '--report', relatorio, ...extra], { encoding: 'utf-8', cwd: RAIZ_DO_REPOSITORIO, maxBuffer: 64 * 1024 * 1024 });
        let json = null;
        try { json = JSON.parse(fs.readFileSync(relatorio, 'utf-8')); } catch { /* sem relatório (ex.: zero testes) */ }
        return { code: r.status, out: (r.stdout || '') + (r.stderr || ''), json };
    };
    try {
        // /// <reference types="node" /> é obrigatório: o tsconfig do projeto não inclui tipos
        // globais implícitos (sem isso, `console`/`process` não compilam sob strict mode) —
        // mesma convenção usada em todo arquivo real de src/__tests__/regression/*.test.ts.
        const header = '/// <reference types="node" />\n';
        const escrever = (pasta, nome, corpo) => { fs.mkdirSync(pasta, { recursive: true }); fs.writeFileSync(path.join(pasta, nome), header + corpo); };

        // ── Cenário 1: suíte mista — cada tipo de falha/êxito tem de ser reconhecido pelo que é ───────────────────────
        const mista = path.join(tmpDir, 'mista');
        escrever(mista, 'a_pass.test.ts', `console.log('fixture pass'); process.exit(0);\n`);
        escrever(mista, 'b_fail_exit1.test.ts', `console.log('fixture fail exit1'); process.exit(1);\n`);
        escrever(mista, 'c_fail_throw.test.ts', `throw new Error('fixture uncaught exception');\n`);
        // O caso real que causou falso verde: assertion falha, o processo segue e sai com 0 — agora INCONSISTENTE.
        escrever(mista, 'd_fail_silent_continue.test.ts', `console.error('  ❌ FALHOU: assertion'); console.log('mas o processo segue rodando e sai com 0');\n`);
        escrever(mista, 'e_hang_timeout.test.ts', `console.log('pendurado'); setTimeout(() => {}, ${LIMITE_DOS_FIXTURES_MS * 10});\n`);
        escrever(mista, 'f_slow_known.test.ts', `console.log('começo'); setTimeout(() => { console.log('fim'); process.exit(0); }, 900);\n`);
        // Resumo com "Falhou: 0" (como nos testes reais) NÃO pode virar inconsistência.
        escrever(mista, 'g_summary_zero_failures.test.ts', `console.log('  ❌ Falhou: 0'); console.log('RESULTADO: ✅ 3 passou | ❌ 0 falhou'); process.exit(0);\n`);
        // O hook de medição não pode vazar para subprocessos do teste.
        escrever(mista, 'h_child_env_clean.test.ts',
            `const { spawnSync } = require('child_process');\n` +
            `const r = spawnSync(process.execPath, ['-e', 'process.exit(/regression-preload/.test(process.env.NODE_OPTIONS || "") || process.env.NC_TIMING_FILE ? 1 : 0)'], { env: process.env });\n` +
            `console.log('filho sem hook:', r.status === 0); process.exit(r.status === 0 ? 0 : 1);\n`);
        const m = rodarRunner(mista, ['--timeout', String(LIMITE_DOS_FIXTURES_MS)]);
        const st = (nome) => m.json && m.json.testes.find((t) => t.arquivo === nome);
        verifica(m.code === 1, 'suíte mista com falhas deveria sair com exit 1', m.code);
        verifica(m.json != null, 'o relatório estruturado deveria ser gravado', m.out.slice(-300));
        if (m.json) {
            verifica(st('a_pass.test.ts').status === 'passed', 'process.exit(0) deveria ser "passed"', st('a_pass.test.ts'));
            verifica(st('b_fail_exit1.test.ts').status === 'failed' && st('b_fail_exit1.test.ts').exitCode === 1, 'process.exit(1) deveria ser "failed"');
            verifica(st('c_fail_throw.test.ts').status === 'failed', 'exceção não tratada deveria ser "failed"');
            verifica(st('d_fail_silent_continue.test.ts').status === 'inconsistent', 'exit 0 com "FALHOU:" deveria ser "inconsistent" (antes: falso verde)', st('d_fail_silent_continue.test.ts'));
            verifica(st('e_hang_timeout.test.ts').status === 'timeout', 'teste pendurado deveria ser "timeout"', st('e_hang_timeout.test.ts'));
            verifica(st('g_summary_zero_failures.test.ts').status === 'passed', 'resumo "Falhou: 0" não pode ser tratado como falha', st('g_summary_zero_failures.test.ts'));
            verifica(st('h_child_env_clean.test.ts').status === 'passed', 'o hook de medição não pode vazar para subprocessos', st('h_child_env_clean.test.ts'));
            const lento = st('f_slow_known.test.ts');
            verifica(lento.duracaoMs >= 850 && lento.duracaoMs < 20000, 'duração de um teste de ~900 ms deveria ser medida (>= 850 ms)', lento);
            verifica(lento.inicioMs != null && lento.inicioMs <= lento.duracaoMs && lento.corpoMs >= 700, 'a divisão início × corpo deveria atribuir os ~900 ms ao corpo', lento);
            const t = m.json.totais;
            verifica(t.descobertos === 8 && t.executados === 8 && t.aprovados === 4 && t.falhos === 2 && t.inconsistentes === 1 && t.timeouts === 1, 'os totais do relatório deveriam fechar com o que foi executado', t);
            verifica(t.aprovados + t.falhos + t.inconsistentes + t.timeouts + t.ignorados === t.executados, 'todo teste executado tem exatamente um resultado');
        }

        // ── Cenário 2: tudo passa → exit 0 e relatório íntegro ──────────────────────────────────────────────────────
        const verde = path.join(tmpDir, 'verde');
        escrever(verde, 'a_pass.test.ts', `console.log('ok'); process.exit(0);\n`);
        escrever(verde, 'b_pass.test.ts', `console.log('ok'); process.exitCode = 0;\n`);
        const v = rodarRunner(verde);
        verifica(v.code === 0 && v.json && v.json.totais.aprovados === 2 && v.json.totais.descobertos === 2, 'suíte toda verde deveria sair com exit 0 e 2/2', { code: v.code, totais: v.json && v.json.totais });
        const filtrado = rodarRunner(verde, ['--filter', 'a_pass']);
        verifica(filtrado.code === 0 && filtrado.json && filtrado.json.totais.descobertos === 1, '--filter deveria rodar só os arquivos que casam', filtrado.json && filtrado.json.totais);

        // ── Cenário 3: nada descoberto NÃO é verde ──────────────────────────────────────────────────────────────────
        const vazia = path.join(tmpDir, 'vazia');
        fs.mkdirSync(vazia, { recursive: true });
        const rVazia = rodarRunner(vazia);
        const rVaziaOk = rodarRunner(vazia, ['--allow-empty']);
        const rAusente = rodarRunner(path.join(tmpDir, 'nao-existe'));
        const rFiltro = rodarRunner(verde, ['--filter', 'nenhum-arquivo-assim']);
        verifica(rVazia.code === 1, 'pasta sem testes deveria sair com exit 1 (antes: "0/0 passaram", exit 0)');
        verifica(rVaziaOk.code === 0, '--allow-empty deveria tornar zero testes aceitável (exceção explícita)');
        verifica(rAusente.code === 1, 'pasta ausente deveria sair com exit 1 (antes: "Nada a rodar", exit 0)');
        verifica(rFiltro.code === 1, 'filtro que não casa nada deveria sair com exit 1');

        // ── Cenário 4: IGNORADO é um estado explícito, contabilizado, e nunca um verde ───────────────────────────────
        const ign = path.join(tmpDir, 'ignorados');
        escrever(ign, 'a_pass.test.ts', `console.log('ok'); process.exit(0);
`);
        escrever(ign, 'b_skip_com_motivo.test.ts', `console.log('SKIP: pacote opcional ausente'); process.exit(77);
`);
        const rIgn = rodarRunner(ign);
        const rIgnEstrito = rodarRunner(ign, ['--strict-skips']);
        const semMotivo = path.join(tmpDir, 'sem_motivo');
        escrever(semMotivo, 'a_77_sem_motivo.test.ts', `console.log('sem motivo'); process.exit(77);
`);
        const rSemMotivo = rodarRunner(semMotivo);
        const tIgn = rIgn.json && rIgn.json.totais;
        verifica(rIgn.code === 0 && tIgn && tIgn.ignorados === 1 && tIgn.aprovados === 1 && tIgn.executados === 2, 'ignorado com motivo: não derruba a suíte, mas conta à parte (1 aprovado + 1 ignorado)', tIgn);
        verifica(rIgn.json && rIgn.json.testes.find((t) => t.arquivo === 'b_skip_com_motivo.test.ts').motivoIgnorado === 'pacote opcional ausente', 'o relatório guarda o motivo do ignorado');
        verifica(/IGNORADOS \(1\)/.test(rIgn.out),'o resumo lista os ignorados com o motivo (não ficam escondidos)');
        verifica(rIgnEstrito.code === 1, '--strict-skips: um ignorado conta como falha', rIgnEstrito.code);
        verifica(rSemMotivo.code === 1 && rSemMotivo.json && rSemMotivo.json.totais.falhos === 1 && rSemMotivo.json.totais.ignorados === 0, 'exit 77 SEM a linha "SKIP: motivo" é FALHA (não dá para ignorar em silêncio)', rSemMotivo.json && rSemMotivo.json.totais);
        // ── Cenário 5 (só Windows): crash nativo do Node (0xC0000409) é repetido UMA vez, à vista; se repetir, é falha ──────
        let linhasDoCrash = [];
        if (process.platform === 'win32') {
            const cr = path.join(tmpDir, 'crash_nativo');
            const marca = path.join(cr, 'ja-crashou.txt').replace(/\\/g, '/');
            escrever(cr, 'a_crasha_uma_vez.test.ts', `const fs = require('fs'); if (!fs.existsSync('${marca}')) { fs.writeFileSync('${marca}', 'x'); process.exit(-1073740791); } console.log('ok na repetição'); process.exit(0);
`);
            const rCr = rodarRunner(cr);
            const crSempre = path.join(tmpDir, 'crash_sempre');
            escrever(crSempre, 'a_crasha_sempre.test.ts', `process.exit(-1073740791);
`);
            const rCrSempre = rodarRunner(crSempre);
            const tCr = rCr.json && rCr.json.totais;
            linhasDoCrash = [
                ['crash nativo do Node uma vez (Windows)', 'exit 0, 1 repetido', `exit ${rCr.code}, ${tCr ? tCr.repetidosPorCrashNativo : '?'} repetido`, rCr.code === 0 && tCr && tCr.repetidosPorCrashNativo === 1 && /REPETIDOS POR CRASH NATIVO/.test(rCr.out)],
                ['crash nativo do Node de novo na repetição', 'exit 1 (falha)', `exit ${rCrSempre.code}`, rCrSempre.code === 1],
            ];
        }

        // ── Evidência: cada cenário controlado, o que se esperava e o que o processo PRINCIPAL do runner fez ─────────────
        const stt = (nome) => (m.json && m.json.testes.find((t) => t.arquivo === nome)) || {};
        const linhas = [
            ...linhasDoCrash,
            ['pasta de testes ausente', 'exit 1', `exit ${rAusente.code}`, rAusente.code === 1],
            ['zero testes descobertos', 'exit 1', `exit ${rVazia.code}`, rVazia.code === 1],
            ['zero testes + --allow-empty (exceção explícita)', 'exit 0', `exit ${rVaziaOk.code}`, rVaziaOk.code === 0],
            ['filtro que não casa nenhum arquivo', 'exit 1', `exit ${rFiltro.code}`, rFiltro.code === 1],
            ['teste pendurado (timeout)', 'status timeout', `status ${stt('e_hang_timeout.test.ts').status}`, stt('e_hang_timeout.test.ts').status === 'timeout'],
            ['exceção não tratada', 'status failed', `status ${stt('c_fail_throw.test.ts').status}, exit ${stt('c_fail_throw.test.ts').exitCode}`, stt('c_fail_throw.test.ts').status === 'failed'],
            ['process.exit(1)', 'status failed, exit 1', `status ${stt('b_fail_exit1.test.ts').status}, exit ${stt('b_fail_exit1.test.ts').exitCode}`, stt('b_fail_exit1.test.ts').status === 'failed' && stt('b_fail_exit1.test.ts').exitCode === 1],
            ['exit 0 mas imprimiu "FALHOU:"', 'status inconsistent', `status ${stt('d_fail_silent_continue.test.ts').status}`, stt('d_fail_silent_continue.test.ts').status === 'inconsistent'],
            ['resumo "Falhou: 0" (sem falso positivo)', 'status passed', `status ${stt('g_summary_zero_failures.test.ts').status}`, stt('g_summary_zero_failures.test.ts').status === 'passed'],
            ['suíte mista: o processo principal propaga a falha', 'exit 1', `exit ${m.code}`, m.code === 1],
            ['ignorado COM motivo (SKIP: + exit 77)', 'exit 0, 1 aprovado + 1 ignorado', `exit ${rIgn.code}, ${tIgn ? tIgn.aprovados : '?'} aprovado + ${tIgn ? tIgn.ignorados : '?'} ignorado`, rIgn.code === 0 && tIgn && tIgn.ignorados === 1 && tIgn.aprovados === 1],
            ['ignorado + --strict-skips', 'exit 1', `exit ${rIgnEstrito.code}`, rIgnEstrito.code === 1],
            ['exit 77 sem motivo (SKIP ausente)', 'exit 1 (falha)', `exit ${rSemMotivo.code}`, rSemMotivo.code === 1],
            ['suíte toda verde', 'exit 0, 2/2', `exit ${v.code}, ${v.json ? v.json.totais.aprovados : '?'}/${v.json ? v.json.totais.descobertos : '?'}`, v.code === 0 && v.json && v.json.totais.aprovados === 2],
        ];
        console.log('EVIDÊNCIA DO AUTOTESTE (cada cenário roda o runner como processo à parte sobre fixtures descartáveis):');
        for (const [nome, esperado, observado, cond] of linhas) {
            console.log(`  ${cond ? 'OK  ' : 'ERRO'} ${nome.padEnd(52)} esperado: ${esperado.padEnd(22)} observado: ${observado}`);
            if (!cond) ok = false;
        }
        console.log(ok ? 'SELFTEST OK' : 'SELFTEST FALHOU');
        return ok;
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
}

if (require.main === module) {
    const opcoes = lerArgumentos(process.argv.slice(2));
    if (opcoes.selftest) {
        process.exit(selfTest() ? 0 : 1);
    } else {
        process.exit(executar(opcoes).exitCode);
    }
}

module.exports = { runOne, discover, executar, MARCADOR_DE_FALHA };
