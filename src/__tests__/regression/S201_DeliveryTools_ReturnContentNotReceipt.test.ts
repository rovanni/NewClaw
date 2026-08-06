/// <reference types="node" />
/**
 * S201 — Ferramenta de entrega devolve o conteúdo entregue, não o recibo da operação.
 *
 * BUG REAL (execução real de 05/08/2026): pedido "Poderia explicar cada projeto?" com três imagens.
 * O agente analisou as três, produziu a explicação e a entregou por áudio. O que chegou ao usuário:
 *
 *     attachments: [voice.ogg, 450 KB]
 *     response:    "🔊 Áudio já enviado nesta execução do objetivo — reenvio evitado."
 *
 * A resposta textual era a mensagem interna do mecanismo de deduplicação. Quem não pudesse ouvir o
 * áudio ficaria sem resposta nenhuma, apesar de todo o trabalho ter sido feito corretamente.
 *
 * A investigação mostrou que não era caso isolado do dedup: os TRÊS caminhos do `send_audio`
 * devolviam recibo — inclusive o caminho de sucesso ("🔊 Áudio enviado com sucesso!"). O caso do
 * dedup só era o mais visível porque a mensagem era a mais estranha.
 *
 * Princípio normativo derivado: `docs/ARCHITECTURE/FERRAMENTAS_DE_ENTREGA.md` — o `output` de uma
 * ferramenta de entrega tem dois consumidores (o LLM no passo seguinte e o usuário, quando a
 * ferramenta é o último passo); recibo serve mal aos dois. Diagnóstico vai para o log.
 *
 * Cobre os três caminhos operacionais do send_audio e a guarda de dedup do GoalExecutionLoop.
 *
 * Execução: npx ts-node src/__tests__/regression/S201_DeliveryTools_ReturnContentNotReceipt.test.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { SendAudioTool } from '../../tools/send_audio';
import type { MessageBus } from '../../channels/MessageBus';

const CONTEUDO = 'O projeto 7 é o Supabase: banco Postgres gerenciado, autenticação e APIs em tempo real.';

/** Frases de recibo que NÃO podem mais aparecer como output — só em log. */
const RECIBOS = ['enviado com sucesso', 'já enviado recentemente', 'reenvio evitado', 'já enviado nesta execução'];

let failures = 0;
function check(ok: boolean, label: string, detail = '') {
    if (ok) {
        console.log(`  OK   ${label}`);
    } else {
        failures++;
        console.error(`  FALHOU: ${label}${detail ? ' → ' + detail : ''}`);
    }
}

function isReceipt(output: string): boolean {
    const lower = output.toLowerCase();
    return RECIBOS.some(r => lower.includes(r));
}

/** Bus falso: aceita o envio de voz e registra quantas vezes foi chamado. */
function makeBus(): { bus: MessageBus; calls: () => number } {
    let calls = 0;
    const bus = {
        async sendVoice() { calls++; },
    } as unknown as MessageBus;
    return { bus, calls: () => calls };
}

async function main() {
    console.log('S201 — Ferramentas de entrega devolvem conteúdo, não recibo\n');

    // ── 1. Caminho de debounce ────────────────────────────────────────────────
    // Não depende de TTS instalado: o debounce responde antes de qualquer geração de áudio.
    {
        const { bus } = makeBus();
        const tool = new SendAudioTool(bus);
        tool.setContext('chat-1', 'web');
        // Simula "acabou de enviar" mexendo no relógio interno do debounce.
        (tool as unknown as { lastSendTime: number }).lastSendTime = Date.now();

        const result = await tool.execute({ text: CONTEUDO });

        check(result.success === true, 'debounce continua respondendo sucesso');
        check(result.output === CONTEUDO, 'debounce devolve o conteúdo, não o recibo', result.output);
        check(!isReceipt(result.output), 'nenhuma frase de recibo no output do debounce', result.output);
    }

    // ── 2. Guarda de dedup do GoalExecutionLoop ───────────────────────────────
    // A guarda vive dentro de um método privado grande; a verificação é sobre o contrato do
    // retorno, feita na fonte — o que importa é não voltar a devolver texto de diagnóstico.
    {
        const source = fs.readFileSync(
            path.join(__dirname, '..', '..', 'loop', 'GoalExecutionLoop.ts'), 'utf-8',
        );
        const dedupReturn = source
            .split('\n')
            .find(l => l.includes('toolResult') && l.includes('resolvedArgs[\'text\']'));

        check(
            dedupReturn !== undefined,
            'a guarda de dedup devolve o texto do próprio passo',
            'não encontrei o retorno com resolvedArgs[\'text\']',
        );
        check(
            !/output:\s*'🔊[^']*'/.test(source),
            'nenhum retorno de send_audio com recibo literal no GoalExecutionLoop',
        );
    }

    // ── 3. O código da tool não devolve mais recibo em nenhum caminho ─────────
    {
        const source = fs.readFileSync(
            path.join(__dirname, '..', '..', 'tools', 'send_audio.ts'), 'utf-8',
        );
        const returnsWithReceipt = source
            .split('\n')
            .filter(l => /return\s*\{[^}]*output:/.test(l) && isReceipt(l));

        check(
            returnsWithReceipt.length === 0,
            'send_audio não tem nenhum return com recibo no output',
            returnsWithReceipt.map(l => l.trim().slice(0, 60)).join(' | '),
        );

        // O recibo não some do sistema — muda de lugar: continua no log.
        check(
            /log\.info\(/.test(source) && /Audio sent|Debounced/.test(source),
            'o status continua registrado em log (a informação não se perde, muda de canal)',
        );
    }

    // ── 4. Falha continua sendo falha ─────────────────────────────────────────
    {
        const { bus } = makeBus();
        const tool = new SendAudioTool(bus);
        tool.setContext('chat-1', 'web');

        const result = await tool.execute({});   // sem texto

        check(result.success === false, 'chamada sem texto continua falhando', JSON.stringify(result));
        check(!!result.error, 'com erro descritivo', result.error);
    }

    console.log(failures === 0 ? '\n✅ S201 passou' : `\n❌ S201: ${failures} falha(s)`);
    process.exitCode = failures === 0 ? 0 : 1;
}

main();
