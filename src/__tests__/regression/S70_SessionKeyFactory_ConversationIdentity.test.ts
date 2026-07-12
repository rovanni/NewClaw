/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S70
 * Microauditoria holística e adversarial da continuidade conversacional (2026-07-08), pedida
 * pelo usuário depois dos fixes S68/S69 (sessionKey.channel hardcoded + recentCompletedGoals
 * preservando goal já entregue). A auditoria rastreou ponta a ponta adapter → MessageBus →
 * SessionManager → AgentLoop → GoalOrchestrator → GoalExecutionLoop → disco, e provou
 * DUPLICAÇÃO REAL de lógica de identidade de sessão (não hipotética):
 *
 * 1. `${channel}:${userId}` era composto de forma independente em pelo menos 4 arquivos
 *    (SessionManager, GoalOrchestrator, SessionLearner, MessageBus).
 * 2. Decomposto via `str.split(':')` com destructuring em 4 call sites
 *    (GoalOrchestrator.ts, GoalExecutionLoop.ts×3) — que TRUNCA silenciosamente qualquer
 *    userId contendo ':' (só os 2 primeiros elementos do array eram usados).
 *    SessionAutoCleaner.ts já tinha uma versão diferente e correta (`slice(1).join(':')`),
 *    provando que as duas implementações divergiam sem detecção.
 * 3. BUG CONFIRMADO EM PRODUÇÃO (não teórico): `dir /r` em data/sessions na instalação
 *    Windows real do usuário mostrou que TODO arquivo de sessão (`telegram:8071707790.jsonl`,
 *    `web:powerpoint-addin-....jsonl`, etc.) nunca existiu como arquivo de verdade — o ':' no
 *    nome é o separador de Alternate Data Stream do NTFS, então o conteúdo real foi parar numa
 *    ADS pendurada num arquivo-base vazio chamado só "telegram"/"web". `fs.readdirSync` (usado
 *    por SessionAutoCleaner.compactLargeSessions) NUNCA viu essas entradas — resultado: a
 *    compactação automática de sessão nunca rodou em NENHUMA instalação Windows deste projeto.
 * 4. Scheduler (AgentController.ts): `agentLoop.process(chatId, prompt)` era chamado SEM
 *    ChannelContext — mesmo scheduled_tasks suportando channel=discord/signal/whatsapp/web
 *    (SchedulerService.ts), o turno processava sob sessionKey `telegram:<chatId>` sempre
 *    (fallback do fix anterior), enquanto a entrega final (`messageBus.sendToChat`) já usava o
 *    channel real — a mesma classe de assimetria leitura/escrita do S68, num call site diferente.
 * 5. MessageBus: o branch de erro/timeout do catch enviava a mensagem de falha pro usuário mas
 *    nunca a persistia na transcript — o próximo turno via a pergunta original sem NENHUMA
 *    resposta do assistente depois dela, perdendo o antecedente de que o turno anterior falhou.
 *
 * Fix: módulo canônico único `session/SessionKeyFactory.ts` (compose/parse/toFileSafeId/
 * fromFileSafeId) substituindo toda construção/decomposição manual; SessionTranscript grava
 * sob nome de arquivo seguro com migração automática do path legado; scheduler propaga o
 * channel real; MessageBus persiste a resposta de erro.
 *
 * Execução: npx ts-node src/__tests__/regression/S70_SessionKeyFactory_ConversationIdentity.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { composeSessionKey, parseSessionKey, toFileSafeId, fromFileSafeId } from '../../session/SessionKeyFactory';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`); failed++; }
}

function readSrc(relPath: string): string {
    return fs.readFileSync(path.join(process.cwd(), 'src', relPath), 'utf-8');
}

async function main(): Promise<void> {

console.log('\n=== S70-1 — SessionKeyFactory: compose/parse fazem round-trip exato, mesmo com \':\' no userId ===');
{
    const key = { channel: 'web', userId: 'powerpoint-addin-09e597ca-11a2-4287-876e-67c62479b275' };
    const composite = composeSessionKey(key);
    assert(composite === 'web:powerpoint-addin-09e597ca-11a2-4287-876e-67c62479b275', 'compose produz o formato channel:userId');
    assert(JSON.stringify(parseSessionKey(composite)) === JSON.stringify(key), 'parse(compose(key)) === key para userId normal');

    // O caso que o destructuring antigo (`const [ch, uid] = s.split(':')`) quebrava:
    const trickyKey = { channel: 'web', userId: 'a:b:c' };
    const trickyComposite = composeSessionKey(trickyKey);
    assert(trickyComposite === 'web:a:b:c', 'compose não escapa \':\' no userId (comportamento existente preservado)');
    const parsedBack = parseSessionKey(trickyComposite);
    assert(
        parsedBack.channel === 'web' && parsedBack.userId === 'a:b:c',
        `parse usa o PRIMEIRO ':' como delimitador — userId "a:b:c" não é truncado (encontrado: channel="${parsedBack.channel}" userId="${parsedBack.userId}")`,
    );
}

console.log('\n=== S70-2 — SessionKeyFactory: toFileSafeId/fromFileSafeId round-trip (fix do bug de ADS no Windows) ===');
{
    const composite = 'web:powerpoint-addin-09e597ca-11a2-4287-876e-67c62479b275';
    const safe = toFileSafeId(composite);
    assert(!safe.includes(':'), 'id seguro para arquivo não contém \':\' (o separador de ADS no NTFS)');
    assert(safe === composite.replace(/:/g, '~'), 'toFileSafeId troca \':\' por \'~\'');
    assert(fromFileSafeId(safe) === composite, 'fromFileSafeId reverte exatamente para o composite original');
}

console.log('\n=== S70-3 — SessionTranscript grava sob nome de arquivo seguro e migra path legado ===');
{
    const src = readSrc('session/SessionTranscript.ts');
    assert(/toFileSafeId\(sessionId\)/.test(src), 'constructor deriva o path do arquivo via toFileSafeId(sessionId), não do sessionId bruto');
    assert(/migrateLegacyColonPath/.test(src), 'init() chama uma migração do path legado (com \':\') pro path seguro');

    // Verificado rodando de verdade contra uma cópia dos dados reais do usuário: fs.renameSync
    // E fs.copyFileSync FALHAM com EINVAL ao mover/copiar de uma NTFS ADS pra um arquivo normal
    // no Windows — a única combinação que funciona é readFileSync+writeFileSync+unlinkSync.
    // A primeira versão deste fix usava renameSync, engolia o EINVAL como "non-fatal" e seguia
    // com um arquivo novo VAZIO — teria zerado o histórico de todo mundo no primeiro deploy.
    const migrateFnSrc = src.slice(src.indexOf('private migrateLegacyColonPath'));
    assert(!/fs\.renameSync/.test(migrateFnSrc), 'migração não usa mais fs.renameSync (falha com EINVAL nesse cenário no Windows)');
    assert(!/fs\.copyFileSync/.test(migrateFnSrc), 'migração não usa fs.copyFileSync (falha com o mesmo EINVAL)');
    assert(
        /fs\.readFileSync\(legacyFilePath\)/.test(migrateFnSrc) && /fs\.writeFileSync\(this\.filePath/.test(migrateFnSrc) && /fs\.unlinkSync\(legacyFilePath\)/.test(migrateFnSrc),
        'migração usa readFileSync + writeFileSync + unlinkSync (única combinação confirmada funcionando)',
    );
    // A ÚNICA referência restante ao path bruto (`${this.sessionId}.jsonl`) deve estar dentro de
    // migrateLegacyColonPath (onde ela é intencional: é o path ANTIGO que o migrador procura pra
    // mover pro path novo) — não no constructor, que já foi corrigido para usar toFileSafeId.
    const constructorSrc = src.slice(src.indexOf('constructor('), src.indexOf('migrateLegacyColonPath', src.indexOf('constructor(')));
    assert(
        !/`\$\{sessionId\}\.jsonl`/.test(constructorSrc),
        'o constructor (antes da migração) não constrói mais nenhum path usando o sessionId bruto direto',
    );
}

console.log('\n=== S70-4 — Nenhum call site de decomposição de sessionKey usa mais o destructuring frágil de split(\':\') ===');
{
    const filesToCheck = [
        'loop/GoalOrchestrator.ts',
        'loop/GoalExecutionLoop.ts',
    ];
    for (const f of filesToCheck) {
        const src = readSrc(f);
        assert(
            !/\.sessionKey\.split\(':'\)/.test(src),
            `${f} não contém mais ".sessionKey.split(':')" (substituído por parseSessionKey)`,
        );
        assert(
            /parseSessionKey/.test(src),
            `${f} importa/usa parseSessionKey do SessionKeyFactory`,
        );
    }
}

console.log('\n=== S70-5 — SessionAutoCleaner enxerga arquivos file-safe e os reconverte corretamente ===');
{
    const src = readSrc('session/SessionAutoCleaner.ts');
    assert(/fromFileSafeId/.test(src), 'SessionAutoCleaner usa fromFileSafeId ao interpretar nomes de arquivo do disco');
    assert(/parseSessionKey/.test(src), 'SessionAutoCleaner usa parseSessionKey (não split(\':\') manual) pra extrair {channel, userId}');
}

console.log('\n=== S70-6 — Scheduler (AgentController) propaga o channel real da tarefa agendada pro AgentLoop ===');
{
    const src = readSrc('core/AgentController.ts');
    const match = src.match(/const result = await this\.agentLoop\.process\(([^)]*)\);/);
    assert(match !== null, 'chamada a agentLoop.process() no handler de SCHEDULER_TRIGGER encontrada');
    if (match) {
        assert(
            /schedulerContext/.test(match[1]) || /channel/.test(match[1]),
            `chamada agora passa um ChannelContext com o channel real da tarefa (encontrado: "agentLoop.process(${match[1]})")`,
        );
    }
    assert(
        /schedulerContext: ChannelContext = \{ channel,/.test(src),
        'ChannelContext construído a partir da variável `channel` desestruturada do payload do evento (não mais fixo)',
    );
}

console.log('\n=== S70-7 — MessageBus persiste a mensagem de erro/timeout no branch catch (antes não persistia) ===');
{
    const src = readSrc('channels/MessageBus.ts');
    const catchIdx = src.indexOf('} catch (error) {');
    const finallyIdx = src.indexOf('} finally {');
    assert(catchIdx > -1 && finallyIdx > catchIdx, 'bloco catch/finally do processMessageCore encontrado');
    const catchBlock = src.slice(catchIdx, finallyIdx);
    assert(
        /recordAssistantMessage\(sessionKey, userMessage/.test(catchBlock),
        'catch agora chama recordAssistantMessage(sessionKey, userMessage, ...) antes do finally',
    );
}

console.log('\n=== S70-8 — Confirmação curta ("sim") não aciona busca de memória de longo prazo (sem risco de contaminação) ===');
{
    // Reproduz isSocialOrGreeting: query curta (< MIN_QUERY_LENGTH) retorna true → buildContext
    // retorna '' antes de qualquer busca semântica. Confirmado pelo log real do incidente:
    // turno de "sim" logou memory=false (SessionContext: ... memory=false, checkpoint=false).
    const src = readSrc('loop/ContextBuilder.ts');
    assert(
        /if \(trimmed\.length < MIN_QUERY_LENGTH\) return true;/.test(src),
        'isSocialOrGreeting trata qualquer query curta (ex.: "sim", 3 chars) como social/greeting — short-circuit antes da busca de memória',
    );
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S70 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;

}

main().catch((err) => {
    console.error('S70 erro inesperado:', err);
    process.exitCode = 1;
});
