/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S354 (Sprint C, 08/10/2026 — campo de observação "faltou" dos avaliadores)
 *
 * Proposta do operador: o LLM dá um feedback quando não tem informação para decidir — como a avaliação de fim de
 * curso. O campo é opcional e só de observabilidade: vai para o gravador de voo e nenhuma decisão o lê.
 *
 * REGRESSÃO SE:
 *  - um dos três prompts (juiz de grounding, validador de qualidade, análise de risco) deixar de pedir o campo;
 *  - a instrução deixar de ser única (cópias divergindo entre os avaliadores);
 *  - o campo mudar uma decisão (veredito/aprovação/plano iguais com e sem ele);
 *  - o gravador deixar de registrar a observação.
 *
 * Execução: npx ts-node src/__tests__/regression/S354_EvaluatorFeedbackField.test.ts
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ObserverValidator } from '../../loop/ObserverValidator';
import { INSTRUCAO_FALTOU, lerFaltou } from '../../shared/evaluatorFlightRecorder';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}
const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
    const orig = process.stdout.write.bind(process.stdout);
    (process.stdout.write as unknown) = (): boolean => true;
    try { return await fn(); } finally { process.stdout.write = orig; }
};
function fake(conteudo: string, prompts: string[]) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getBudgetAuxiliar } = require('../../shared/auxTimeout');
    return {
        chatWithFallback: async (msgs: Array<{ content: string }>) => { prompts.push(msgs[msgs.length - 1].content); return { status: 'success', content: conteudo, attempts: [] }; },
        getBudgetAuxiliar: (p: 'classificacao' | 'validacao') => getBudgetAuxiliar(p, null, null),
    } as any;
}

async function main(): Promise<void> {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 's354-'));
    const logOrig = process.env.LOG_FILE, contOrig = process.env.TRACE_CONTENT;
    process.env.LOG_FILE = path.join(base, 'newclaw-audit.log');
    process.env.TRACE_CONTENT = 'true';
    const pasta = path.join(base, 'avaliadores');
    const ler = (pref: string) => fs.existsSync(pasta) ? fs.readdirSync(pasta).filter(n => n.startsWith(pref))
        .flatMap(n => fs.readFileSync(path.join(pasta, n), 'utf8').trim().split('\n').map(l => JSON.parse(l))).filter(r => r.tipo === 'avaliacao') : [];

    console.log('\n=== S354-1 — leitura estrutural do campo ===');
    assert(lerFaltou('{"claims":[],"faltou":"o pedido do usuário"}') === 'o pedido do usuário', 'lê o campo');
    assert(lerFaltou('```json\n{"approved":true,"faltou":"  x  "}\n```') === 'x', 'tolera cerca de código e espaços');
    assert(lerFaltou('{"claims":[]}') === undefined && lerFaltou('{"faltou":""}') === undefined && lerFaltou('não é json') === undefined, 'ausente, vazio ou sem JSON → nada');

    console.log('\n=== S354-2 — juiz de grounding: prompt pede o campo; veredito igual com e sem ele; observação gravada ===');
    const pj: string[] = [];
    const ev = [{ id: 'E1', tool: 'weather', output: 'Curitiba: 18.4 °C' }];
    const semCampo = await quiet(() => new ObserverValidator(fake('{"claims":[{"claim":"faz 27 °C","evidence":["E1"],"verdict":"NOT_SUPPORTED"}]}', pj), 'm').validateGrounding('Faz 27 °C.', ev, undefined, { phase: 'initial' }));
    const comCampo = await quiet(() => new ObserverValidator(fake('{"claims":[{"claim":"faz 27 °C","evidence":["E1"],"verdict":"NOT_SUPPORTED"}],"faltou":"o pedido do usuário"}', pj), 'm').validateGrounding('Faz 27 °C.', ev, undefined, { phase: 'initial' }));
    assert(pj[0].includes(INSTRUCAO_FALTOU), 'o prompt do juiz contém a instrução única');
    assert(semCampo.state === comCampo.state && semCampo.state === 'REJECTED', `veredito não muda com o campo (${semCampo.state} / ${comCampo.state})`);
    const rj = ler('juiz_grounding-').find(r => r.id === comCampo.avaliacaoId);
    assert(rj?.depois?.fatos?.faltouInformado === true && rj?.depois?.conteudo?.faltou === 'o pedido do usuário', 'gravador registra a observação do juiz');
    const rj0 = ler('juiz_grounding-').find(r => r.id === semCampo.avaliacaoId);
    assert(rj0?.depois?.fatos?.faltouInformado === false, 'sem observação → faltouInformado=false');

    console.log('\n=== S354-3 — validador de qualidade: idem ===');
    const pq: string[] = [];
    const q0 = await quiet(() => new ObserverValidator(fake('{"approved": false, "reason": "r", "confidence": 0.8}', pq), 'm').validate('pedido', 'i', 'edit', 'Conteúdo adicionado', 'Resposta completa ao usuário.'));
    const q1 = await quiet(() => new ObserverValidator(fake('{"approved": false, "reason": "r", "confidence": 0.8, "faltou": "o resultado das outras ferramentas"}', pq), 'm').validate('pedido', 'i', 'edit', 'Conteúdo adicionado', 'Resposta completa ao usuário.'));
    assert(pq[0].includes(INSTRUCAO_FALTOU), 'o prompt do validador contém a instrução única');
    assert(q0.approved === q1.approved && q0.confidence === q1.confidence, 'aprovação e confiança não mudam com o campo');
    assert(ler('validador_qualidade-').find(r => r.id === q1.avaliacaoId)?.depois?.conteudo?.faltou === 'o resultado das outras ferramentas', 'gravador registra a observação do validador');

    console.log('\n=== S354-4 — análise de risco: o prompt pede o campo, pela mesma instrução ===');
    const srcRisco = fs.readFileSync(path.join(process.cwd(), 'src', 'loop', 'RiskAnalyzer.ts'), 'utf8');
    assert(srcRisco.includes('${INSTRUCAO_FALTOU}') && srcRisco.includes('faltou: lerFaltou(reg.saidaBruta)'), 'RiskAnalyzer usa a instrução única e grava a observação');
    const srcObs = fs.readFileSync(path.join(process.cwd(), 'src', 'loop', 'ObserverValidator.ts'), 'utf8');
    assert(!/Campo OPCIONAL "faltou"/.test(srcObs + srcRisco), 'nenhuma cópia local do texto da instrução (fonte única: evaluatorFlightRecorder)');

    if (logOrig === undefined) delete process.env.LOG_FILE; else process.env.LOG_FILE = logOrig;
    if (contOrig === undefined) delete process.env.TRACE_CONTENT; else process.env.TRACE_CONTENT = contOrig;
    // A pasta temporária NÃO é apagada: o AppLogger abre o LOG_FILE em segundo plano, e apagar a pasta antes da abertura
    // gera ENOENT sem tratamento (falhava só dentro da suíte, com a máquina ocupada). O SO limpa o diretório temporário.

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S354 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    if (failed > 0) process.exitCode = 1;
}
main().catch((err) => { console.error('S354 erro inesperado:', err); process.exitCode = 1; });
