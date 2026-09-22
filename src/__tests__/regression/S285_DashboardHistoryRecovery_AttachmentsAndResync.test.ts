/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S285 (issues 040/041, campanha "sistema não utilizável", 22/09/2026)
 *
 * Achado ao vivo, testando o dashboard real pelo navegador visível (handoff), a pedido do
 * usuário depois de eu ter afirmado erroneamente que um teste anterior tinha "dado certo": um
 * PPTX gerado por um goal apareceu como texto de sucesso mas SEM o anexo pra baixar, e uma
 * resposta de goal simples (posição no River) nunca apareceu na tela mesmo depois de recarregar
 * a página — apesar de as duas respostas estarem corretas e completas no banco de dados
 * (`sqlite3 newclaw.db`, tabela `messages`, confirmado por consulta direta).
 *
 * Duas causas raiz distintas, ambas na camada de persistência/sincronização do Web Dashboard —
 * nenhuma no pipeline de goal/agente, que produziu as respostas corretamente nos dois casos:
 *
 * BUG 1 — anexos nunca eram persistidos. A tabela `messages` só tinha `role`/`content`/
 * `created_at`; um anexo entregue via `send_document`/`send_audio` só existia no objeto
 * `NormalizedResponse` em memória, dentro do Outbox do `WebChannelAdapter` — consumido uma vez e
 * descartado. Reabrir a conversa (reload, outro navegador, outro dispositivo) sempre recarregava
 * só texto, mesmo com o arquivo intacto em disco.
 *
 * BUG 2 — `syncFromServer()` só buscava mensagens do servidor para conversas AINDA NÃO
 * conhecidas localmente (`if (!local)`). Isso cobre a re-hidratação de uma conversa nova (ex:
 * outro dispositivo), mas não o caso, muito mais comum dado que respostas levam de 16 a mais de
 * 500 segundos nesta investigação, de uma conversa JÁ aberta cuja resposta nunca chegou via
 * `fetchAndRenderOutbox()` (outbox consumido antes do reload, turnId perdido em memória,
 * conexão instável) — a mensagem ficava completa e correta no banco, e permanentemente invisível
 * na tela, sem nenhum caminho de recuperação.
 *
 * S285.1-.3 — Bug 1: cadeia real de persistência (conversationRepository.addMessage →
 *   DashboardMemoryRepository.getMessagesByConversation), banco SQLite real (:memory:), sem
 *   mock de serialização — mesma função `serializeAttachment` que o Outbox já usa.
 * S285.4-.7 — Bug 2: extrai o corpo REAL de `syncFromServer()` de dentro de index.html (mesma
 *   técnica de S227) e testa com fakes só nas bordas (fetch, save, renderSidebar).
 *
 * Execução: npx ts-node src/__tests__/regression/S285_DashboardHistoryRecovery_AttachmentsAndResync.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../memory/memorySchema';
