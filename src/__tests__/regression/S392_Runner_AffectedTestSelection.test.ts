/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S392: seleção dos testes AFETADOS (`npm run test:regression:afetados`, scripts/testes-afetados.cjs).
 *
 * A suíte completa passou de 25 minutos; durante o trabalho roda-se só o que as mudanças podem afetar, e a completa fica para antes
 * de enviar ao GitHub. Uma seleção que OMITE um teste afetado devolve um verde falso — por isso cada regra tem um cenário aqui, com
 * arquivos reais do repositório. Conferida também contra o que cada um dos 386 testes leu de fato numa suíte completa (10/2026):
 * só estático, 10,1% dos pares (teste, arquivo lido) ficavam de fora; com o mapa observado + varredura de pasta + recenseamento, 0.
 *
 * REGRESSÃO SE: uma das regras deixar de selecionar (import transitivo, citação por nome, arquivo removido, leitura observada,
 * varredura de pasta, recenseamento com arquivo criado, mudança de infraestrutura = tudo) ou a seleção passar a pegar teste sem motivo.
 *
 * Execução: npx ts-node src/__tests__/regression/S392_Runner_AffectedTestSelection.test.ts
 */
import * as fs from 'fs';
import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { selecionar, MUDA_TUDO } = require(path.join(process.cwd(), 'scripts', 'testes-afetados.cjs')) as {
    selecionar: (testes: string[], alterados: string[], fontes?: { mapa?: Record<string, string[]> | null; criadosOuRemovidos?: string[] }) =>
        { tudo: string | null; selecionados: Array<{ arquivo: string; motivos: string[] }> };
    MUDA_TUDO: string[];
};

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}

const DIR = path.join(process.cwd(), 'src', '__tests__', 'regression');
const TODOS = fs.readdirSync(DIR).filter((f) => f.endsWith('.test.ts')).map((f) => path.join(DIR, f));
const nome = (prefixo: string) => TODOS.find((t) => path.basename(t).startsWith(prefixo + '_')) as string;
const sel = (alterados: string[], fontes = {}) => selecionar(TODOS, alterados, fontes);
const pegou = (r: ReturnType<typeof sel>, prefixo: string) => r.selecionados.find((x) => path.basename(x.arquivo).startsWith(prefixo + '_'));

console.log('\n=== S392-1 — import transitivo: mudar o adaptador web seleciona quem o importa ===');
{
    const r = sel(['src/channels/WebChannelAdapter.ts']);
    assert(r.tudo === null, 'não é mudança de infraestrutura');
    assert(!!pegou(r, 'S382') && /importa src\/channels\/WebChannelAdapter\.ts/.test(pegou(r, 'S382')!.motivos.join()), 'S382 (importa direto) é selecionado, com o motivo', pegou(r, 'S382'));
    assert(!pegou(r, 'S391'), 'S391 (SkillLoader, sem relação) NÃO é selecionado');
    assert(r.selecionados.length < TODOS.length / 2, `a seleção é parcial (${r.selecionados.length} de ${TODOS.length})`);
}

console.log('\n=== S392-2 — citação por nome: teste que lê o código como texto ===');
{
    const r = sel(['src/loop/GoalExecutionLoop.ts']);
    const s114 = pegou(r, 'S114');
    assert(!!s114, 'S114 (lê GoalExecutionLoop.ts por path.join, sem importá-lo) é selecionado', r.selecionados.length);
    assert(!!s114 && s114.motivos.some((m) => /GoalExecutionLoop\.ts/.test(m)), 'o motivo nomeia o arquivo', s114?.motivos);
}

console.log('\n=== S392-3 — o próprio teste mudou ===');
{
    const r = sel([path.relative(process.cwd(), nome('S391')).split(path.sep).join('/')]);
    assert(r.selecionados.length === 1 && !!pegou(r, 'S391') && pegou(r, 'S391')!.motivos.includes('o próprio teste mudou'), 'só ele é selecionado', r.selecionados.map((x) => path.basename(x.arquivo)));
}

