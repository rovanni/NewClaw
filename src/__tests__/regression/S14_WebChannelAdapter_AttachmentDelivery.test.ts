/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S14
 * Entrega de arquivos (send_document/send_audio) pelo canal web do Dashboard.
 *
 * PROBLEMA CORRIGIDO (02/07/2026):
 * send_document.ts só sabia entregar via Discord (push imediato) ou Telegram (bus.sendDocument).
 * Uma sessão via dashboard (channel='web') caía no branch "senão → Telegram" e tentava enviar
 * usando o session id do dashboard como se fosse um chatId do Telegram — falha silenciosa ou
 * sem efeito nenhum. Mesmo se funcionasse, chat.ts nunca incluía anexos na resposta JSON, e o
 * frontend nunca sabia renderizar um anexo do agente (só ecoava o que o usuário tinha subido).
 *
 * FIX: WebChannelAdapter agora acumula anexos por chatId (send_document/send_audio chamam
 * bus.sendDocument('web', ...)/bus.sendVoice('web', ...) que resolvem no adapter web) e os
 * funde na NormalizedResponse final quando send() resolve o pending HTTP da requisição —
 * porque o canal web é request/response (não push como Telegram/Discord), então o anexo só
 * pode chegar junto da resposta de texto final, nunca antes.
 *
 * Este teste NÃO sobe um servidor HTTP real (sem AgentController/LLM) — testa diretamente
 * o WebChannelAdapter (acumulação + merge) e as funções puras de serialização de chat.ts
 * (base64 + inferência de mimetype), que são as duas peças novas desta correção.
 *
 * ATUALIZADO 10/07/2026: sendDocument() sem requisição pendente não lança mais (hotfix E
 * original) — em vez disso fica em espera (orphanedAttachments) e é entregue assim que a
 * MESMA sessão mandar a próxima mensagem, qualquer que seja o assunto. Ver
 * project_session_bugs_jul2026_aq/ar na memória do projeto e o comentário em
 * WebChannelAdapter.sendDocument(). sendVoice() mantém o contrato antigo (lança) —
 * escopo deliberadamente limitado a sendDocument, mesma decisão do fix anterior.
 *
 * Execução: npx ts-node src/__tests__/regression/S14_WebChannelAdapter_AttachmentDelivery.test.ts
 */

import { WebChannelAdapter } from '../../channels/WebChannelAdapter';
import { serializeAttachment, mimeTypeForFile } from '../../dashboard/routes/chat';
import { ResponseAttachment } from '../../channels/ChannelAdapter';

let passed = 0;
let failed = 0;

function check(desc: string, cond: boolean, detail?: string) {
    if (cond) { passed++; console.log(`  ✅ ${desc}`); }
    else { failed++; console.log(`  ❌ ${desc}${detail ? ` (${detail})` : ''}`); }
}

