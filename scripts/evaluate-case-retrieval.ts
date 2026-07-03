/**
 * evaluate-case-retrieval.ts — S6.5b/S6.5d + S7.6 (roadmap de aprendizado orientado a objetivos)
 *
 * Avaliação CONTROLADA da recuperação por problema (CaseMemory.findRelevantCasesShadow)
 * usando o EmbeddingService REAL (Ollama local, modelo nomic-embed-text) — não mockado.
 *
 * Também serve como o "dataset offline mínimo" pedido pela S6.5d: um corpus pequeno,
 * explícito e reproduzível de pares de objetivos, com o rótulo humano do que é esperado
 * (relacionado / não-relacionado / ambíguo), sem tentar virar uma plataforma de benchmark.
 *
 * Este script NÃO toca o banco de produção (usa um EmbeddingService próprio contra
 * :memory:, só para poder chamar embed()/cosineSimilarity() reais) e NÃO define threshold
 * de produção — só descreve a distribuição observada de scores.
 *
 * S7.6 — expande o MESMO script (não cria benchmark paralelo) com os grupos K-T exigidos pela
 * Sprint e com a comparação OLD (semanticScore sozinho) vs REFINED (semanticScore +
 * operationalCompatibility, via CaseMemory.classifyOperation/operationalCompatibility). A parte
 * operacional NÃO depende do Ollama — é síncrona/determinística — então roda mesmo se o
 * provider estiver indisponível (só a comparação com score semântico real fica condicionada).
 *
 * Uso: npx ts-node scripts/evaluate-case-retrieval.ts
 * Se o Ollama/modelo não estiver disponível, declara isso explicitamente e sai sem falsificar.
 */
import Database from 'better-sqlite3';
import { EmbeddingService } from '../src/memory/EmbeddingService';
import { classifyOperation, operationalCompatibility, OperationalIntent } from '../src/memory/CaseMemory';

interface Pair {
    group: string;
    a: string;
    b: string;
    expected: 'relacionado' | 'irrelevante' | 'incerto';
    note: string;
}

// ── S7.6 — corpus K-T: grupos operacionais exigidos pela Sprint, além dos 6 grupos semânticos
// da S6.5 acima. Cada par tem um rótulo esperado de COMPATIBILIDADE OPERACIONAL (não de
// similaridade semântica) — testa se classifyOperation() distingue corretamente, sem assumir
// equivalência onde a própria Sprint pede para medir em vez de assumir ('medir').
interface OperationalPair {
    group: string;
    a: string;
    b: string;
    expectedCompatible: 'compatible' | 'incompatible' | 'medir';
    note: string;
}
const OPERATIONAL_CORPUS: OperationalPair[] = [
    { group: 'K — criação equivalente (sinonímia)', a: 'criar apresentação', b: 'gerar slides', expectedCompatible: 'compatible', note: 'produzir apresentação também entra na mesma classe' },
    { group: 'L — mesmo objeto, operações diferentes', a: 'criar apresentação', b: 'analisar apresentação', expectedCompatible: 'incompatible', note: 'não colapsar em equivalência (corrigir/remover também divergem — ver relatório)' },
    { group: 'M — mesmo verbo, objeto diferente', a: 'criar apresentação', b: 'criar servidor DNS', expectedCompatible: 'compatible', note: 'operacionalmente compatível (mesmo verbo) — mas isso NÃO deve implicar relevância semântica; quem barra isso é a similaridade upstream, não este gate' },
    { group: 'N — sinonímia operacional PT-BR', a: 'criar relatório', b: 'produzir relatório', expectedCompatible: 'compatible', note: 'criar/gerar/produzir mapeiam para a mesma classe (create)' },
    { group: 'O — verbos próximos, não necessariamente equivalentes', a: 'analisar configuração', b: 'validar configuração', expectedCompatible: 'medir', note: 'não assumir — reportar o que o classificador realmente produz' },
    { group: 'P — operação implícita', a: 'isso aqui, por favor', b: 'criar apresentação', expectedCompatible: 'medir', note: 'objetivo sem verbo operacional claro — esperado: unknown' },
    { group: 'Q — mesma entidade, direção oposta', a: 'instalar serviço', b: 'desinstalar serviço', expectedCompatible: 'incompatible', note: 'create × remove' },
    { group: 'R — mesma entidade, lifecycle diferente', a: 'criar banco de dados', b: 'remover banco de dados', expectedCompatible: 'incompatible', note: 'ver relatório para migrar/consultar (não são pares binários)' },
    { group: 'S — produção vs inspeção', a: 'gerar relatório', b: 'revisar relatório', expectedCompatible: 'incompatible', note: 'create × inspect' },
    { group: 'T — correção vs diagnóstico', a: 'corrigir configuração', b: 'diagnosticar configuração', expectedCompatible: 'incompatible', note: 'modify × inspect' },
];

