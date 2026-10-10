/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S363 (ADR-014, Sprint M0 — motor único de validação)
 *
 * O contrato que todo tipo de validação passa a seguir: entradas declaradas com papel, prompt por seções na mesma
 * ordem, corte só onde declarado (e declarado no prompt), teto → não avaliável, modelo e modo de raciocínio por tipo,
 * leitura estrutural da saída, pré-verificação de citação, adaptador e registro no gravador de voo com `faltou` e
 * `dificuldade`.
 *
 * REGRESSÃO SE: qualquer parte desse contrato deixar de valer para um tipo registrado.
 *
 * Execução: npx ts-node src/__tests__/regression/S363_ValidationEngine_Contract.test.ts
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ValidationEngine } from '../../validation/ValidationEngine';
import { RegistroDeValidacoes, validarDescritor, type DescritorDeValidacao } from '../../validation/contratoDeValidacao';
import { DECISION_PROMPT_MAX_CHARS } from '../../core/providerTypes';
import { INSTRUCAO_FALTOU, INSTRUCAO_DIFICULDADE } from '../../shared/evaluatorFlightRecorder';
import { ProviderFactory } from '../../core/ProviderFactory';

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

type Chamada = { prompt: string; modelo?: string; opts?: Record<string, unknown> };
function fabrica(saida: string, chamadas: Chamada[]) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getBudgetAuxiliar } = require('../../shared/auxTimeout');
    return {
        chatWithFallback: async (msgs: Array<{ content: string }>, _t: unknown, _p: unknown, _ms: unknown, _s: unknown, modelo?: string, opts?: Record<string, unknown>) => {
            chamadas.push({ prompt: msgs[0].content, modelo, opts });
            return { status: 'success', content: saida, attempts: [] };
        },
        getBudgetAuxiliar: (p: 'classificacao' | 'validacao') => getBudgetAuxiliar(p, null, null),
    } as any;
}

const DADOS: DescritorDeValidacao = {
    tipo: 'dados_contra_ferramenta',
    pergunta: 'os dados da resposta batem com as ferramentas?',
    entradas: [
        { nome: 'pedido', rotulo: 'Pedido do usuário', papel: 'contexto_do_usuario', obrigatoria: true },
        { nome: 'resposta', rotulo: 'Resposta', papel: 'objeto', obrigatoria: true },
        { nome: 'evidencia', rotulo: 'Saída da ferramenta', papel: 'fonte_de_verdade', obrigatoria: true },
        { nome: 'historico', rotulo: 'Tentativas anteriores', papel: 'contexto_da_execucao', obrigatoria: false, corteMaxChars: 50 },
    ],
    checklist: ['Cada número da resposta aparece na saída da ferramenta?'],
    agregacao: 'itens',
    preVerificacoes: ['citacao_existe_na_fonte'],
    raciocinio: 'desligado',
    semVeredito: 'bloquear',
};

