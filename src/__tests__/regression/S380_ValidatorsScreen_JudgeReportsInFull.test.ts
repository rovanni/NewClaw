/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S380 (10/10/2026, Sprint B: tela "Validadores")
 *
 * O campo `faltou`/`dificuldade` — o juiz dizendo, em uma frase, o que lhe faltou ou o que dificultou — mostrou as lacunas reais
 * entre o que uma pessoa teria no lugar do juiz e o que ele recebia. A tela os lista POR EXTENSO, agrupados pelo que é fato
 * (qual juiz, qual campo, quando) e com o resumo "quantas avaliações trouxeram relato" — a medida de que as melhorias funcionam.
 *
 * S380-1 — o gravador passa a gravar SEMPRE o texto do relato (antes só com TRACE_CONTENT).
 * S380-2 — leitura: texto de registros novos e antigos, contagem por juiz, o que declarou sem texto.
 * S380-3 — a rota HTTP.
 * S380-4 — a tela: item de menu, view, textos nos três idiomas, sem classificar texto por regra.
 *
 * Execução: npx ts-node src/__tests__/regression/S380_ValidatorsScreen_JudgeReportsInFull.test.ts
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import express from 'express';
import { lerRelatos } from '../../validation/relatosDosJuizes';
import { createValidatorsRouter } from '../../dashboard/routes/validators';
import { ValidationEngine } from '../../validation/ValidationEngine';
import { criarRegistroPadrao } from '../../validation/motorPadrao';
import { PerfilDoJuiz } from '../../validation/perfilDoJuiz';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}
const ler = (rel: string): string => fs.readFileSync(path.join(process.cwd(), rel), 'utf-8');

async function main(): Promise<void> {

console.log('\n=== S380-1 — o texto do relato é gravado sempre ===');
{
    const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 's380-'));
    const logAnterior = process.env.LOG_FILE, traceAnterior = process.env.TRACE_CONTENT;
    process.env.LOG_FILE = path.join(pasta, 'newclaw-audit.log');
    delete process.env.TRACE_CONTENT;
    const pf = {
        getBudgetAuxiliar: () => ({ timeoutMs: 30_000, origem: 'padrao', latenciaTipicaMs: null }),
        chatWithFallback: async () => ({ status: 'success', content: JSON.stringify({ estado: 'aprovado', itens: [], tipo_de_falha: 'none', faltou: 'não vi o conteúdo gravado', dificuldade: 'a data parece estranha' }), attempts: [] }),
    } as any;
    await new ValidationEngine(pf, criarRegistroPadrao(), () => 'm', new PerfilDoJuiz()).validar('qualidade_da_resposta', { pedido: 'p', resposta: 'r' });
    const arquivos = fs.readdirSync(path.join(pasta, 'avaliadores'));
    const reg = JSON.parse(fs.readFileSync(path.join(pasta, 'avaliadores', arquivos[0]), 'utf8').trim().split('\n').filter(l => l.includes('"avaliacao"'))[0]);
    assert(reg.depois.fatos.faltou === 'não vi o conteúdo gravado' && reg.depois.fatos.dificuldade === 'a data parece estranha', 'sem TRACE_CONTENT, o texto de faltou/dificuldade está nos fatos', reg.depois.fatos);
    assert(reg.depois.conteudo === undefined || reg.depois.conteudo.saidaBruta === undefined, 'e o conteúdo da saída continua só com TRACE_CONTENT');
    if (logAnterior === undefined) delete process.env.LOG_FILE; else process.env.LOG_FILE = logAnterior;
    if (traceAnterior !== undefined) process.env.TRACE_CONTENT = traceAnterior;
}