function runOperationalCorpus(): void {
    console.log('\n'.repeat(1) + '═'.repeat(70));
    console.log('S7.6 — CORPUS OPERACIONAL K-T (determinístico, não depende do Ollama)');
    console.log('═'.repeat(70));
    for (const p of OPERATIONAL_CORPUS) {
        const opA: OperationalIntent = classifyOperation(p.a);
        const opB: OperationalIntent = classifyOperation(p.b);
        const compat = operationalCompatibility(opA, opB);
        const compatLabel = compat === 'unknown' ? 'unknown' : compat ? 'compatible' : 'incompatible';
        const verdict = p.expectedCompatible === 'medir'
            ? `MEDIDO (sem assumir): ${compatLabel}`
            : (compatLabel === p.expectedCompatible ? 'OK' : `DIVERGE (esperado ${p.expectedCompatible})`);
        console.log(`${p.group}`);
        console.log(`  A: "${p.a}" → ${opA}   B: "${p.b}" → ${opB}`);
        console.log(`  compatibilidade=${compatLabel}  ${verdict}  (${p.note})`);
        console.log('');
    }
}

/** S7.6 — comparação OLD (semanticScore sozinho) vs REFINED (semanticScore + gate operacional)
 * sobre os 2 erros reais medidos na S6.5. Roda com o EmbeddingService real quando disponível;
 * caso contrário, usa o score real JÁ MEDIDO na S6.5 (documentado, não fabricado agora) só para
 * ilustrar a decisão do gate — deixado explícito no output qual dos dois caminhos foi usado. */
async function runOldVsRefined(svc: EmbeddingService | null): Promise<void> {
    console.log('═'.repeat(70));
    console.log('S7.6 — OLD (semanticScore sozinho) vs REFINED (semanticScore + operationalCompatibility)');
    console.log('═'.repeat(70));
    const flagship: Array<{ label: string; a: string; b: string; measuredS65: number }> = [
        { label: 'Erro 1 — criar × analisar PPTX', a: 'crie uma apresentação PPTX sobre redes', b: 'analise uma apresentação PPTX sobre redes', measuredS65: 0.9645 },
        { label: 'Erro 2 — criar × remover arquivo', a: 'crie arquivo de configuração', b: 'remova arquivo de configuração', measuredS65: 0.8955 },
        { label: 'Preservar — criar × gerar (equivalentes)', a: 'crie uma apresentação sobre redes de computadores', b: 'gere slides explicando redes de computadores', measuredS65: 0.7234 },
    ];
    for (const f of flagship) {
        let score = f.measuredS65;
        let scoreSource = 'medido na S6.5 (Ollama real, registrado no relatório — não fabricado agora)';
        if (svc) {
            const [vecA, vecB] = await Promise.all([svc.embed(f.a), svc.embed(f.b)]);
            if (vecA && vecB) {
                score = svc.cosineSimilarity(vecA, vecB);
                scoreSource = 'medido AGORA (Ollama real, esta execução)';
            }
        }
        const opA = classifyOperation(f.a);
        const opB = classifyOperation(f.b);
        const compat = operationalCompatibility(opA, opB);
        const compatLabel = compat === 'unknown' ? 'unknown' : compat ? 'compatible' : 'incompatible';
        console.log(`${f.label}`);
        console.log(`  A: "${f.a}"`);
        console.log(`  B: "${f.b}"`);
        console.log(`  OLD  → semanticScore=${score.toFixed(4)} (${scoreSource}) → decisão old (threshold hipotético 0.8): ${score >= 0.8 ? 'TRATARIA COMO RELEVANTE (falso positivo conhecido)' : 'abaixo do threshold hipotético'}`);
        console.log(`  REFINED → semanticScore=${score.toFixed(4)} (inalterado) + operationalIntent(A)=${opA} operationalIntent(B)=${opB} → operationalCompatibility=${compatLabel}`);
        console.log(`  REFINED → decisão: candidato só seria considerado aplicável se operationalCompatibility!==false. Aqui: ${compat !== false ? 'aplicável (sem contraindicação operacional)' : 'NÃO aplicável — operação incompatível, mesmo com score semântico alto'}`);
        console.log('');
    }
}

