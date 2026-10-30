/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S466 (30/10/2026, interface de voz)
 *
 * Com um esclarecimento pendente (ADR-015), a mensagem seguinte era SEMPRE juntada ao pedido antigo, antes de qualquer
 * análise. Caso real: o microfone pegou "Romântica básica." (fala de verdade por perto), o NewClaw perguntou o que era,
 * e o "Olá, tudo bem?" seguinte foi juntado a essa pergunta e respondido como se fosse sobre ela. O classificador até
 * escreveu no `reason` que a saudação não respondia à pergunta, mas nada lia isso.
 *
 * Correção (responsabilidade antes do mecanismo): quem decide se a resposta responde à pergunta é o classificador do
 * turno (GoalExtractor), que já lê o pedido, a pergunta e a resposta inteiros — um campo a mais no JSON dele, sem juiz
 * novo. O orquestrador consome o veredito: `false` → o turno segue com a mensagem como chegou, como pedido novo, e ela é
 * classificada de novo; sem veredito → tudo como antes.
 *
 * S466-1 — o prompt pede o veredito e diz quando ele vale (só com o bloco [ESCLARECIMENTO …]).
 * S466-2 — só um booleano é veredito: true / false / null / ausente / texto.
 * S466-3 — o orquestrador guarda a mensagem como chegou, só desfaz a junção com `false` e classifica de novo.
 *
 * REGRESSÃO SE: a resposta voltar a ser juntada sem que o veredito possa desfazer a junção; um valor que não é booleano
 * passar a valer como veredito; ou o caminho sem veredito deixar de juntar (o comportamento de antes).
 *
 * Execução: npx ts-node src/__tests__/regression/S466_EsclarecimentoRespostaNaoRelacionada.test.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { GoalExtractor } from '../../loop/GoalExtractor';

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

// A mensagem como o orquestrador a monta quando há um esclarecimento pendente (formato de GoalOrchestrator.processarTurno).
const COMBINADA = 'Romântica básica.\n\n[ESCLARECIMENTO — o assistente perguntou: "o que é \'romântica básica\'?"; '
    + 'o usuário respondeu: "Olá, tudo bem?". Atenda o pedido acima usando esta resposta.]';

function extratorQueResponde(json: object): { ex: GoalExtractor; prompts: string[] } {
    const prompts: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getBudgetAuxiliar } = require('../../shared/auxTimeout');
    const factory = {
        chatWithFallback: async (msgs: Array<{ content: string }>) => {
            prompts.push(msgs[0]?.content ?? '');
            return { status: 'success', content: JSON.stringify(json), attempts: [] };
        },
        getBudgetAuxiliar: (p: 'classificacao' | 'validacao') => getBudgetAuxiliar(p, null, null),
    } as any;
    return { ex: new GoalExtractor(factory), prompts };
}

const BASE = { is_goal: false, confidence: 0.9, reason: 'r', is_ambiguous: false };

async function main(): Promise<void> {
    console.log('\n=== S466-1 — o prompt pede o veredito ===');
    const { ex, prompts } = extratorQueResponde({ ...BASE, responde_ao_esclarecimento: false });
    await quiet(() => (ex as any).llmClassify(COMBINADA, {}, []));
    const p = prompts[0] ?? '';
    assert(p.includes(COMBINADA), 'a mensagem combinada chega inteira (pedido, pergunta e resposta)');
    assert(p.includes('"responde_ao_esclarecimento": boolean ou null'), 'o JSON pedido tem o campo do veredito');
    assert(/null quando não há o bloco \[ESCLARECIMENTO/.test(p), 'sem o bloco, o campo é null (não se aplica)');
    assert(/false quando é outra coisa — uma saudação/.test(p), 'a regra cita a saudação como "não responde"');

    console.log('\n=== S466-2 — só um booleano é veredito ===');
    const casos: Array<[unknown, boolean | undefined, string]> = [
        [false, false, 'false → não responde'],
        [true, true, 'true → responde'],
        [null, undefined, 'null → sem veredito'],
        ['false', undefined, 'texto "false" → sem veredito (não é booleano)'],
    ];
    for (const [valor, esperado, rotulo] of casos) {
        const { ex: e } = extratorQueResponde({ ...BASE, responde_ao_esclarecimento: valor });
        const r: any = await quiet(() => (e as any).llmClassify(COMBINADA, {}, []));
        assert(r.respondeAoEsclarecimento === esperado, rotulo, r.respondeAoEsclarecimento);
    }
    const { ex: semCampo } = extratorQueResponde(BASE);
    const r: any = await quiet(() => (semCampo as any).llmClassify('Olá, tudo bem?', {}, []));
    assert(r.respondeAoEsclarecimento === undefined, 'campo ausente → sem veredito');

    console.log('\n=== S466-3 — o orquestrador consome o veredito ===');
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'loop', 'GoalOrchestrator.ts'), 'utf-8');
    const inicio = src.indexOf('// ── Resolver clarificação pendente');
    const fim = src.indexOf('const classificationMs = Date.now() - classifyStart;');
    const bloco = inicio >= 0 && fim > inicio ? src.slice(inicio, fim) : '';
    assert(bloco.length > 0, 'trecho da resolução do esclarecimento até a classificação encontrado');
    assert(/const mensagemDoUsuario = message;/.test(bloco), 'guarda a mensagem como chegou, antes da junção');
    assert(/juntouAoEsclarecimento = Boolean\(pending\.pergunta\)/.test(bloco), 'marca a junção só quando havia pergunta');
    assert(/\[ESCLARECIMENTO — o assistente perguntou/.test(bloco), 'a junção continua (caminho sem veredito, como antes)');
    assert(/if \(juntouAoEsclarecimento && classification\.respondeAoEsclarecimento === false\)/.test(bloco),
        'só o veredito false desfaz a junção');
    const desfaz = bloco.slice(bloco.indexOf('respondeAoEsclarecimento === false'));
    assert(/message = mensagemDoUsuario;/.test(desfaz) && /classification = await this\.extractor\.classify\(/.test(desfaz),
        'com false: segue com a mensagem como chegou e classifica de novo');
    assert(/let classification = await this\.extractor\.classify\(/.test(bloco), 'a classificação pode ser refeita');

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S466 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    if (failed > 0) process.exitCode = 1;
}
main().catch((err) => { console.error('S466 erro inesperado:', err); process.exitCode = 1; });