async function main(): Promise<void> {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 's363-'));
    const logOrig = process.env.LOG_FILE, contOrig = process.env.TRACE_CONTENT;
    process.env.LOG_FILE = path.join(base, 'newclaw-audit.log');
    process.env.TRACE_CONTENT = 'true';

    console.log('\n=== S363-1 — o registro recusa descritor fora do contrato ===');
    assert(validarDescritor({ ...DADOS, entradas: DADOS.entradas.filter(e => e.papel !== 'objeto') }).some(e => /objeto/.test(e)), 'sem entrada "objeto" → erro');
    assert(validarDescritor({ ...DADOS, entradas: [{ ...DADOS.entradas[1], corteMaxChars: 100 }, DADOS.entradas[2]] }).some(e => /não pode ter corte/.test(e)), 'corte no objeto → erro (objeto nunca é cortado)');
    const reg = new RegistroDeValidacoes();
    reg.registrar(DADOS);
    let duplicou = false;
    try { reg.registrar(DADOS); } catch { duplicou = true; }
    assert(duplicou, 'tipo duplicado → erro');

    console.log('\n=== S363-2 — entrada obrigatória ausente: não avaliável, sem chamar o modelo ===');
    const c1: Chamada[] = [];
    const motor1 = new ValidationEngine(fabrica('{}', c1), reg, () => 'modelo-x');
    const r1 = await quiet(() => motor1.validar('dados_contra_ferramenta', { pedido: 'qual o tempo?', resposta: 'Faz 18 °C.' }));
    assert(c1.length === 0 && r1.veredito.estado === 'nao_avaliavel' && /evidencia/.test(r1.veredito.naoAvaliavelPorque ?? ''), `não avaliável: ${r1.veredito.naoAvaliavelPorque}`);

    console.log('\n=== S363-3 — prompt por seções, na ordem do contrato, com corte só onde declarado ===');
    const c2: Chamada[] = [];
    const saidaReprova = JSON.stringify({ estado: 'aprovado', itens: [{ item: 'faz 27 °C', confere: 'nao', evidencia: 'E1', trecho: '18.4 °C' }], faltou: 'o horário da medição', dificuldade: 'a resposta mistura dado e opinião' });
    const motor2 = new ValidationEngine(fabrica(saidaReprova, c2), reg, (k) => k === 'OBSERVER_MODEL' ? 'modelo-do-painel' : undefined);
    const historico = 'tentativa 1 falhou por timeout; tentativa 2 trouxe dados parciais e foi descartada';
    const r2 = await quiet(() => motor2.validar('dados_contra_ferramenta', { pedido: 'qual o tempo em Curitiba?', resposta: 'Faz 27 °C em Curitiba.', evidencia: 'Curitiba: 18.4 °C, nublado', historico }, { goalId: 'g1' }));
    const p = c2[0]?.prompt ?? '';
    const pos = (s: string) => p.indexOf(s);
    assert(pos('PERGUNTA:') < pos('CONTEXTO DO USUÁRIO') && pos('CONTEXTO DO USUÁRIO') < pos('O QUE ESTÁ SENDO JULGADO') && pos('O QUE ESTÁ SENDO JULGADO') < pos('FONTES DE VERDADE') && pos('FONTES DE VERDADE') < pos('CONTEXTO DA EXECUÇÃO') && pos('CONTEXTO DA EXECUÇÃO') < pos('CHECKLIST'), 'seções na ordem: pergunta → pedido → objeto → fontes → execução → checklist');
    assert(p.includes('Faz 27 °C em Curitiba.') && p.includes('Curitiba: 18.4 °C, nublado'), 'objeto e fonte de verdade inteiros');
    assert(!p.includes(historico) && /trecho: primeiros 50 de \d+ caracteres — o corte é do sistema/.test(p), 'contexto da execução cortado onde declarado, com o corte declarado');
    assert(p.includes(INSTRUCAO_FALTOU) && p.includes(INSTRUCAO_DIFICULDADE), 'campos opcionais "faltou" e "dificuldade" pedidos');

    console.log('\n=== S363-4 — modelo e modo de raciocínio do tipo ===');
    assert(c2[0]?.modelo === 'modelo-do-painel', `modelo resolvido pela chave do descritor (${c2[0]?.modelo})`);
    assert(c2[0]?.opts?.raciocinio === 'desligado' && c2[0]?.opts?.reasoningIntensive === false, 'raciocínio desligado repassado ao provedor');

    console.log('\n=== S363-5 — agregação por itens + citação conferida pelo código ===');
    assert(r2.veredito.estado === 'reprovado', `item "nao" com citação real → reprovado, mesmo o modelo dizendo "aprovado" (${r2.veredito.estado})`);
    assert(r2.veredito.itens[0]?.citacaoConfere === true, 'a citação "18.4 °C" existe na fonte');
    const c3: Chamada[] = [];
    const inventada = JSON.stringify({ estado: 'aprovado', itens: [{ item: 'faz 18 °C', confere: 'sim', trecho: 'Curitiba: 18 graus exatos' }] });
    const r3 = await quiet(() => new ValidationEngine(fabrica(inventada, c3), reg, () => '').validar('dados_contra_ferramenta', { pedido: 'p', resposta: 'Faz 18 °C.', evidencia: 'Curitiba: 18.4 °C' }));
    assert(r3.veredito.itens[0]?.confere === 'sem_evidencia' && r3.veredito.estado === 'nao_avaliavel', 'citação que não existe na fonte não decide nada → não avaliável');
    assert(c3[0]?.modelo === undefined, 'sem modelo configurado → modelo padrão do provedor (nenhum nome embutido)');

    console.log('\n=== S363-6 — teto, saída inválida e adaptador ===');
    const c4: Chamada[] = [];
    const r4 = await quiet(() => new ValidationEngine(fabrica('{}', c4), reg).validar('dados_contra_ferramenta', { pedido: 'p', resposta: 'r', evidencia: 'x'.repeat(DECISION_PROMPT_MAX_CHARS) }));
    assert(c4.length === 0 && r4.veredito.estado === 'nao_avaliavel' && /teto/.test(r4.veredito.naoAvaliavelPorque ?? ''), 'acima do teto → não avaliável sem chamar o modelo');
    const r5 = await quiet(() => new ValidationEngine(fabrica('isto não é json', []), reg).validar('dados_contra_ferramenta', { pedido: 'p', resposta: 'r', evidencia: 'e' }));
    assert(r5.veredito.estado === 'nao_avaliavel' && /estrutura/.test(r5.veredito.naoAvaliavelPorque ?? ''), 'saída sem a estrutura → não avaliável (nunca "consertada")');
    const reg2 = new RegistroDeValidacoes();
    reg2.registrar({ ...DADOS, tipo: 'com_adaptador', agregacao: 'modelo', preVerificacoes: [], adaptador: (v) => ({ aprovado: v.estado === 'aprovado' }) } as DescritorDeValidacao<unknown>);
    const r6 = await quiet(() => new ValidationEngine(fabrica('{"estado":"aprovado","itens":[]}', []), reg2).validar<{ aprovado: boolean }>('com_adaptador', { pedido: 'p', resposta: 'r', evidencia: 'e' }));
    assert(r6.adaptado.aprovado === true, 'adaptador traduz para o formato do consumidor');

    console.log('\n=== S363-7 — gravador de voo: validacao_<tipo>, com faltou e dificuldade ===');
    const pasta = path.join(base, 'avaliadores');
    const regs = fs.readdirSync(pasta).filter(n => n.startsWith('validacao_dados_contra_ferramenta-'))
        .flatMap(n => fs.readFileSync(path.join(pasta, n), 'utf8').trim().split('\n').map(l => JSON.parse(l)));
    const rr = regs.find(x => x.id === r2.veredito.avaliacaoId);
    assert(!!rr && rr.depois?.estado === 'reprovado' && rr.antes?.fatos?.raciocinio === 'desligado', 'registro do julgamento com estado e modo de raciocínio');
    assert(rr?.depois?.conteudo?.faltou === 'o horário da medição' && rr?.depois?.conteudo?.dificuldade === 'a resposta mistura dado e opinião', 'faltou e dificuldade gravados');
    assert(regs.some(x => x.depois?.desfecho === 'entrada_ausente'), 'a recusa por entrada ausente também é registrada');

    console.log('\n=== S363-8 — raciocínio desligado chega ao Ollama como think:false ===');
    const corpos: Array<Record<string, unknown>> = [];
    const orig = global.fetch;
    global.fetch = (async (_u: string, init?: { body?: string }) => {
        corpos.push(JSON.parse(String(init?.body ?? '{}')));
        const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode(JSON.stringify({ message: { content: '{"estado":"aprovado","itens":[]}' }, done: true, done_reason: 'stop' }) + '\n')); c.close(); } });
        return { ok: true, status: 200, body } as unknown as Response;
    }) as unknown as typeof fetch;
    try {
        const pf = new ProviderFactory({ defaultProvider: 'ollama', ollamaUrl: 'http://fake-ollama.invalid', ollamaModel: 'modelo-teste' } as any);
        await quiet(() => pf.chatWithFallback([{ role: 'user', content: 'x' }], undefined, 'ollama', 2000, undefined, undefined, { raciocinio: 'desligado' }));
        await quiet(() => pf.chatWithFallback([{ role: 'user', content: 'x' }], undefined, 'ollama', 2000));
    } finally { global.fetch = orig; }
    assert(corpos[0]?.think === false, 'raciocinio=desligado → corpo da requisição com think:false');
    assert(!('think' in (corpos[1] ?? {})), 'sem o modo declarado → corpo sem "think" (comportamento anterior)');

    if (logOrig === undefined) delete process.env.LOG_FILE; else process.env.LOG_FILE = logOrig;
    if (contOrig === undefined) delete process.env.TRACE_CONTENT; else process.env.TRACE_CONTENT = contOrig;

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S363 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    if (failed > 0) process.exitCode = 1;
}
main().catch((err) => { console.error('S363 erro inesperado:', err); process.exitCode = 1; });