// ── Corpus controlado (S6.5b/d) — pequeno, auditável, com rótulo humano explícito ──────────
const CORPUS: Pair[] = [
    {
        group: 'Grupo 1 — equivalentes',
        a: 'crie uma apresentação sobre redes de computadores',
        b: 'gere slides explicando redes de computadores',
        expected: 'relacionado',
        note: 'mesma tarefa (criar apresentação), mesmo tema, wording diferente',
    },
    {
        group: 'Grupo 2 — mesmo domínio, operação diferente',
        a: 'crie uma apresentação PPTX sobre redes',
        b: 'analise uma apresentação PPTX sobre redes',
        expected: 'incerto',
        note: 'mesmo domínio/artefato, intenção operacional oposta (criar vs. analisar) — risco conhecido de falso positivo',
    },
    {
        group: 'Grupo 3 — pipeline potencialmente parecido, problema diferente',
        a: 'gere relatório sobre bitcoin',
        b: 'gere relatório sobre segurança de redes',
        expected: 'irrelevante',
        note: 'mesma operação (gerar relatório), tema completamente diferente',
    },
    {
        group: 'Grupo 4 — wording superficialmente diferente, tarefa equivalente',
        a: 'escreva um resumo executivo do documento financeiro anexado',
        b: 'faça uma síntese executiva do arquivo financeiro em anexo',
        expected: 'relacionado',
        note: 'sinônimos reais em PT-BR (resumo/síntese, documento/arquivo, anexado/em anexo)',
    },
    {
        group: 'Grupo 5 — objetivo curto e ambíguo',
        a: 'corrija isso',
        b: 'crie uma apresentação sobre redes de computadores',
        expected: 'incerto',
        note: 'objetivo sem contexto suficiente — não deve gerar confiança artificial em nenhuma direção',
    },
    {
        group: 'Grupo 6 — objetivos operacionalmente opostos',
        a: 'crie arquivo de configuração',
        b: 'remova arquivo de configuração',
        expected: 'irrelevante',
        note: 'mesmo objeto (arquivo de configuração), ação diretamente oposta (criar vs. remover)',
    },
];

async function main() {
    const db = new (Database as any)(':memory:'); // isolado — nunca toca data/newclaw.db
    const svc = new EmbeddingService(db);

    const available = await svc.isAvailable();
    console.log(`Ollama disponível: ${available}`);

    // S7.6 — a parte OPERACIONAL é determinística (não usa Ollama): roda sempre, mesmo se o
    // provider estiver indisponível — diferente da parte semântica original (S6.5), que exige
    // o embedding real e sai cedo quando ele falta.
    runOperationalCorpus();
    await runOldVsRefined(available ? svc : null);

    if (!available) {
        console.log('Provider real indisponível nesta execução — nenhum resultado SEMÂNTICO será fabricado (a comparação OLD/REFINED acima usou os scores já medidos na S6.5, documentados no relatório).');
        console.log('Os testes determinísticos (S20-S25) continuam válidos para a LÓGICA, mas não validam qualidade semântica do modelo nesta execução.');
        process.exit(0);
    }

    const t0 = Date.now();
    console.log(`\nModelo: ${svc.getModel()}\n`);

    const results: Array<Pair & { score: number }> = [];
    for (const pair of CORPUS) {
        const [vecA, vecB] = await Promise.all([svc.embed(pair.a), svc.embed(pair.b)]);
        if (!vecA || !vecB) {
            console.log(`  ⚠️  embed() retornou null para "${pair.a}" ou "${pair.b}" — pulando par`);
            continue;
        }
        const score = svc.cosineSimilarity(vecA, vecB);
        results.push({ ...pair, score });
        console.log(`${pair.group}`);
        console.log(`  A: "${pair.a}"`);
        console.log(`  B: "${pair.b}"`);
        console.log(`  score=${score.toFixed(4)}  esperado=${pair.expected}  (${pair.note})`);
        console.log('');
    }

    const latencyMs = Date.now() - t0;
    const scores = results.map(r => r.score);
    const min = Math.min(...scores);
    const max = Math.max(...scores);
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;

    console.log('─'.repeat(70));
    console.log('DISTRIBUIÇÃO OBSERVADA (descritiva — nenhum threshold de produção definido aqui):');
    console.log(`  min=${min.toFixed(4)} max=${max.toFixed(4)} mean=${mean.toFixed(4)}`);
    console.log(`  latência total (${results.length} pares, 2 embeds cada): ${latencyMs}ms (~${(latencyMs / (results.length * 2)).toFixed(0)}ms/embed)`);
    console.log('');
    console.log('ORDENAÇÃO RELATIVA (sanity check — não é threshold):');
    const relacionados = results.filter(r => r.expected === 'relacionado');
    const irrelevantes = results.filter(r => r.expected === 'irrelevante');
    if (relacionados.length && irrelevantes.length) {
        const meanRel = relacionados.reduce((a, r) => a + r.score, 0) / relacionados.length;
        const meanIrr = irrelevantes.reduce((a, r) => a + r.score, 0) / irrelevantes.length;
        console.log(`  média "relacionado"=${meanRel.toFixed(4)} vs média "irrelevante"=${meanIrr.toFixed(4)}`);
        console.log(`  ordenação correta (relacionado > irrelevante)? ${meanRel > meanIrr ? 'SIM' : 'NÃO'}`);
    }
    console.log('\nResultado bruto (JSON, para reuso em futura Sprint de calibração):');
    console.log(JSON.stringify(results.map(r => ({ group: r.group, expected: r.expected, score: Number(r.score.toFixed(4)) })), null, 2));
}

main().catch(err => { console.error('ERRO NÃO TRATADO:', err); process.exit(1); });
