/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S174
 * (a) O trabalho em andamento é visível para a interface, mesmo depois de recarregar a página.
 * (b) Um provider que não responde não consome o timeout inteiro antes do fallback.
 *
 * CONTEXTO (relato + log de auditoria, 02/08/2026): o usuário perguntou algo às 11:32, repetiu às
 * 12:03, e às 12:19 o sistema ainda trabalhava — "não mostra o status no navegador e nem a opção
 * de parar". Duas causas independentes, ambas confirmadas no log:
 *
 * 1. O estado "processando" existia SÓ na aba que enviou a mensagem. Recarregar, trocar de tela
 *    ou reiniciar o servidor apagava o indicador e o botão de parar, enquanto o trabalho seguia.
 *    Pior: a pergunta foi roteada para o GoalOrchestrator (`route=goal_orchestrator`,
 *    durationMs=189178), e nesse caminho `AgentLoop.activeTurns` fica vazio — olhar só os turnos
 *    não bastaria.
 *
 * 2. O provider preferido estava cadastrado e fora do ar. Cada tentativa esperava o timeout
 *    completo da requisição (`timeout=352260ms` no log, quase 6 minutos) antes de cair para o
 *    próximo provider — e com o retry, o dobro. Quem usa não distingue isso de travamento.
 *
 * REGRESSÃO SE: goals em execução deixarem de aparecer na consulta de trabalho ativo; ou um
 * endpoint que aceita conexão e não responde voltar a consumir o timeout inteiro.
 *
 * Execução: npx ts-node src/__tests__/regression/S174_VisibilityAndDeadProviderTimeout.test.ts
 */

import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import { OpenAIProvider } from '../../core/OpenAIProvider';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

async function main() {
    console.log('\n=== S174 — endpoint travado falha rápido, sem gastar o timeout da requisição ===');
    {
        // Servidor que ACEITA a conexão e nunca responde: é assim que um endpoint travado se
        // comporta. Porta fechada já falhava rápido (ECONNREFUSED); este é o caso que doía.
        const server = net.createServer(() => { /* silêncio proposital */ });
        await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
        const port = (server.address() as net.AddressInfo).port;

        const provider = new OpenAIProvider('', 'modelo-x', `http://127.0.0.1:${port}`, 'servidor-travado');
        const inicio = Date.now();
        let erro = '';
        try {
            await provider.chat([{ role: 'user', content: 'oi' }], undefined, { timeoutMs: 350_000 });
        } catch (e) {
            erro = (e as Error).message;
        }
        const decorridoMs = Date.now() - inicio;
        server.close();

        assert(decorridoMs < 25_000, `falha em menos de 25s, não nos 350s do timeout da requisição (levou ${(decorridoMs / 1000).toFixed(1)}s)`);
        assert(decorridoMs > 10_000, `não falha cedo demais — dá tempo de uma conexão lenta se estabelecer (levou ${(decorridoMs / 1000).toFixed(1)}s)`);
        assert(erro.includes('servidor-travado'), `a mensagem diz QUAL provider falhou (obtida: ${erro.slice(0, 60)})`);
        assert(/127\.0\.0\.1/.test(erro), 'a mensagem inclui o endereço, para o usuário saber onde olhar');
    }

    console.log('\n=== S174 — cancelamento do usuário não é confundido com endpoint travado ===');
    {
        const server = net.createServer(() => { /* idem */ });
        await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
        const port = (server.address() as net.AddressInfo).port;

        const provider = new OpenAIProvider('', 'modelo-x', `http://127.0.0.1:${port}`, 'servidor-travado');
        const externo = new AbortController();
        setTimeout(() => externo.abort(), 300);   // usuário desiste antes do timeout de conexão

        let erro = '';
        try {
            await provider.chat([{ role: 'user', content: 'oi' }], undefined, { signal: externo.signal, timeoutMs: 350_000 });
        } catch (e) {
            erro = (e as Error).message;
        }
        server.close();

        assert(
            !erro.includes('não respondeu em'),
            `cancelamento externo mantém o erro original, não vira "endpoint travado" (obtida: ${erro.slice(0, 60)})`
        );
    }

    console.log('\n=== S174 — trabalho em andamento inclui GOALS, não só turnos ===');
    {
        // O caminho do goal é o que mais demora e é justamente onde `activeTurns` fica vazio.
        const chatSrc = fs.readFileSync(path.join(process.cwd(), 'src', 'dashboard', 'routes', 'chat.ts'), 'utf-8');
        const rota = chatSrc.slice(chatSrc.indexOf("router.get('/active'"), chatSrc.indexOf("router.post('/'"));
        assert(rota.length > 0, 'rota GET /chat/active existe');
        assert(rota.includes('getActiveTurns'), 'considera turnos do AgentLoop');
        assert(rota.includes('getActiveGoals'), 'considera goals do GoalOrchestrator — o caso de execução longa');
        assert(/kind: 'goal'/.test(rota), 'distingue turno de goal, para a interface poder explicar o que está rodando');

        const orchSrc = fs.readFileSync(path.join(process.cwd(), 'src', 'loop', 'GoalOrchestrator.ts'), 'utf-8');
        assert(
            /getActiveGoals\(\)/.test(orchSrc),
            'GoalOrchestrator expõe os goals ativos por método público (sem alcançar o goalStore privado por fora)'
        );

        const loopSrc = fs.readFileSync(path.join(process.cwd(), 'src', 'loop', 'AgentLoop.ts'), 'utf-8');
        assert(/getActiveTurns\(\)/.test(loopSrc), 'AgentLoop expõe os turnos ativos');
    }

    console.log('\n=== S174 — a interface restaura o estado ao abrir a página ===');
    {
        const html = fs.readFileSync(path.join(process.cwd(), 'src', 'dashboard', 'public', 'index.html'), 'utf-8');
        assert(/function restoreActiveTurn/.test(html), 'existe restauração do estado ativo');
        assert(/\/api\/chat\/active/.test(html), 'consulta o servidor, não confia só no estado da aba');
        assert(
            /restoreActiveTurn\(\);/.test(html.slice(html.indexOf('// === Init ==='))),
            'a restauração roda na inicialização da página'
        );
        assert(
            /setSendBtnBusy\(true\)/.test(html.slice(html.indexOf('function restoreActiveTurn'))),
            'devolve o botão de parar — sem ele o usuário fica sem saída'
        );
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S174 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    console.log(`\nCOBERTURA:`);
    console.log(`  Endpoint travado falhando rápido: testado com servidor real`);
    console.log(`  Cancelamento do usuário preservado: testado`);
    console.log(`  Goals contando como trabalho ativo: testado`);
    console.log(`  Restauração do estado na interface: testado`);
    if (failed > 0) process.exit(1);
}

main().catch(err => { console.error('Erro inesperado:', err); process.exit(1); });