console.log('\n=== S392-4 — arquivo removido: quem o importava é selecionado ===');
{
    // S382 importa ../../channels/WebChannelAdapter; simula a remoção de um arquivo que ele importava (o nome não existe em disco).
    const r = sel(['src/channels/ArquivoQueFoiRemovido.ts']);
    assert(!pegou(r, 'S382'), 'controle: um arquivo removido que ninguém importava não seleciona S382');
    const s = selecionar([nome('S382')], ['src/channels/WebChannelAdapter.ts']);
    assert(s.selecionados.length === 1, 'controle: o arquivo existente seleciona S382 pelo import');
}

console.log('\n=== S392-5 — mudança de infraestrutura seleciona TUDO ===');
for (const infra of ['package.json', 'tsconfig.json', 'scripts/run-regression-tests.cjs', 'scripts/testes-afetados.cjs']) {
    const r = sel([infra]);
    assert(MUDA_TUDO.includes(infra) && r.tudo !== null && r.selecionados.length === TODOS.length, `${infra} → os ${TODOS.length} testes`);
}

// Nomes montados por concatenação: se aparecessem inteiros entre aspas neste arquivo, a regra de citação (correta) selecionaria o S392.
const DOC_SEM_RELACAO = 'docs/' + 'anotacao-sem-' + 'relacao.md';

console.log('\n=== S392-6 — documento sem relação não seleciona nada ===');
{
    const r = sel([DOC_SEM_RELACAO]);
    assert(r.tudo === null && r.selecionados.length === 0, 'zero testes', r.selecionados.map((x) => path.basename(x.arquivo)));
}

console.log('\n=== S392-7 — mapa observado: leitura que nenhuma regra estática enxerga ===');
{
    const alvo = path.basename(nome('S382'));
    const sem = sel([DOC_SEM_RELACAO]);
    assert(!pegou(sem, 'S382'), 'sem mapa, o documento não seleciona S382');
    const com = sel([DOC_SEM_RELACAO], { mapa: { [alvo]: [DOC_SEM_RELACAO] } });
    assert(!!pegou(com, 'S382') && pegou(com, 'S382')!.motivos.some((m) => m.startsWith('leu ') && m.includes(DOC_SEM_RELACAO)),
        'com o mapa dizendo que S382 leu o arquivo, ele é selecionado', pegou(com, 'S382'));
}

console.log('\n=== S392-8 — varredura de pasta: arquivo NOVO numa pasta que o teste varreu ===');
{
    const alvo = path.basename(nome('S391'));
    // O teste leu (quase) todos os arquivos rastreados de src/channels → varre a pasta; um arquivo novo ali o seleciona.
    const lidos = fs.readdirSync(path.join(process.cwd(), 'src', 'channels')).filter((f) => /\.ts$/.test(f)).map((f) => `src/channels/${f}`);
    const r = sel(['src/channels/CanalNovo.ts'], { mapa: { [alvo]: lidos }, criadosOuRemovidos: ['src/channels/CanalNovo.ts'] });
    assert(lidos.length >= 3 && !!pegou(r, 'S391') && /varre src\/channels/.test(pegou(r, 'S391')!.motivos.join()), 'quem varreu src/channels é selecionado por arquivo novo nela', pegou(r, 'S391'));
    const pouco = sel(['src/channels/CanalNovo.ts'], { mapa: { [alvo]: lidos.slice(0, 1) } });
    assert(!pegou(pouco, 'S391'), 'quem leu só um arquivo da pasta NÃO é tratado como quem a varre');
}

console.log('\n=== S392-9 — recenseamento: arquivo criado seleciona quem lista pastas ===');
{
    const r = sel(['src/utils/utilitarioNovo.ts'], { criadosOuRemovidos: ['src/utils/utilitarioNovo.ts'] });
    assert(!!pegou(r, 'S384') && /lista pastas/.test(pegou(r, 'S384')!.motivos.join()), 'S384 (arquivo sem consumidor) roda quando um arquivo é criado', pegou(r, 'S384'));
    const modificado = sel(['src/utils/utilitarioNovo.ts']);
    assert(!pegou(modificado, 'S384'), 'controle: sem criação/remoção, a regra de recenseamento não dispara');
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S392 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;