console.log('\n=== S380-2 — a leitura ===');
const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 's380-leitura-'));
{
    const reg = (id: string, ts: string, avaliador: string, depois: object) => JSON.stringify({ v: 1, ts, tipo: 'avaliacao', id, avaliador, antes: { modelo: 'modelo-x' }, depois: { desfecho: 'veredito', estado: 'aprovado', duracaoMs: 1, ...depois } });
    fs.writeFileSync(path.join(pasta, 'validacao_qualidade_da_resposta-2026-10-10.jsonl'), [
        reg('a1', '2026-10-10T10:00:00Z', 'validacao_qualidade_da_resposta', { fatos: { faltouInformado: true, faltou: 'texto novo nos fatos' } }),
        reg('a2', '2026-10-10T11:00:00Z', 'validacao_qualidade_da_resposta', { fatos: { dificuldadeInformada: true }, conteudo: { dificuldade: 'texto antigo no conteúdo' } }),
        reg('a3', '2026-10-10T12:00:00Z', 'validacao_qualidade_da_resposta', { fatos: { faltouInformado: true } }),
        reg('a4', '2026-10-10T13:00:00Z', 'validacao_qualidade_da_resposta', { fatos: {} }),
        JSON.stringify({ v: 1, ts: '2026-10-10T13:00:00Z', tipo: 'efeito', id: 'x' }),
        'linha corrompida',
    ].join('\n'));
    fs.writeFileSync(path.join(pasta, 'validacao_saida_contra_evidencia-2026-10-10.jsonl'), reg('b1', '2026-10-10T09:00:00Z', 'validacao_saida_contra_evidencia', { fatos: {} }));
    const r = lerRelatos(pasta);
    const q = r.porJuiz.find(j => j.avaliador === 'validacao_qualidade_da_resposta')!;
    assert(q.avaliacoes === 4 && q.comFaltou === 2 && q.comDificuldade === 1, 'contagem por juiz (avaliações, com faltou, com dificuldade)', q);
    assert(q.semTexto === 1, 'declarou sem texto gravado: contado à parte (registro anterior a gravá-lo sempre)', q);
    assert(r.relatos.length === 2 && r.relatos[0].ts > r.relatos[1].ts, 'só quem tem texto vira relato, do mais novo para o mais antigo', r.relatos.map(x => x.avaliacaoId));
    assert(r.relatos.find(x => x.avaliacaoId === 'a1')?.faltou === 'texto novo nos fatos' && r.relatos.find(x => x.avaliacaoId === 'a2')?.dificuldade === 'texto antigo no conteúdo', 'lê o texto dos fatos (novos) e do conteúdo (antigos)');
    assert(r.porJuiz.find(j => j.avaliador === 'validacao_saida_contra_evidencia')?.avaliacoes === 1, 'juízes sem relato também aparecem no resumo (o denominador da porcentagem)');
    assert(lerRelatos(null).relatos.length === 0 && lerRelatos('/nao/existe').porJuiz.length === 0, 'sem pasta (gravador desligado): vazio, sem lançar');
    const longo = 'x'.repeat(3000);
    fs.writeFileSync(path.join(pasta, 'validacao_risco_do_plano-2026-10-10.jsonl'), reg('c1', '2026-10-10T14:00:00Z', 'validacao_risco_do_plano', { fatos: { faltouInformado: true, faltou: longo } }));
    assert(lerRelatos(pasta).relatos.find(x => x.avaliacaoId === 'c1')?.faltou?.length === 3000, 'o texto sai POR EXTENSO (a leitura não corta)');
}

console.log('\n=== S380-3 — a rota ===');
{
    const app = express();
    app.use('/api/validators', createValidatorsRouter(() => pasta));
    const servidor = app.listen(0);
    const base = `http://127.0.0.1:${(servidor.address() as { port: number }).port}/api/validators`;
    const r: any = await (await fetch(`${base}/reports`)).json();
    servidor.close();
    assert(r.success === true && r.disponivel === true && r.porJuiz.length >= 2 && r.relatos.length >= 2, 'devolve o resumo por juiz e os relatos', Object.keys(r));
    const off = express(); off.use('/api/validators', createValidatorsRouter(() => null));
    const s2 = off.listen(0);
    const r2: any = await (await fetch(`http://127.0.0.1:${(s2.address() as { port: number }).port}/api/validators/reports`)).json();
    s2.close();
    assert(r2.success === true && r2.disponivel === false, 'gravador desligado: disponivel=false (a tela explica, não quebra)');
    assert(/createValidatorsRouter\(\)/.test(ler('src/dashboard/DashboardServer.ts')) && /\/api\/validators/.test(ler('src/dashboard/DashboardServer.ts')), 'montada no servidor do painel (atrás da mesma autenticação)');
}

console.log('\n=== S380-4 — a tela ===');
{
    assert(/data-page="validadores"/.test(ler('src/dashboard/public/config.html')) && /validadores: 'ValidadoresView'/.test(ler('src/dashboard/public/config/app.js')), 'item de menu e registro da view');
    const view = ler('src/dashboard/public/config/views/ValidadoresView.js');
    assert(/getValidatorReports\(\)/.test(view) && /r\.faltou/.test(view) && /r\.dificuldade/.test(view), 'a view lista o texto de faltou e de dificuldade');
    assert(!/\b(truncad|cortad|data atual)\b/i.test(view.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')), 'a tela não classifica o texto por regra (agrupar por tema é interpretar — do modelo)');
    const shared = ler('src/dashboard/public/shared.js');
    for (const k of ['sidebar_validators', 'validators_page_desc', 'validators_guide', 'validators_summary_title', 'validators_missing', 'validators_difficulty', 'validators_none', 'validators_unavailable', 'validators_search', 'validators_no_text', 'validator_name_qualidade_da_resposta', 'validator_name_saida_contra_evidencia']) {
        assert((shared.match(new RegExp(`\\b${k}:`, 'g')) || []).length === 3, `${k}: presente nos três idiomas`);
    }
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S380 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;
}

main().catch(e => { console.error(e); process.exit(1); });
