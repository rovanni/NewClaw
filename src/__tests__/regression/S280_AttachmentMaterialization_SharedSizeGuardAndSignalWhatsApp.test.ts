/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S280 (issue 032, Sprint 3)
 *
 * Antes desta Sprint, nenhum dos três caminhos que `agentMediaHandlers.ts` sabe ler bytes
 * (`fileId`+`downloadFile`, `url`, `data` inline) batia para WhatsApp/Signal — todo anexo desses
 * canais virava "falha ao baixar" (fato, nunca decisão de encerrar o turno — RFC-004 preservada).
 * Este teste cobre a materialização adicionada (popular `attachment.data`, mesmo mecanismo já usado
 * pelo canal Web) e, principalmente, o teto de tamanho que `agentMediaHandlers.ts` NUNCA teve para
 * NENHUM canal antes desta Sprint — o achado mais sério da investigação (Fase 2).
 *
 *   S280.1 — `MessageBus.MAX_ATTACHMENT_BYTES` é a autoridade única (Dashboard herda dela, não tem
 *            mais teto próprio)
 *   S280.2 — o guard compartilhado em `agentMediaHandlers.ts` rejeita ANTES de decodificar, nos 3
 *            handlers (áudio/documento/foto), sem quebrar o caminho normal (arquivo pequeno)
 *   S280.3 — `WhatsAppAdapter.toDeclaredBytes()`: number/string/Long-like/inválido
 *   S280.4 — `WhatsAppAdapter.materializeAttachment()`: sem socket → undefined, nunca lança
 *   S280.5 — `SignalAdapter.readAttachmentFile()`: SIGNAL_CLI_CONFIG_DIR ausente (comportamento
 *            inalterado — a "ausência de materialização" que a campanha pediu como controle),
 *            leitura real de arquivo, teto de tamanho, id com path traversal, arquivo ausente
 *   S280.6 — nenhum caminho da máquina de desenvolvimento foi commitado (nem em código, nem em
 *            `.env.example`)
 *
 * CONTROLE NEGATIVO (feito interativamente ao validar esta mudança, não é código deste arquivo —
 * mesmo padrão de S277/S279): os 3 guards de `agentMediaHandlers.ts` foram temporariamente
 * neutralizados (patch em cópia do arquivo) e o S280.2 falhou nas 3 asserções de rejeição, provando
 * que o teste detecta a ausência do guard, não só o formato do texto de erro.
 *
 * Execução: npx ts-node src/__tests__/regression/S280_AttachmentMaterialization_SharedSizeGuardAndSignalWhatsApp.test.ts
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MessageBus } from '../../channels/MessageBus';
import { MAX_UPLOAD_BYTES } from '../../dashboard/routes/chat';
import { transcribeAttachment, handleDocumentAttachment, handlePhotoAttachment } from '../../core/agentMediaHandlers';
import { WhatsAppAdapter, toDeclaredBytes } from '../../channels/WhatsAppAdapter';
import { SignalAdapter } from '../../channels/SignalAdapter';
import type { NormalizedMessage, ChannelAttachment } from '../../channels/ChannelAdapter';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  OK ${message}`); passed++; }
    else { console.error(`  FALHOU: ${message}`, detail ?? ''); failed++; }
}

const fakeBus = { downloadFile: async () => { throw new Error('não deveria ser chamado'); } } as unknown as MessageBus;

function makeMsg(): NormalizedMessage {
    return { messageId: 'm1', channel: 'whatsapp', userId: 'u1', type: 'document', text: '' };
}

/** Base64 válido de tamanho controlado (múltiplo de 4 chars = sem padding, tamanho decodificado exato). */
function fakeBase64OfSize(bytes: number): string {
    const raw = Buffer.alloc(bytes, 65); // 'A' repetido — conteúdo irrelevante, só o tamanho importa
    return raw.toString('base64');
}

async function main(): Promise<void> {
    console.log('\n=== S280.1 — MAX_ATTACHMENT_BYTES é a autoridade única (Dashboard herda, não duplica) ===');
    {
        assert(typeof MessageBus.MAX_ATTACHMENT_BYTES === 'number' && MessageBus.MAX_ATTACHMENT_BYTES > 0,
            'MessageBus.MAX_ATTACHMENT_BYTES existe e é positivo', MessageBus.MAX_ATTACHMENT_BYTES);
        assert(MAX_UPLOAD_BYTES === MessageBus.MAX_ATTACHMENT_BYTES,
            'dashboard/routes/chat.ts MAX_UPLOAD_BYTES é o MESMO valor (mesma referência de autoridade, não um literal próprio)',
            { dashboard: MAX_UPLOAD_BYTES, bus: MessageBus.MAX_ATTACHMENT_BYTES });
        const src = fs.readFileSync(path.resolve(__dirname, '../../dashboard/routes/chat.ts'), 'utf8');
        assert(!/MAX_UPLOAD_BYTES\s*=\s*\d/.test(src), 'chat.ts não tem mais um número literal próprio para o teto', src);
    }

    const oversized = fakeBase64OfSize(MessageBus.MAX_ATTACHMENT_BYTES + 1024);
    const small = fakeBase64OfSize(1024);

    console.log('\n=== S280.2 — guard compartilhado: rejeita ANTES de decodificar, nos 3 handlers, sem quebrar o caso pequeno ===');
    {
        // transcribeAttachment
        const msgA = makeMsg();
        const rA = await transcribeAttachment(msgA, { type: 'voice', data: oversized } as ChannelAttachment, fakeBus, os.tmpdir());
        assert(rA !== null && /excede/i.test(rA), 'transcribeAttachment: anexo grande é recusado com mensagem honesta', rA);
        assert(msgA.text === '', 'transcribeAttachment: nenhuma transcrição foi anexada ao texto (nada foi decodificado)', msgA.text);

        // handleDocumentAttachment / handlePhotoAttachment escrevem em WORKSPACE_DIR — isola num tmpdir
        const tmpWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'newclaw-s280-ws-'));
        const prevWs = process.env.WORKSPACE_DIR;
        process.env.WORKSPACE_DIR = tmpWorkspace;
        try {
            const msgB = makeMsg();
            const rB = await handleDocumentAttachment(msgB, { type: 'document', data: oversized, fileName: 'grande.pdf' } as ChannelAttachment, fakeBus);
            assert(rB !== null && /excede/i.test(rB), 'handleDocumentAttachment: anexo grande é recusado', rB);
            assert(fs.readdirSync(tmpWorkspace).length === 0, 'handleDocumentAttachment: NADA foi escrito no workspace — a recusa veio antes da escrita', fs.readdirSync(tmpWorkspace));

            const msgC = makeMsg();
            const rC = await handlePhotoAttachment(msgC, { type: 'photo', data: oversized } as ChannelAttachment, fakeBus, null);
            assert(rC !== null && /excede/i.test(rC), 'handlePhotoAttachment: anexo grande é recusado', rC);
            assert(fs.readdirSync(tmpWorkspace).length === 0, 'handlePhotoAttachment: nada foi escrito', fs.readdirSync(tmpWorkspace));

            // Caso pequeno: comportamento normal preservado (regressão do caminho feliz do canal Web).
            const msgD = makeMsg();
            const rD = await handleDocumentAttachment(msgD, { type: 'document', data: small, fileName: 'pequeno.txt' } as ChannelAttachment, fakeBus);
            assert(rD === null, 'handleDocumentAttachment: anexo pequeno continua sendo aceito normalmente (null = sucesso)', rD);
            assert(fs.readdirSync(tmpWorkspace).length === 1, 'e o arquivo pequeno foi de fato escrito', fs.readdirSync(tmpWorkspace));
        } finally {
            if (prevWs === undefined) delete process.env.WORKSPACE_DIR; else process.env.WORKSPACE_DIR = prevWs;
            fs.rmSync(tmpWorkspace, { recursive: true, force: true });
        }
    }

    console.log('\n=== S280.3 — WhatsAppAdapter.toDeclaredBytes(): aceita number/string/Long-like, nunca adivinha o resto ===');
    {
        assert(toDeclaredBytes(1234) === 1234, 'number direto');
        assert(toDeclaredBytes('1234') === 1234, 'string numérica');
        assert(toDeclaredBytes('abc') === undefined, 'string não numérica → undefined');
        assert(toDeclaredBytes({ toNumber: () => 999 }) === 999, 'objeto Long-like (tem .toNumber()) é aceito');
        assert(toDeclaredBytes({ toNumber: () => { throw new Error('boom'); } }) === undefined, '.toNumber() que lança → undefined, não propaga');
        assert(toDeclaredBytes(null) === undefined, 'null → undefined');
        assert(toDeclaredBytes(undefined) === undefined, 'undefined → undefined');
        assert(toDeclaredBytes({}) === undefined, 'objeto sem .toNumber() → undefined (nunca adivinha)');
        assert(toDeclaredBytes(NaN) === undefined, 'NaN → undefined');
    }

    console.log('\n=== S280.4 — WhatsAppAdapter.materializeAttachment(): sem socket, nunca lança, nunca tenta baixar ===');
    {
        const adapter = new WhatsAppAdapter({ enabled: false }); // enabled:false — start() nunca roda, this.sock fica null
        const result = await (adapter as unknown as { materializeAttachment: (m: unknown, d: unknown) => Promise<string | undefined> })
            .materializeAttachment({ key: { id: 'x' } }, 100);
        assert(result === undefined, 'sem socket conectado, devolve undefined (nunca lança)', result);

        const src = fs.readFileSync(path.resolve(__dirname, '../../channels/WhatsAppAdapter.ts'), 'utf8');
        const checkIdx = src.indexOf('declared > MessageBus.MAX_ATTACHMENT_BYTES');
        const downloadIdx = src.indexOf('await downloadMediaMessage(');
        assert(checkIdx !== -1 && downloadIdx !== -1 && checkIdx < downloadIdx,
            'estruturalmente: a checagem de tamanho declarado vem ANTES da chamada de download (evita gastar rede com arquivo que seria recusado)',
            { checkIdx, downloadIdx });
    }

    console.log('\n=== S280.5 — SignalAdapter.readAttachmentFile(): ausência de config, leitura real, teto, path traversal ===');
    {
        type PrivateSignal = { readAttachmentFile: (id: string | undefined, size: number | undefined) => string | undefined };

        // (a) Controle da campanha: SEM SIGNAL_CLI_CONFIG_DIR — "ausência de materialização" —
        // continua devolvendo undefined, exatamente o comportamento de antes desta Sprint.
        const noConfigAdapter = new SignalAdapter({ enabled: false, phoneNumber: '+5511999999999' });
        const noConfigResult = (noConfigAdapter as unknown as PrivateSignal).readAttachmentFile('qualquer-id', 10);
        assert(noConfigResult === undefined, 'sem SIGNAL_CLI_CONFIG_DIR configurado, nunca materializa (regressão da ausência intencional)', noConfigResult);

        // (b) Com config real: lê o arquivo de verdade.
        const tmpConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'newclaw-s280-signal-'));
        const attachmentsDir = path.join(tmpConfigDir, 'attachments');
        fs.mkdirSync(attachmentsDir, { recursive: true });
        const realId = 'attachment-real-123';
        const originalBytes = Buffer.from('conteúdo real do anexo de teste S280', 'utf8');
        fs.writeFileSync(path.join(attachmentsDir, realId), originalBytes);

        const adapter = new SignalAdapter({ enabled: false, phoneNumber: '+5511999999999', signalCliConfigDir: tmpConfigDir });
        const priv = adapter as unknown as PrivateSignal;

        const read = priv.readAttachmentFile(realId, originalBytes.length);
        assert(read !== undefined && Buffer.from(read, 'base64').equals(originalBytes),
            'com SIGNAL_CLI_CONFIG_DIR configurado, lê o arquivo real e devolve os MESMOS bytes em base64', read);

        // (c) Teto de tamanho — recusa mesmo com o arquivo existindo.
        const overLimit = priv.readAttachmentFile(realId, MessageBus.MAX_ATTACHMENT_BYTES + 1);
        assert(overLimit === undefined, 'tamanho declarado acima do teto → recusa, mesmo o arquivo existindo', overLimit);

        // (d) id com path traversal — nunca escapa de attachments/, mesmo que o alvo exista.
        const outsideMarker = path.join(tmpConfigDir, 's280-outside-marker.txt');
        fs.writeFileSync(outsideMarker, 'não deveria ser lido');
        for (const maliciousId of ['../s280-outside-marker.txt', '..\\s280-outside-marker.txt', '../../etc/passwd', 'sub/dir']) {
            const r = priv.readAttachmentFile(maliciousId, undefined);
            assert(r === undefined, `id adversarial "${maliciousId}" é recusado antes de montar o caminho`, r);
        }

        // (e) id ausente / arquivo inexistente.
        assert(priv.readAttachmentFile(undefined, undefined) === undefined, 'id ausente → undefined');
        assert(priv.readAttachmentFile('nunca-existiu', undefined) === undefined, 'arquivo inexistente → undefined (não lança)');

        fs.rmSync(tmpConfigDir, { recursive: true, force: true });
    }

    console.log('\n=== S280.6 — nenhum caminho da máquina de desenvolvimento foi commitado ===');
    {
        const filesToCheck = [
            '../../channels/WhatsAppAdapter.ts',
            '../../channels/SignalAdapter.ts',
            '../../core/agentMediaHandlers.ts',
            '../../channels/MessageBus.ts',
            '../../index.ts',
            '../../core/agentControllerTypes.ts',
        ];
        const forbidden = [/lucia/i, /C:\\Users\\/i, /AppData\\Local\\Temp/i];
        for (const rel of filesToCheck) {
            const p = path.resolve(__dirname, rel);
            const content = fs.readFileSync(p, 'utf8');
            for (const pattern of forbidden) {
                assert(!pattern.test(content), `${path.basename(p)} não contém ${pattern} (sem caminho pessoal commitado)`, pattern);
            }
        }
        const envExample = fs.readFileSync(path.resolve(__dirname, '../../../.env.example'), 'utf8');
        for (const pattern of forbidden) {
            assert(!pattern.test(envExample), `.env.example não contém ${pattern}`, pattern);
        }
        assert(/^SIGNAL_CLI_CONFIG_DIR=\s*$/m.test(envExample), 'SIGNAL_CLI_CONFIG_DIR em .env.example fica vazio (sem valor padrão adivinhado)', envExample);
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S280 RESULTADO: ${passed} passou | ${failed} falhou`);
    if (failed > 0) process.exit(1);
    process.exit(0);
}

main().catch(err => { console.error('S280 erro inesperado:', err); process.exit(1); });
