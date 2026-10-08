/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S356 (princípio "Informação Completa para Decidir", 08/10/2026)
 *
 * docs/ARCHITECTURE/INFORMACAO_COMPLETA_PARA_DECIDIR.md §5.1: toda chamada em que o LLM decide precisa constar no
 * registro vigente (tabela §1 do mapa da informação) com a pergunta que decide e o que recebe. Este teste é o
 * recenseamento: varre src/ atrás de chamadas de decisão ao LLM e falha se um arquivo que as faz não estiver no
 * registro. Quem cria uma decisão nova é obrigado a declarar o que ela vê.
 *
 * REGRESSÃO SE: uma chamada nova ao LLM entrar no código sem entrar no registro.
 *
 * Execução: npx ts-node src/__tests__/regression/S356_LlmDecisionCensus.test.ts
 */
import * as fs from 'fs';
import * as path from 'path';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}

const RAIZ = process.cwd();
const REGISTRO = path.join(RAIZ, 'docs', 'analises-arquiteturais', 'MAPA_INFORMACAO_DAS_DECISOES_LLM_2026-10-08.md');
const PRINCIPIO = path.join(RAIZ, 'docs', 'ARCHITECTURE', 'INFORMACAO_COMPLETA_PARA_DECIDIR.md');
// O próprio ProviderFactory implementa as funções — não é um ponto de decisão.
const FORA = new Set(['ProviderFactory.ts']);

function arquivos(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) return e.name === '__tests__' ? [] : arquivos(p);
        return /\.ts$/.test(e.name) ? [p] : [];
    });
}

/** Linhas de código (não comentário) com chamada de decisão ao LLM. */
function chamadas(src: string): number {
    return src.split('\n').filter(l => {
        const t = l.trim();
        if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return false;
        return /\b(chatWithFallback|classifyWithFallback)\(/.test(t);
    }).length;
}

console.log('\n=== S356-1 — o princípio e o registro existem ===');
assert(fs.existsSync(PRINCIPIO), 'docs/ARCHITECTURE/INFORMACAO_COMPLETA_PARA_DECIDIR.md');
assert(fs.existsSync(REGISTRO), 'registro vigente (mapa da informação)');
const registro = fs.readFileSync(REGISTRO, 'utf-8');
const tabela = registro.slice(registro.indexOf('## 1. Tabela'), registro.indexOf('## 2.'));
assert(tabela.length > 100, 'tabela §1 do registro encontrada');

console.log('\n=== S356-2 — toda chamada de decisão ao LLM está no registro ===');
const encontrados = arquivos(path.join(RAIZ, 'src'))
    .filter(p => !FORA.has(path.basename(p)))
    .map(p => ({ p, n: chamadas(fs.readFileSync(p, 'utf-8')) }))
    .filter(x => x.n > 0);
assert(encontrados.length >= 10, `recenseamento encontrou ${encontrados.length} arquivos com decisão do LLM`);
for (const { p, n } of encontrados) {
    const nome = path.basename(p, '.ts');
    assert(tabela.includes(nome), `${path.relative(RAIZ, p)} (${n} chamada(s)) está no registro`,
        `adicione uma linha para "${nome}" na tabela §1 de ${path.relative(RAIZ, REGISTRO)}: pergunta que decide, o que recebe, o que falta`);
}

console.log('\n=== S356-3 — o princípio está nos índices normativos ===');
const readme = fs.readFileSync(path.join(RAIZ, 'docs', 'ARCHITECTURE', 'README.md'), 'utf-8');
const diretriz = fs.readFileSync(path.join(RAIZ, 'docs', 'DIRETRIZ_ARQUITETURA_2026-07-13.md'), 'utf-8');
assert(readme.includes('INFORMACAO_COMPLETA_PARA_DECIDIR.md'), 'citado no índice docs/ARCHITECTURE/README.md');
assert(diretriz.includes('INFORMACAO_COMPLETA_PARA_DECIDIR.md'), 'citado na diretriz permanente de arquitetura');

console.log(`\n${'─'.repeat(60)}`);
console.log(`S356 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;
