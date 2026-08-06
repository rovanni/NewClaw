/// <reference types="node" />
/**
 * S197 — Pré-processamento de anexos observa TODOS os anexos e nunca responde pelo Core.
 *
 * BUG REAL (incidente de 04/08/2026, RFC-004 Princípio 2): um usuário enviou 12 imagens com a
 * pergunta "Poderia explicar cada projeto?". `processAttachments` dava `return` no primeiro anexo
 * processado com sucesso — as outras onze nunca chegaram a nenhum handler, não foram salvas, não
 * foram descritas e não deixaram rastro no texto da mensagem. O agente respondeu "cada projeto"
 * tendo visto um.
 *
 * A origem está documentada no commit `cef60c7` ("fix: voice transcription not reaching
 * AgentLoop"), que introduziu as cinco linhas responsáveis. O comentário dizia "Continue to text
 * processing pipeline" e o código fazia `return null` — para voz funcionava (o Telegram entrega um
 * áudio por mensagem), e o caso de N anexos nunca foi exercido.
 *
 * Segundo defeito, mesma função: quando um anexo falhava, ela devolvia uma mensagem PRONTA que o
 * MessageBus enviava crua ao usuário, encerrando o turno. Duas consequências — o canal decidia
 * pelo Core, e a mensagem saía sempre em português, porque texto fixo emitido no canal não passa
 * por `buildLanguageDirective` (que instrui o LLM a responder em pt-BR/en-US/es-ES).
 *
 * Invariantes travadas aqui:
 *   1. todo anexo chega ao seu handler, em ordem;
 *   2. anexo que falha vira FATO no texto e não interrompe os demais;
 *   3. handler que lança exceção não derruba os outros anexos nem a conversa;
 *   4. tipo sem handler registrado vira fato, não silêncio;
 *   5. excedente do limite vira fato, não descarte silencioso;
 *   6. o texto original do usuário (legenda) nunca é sobrescrito;
 *   7. `processMessageCore` não volta a encerrar o turno com resposta vinda da ingestão.
 *
 * Execução: npx ts-node src/__tests__/regression/S197_MessageBus_AllAttachmentsBecomeFacts.test.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { MessageBus } from '../../channels/MessageBus';
import type { NormalizedMessage, ChannelAttachment } from '../../channels/ChannelAdapter';

let failures = 0;
function check(ok: boolean, label: string, detail = '') {
    if (ok) {
        console.log(`  OK   ${label}`);
    } else {
        failures++;
        console.error(`  FALHOU: ${label}${detail ? ' → ' + detail : ''}`);
    }
}

/** Constructor só guarda referências — stubs bastam, mesmo padrão de S29. */
function makeBus(): MessageBus {
    return new MessageBus(
        {} as unknown as import('../../loop/AgentLoop').AgentLoop,
        {} as unknown as import('../../session/SessionManager').SessionManager,
    );
}

function photo(fileName: string): ChannelAttachment {
    return { type: 'photo', fileName, data: 'ZmFrZQ==' };
}

function makeMsg(text: string, attachments: ChannelAttachment[]): NormalizedMessage {
    return {
        messageId: `msg_${Math.random().toString(36).slice(2)}`,
        channel: 'web',
        userId: 'user-teste',
        type: 'photo',
        text,
        attachments,
        rawContext: 'ctx',
        chatId: 'chat-teste',
    };
}

/** processAttachments é privado por design — o teste exercita a unidade diretamente. */
function runIngestion(bus: MessageBus, msg: NormalizedMessage): Promise<void> {
    return (bus as unknown as {
        processAttachments(m: NormalizedMessage, k: unknown): Promise<void>;
    }).processAttachments(msg, { channel: msg.channel, userId: msg.userId });
}