async function main() {
    console.log('=== S14 — sendDocument acumula e send() funde o anexo na resposta final ===');
    {
        const adapter = new WebChannelAdapter();
        const requestId = 'req-1';
        const chatId = 'conv_abc';

        const responsePromise = adapter.waitForResponse(requestId, chatId, 5000);

        // Simula o tool send_document sendo chamado no MEIO do turno (antes da resposta final)
        await adapter.sendDocument(chatId, Buffer.from('conteudo do arquivo'), 'aula.pptx', 'legenda');

        // Simula MessageBus enviando a resposta final de texto — deve resolver o promise
        // acima e trazer o anexo junto, mesmo sem o texto final saber que ele existe.
        await adapter.send({ text: 'Aula gerada!', format: 'markdown' }, requestId);

        const response = await responsePromise;
        check('response.text preservado', response.text === 'Aula gerada!');
        check('response.attachments tem 1 item', (response.attachments?.length ?? 0) === 1, `got ${response.attachments?.length}`);
        check('attachment.fileName correto', response.attachments?.[0].fileName === 'aula.pptx');
        check('attachment.data é o Buffer original', Buffer.isBuffer(response.attachments?.[0].data) && (response.attachments![0].data as Buffer).toString() === 'conteudo do arquivo');
        check('attachment.type = document', response.attachments?.[0].type === 'document');
    }

    console.log('\n=== S14 — sendVoice usa o mesmo mecanismo de acumulação (send_audio.ts) ===');
    {
        const adapter = new WebChannelAdapter();
        const responsePromise = adapter.waitForResponse('req-2', 'conv_voice', 5000);
        await adapter.sendVoice('conv_voice', Buffer.from('audio-bytes'), 'voice.ogg');
        await adapter.send({ text: 'Aqui está o áudio', format: 'plain' }, 'req-2');
        const response = await responsePromise;
        check('anexo de voz chega junto da resposta final', response.attachments?.[0]?.fileName === 'voice.ogg');
        check('anexo de voz tem type=audio', response.attachments?.[0]?.type === 'audio');
    }

    console.log('\n=== S14 — anexo NÃO vaza entre sessões concorrentes (chatId diferente) ===');
    {
        const adapter = new WebChannelAdapter();
        const pA = adapter.waitForResponse('req-A', 'conv_A', 5000);
        const pB = adapter.waitForResponse('req-B', 'conv_B', 5000);

        await adapter.sendDocument('conv_A', Buffer.from('so de A'), 'relatorioA.txt');

        await adapter.send({ text: 'resposta A', format: 'plain' }, 'req-A');
        await adapter.send({ text: 'resposta B', format: 'plain' }, 'req-B');

        const [respA, respB] = await Promise.all([pA, pB]);
        check('conv_A recebeu o anexo', respA.attachments?.length === 1);
        check('conv_B NÃO recebeu o anexo de conv_A', (respB.attachments?.length ?? 0) === 0, `got ${respB.attachments?.length}`);
    }

    // ATUALIZADO 11/07/2026: sendVoice sem pending deixou de lançar (hotfix E original) —
    // generalização do mesmo mecanismo já aplicado a sendDocument (ver WebChannelAdapter.ts,
    // nota de classe "Entrega órfã"). Lançar evitava falso-sucesso mas descartava um áudio já
    // pronto pra sempre; agora fica em espera e é entregue na próxima mensagem da sessão.
    console.log('\n=== S14 — sendVoice sem requisição pendente NÃO lança mais: entrega na próxima mensagem (generalização, mesma política de sendDocument) ===');
    {
        const adapter = new WebChannelAdapter();
        let threw = false;
        try {
            await adapter.sendVoice('conv_voice_orfao', Buffer.from('audio-tardio'), 'tardio.ogg');
        } catch {
            threw = true;
        }
        check('sendVoice NÃO lança quando não há pending (fica em espera)', !threw);

        const responsePromise = adapter.waitForResponse('req-voice-depois', 'conv_voice_orfao', 5000);
        await adapter.send({ text: 'oi', format: 'plain' }, 'req-voice-depois');
        const response = await responsePromise;
        check('áudio órfão chega na próxima resposta da sessão', response.attachments?.[0]?.fileName === 'tardio.ogg', JSON.stringify(response.attachments));
        check('áudio órfão tem type=audio', response.attachments?.[0]?.type === 'audio');
    }

    // Contrato de sendDocument atualizado em 10/07/2026: em vez de lançar (o que perdia o
    // anexo pra sempre — reproduzido ao vivo com um goal de 21min que gerou o .pptx com
    // sucesso mas nunca conseguiu entregá-lo, porque o dashboard não tem polling como o
    // suplemento PowerPoint), agora fica em espera e é mesclado na PRÓXIMA resposta dessa
    // mesma sessão — mesmo que seja sobre outro assunto.
    console.log('\n=== S14 — sendDocument sem requisição pendente NÃO descarta: entrega na próxima mensagem da sessão ===');
    {
        const adapter = new WebChannelAdapter();

        // Sem nenhum waitForResponse ativo pra esse chatId — simula o goal terminando depois
        // que a requisição HTTP original já expirou/fechou.
        let threw = false;
        try {
            await adapter.sendDocument('conv_orfao', Buffer.from('conteudo atrasado'), 'atrasado.pptx');
        } catch {
            threw = true;
        }
        check('sendDocument p/ chatId sem pending NÃO lança (fica em espera)', !threw);

        // Próxima mensagem da MESMA sessão — mesmo sem relação nenhuma com o pedido original —
        // deve vir com o anexo grudado.
        const responsePromise = adapter.waitForResponse('req-depois', 'conv_orfao', 5000);
        await adapter.send({ text: 'resposta de um assunto totalmente diferente', format: 'plain' }, 'req-depois');
        const response = await responsePromise;
        check('anexo órfão chega na próxima resposta da sessão', response.attachments?.[0]?.fileName === 'atrasado.pptx');

        // Uma segunda mensagem subsequente não deve repetir o anexo já entregue.
        const responsePromise2 = adapter.waitForResponse('req-depois-2', 'conv_orfao', 5000);
        await adapter.send({ text: 'mais uma mensagem', format: 'plain' }, 'req-depois-2');
        const response2 = await responsePromise2;
        check('anexo órfão não repete numa segunda mensagem seguinte', (response2.attachments?.length ?? 0) === 0, `got ${response2.attachments?.length}`);
    }

    console.log('\n=== S14 — sessão diferente NÃO recebe o anexo órfão de outra sessão ===');
    {
        const adapter = new WebChannelAdapter();
        await adapter.sendDocument('conv_orfao_2', Buffer.from('x'), 'so_da_2.pptx');

        const responsePromise = adapter.waitForResponse('req-outra-sessao', 'conv_outra_sessao', 5000);
        await adapter.send({ text: 'oi', format: 'plain' }, 'req-outra-sessao');
        const response = await responsePromise;
        check('sessão sem relação nenhuma não recebe anexo órfão de outra', (response.attachments?.length ?? 0) === 0, `got ${response.attachments?.length}`);
    }

    console.log('\n=== S14 — resposta sem anexo continua funcionando normalmente (sem regressão) ===');
    {
        const adapter = new WebChannelAdapter();
        const responsePromise = adapter.waitForResponse('req-3', 'conv_sem_anexo', 5000);
        await adapter.send({ text: 'só texto, sem arquivo', format: 'markdown' }, 'req-3');
        const response = await responsePromise;
        check('response.attachments continua undefined quando nada foi acumulado', response.attachments === undefined, `got ${JSON.stringify(response.attachments)}`);
    }

    // ── NOVO 11/07/2026: entrega órfã de TEXTO (não só anexo) ──────────────────────────────
    // Causa raiz auditada: waitForResponse() tem um teto de 10min (AGENT_RESPONSE_TIMEOUT_MS,
    // chat.ts); um Goal pode legitimamente demorar mais que isso (fire-and-forget — não é
    // cancelado quando o HTTP desiste). Antes deste fix, send() sem pending SEMPRE descartava
    // o texto final ("send_no_pending"), mesmo quando sendDocument já tinha fallback. Agora
    // send() também vira entrega órfã quando o requestId corresponde a um waitForResponse que
    // já estourou o timeout (rastreado em timedOutRequests).
    console.log('\n=== S14 — resposta de TEXTO cujo waitForResponse já estourou o timeout: fica em espera, não é descartada ===');
    {
        const adapter = new WebChannelAdapter();
        const chatId = 'conv_timeout_texto';
        let timedOut = false;
        const responsePromise = adapter.waitForResponse('req-timeout-1', chatId, 20);
        responsePromise.catch(() => { timedOut = true; });
        await new Promise(r => setTimeout(r, 60));
        check('waitForResponse original realmente estourou o timeout', timedOut);

        // Goal "termina" bem depois do timeout HTTP e chama send() pro MESMO requestId —
        // não deve lançar nem travar.
        await adapter.send({ text: 'Resumo final do goal que demorou demais', format: 'markdown' }, 'req-timeout-1');

        const nextResponsePromise = adapter.waitForResponse('req-timeout-2', chatId, 5000);
        await adapter.send({ text: 'próxima mensagem qualquer', format: 'plain' }, 'req-timeout-2');
        const nextResponse = await nextResponsePromise;
        check('texto órfão chega mesclado na próxima resposta da sessão', nextResponse.text.includes('Resumo final do goal que demorou demais'), nextResponse.text);
        check('texto da nova mensagem também está presente', nextResponse.text.includes('próxima mensagem qualquer'), nextResponse.text);
    }

    console.log('\n=== S14 — resposta órfã combinando TEXTO + ANEXO do mesmo turno morto ===');
    {
        const adapter = new WebChannelAdapter();
        const chatId = 'conv_timeout_doc';
        const responsePromise = adapter.waitForResponse('req-td-1', chatId, 20);
        responsePromise.catch(() => {});
        await new Promise(r => setTimeout(r, 60));

        // sendDocument chamado DEPOIS do timeout (tool call no meio do turno que já morreu)...
        await adapter.sendDocument(chatId, Buffer.from('conteudo'), 'atrasado2.pptx');
        // ...e só depois o texto final do mesmo turno.
        await adapter.send({ text: 'Documento pronto', format: 'markdown' }, 'req-td-1');

        const nextResponsePromise = adapter.waitForResponse('req-td-2', chatId, 5000);
        await adapter.send({ text: 'oi de novo', format: 'plain' }, 'req-td-2');
        const nextResponse = await nextResponsePromise;
        check(
            'texto órfão + anexo órfão chegam JUNTOS na próxima mensagem',
            (nextResponse.text?.includes('Documento pronto') ?? false) && nextResponse.attachments?.length === 1,
            JSON.stringify(nextResponse)
        );
    }

    console.log('\n=== S14 — múltiplas sessões simultâneas em timeout não vazam entre si ===');
    {
        const adapter = new WebChannelAdapter();
        const pA = adapter.waitForResponse('req-ms-a1', 'conv_ms_A', 20);
        const pB = adapter.waitForResponse('req-ms-b1', 'conv_ms_B', 20);
        pA.catch(() => {});
        pB.catch(() => {});
        await new Promise(r => setTimeout(r, 60));

        await adapter.send({ text: 'resultado tardio de A', format: 'plain' }, 'req-ms-a1');
        await adapter.send({ text: 'resultado tardio de B', format: 'plain' }, 'req-ms-b1');

        const nextA = adapter.waitForResponse('req-ms-a2', 'conv_ms_A', 5000);
        await adapter.send({ text: 'nova mensagem A', format: 'plain' }, 'req-ms-a2');
        const respA = await nextA;
        check('sessão A recebe só o próprio texto órfão', respA.text.includes('resultado tardio de A') && !respA.text.includes('resultado tardio de B'), respA.text);

        const nextB = adapter.waitForResponse('req-ms-b2', 'conv_ms_B', 5000);
        await adapter.send({ text: 'nova mensagem B', format: 'plain' }, 'req-ms-b2');
        const respB = await nextB;
        check('sessão B recebe só o próprio texto órfão', respB.text.includes('resultado tardio de B') && !respB.text.includes('resultado tardio de A'), respB.text);
    }

    console.log('\n=== S14 — ausência de duplicação: só a 1ª mensagem seguinte recebe a entrega órfã ===');
    {
        const adapter = new WebChannelAdapter();
        const chatId = 'conv_no_dup';
        const p1 = adapter.waitForResponse('req-nd-1', chatId, 20);
        p1.catch(() => {});
        await new Promise(r => setTimeout(r, 60));
        await adapter.send({ text: 'entrega tardia única', format: 'plain' }, 'req-nd-1');

        const p2 = adapter.waitForResponse('req-nd-2', chatId, 5000);
        await adapter.send({ text: 'segue o jogo', format: 'plain' }, 'req-nd-2');
        const r2 = await p2;
        check('1ª mensagem seguinte recebe a entrega órfã', r2.text.includes('entrega tardia única'));

        const p3 = adapter.waitForResponse('req-nd-3', chatId, 5000);
        await adapter.send({ text: 'mais uma', format: 'plain' }, 'req-nd-3');
        const r3 = await p3;
        check('2ª mensagem seguinte NÃO repete a entrega já feita', !r3.text.includes('entrega tardia única'), r3.text);
    }

    // Limitação conhecida e documentada (não corrigida nesta rodada — ver relatório): a fila
    // de entregas órfãs vive só em memória, não é persistida. Este teste prova o comportamento
    // atual (não sobrevive a um "restart", simulado aqui como uma nova instância do adapter)
    // para que a limitação fique explícita e testada, não apenas presumida.
    console.log('\n=== S14 — "reinício do processo": nova instância não herda entregas órfãs da anterior (limitação conhecida, fila em memória) ===');
    {
        const adapterBefore = new WebChannelAdapter();
        const chatId = 'conv_restart';
        const p1 = adapterBefore.waitForResponse('req-restart-1', chatId, 20);
        p1.catch(() => {});
        await new Promise(r => setTimeout(r, 60));
        await adapterBefore.send({ text: 'entrega que ficaria pendente antes de um restart', format: 'plain' }, 'req-restart-1');

        // Simula reinício do processo: nova instância, estado em memória não sobrevive.
        const adapterAfter = new WebChannelAdapter();
        const p2 = adapterAfter.waitForResponse('req-restart-2', chatId, 5000);
        await adapterAfter.send({ text: 'primeira mensagem pós-restart', format: 'plain' }, 'req-restart-2');
        const r2 = await p2;
        check(
            'entrega órfã NÃO sobrevive a um restart (limitação documentada — fila em memória, sem persistência)',
            !r2.text.includes('entrega que ficaria pendente'),
            r2.text
        );
    }

    console.log('\n=== S14 — serializeAttachment/mimeTypeForFile (chat.ts) ===');
    {
        const buf = Buffer.from('binary-content-aqui');
        const att: ResponseAttachment = { type: 'document', data: buf, fileName: 'aula_marp.pptx' };
        const serialized = serializeAttachment(att);
        check('data serializado é base64 válido e reversível', Buffer.from(serialized.data, 'base64').equals(buf));
        check('mimeType inferido corretamente p/ .pptx', serialized.mimeType === 'application/vnd.openxmlformats-officedocument.presentationml.presentation', serialized.mimeType);
        check('fileName preservado', serialized.fileName === 'aula_marp.pptx');

        check('mimeTypeForFile .md', mimeTypeForFile('notas.md') === 'text/markdown');
        check('mimeTypeForFile .pdf', mimeTypeForFile('relatorio.PDF') === 'application/pdf'); // case-insensitive
        check('mimeTypeForFile extensão desconhecida cai em octet-stream', mimeTypeForFile('arquivo.xyz123') === 'application/octet-stream');

        // ResponseAttachment.mimeType explícito tem prioridade sobre a inferência por extensão
        const attWithMime: ResponseAttachment = { type: 'document', data: buf, fileName: 'sem_extensao', mimeType: 'application/custom' };
        check('mimeType explícito tem prioridade sobre inferência', serializeAttachment(attWithMime).mimeType === 'application/custom');
    }

    console.log('\n' + '─'.repeat(60));
    console.log(`S14 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    process.exit(failed > 0 ? 1 : 0);
}

main();