import { addMessage } from '../../memory/conversationRepository';
import { DashboardMemoryRepository } from '../../dashboard/DashboardMemoryRepository';
import type { ResponseAttachment } from '../../channels/ChannelAdapter';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  OK ${message}`); passed++; }
    else { console.error(`  FALHOU: ${message}`, detail ?? ''); failed++; }
}

async function main(): Promise<void> {

console.log('\n=== S285.1 — BUG 1: addMessage() sem anexos grava NULL, não "[]" nem "undefined" ===');
{
    const db = new (Database as any)(':memory:');
    initializeSchema(db);
    db.prepare("INSERT INTO conversations (id, user_id, provider) VALUES ('web:conv_1', 'conv_1', 'web')").run();
    addMessage(db, 'web:conv_1', 'assistant', 'sem anexo');
    const row = db.prepare("SELECT attachments FROM messages WHERE conversation_id='web:conv_1'").get() as { attachments: string | null };
    assert(row.attachments === null, `attachments é NULL quando nenhum anexo é passado — obtido: ${JSON.stringify(row.attachments)}`, row);
}

console.log('\n=== S285.2 — BUG 1: addMessage() com anexo real persiste e getMessagesByConversation() devolve o mesmo anexo ===');
{
    const db = new (Database as any)(':memory:');
    initializeSchema(db);
    db.prepare("INSERT INTO conversations (id, user_id, provider) VALUES ('web:conv_2', 'conv_2', 'web')").run();
    const attachment: ResponseAttachment = {
        type: 'document',
        data: Buffer.from('conteudo real do pptx'),
        fileName: 'redes_computadores.pptx',
        mimeType: undefined,
    };
    addMessage(db, 'web:conv_2', 'assistant', 'Pronto, arquivo gerado.', [attachment]);

    const repo = new DashboardMemoryRepository(db);
    const msgs = repo.getMessagesByConversation('web:conv_2', 10);
    assert(msgs.length === 1, `1 mensagem persistida — obtido: ${msgs.length}`, msgs);
    const persisted = msgs[0].attachments as Array<{ type: string; fileName: string; mimeType: string; data: string }> | undefined;
    assert(!!persisted && persisted.length === 1, 'attachments sobrevive à volta completa (write → read)', msgs[0]);
    if (persisted) {
        assert(persisted[0].fileName === 'redes_computadores.pptx', `fileName preservado — obtido: ${persisted[0].fileName}`, persisted[0]);
        assert(persisted[0].mimeType === 'application/vnd.openxmlformats-officedocument.presentationml.presentation', `mimeType inferido pela extensão (mesma autoridade do Outbox, serializeAttachment) — obtido: ${persisted[0].mimeType}`, persisted[0]);
        assert(
            Buffer.from(persisted[0].data, 'base64').toString('utf-8') === 'conteudo real do pptx',
            'data é base64 reversível pro conteúdo original (mesmo formato que downloadAttachment() no dashboard já consome)',
            persisted[0]
        );
    }
}

console.log('\n=== S285.3 — BUG 1: mensagem sem anexo entre mensagens com anexo não confunde a leitura (attachments undefined, não [])===');
{
    const db = new (Database as any)(':memory:');
    initializeSchema(db);
    db.prepare("INSERT INTO conversations (id, user_id, provider) VALUES ('web:conv_3', 'conv_3', 'web')").run();
    addMessage(db, 'web:conv_3', 'user', 'crie um arquivo');
    addMessage(db, 'web:conv_3', 'assistant', 'pronto', [{ type: 'document', data: Buffer.from('x'), fileName: 'a.txt' }]);
    addMessage(db, 'web:conv_3', 'user', 'obrigado');

    const repo = new DashboardMemoryRepository(db);
    const msgs = repo.getMessagesByConversation('web:conv_3', 10);
    assert(msgs.length === 3, `3 mensagens — obtido: ${msgs.length}`, msgs);
    assert(msgs[0].attachments === undefined, 'msg 1 (user, sem anexo) — attachments undefined', msgs[0]);
    assert(Array.isArray(msgs[1].attachments) && msgs[1].attachments.length === 1, 'msg 2 (assistant, com anexo) — attachments presente', msgs[1]);
    assert(msgs[2].attachments === undefined, 'msg 3 (user, sem anexo) — attachments undefined', msgs[2]);
}

// ── Bug 2: syncFromServer() ──────────────────────────────────────────────────────────────────

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...args: string[]) => (...args: unknown[]) => Promise<unknown>;

/** Extrai o corpo REAL de `syncFromServer()` de dentro de index.html — mesma técnica de S227. */
function extractSyncFromServerBody(): string {
    const html = fs.readFileSync(path.join(__dirname, '../../dashboard/public/index.html'), 'utf-8');
    const startMarker = 'async function syncFromServer() {';
    const startIdx = html.indexOf(startMarker);
    if (startIdx < 0) throw new Error('pré-condição falhou: "async function syncFromServer() {" não encontrado em index.html');
    const bodyStart = startIdx + startMarker.length;
    // A função termina no "}" que fecha o catch, seguido do "}" que fecha a função — localizado
    // pelo comentário da próxima seção, âncora estável e já usada como marcador de fim por
    // convenção (ver "// === Export/Import ===" logo depois desta função).
    const endMarker = '// === Export/Import ===';
    const endIdx = html.indexOf(endMarker, bodyStart);
    if (endIdx < 0) throw new Error('pré-condição falhou: marcador de fim de syncFromServer() não encontrado');
    let body = html.slice(bodyStart, endIdx);
    // Remove o "}" de fechamento da própria função (o body real termina antes dele).
    body = body.replace(/\}\s*$/, '');
    return body;
}

interface SyncHarness {
    call: () => Promise<void>;
    conversations: Array<{ id: string; serverId?: string; title: string; messages: unknown[]; createdAt: number; updatedAt: number }>;
    fetchedMessageUrls: string[];
    saveCalled: boolean;
    renderSidebarCalled: boolean;
}

function buildSyncHarness(
    apiConversationsResponse: { success: boolean; conversations: Array<{ id: string; sessionId?: string; user_id?: string; created_at: string; updated_at: string }> },
    initialLocalConversations: Array<{ id: string; serverId?: string; title: string; messages: unknown[]; createdAt: number; updatedAt: number }>,
    messagesForFetch: Record<string, { success: boolean; messages: Array<{ role: string; content: string; created_at: string; attachments?: unknown[] }> }>,
): SyncHarness {
    const body = extractSyncFromServerBody();
    const conversations = initialLocalConversations;
    const fetchedMessageUrls: string[] = [];
    const harness: SyncHarness = { call: async () => {}, conversations, fetchedMessageUrls, saveCalled: false, renderSidebarCalled: false };

    const newclawFetch = async (_url: string) => ({ json: async () => apiConversationsResponse });
    const fetchFake = async (url: string) => {
        fetchedMessageUrls.push(url);
        const match = url.match(/\/api\/conversations\/([^/]+)\/messages/);
        const id = match ? match[1] : '';
        const resp = messagesForFetch[id] ?? { success: true, messages: [] };
        return { json: async () => resp };
    };
    const mapServerMessage = (m: { role: string; content: string; created_at: string; attachments?: unknown[] }) => ({
        role: m.role, content: m.content, timestamp: new Date(m.created_at).getTime(), attachments: m.attachments,
    });
    const save = () => { harness.saveCalled = true; };
    const renderSidebar = () => { harness.renderSidebarCalled = true; };
    const consoleFake = { warn: () => {} };

    const fn = new AsyncFunction(
        'newclawFetch', 'fetch', 'conversations', 'mapServerMessage', 'save', 'renderSidebar', 'console',
        body,
    );
    harness.call = () => fn(newclawFetch, fetchFake, conversations, mapServerMessage, save, renderSidebar, consoleFake) as Promise<void>;
    return harness;
}

console.log('\n=== S285.4 — CONTROLE NEGATIVO: conversa desconhecida localmente continua sendo buscada e criada (comportamento pré-fix preservado) ===');
{
    const harness = buildSyncHarness(
        { success: true, conversations: [{ id: 'web:conv_nova', sessionId: 'conv_nova', created_at: '2026-09-22 10:00:00', updated_at: '2026-09-22 10:05:00' }] },
        [],
        { 'web:conv_nova': { success: true, messages: [{ role: 'user', content: 'oi', created_at: '2026-09-22 10:00:00' }, { role: 'assistant', content: 'olá', created_at: '2026-09-22 10:05:00' }] } },
    );
    await harness.call();
    assert(harness.conversations.length === 1, `conversa nova foi adicionada localmente — obtido: ${harness.conversations.length}`, harness.conversations);
    assert(harness.conversations[0].messages.length === 2, 'as 2 mensagens do servidor foram carregadas', harness.conversations[0]);
    assert(harness.fetchedMessageUrls.length === 1, 'exatamente 1 fetch de mensagens (a conversa nova)', harness.fetchedMessageUrls);
}

console.log('\n=== S285.5 — CASO POSITIVO (bug real): conversa já conhecida, servidor mais recente → mensagens são ressincronizadas ===');
{
    const localConv = { id: 'conv_1790112449071', serverId: 'web:conv_1790112449071', title: 'Como está minha posição no River hoje?', messages: [{ role: 'user', content: 'Como está minha posição no River hoje?', timestamp: 1000, attachments: undefined }], createdAt: 1000, updatedAt: 1000 };
    const harness = buildSyncHarness(
        { success: true, conversations: [{ id: 'web:conv_1790112449071', sessionId: 'conv_1790112449071', created_at: '2026-09-22 21:27:34', updated_at: '2026-09-22 21:29:36' }] },
        [localConv],
        {
            'web:conv_1790112449071': {
                success: true,
                messages: [
                    { role: 'user', content: 'Como está minha posição no River hoje?', created_at: '2026-09-22 21:27:34' },
                    { role: 'assistant', content: '**River hoje:** Preço atual: US$ 1,28...', created_at: '2026-09-22 21:29:36' },
                ],
            },
        },
    );
    await harness.call();
    assert(
        harness.fetchedMessageUrls.some(u => u.includes('web:conv_1790112449071')),
        `syncFromServer() buscou as mensagens da conversa JÁ conhecida (ANTES do fix: nunca buscava, resposta ficava presa no banco) — obtido: ${JSON.stringify(harness.fetchedMessageUrls)}`,
        harness.fetchedMessageUrls
    );
    assert(harness.conversations[0].messages.length === 2, `a resposta do assistente (que nunca chegou à tela no bug real) agora aparece — obtido: ${harness.conversations[0].messages.length} mensagens`, harness.conversations[0]);
    assert(harness.conversations[0].updatedAt === new Date('2026-09-22 21:29:36').getTime(), 'updatedAt local avança para o valor do servidor', harness.conversations[0]);
}

console.log('\n=== S285.6 — conversa já conhecida, servidor SEM novidade (mesmo updatedAt) → NÃO refaz fetch (evita round-trip desnecessário a cada sync) ===');
{
    const ts = new Date('2026-09-22 15:45:00').getTime();
    const localConv = { id: 'conv_1790090298529', serverId: 'web:conv_1790090298529', title: 'PPTX', messages: [{ role: 'assistant', content: 'já sincronizado' }], createdAt: ts, updatedAt: ts };
    const harness = buildSyncHarness(
        { success: true, conversations: [{ id: 'web:conv_1790090298529', sessionId: 'conv_1790090298529', created_at: '2026-09-22 15:36:00', updated_at: '2026-09-22 15:45:00' }] },
        [localConv],
        {},
    );
    await harness.call();
    assert(harness.fetchedMessageUrls.length === 0, `nenhum fetch de mensagens quando o servidor não tem novidade — obtido: ${harness.fetchedMessageUrls.length}`, harness.fetchedMessageUrls);
}

console.log('\n=== S285.7 — anexo entregue via goal sobrevive à ressincronização (o próprio caso real: PPTX "sumido") ===');
{
    const ts = new Date('2026-09-22 15:36:00').getTime();
    const localConv = { id: 'conv_1790090298529', serverId: 'web:conv_1790090298529', title: 'PPTX', messages: [{ role: 'user', content: 'gere o pptx' }], createdAt: ts, updatedAt: ts };
    const harness = buildSyncHarness(
        { success: true, conversations: [{ id: 'web:conv_1790090298529', sessionId: 'conv_1790090298529', created_at: '2026-09-22 15:36:00', updated_at: '2026-09-22 15:45:51' }] },
        [localConv],
        {
            'web:conv_1790090298529': {
                success: true,
                messages: [
                    { role: 'user', content: 'gere o pptx', created_at: '2026-09-22 15:36:00' },
                    {
                        role: 'assistant', content: 'Objetivo concluído.', created_at: '2026-09-22 15:45:51',
                        attachments: [{ type: 'document', fileName: 'redes_computadores.pptx', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', data: 'YmFzZTY0' }],
                    },
                ],
            },
        },
    );
    await harness.call();
    const botMsg = harness.conversations[0].messages[1] as { attachments?: Array<{ fileName: string }> };
    assert(!!botMsg.attachments && botMsg.attachments.length === 1, 'a mensagem ressincronizada carrega o anexo (ANTES da issue 040 nunca existia no banco; ANTES da 041 nunca era buscado de novo)', botMsg);
    assert(botMsg.attachments?.[0]?.fileName === 'redes_computadores.pptx', 'fileName do anexo preservado na volta completa', botMsg.attachments);
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S285 RESULTADO: ${passed} passou | ${failed} falhou`);
process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => { console.error('ERRO NÃO TRATADO:', err); process.exit(1); });
