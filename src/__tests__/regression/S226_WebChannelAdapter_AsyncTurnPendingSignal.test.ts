/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S226
 *
 * Origem: teste real no Windows (12/08/2026, 18:07-18:11) — o backend computou a cotação do
 * River em 13s (`MessageBus processing_done responseLength=181`), mas o usuário nunca a viu. O
 * painel web usa um fluxo assíncrono (Outbox): `POST /api/chat` devolve `202 {turnId}` na hora, e
 * o front faz polling de `GET /api/chat/active?sessionId=` até não achar mais nada "ativo" —
 * então busca a resposta em `GET /api/chat/outbox?turnId=`.
 *
 * A causa: entre o 202 e o goal existir em algo rastreável (`AgentLoop.activeTurns` /
 * `GoalStore`), há uma janela real de alguns segundos — o tempo da classificação
 * (`GoalExtractor`/`UnifiedIntentRouter`) decidir se vira goal. Se o primeiro poll cair nessa
 * janela, `/active` (corretamente) não acha nada, o front conclui "terminou antes de começar",
 * esgota as poucas tentativas de Outbox (que ainda nem existe) e abandona o `turnId` de vez — a
 * resposta real, quando chega minutos depois, não tem mais ninguém esperando por ela.
 *
 * `WebChannelAdapter.registerAsyncTurn(turnId, chatId)` já registra o turno no instante em que o
 * POST é aceito, ANTES dessa janela existir — só que `/api/chat/active` nunca consultava esse
 * registro. Esta sprint expõe esse fato (`hasPendingAsyncTurn`) e conecta `/active` a ele — sem
 * criar nenhum mecanismo de estado novo, só lendo o que `asyncTurns` já sabe.
 *
 * S227 (próxima sprint, não implementada aqui) altera o `poll()` do frontend para respeitar este
 * sinal. Este teste cobre só o backend: o fato existe e está correto, estruturalmente, sem
 * depender de sleep/timeout.
 *
 * Execução: npx ts-node src/__tests__/regression/S226_WebChannelAdapter_AsyncTurnPendingSignal.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { WebChannelAdapter } from '../../channels/WebChannelAdapter';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

async function main(): Promise<void> {

console.log('\n=== S226-1 — janela exata: registrado → sem Goal/activeTurn → pending=true → resolvido → pending=false ===');
{
    const adapter = new WebChannelAdapter();
    const turnId = 'turn-s226-janela';
    const sessionId = 'session-s226-janela';

    // Ainda não existe nenhum turnId no mapa — nunca foi registrado.
    assert(adapter.hasPendingAsyncTurn(turnId) === false, 'antes de registrar, hasPendingAsyncTurn é false (não inventa um pendente)');

    // registerAsyncTurn() — o que POST /api/chat chama no instante do 202, antes de qualquer
    // classificação/GoalExtractor rodar. Nenhum Goal, nenhum activeTurn existe neste ponto —
    // e não precisa existir: hasPendingAsyncTurn não depende de nenhum dos dois.
    adapter.registerAsyncTurn(turnId, sessionId);
    assert(adapter.hasPendingAsyncTurn(turnId) === true, 'logo após registerAsyncTurn(), pending=true — cobre a janela antes do Goal/activeTurn existir', {
        // Prova negativa: nada além do registro em si foi consultado — não há goalStore, não há
        // agentLoop, não há nenhuma outra dependência neste teste.
        dependencies: 'nenhuma',
    });

    // Turno resolvido — o mesmo send() que POST /api/chat aguarda para popular a Outbox.
    await adapter.send({ text: 'Resposta real do goal', format: 'plain' }, turnId);
    assert(adapter.hasPendingAsyncTurn(turnId) === false, 'após send(), pending=false — o turno saiu do estado "em andamento"');

    // Não-regressão: a resposta continua acessível via Outbox (send() não foi alterado).
    const consumed = adapter.consumeOutbox(turnId);
    assert(consumed?.text === 'Resposta real do goal', 'a resposta ainda chega à Outbox normalmente — hasPendingAsyncTurn só LÊ o estado, não o consome');
}

console.log('\n=== S226-2 — não-regressão: turnId nunca registrado nunca aparece como pending ===');
{
    const adapter = new WebChannelAdapter();
    assert(adapter.hasPendingAsyncTurn('turn-nunca-existiu') === false, 'turnId desconhecido não é pending (evita falso-positivo)');
}

console.log('\n=== S226-3 — não-regressão: dois turnos da mesma sessão são isolados ===');
{
    const adapter = new WebChannelAdapter();
    const sessionId = 'session-s226-dois-turnos';
    adapter.registerAsyncTurn('turn-A', sessionId);
    adapter.registerAsyncTurn('turn-B', sessionId);

    assert(adapter.hasPendingAsyncTurn('turn-A') === true, 'turn-A está pending');
    assert(adapter.hasPendingAsyncTurn('turn-B') === true, 'turn-B está pending');

    await adapter.send({ text: 'A', format: 'plain' }, 'turn-A');

    assert(adapter.hasPendingAsyncTurn('turn-A') === false, 'resolver turn-A não afeta turn-B (isolamento por turnId, não por sessão)');
    assert(adapter.hasPendingAsyncTurn('turn-B') === true, 'turn-B continua pending — cada turnId é independente');
}

console.log('\n=== S226-4 — estrutural: GET /api/chat/active lê hasPendingAsyncTurn e devolve `pending` ===');
{
    const source = fs.readFileSync(path.join(__dirname, '../../dashboard/routes/chat.ts'), 'utf-8');
    const routeStart = source.indexOf("router.get('/active'");
    const routeEnd = source.indexOf("router.post('/auth-decision'", routeStart);
    assert(routeStart > 0 && routeEnd > routeStart, 'pré-condição: rota GET /active localizada');
    const route = source.slice(routeStart, routeEnd);

    assert(/req\.query\.turnId/.test(route), 'a rota lê turnId da query string');
    assert(/hasPendingAsyncTurn\(turnId\)/.test(route), 'a rota consulta hasPendingAsyncTurn — reusa o mecanismo existente, não cria estado paralelo');
    assert(/res\.json\(\{[^}]*pending/.test(route), 'a resposta JSON inclui o campo `pending`', route.slice(route.indexOf('res.json(')));

    // Não-regressão: nenhum mecanismo de estado NOVO foi introduzido (nada de Map/Set novo,
    // nenhum campo novo em WebChannelAdapter além do método de leitura).
    const adapterSource = fs.readFileSync(path.join(__dirname, '../../channels/WebChannelAdapter.ts'), 'utf-8');
    const asyncTurnsDeclarations = (adapterSource.match(/asyncTurns\s*[:=]/g) || []).length;
    assert(asyncTurnsDeclarations === 1, 'ainda existe UMA única declaração de asyncTurns — nenhum mapa paralelo foi criado', asyncTurnsDeclarations);
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S226 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;

}

main().catch((err) => {
    console.error('S226 erro inesperado:', err);
    process.exitCode = 1;
});