async function main() {
    console.log('S197 — Ingestão de anexos produz fatos, nunca decisões\n');

    // ── 1. Todos os anexos chegam ao handler, e o texto original sobrevive ──────
    {
        const bus = makeBus();
        const seen: string[] = [];
        bus.registerMediaHandler('photo', async (m, att) => {
            seen.push(att.fileName || '?');
            m.text = `${m.text}\n[IMAGEM RECEBIDA: ${att.fileName}]`;
            return null;
        });

        const msg = makeMsg('Poderia explicar cada projeto?', [
            photo('img-1.jpg'), photo('img-2.jpg'), photo('img-3.jpg'),
        ]);
        const returned = await runIngestion(bus, msg);

        check(seen.length === 3, 'os 3 anexos chegaram ao handler', `viu: ${seen.join(', ')}`);
        check(
            seen.join(',') === 'img-1.jpg,img-2.jpg,img-3.jpg',
            'os anexos foram processados na ordem em que chegaram',
            seen.join(','),
        );
        check(
            msg.text.startsWith('Poderia explicar cada projeto?'),
            'a pergunta original do usuário foi preservada',
            msg.text.slice(0, 40),
        );
        check(
            ['img-1.jpg', 'img-2.jpg', 'img-3.jpg'].every(f => msg.text.includes(f)),
            'o texto final cita as três imagens',
        );
        check(returned === undefined, 'a ingestão não devolve resposta pronta ao canal');
    }

    // ── 2. Falha de um anexo não interrompe os outros e vira fato ───────────────
    {
        const bus = makeBus();
        const seen: string[] = [];
        bus.registerMediaHandler('photo', async (m, att) => {
            seen.push(att.fileName || '?');
            if (att.fileName === 'img-2.jpg') return '⚠️ Falha ao baixar o arquivo do canal telegram.';
            m.text = `${m.text}\n[IMAGEM RECEBIDA: ${att.fileName}]`;
            return null;
        });

        const msg = makeMsg('olha isso', [photo('img-1.jpg'), photo('img-2.jpg'), photo('img-3.jpg')]);
        await runIngestion(bus, msg);

        check(seen.length === 3, 'o anexo seguinte ao que falhou continuou sendo processado', `viu ${seen.length}/3`);
        check(msg.text.includes('img-3.jpg'), 'o terceiro anexo foi analisado apesar da falha do segundo');
        check(
            /ANEXO NÃO PROCESSADO: img-2\.jpg/.test(msg.text),
            'a falha entrou no texto como fato, com identificação do anexo',
            msg.text,
        );
        check(
            msg.text.includes('Falha ao baixar'),
            'o motivo relatado pelo handler foi preservado no fato',
        );
    }

    // ── 3. Handler que lança não derruba os demais ─────────────────────────────
    {
        const bus = makeBus();
        const seen: string[] = [];
        bus.registerMediaHandler('photo', async (m, att) => {
            seen.push(att.fileName || '?');
            if (att.fileName === 'bomba.jpg') throw new Error('estouro inesperado no handler');
            m.text = `${m.text}\n[IMAGEM RECEBIDA: ${att.fileName}]`;
            return null;
        });

        const msg = makeMsg('', [photo('bomba.jpg'), photo('ok.jpg')]);
        let threw = false;
        try {
            await runIngestion(bus, msg);
        } catch {
            threw = true;
        }

        check(!threw, 'exceção em um handler não escapa da ingestão');
        check(seen.length === 2, 'o anexo seguinte ao que explodiu foi processado');
        check(msg.text.includes('estouro inesperado'), 'a exceção virou fato no texto', msg.text);
        check(msg.text.includes('ok.jpg'), 'o anexo bom foi analisado normalmente');
    }

    // ── 4. Tipo sem handler registrado vira fato ───────────────────────────────
    {
        const bus = makeBus(); // nenhum handler registrado
        const msg = makeMsg('e esse arquivo?', [{ type: 'document', fileName: 'planilha.xlsx' }]);
        await runIngestion(bus, msg);

        check(
            /ANEXO NÃO PROCESSADO: planilha\.xlsx/.test(msg.text),
            'anexo sem handler registrado vira fato identificado',
            msg.text,
        );
        check(msg.text.startsWith('e esse arquivo?'), 'o texto do usuário foi preservado');
    }

    // ── 5. Excedente do limite vira fato, não descarte silencioso ──────────────
    {
        const bus = makeBus();
        let handled = 0;
        bus.registerMediaHandler('photo', async () => { handled++; return null; });

        const limit = MessageBus.MAX_ATTACHMENTS_PER_MESSAGE;
        const excedente = 3;
        const msg = makeMsg(
            'explica tudo',
            Array.from({ length: limit + excedente }, (_, i) => photo(`img-${i}.jpg`)),
        );
        await runIngestion(bus, msg);

        check(handled === limit, `apenas o limite (${limit}) foi processado`, `processou ${handled}`);
        check(
            msg.text.includes(`${excedente} ANEXO(S) NÃO PROCESSADO(S)`),
            'o excedente foi informado como fato, com a contagem exata',
            msg.text,
        );
    }

    // ── 6. Guarda estática: o turno não volta a ser encerrado pela ingestão ────
    {
        const source = fs.readFileSync(
            path.join(__dirname, '..', '..', 'channels', 'MessageBus.ts'), 'utf-8',
        );
        // A forma exata do bug: capturar o retorno da ingestão e enviá-lo como resposta.
        check(
            !/const\s+mediaResult\s*=\s*await\s+this\.processAttachments/.test(source),
            'processMessageCore não captura resposta da ingestão para enviar ao usuário',
        );
        check(
            /private async processAttachments\([^)]*\)\s*:\s*Promise<void>/.test(source),
            'processAttachments tem contrato Promise<void> — não devolve texto de resposta',
        );
    }

    console.log(failures === 0 ? '\n✅ S197 passou' : `\n❌ S197: ${failures} falha(s)`);
    process.exit(failures === 0 ? 0 : 1);
}

main();
