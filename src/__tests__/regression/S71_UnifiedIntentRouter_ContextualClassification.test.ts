/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S71
 * Continuação da microauditoria de continuidade conversacional (08/07/2026). Depois dos fixes
 * de sessionKey/transcript (S68-S70), o usuário perguntou especificamente sobre o gap #12
 * remanescente: `UnifiedIntentRouter.llmClassify()` classificava a mensagem atual ISOLADA, sem
 * nenhum turno anterior da conversa. Para "sim"/"ok"/"pode" isso nunca foi um problema (a
 * palavra carrega sentido de confirmação mesmo fora de contexto, e além disso são capturadas
 * pelo gate determinístico ANTES de chegar em llmClassify). Para "continue"/"agora"/"isso"/
 * "faça" — nenhuma coberta pelo gate determinístico (que exige match exato/ancorado pra
 * categorias de baixa especificidade) — o LLM classificava esse texto sozinho, sem saber que
 * existia uma pergunta/proposta pendente do assistente.
 *
 * Investigação (rastreamento real, não hipotético):
 *   - A mensagem atual já é gravada via SessionManager.recordUserMessage ANTES de
 *     AgentLoop.runWithTools chamar intentRouter.route() — logo, se a janela de histórico
 *     fosse buscada nesse ponto sem cuidado, a mensagem atual apareceria duplicada.
 *   - MessageBus já calculava exatamente essa janela (`sessionManager.buildContext` + filter
 *     role user/assistant + `.slice(-5,-1)`, que descarta a mensagem atual) — mas só pra
 *     alimentar o GoalExtractor (goalOrchestrator.process), nunca chegava no AgentLoop.
 *   - Toda mensagem role='assistant' na transcript corresponde a uma entrega real (ou tentativa
 *     de entrega sem exceção) — auditado TODOS os call sites de recordAssistantMessage
 *     (MessageBus.ts×3, AgentController.ts×2, SessionContext.ts — não usado): em cada um, a
 *     chamada acontece DEPOIS de adapter.send(...) já ter sido aguardado sem lançar. Não existe
 *     modelagem ambígua a resolver — role==='assistant' já É "resposta real entregue".
 *   - Auditoria do gate determinístico (DETERMINISTIC_RULES): as regras de baixa especificidade
 *     (confirmation/rejection/greeting) exigem match EXATO com a string inteira normalizada
 *     (`normalized === kw`) ou casamento com um regex ANCORADO (`^...$`) — "continue"/"agora"/
 *     "isso"/"faça" não aparecem em nenhuma keyword/pattern, então já chegavam (e continuam
 *     chegando) em llmClassify sem bloqueio. Nenhuma mudança nos gates foi necessária.
 *
 * Fix: `buildClassificationMessages()` (função pura, exportada) monta as mensagens de chat
 * enviadas ao LLM incluindo os turnos recentes reais + identifica explicitamente a última
 * resposta do assistente; `ChannelContext.recentMessages` carrega o dado (populado em
 * MessageBus, antes só calculado quando GoalOrchestrator estava ativo — agora incondicional);
 * `AgentLoop` repassa pro `UnifiedIntentRouter.route()`. Bug lateral corrigido: o cache de
 * classificação (`classificationCache`) era chaveado só pelo texto normalizado — com
 * classificação agora sensível a contexto, duas sessões diferentes mandando o mesmo texto
 * curto em momentos diferentes colidiriam na mesma entrada. `buildCacheKey()` agora inclui
 * sessionId + hash da última resposta do assistente quando há contexto.
 *
 * ── Correção adversarial (mesmo dia, microauditoria curta pedida sobre este próprio S71) ──
 * Duas inconsistências REAIS encontradas por contraexemplo mínimo construído a partir do fluxo
 * real (não hipotético):
 *   Eixo A — domínio incompleto na cache key: buildCacheKey hasheava só a ÚLTIMA resposta do
 *     assistente, mas llmClassify() recebe a JANELA INTEIRA (até 4 turnos). Contraexemplo: numa
 *     mesma sessão, se o assistente fechar duas ações DIFERENTES com a mesma frase genérica
 *     ("Pronto! Quer que eu envie agora?"), a chave colidia mesmo com llmClassify() recebendo
 *     dois conjuntos de mensagens diferentes (os turnos anteriores — sobre o quê — divergem).
 *   Eixo C — inconsistência de subconjunto: buildClassificationMessages() e buildCacheKey()
 *     calculavam a janela efetiva de forma INDEPENDENTE a partir do mesmo context.recentMessages
 *     bruto — se a defesa de deduplicação (remover último item igual à mensagem atual) disparasse
 *     em um, o outro podia hashear/enviar um conjunto diferente.
 * Fix: `resolveClassificationWindow()` — única função que calcula a janela efetiva, usada por
 * ambos. buildCacheKey agora hasheia a janela INTEIRA (role+content de cada turno), não só a
 * última resposta. Sem regex, sem lista, sem aumento de janela — mesma janela de sempre,
 * hasheada por completo em vez de parcialmente.
 *
 * Escopo tocado: loop/UnifiedIntentRouter.ts, loop/agentLoopTypes.ts (ChannelContext),
 * loop/AgentLoop.ts, channels/MessageBus.ts.
 *
 * Execução: npx ts-node src/__tests__/regression/S71_UnifiedIntentRouter_ContextualClassification.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import {
    buildClassificationMessages,
    extractLastAssistantMessage,
    UnifiedIntentRouter,
    RecentTurn,
} from '../../loop/UnifiedIntentRouter';

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

console.log('\n=== S71-1 [classe: ausência de histórico] — sem recentMessages, comportamento idêntico ao original (system + user, sem contexto) ===');
{
    const noContext = buildClassificationMessages('gerar um relatório de vendas');
    assert(noContext.length === 2, 'exatamente 2 mensagens (system + user) quando não há contexto');
    assert(noContext[0].role === 'system' && noContext[1].role === 'user', 'ordem system→user preservada');
    assert(noContext[1].content === 'gerar um relatório de vendas', 'mensagem atual não alterada');
    assert(!noContext[0].content.includes('conversa recente'), 'system prompt NÃO menciona conversa recente quando não há janela (comportamento original preservado)');

    const emptyArray = buildClassificationMessages('continue', { recentMessages: [] });
    assert(emptyArray.length === 2, 'recentMessages=[] tratado igual a undefined (2 mensagens, sem contexto)');
}

console.log('\n=== S71-2 [classe: resposta confirmatória após proposta] — janela inclui a proposta do assistente, última resposta identificável ===');
{
    const recentMessages: RecentTurn[] = [
        { role: 'user', content: 'deixa o fundo da aula branco' },
        { role: 'assistant', content: 'Quer que eu execute o script que aplica fundo branco em todos os 10 slides agora?' },
    ];
    const messages = buildClassificationMessages('faça', { recentMessages, sessionId: 's1' });
    assert(messages.length === 4, 'system + 2 turnos da janela + mensagem atual = 4 mensagens');
    assert(messages[1].role === 'user' && messages[2].role === 'assistant', 'ordem cronológica da janela preservada');
    assert(messages[3].content === 'faça', 'mensagem atual é o último item, sem alteração');
    assert(
        messages[0].content.includes('Quer que eu execute o script que aplica fundo branco'),
        'system prompt identifica explicitamente a última resposta do assistente como antecedente',
    );
    assert(
        extractLastAssistantMessage(recentMessages) === 'Quer que eu execute o script que aplica fundo branco em todos os 10 slides agora?',
        'extractLastAssistantMessage retorna exatamente a última mensagem role=assistant',
    );
}

console.log('\n=== S71-3 [classe: pergunta curta após pergunta do assistente] — "Belo Horizonte" após "qual cidade?" carrega a pergunta como contexto ===');
{
    const recentMessages: RecentTurn[] = [
        { role: 'user', content: 'qual vai ser o clima?' },
        { role: 'assistant', content: 'Qual cidade você quer saber a previsão?' },
    ];
    const messages = buildClassificationMessages('Belo Horizonte', { recentMessages });
    assert(messages[0].content.includes('Qual cidade você quer saber a previsão?'), 'pergunta do assistente presente no prompt');
    assert(messages[messages.length - 1].content === 'Belo Horizonte', 'mensagem atual preservada verbatim');
}

console.log('\n=== S71-4 [classes: adiamento / incerteza após proposta] — texto do usuário não é reinterpretado, só a janela muda ===');
{
    const proposal: RecentTurn[] = [{ role: 'assistant', content: 'Posso gerar os slides agora, quer que eu prossiga?' }];
    const adiamento = buildClassificationMessages('depois eu vejo', { recentMessages: proposal });
    const incerteza = buildClassificationMessages('não sei', { recentMessages: proposal });
    assert(adiamento[adiamento.length - 1].content === 'depois eu vejo', 'adiamento: mensagem atual intacta');
    assert(incerteza[incerteza.length - 1].content === 'não sei', 'incerteza: mensagem atual intacta');
    assert(
        adiamento[0].content.includes('Posso gerar os slides agora') && incerteza[0].content.includes('Posso gerar os slides agora'),
        'ambas as classes recebem a mesma proposta do assistente como antecedente',
    );
}

console.log('\n=== S71-5 [classe: continuação após tarefa parcial] — "continue" carrega o progresso relatado pelo assistente ===');
{
    const recentMessages: RecentTurn[] = [
        { role: 'user', content: 'aplica fundo branco em todos os slides' },
        { role: 'assistant', content: 'Consegui aplicar o fundo branco no Slide 1. Os slides 2 a 10 ainda precisam. Quer que eu continue?' },
    ];
    const messages = buildClassificationMessages('continue', { recentMessages });
    assert(messages[0].content.includes('Slide 1') && messages[0].content.includes('slides 2 a 10'), 'progresso parcial relatado pelo assistente está no antecedente');
    assert(messages[messages.length - 1].content === 'continue', 'input "continue" não é reescrito nem interpretado pelo código — só o LLM recebe o contexto pra decidir');
}

console.log('\n=== S71-6 [classe: mudança de assunto antes da mensagem curta] — janela preserva TODOS os turnos recentes, não só o último ===');
{
    const recentMessages: RecentTurn[] = [
        { role: 'user', content: 'fale sobre gatos' },
        { role: 'assistant', content: 'Gatos são felinos domésticos...' },
        { role: 'user', content: 'e sobre cachorros?' },
        { role: 'assistant', content: 'Cachorros são caninos domésticos...' },
    ];
    const messages = buildClassificationMessages('continue', { recentMessages });
    assert(messages.length === 6, 'system + 4 turnos da janela + mensagem atual = 6 mensagens (janela inteira preservada, não só o último turno)');
    assert(messages[1].content.includes('gatos') && messages[3].content.includes('cachorros'), 'mudança de assunto (gatos → cachorros) visível na ordem cronológica da janela');
    assert(
        extractLastAssistantMessage(recentMessages)!.includes('caninos'),
        'última resposta do assistente identificada é sobre CACHORROS (o assunto mais recente), não sobre gatos',
    );
}

console.log('\n=== S71-7 [classe: referência ao turno anterior] — "aumenta o tamanho dessa fonte" referencia conteúdo específico do turno anterior ===');
{
    const recentMessages: RecentTurn[] = [
        { role: 'assistant', content: 'Criei o slide com a fonte Arial tamanho 18.' },
    ];
    const messages = buildClassificationMessages('aumenta o tamanho dessa fonte', { recentMessages });
    assert(messages[0].content.includes('Arial tamanho 18'), 'detalhe referenciável (a fonte específica) está disponível no antecedente');
}

console.log('\n=== S71-8 [classe: isolamento entre sessões] — buildCacheKey nunca colide entre sessões/contextos diferentes ===');
{
    const router = new UnifiedIntentRouter() as unknown as { buildCacheKey: (input: string, context?: unknown) => string };
    const ctxSessionA = { sessionId: 'session-A', recentMessages: [{ role: 'assistant', content: 'Quer que eu envie o arquivo agora?' }] };
    const ctxSessionB = { sessionId: 'session-B', recentMessages: [{ role: 'assistant', content: 'Quer que eu delete o arquivo agora?' }] };
    const keyA = router.buildCacheKey('sim', ctxSessionA);
    const keyB = router.buildCacheKey('sim', ctxSessionB);
    assert(keyA !== keyB, 'mesmo texto ("sim"), sessões diferentes com propostas diferentes → chaves de cache DIFERENTES (sem isso, a decisão de uma sessão vazaria pra outra)');

    const ctxSameSessionDifferentProposal = { sessionId: 'session-A', recentMessages: [{ role: 'assistant', content: 'Quer que eu delete o arquivo agora?' }] };
    const keyA2 = router.buildCacheKey('sim', ctxSameSessionDifferentProposal);
    assert(keyA !== keyA2, 'mesma sessão, proposta diferente do assistente → chave diferente (evita reusar decisão de uma proposta anterior)');

    const keyNoContext1 = router.buildCacheKey('oi', undefined);
    const keyNoContext2 = router.buildCacheKey('oi', { recentMessages: [] });
    assert(keyNoContext1 === keyNoContext2 && keyNoContext1 === 'oi', 'sem contexto (undefined ou vazio), chave é só o texto normalizado — comportamento original preservado');
}

console.log('\n=== S71-9 [defesa contra duplicação] — mensagem atual repetida no fim da janela é removida antes de montar o prompt ===');
{
    const recentMessages: RecentTurn[] = [
        { role: 'assistant', content: 'Quer que eu prossiga?' },
        { role: 'user', content: 'continue' }, // chamador esqueceu de excluir a mensagem atual
    ];
    const messages = buildClassificationMessages('continue', { recentMessages });
    const userTurnsWithSameContent = messages.filter(m => m.role === 'user' && m.content === 'continue');
    assert(userTurnsWithSameContent.length === 1, 'mensagem atual não aparece duplicada mesmo se o chamador falhar em excluí-la da janela');
}

console.log('\n=== S71-10 [invariante] — role=assistant na transcript só existe após tentativa de entrega real (auditoria de código-fonte) ===');
{
    const messageBusSrc = readSrc('channels/MessageBus.ts');
    const agentControllerSrc = readSrc('core/AgentController.ts');

    // Cada recordAssistantMessage deve ter um adapter.send (ou equivalente já enviado) ANTES
    // dele no mesmo bloco — não depois, não em paralelo sem await.
    const messageBusCalls = [...messageBusSrc.matchAll(/recordAssistantMessage\(/g)];
    assert(messageBusCalls.length === 3, `MessageBus.ts tem exatamente 3 call sites de recordAssistantMessage (encontrado: ${messageBusCalls.length}) — se esse número mudar, revisar manualmente se o novo call site também vem depois de uma entrega real`);

    const agentControllerCalls = [...agentControllerSrc.matchAll(/recordAssistantMessage\(/g)];
    assert(agentControllerCalls.length === 2, `AgentController.ts tem exatamente 2 call sites de recordAssistantMessage (encontrado: ${agentControllerCalls.length})`);

    // Para cada ocorrência, verifica que "adapter.send(" aparece ANTES dela dentro de uma janela
    // curta de código (mesmo bloco de função) — prova estrutural de "send antes de record".
    for (const src of [messageBusSrc, agentControllerSrc]) {
        let idx = 0;
        while (true) {
            const found = src.indexOf('recordAssistantMessage(', idx);
            if (found === -1) break;
            const windowStart = Math.max(0, found - 1200);
            const window = src.slice(windowStart, found);
            assert(
                /adapter\.send\(/.test(window) || /\.send\(\s*\{/.test(window),
                `recordAssistantMessage em offset ${found} é precedido por uma chamada de entrega (adapter.send) na janela de 1200 chars anterior`,
            );
            idx = found + 1;
        }
    }
}

console.log('\n=== S71-11 [Etapa 4 — auditoria de gates lexicais] — "continue"/"isso"/"agora"/"faça" isolados NÃO batem no gate determinístico ===');
{
    // Sem providerFactory, route() usa semanticRoute() (keyword fallback) em vez de llmClassify —
    // permite provar que o gate determinístico não intercepta essas palavras, sem chamar LLM real.
    const router = new UnifiedIntentRouter();
    for (const word of ['continue', 'isso', 'agora', 'faça']) {
        const decision = await router.route(word);
        assert(
            decision.source !== 'deterministic',
            `"${word}" isolado NÃO é capturado pelo gate determinístico (source=${decision.source}) — chega ao classificador contextual`,
        );
    }
    // Controle negativo: "sim"/"ok" CONTINUAM sendo capturados deterministicamente (não regride
    // o fast-path existente — a auditoria não recomendou removê-lo, e o teste prova que não foi
    // removido).
    for (const word of ['sim', 'ok']) {
        const decision = await router.route(word);
        assert(
            decision.source === 'deterministic' && decision.category === 'confirmation',
            `"${word}" isolado CONTINUA no fast-path determinístico (source=${decision.source}, category=${decision.category}) — fast-path seguro preservado`,
        );
    }
}

console.log('\n=== S71-12 — routeSync() aceita recentMessages no contrato mas nunca o consome (contexto síncrono) ===');
{
    const routerSrc = readSrc('loop/UnifiedIntentRouter.ts');
    const routeSyncBody = routerSrc.slice(routerSrc.indexOf('routeSync(input: string'), routerSrc.indexOf('// ── Layer 1: Deterministic Gate'));
    assert(!/context\.recentMessages/.test(routeSyncBody) && !/context\?\.recentMessages/.test(routeSyncBody), 'corpo de routeSync() nunca lê context.recentMessages (não pode chamar LLM de forma síncrona)');
    assert(!/llmClassify/.test(routeSyncBody), 'routeSync() nunca chama llmClassify');

    // Prova em runtime: passar recentMessages não quebra nem muda o resultado de routeSync
    // (mesma decisão com ou sem o campo, pra uma mensagem que não bate no gate determinístico).
    const router = new UnifiedIntentRouter();
    const withoutContext = router.routeSync('mensagem xyz sem categoria clara');
    const withContext = router.routeSync('mensagem xyz sem categoria clara 2', {
        sessionId: 's1',
        recentMessages: [{ role: 'assistant', content: 'Proposta qualquer' }],
    });
    assert(withoutContext.source === 'fallback' && withContext.source === 'fallback', 'routeSync() não lança e não diverge (source=fallback em ambos) quando recentMessages é passado');
}

console.log('\n=== S71-13 — auditoria: routeSync() não tem call sites em produção hoje ===');
{
    // grep textual simplificado: procura por `.routeSync(` em todo src/, excluindo o próprio
    // arquivo do router e arquivos de teste.
    const srcDir = path.join(process.cwd(), 'src');
    function walk(dir: string): string[] {
        const out: string[] = [];
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) out.push(...walk(full));
            else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(full);
        }
        return out;
    }
    const files = walk(srcDir).filter(f => !f.endsWith(path.join('loop', 'UnifiedIntentRouter.ts')));
    const callers = files.filter(f => fs.readFileSync(f, 'utf-8').includes('.routeSync('));
    assert(callers.length === 0, `nenhum arquivo de produção chama .routeSync() hoje (encontrado: ${callers.length > 0 ? callers.join(', ') : 'nenhum'}) — confirma que o contrato documentado (ignora recentMessages) não afeta nenhum caminho vivo`);
}

console.log('\n=== S71-14 [Eixo A — CORREÇÃO] — contraexemplo mínimo: mesma última resposta, turnos anteriores diferentes → chaves DIFERENTES ===');
{
    const router = new UnifiedIntentRouter() as unknown as { buildCacheKey: (input: string, context?: unknown) => string };

    // Contraexemplo real: o assistente fecha duas ações DIFERENTES com a MESMA frase genérica
    // de confirmação ("Pronto! Quer que eu envie agora?") — plausível, já que é um padrão de
    // fechamento reutilizável, não específico do assunto.
    const contextRenomear = {
        sessionId: 'S1',
        recentMessages: [
            { role: 'user', content: 'renomeia o arquivo A para relatorio_final.pptx' },
            { role: 'assistant', content: 'Pronto! Quer que eu envie agora?' },
        ],
    };
    const contextResumo = {
        sessionId: 'S1', // MESMA sessão
        recentMessages: [
            { role: 'user', content: 'cria um resumo do relatório financeiro' },
            { role: 'assistant', content: 'Pronto! Quer que eu envie agora?' }, // MESMA última resposta
        ],
    };
    const keyRenomear = router.buildCacheKey('agora', contextRenomear);
    const keyResumo = router.buildCacheKey('agora', contextResumo);
    assert(
        keyRenomear !== keyResumo,
        'ANTES da correção essas duas chaves colidiam (mesma sessionId + mesma última resposta + mesmo input "agora"), mesmo llmClassify() recebendo turnos anteriores completamente diferentes (renomear arquivo vs. resumir relatório) — agora a janela INTEIRA entra no hash, então divergem',
    );
}

console.log('\n=== S71-15 [Eixo C — CORREÇÃO] — buildCacheKey e buildClassificationMessages usam EXATAMENTE a mesma janela resolvida ===');
{
    const router = new UnifiedIntentRouter() as unknown as { buildCacheKey: (input: string, context?: unknown) => string };

    // Contexto onde o último item da janela bruta duplica a mensagem atual (o chamador "esqueceu"
    // de excluir) — buildClassificationMessages já tinha defesa pra isso (S71-9); prova aqui que
    // buildCacheKey aplica a MESMA defesa (via resolveClassificationWindow compartilhada), não
    // uma leitura independente do array bruto.
    const contextComDuplicata = {
        sessionId: 'S2',
        recentMessages: [
            { role: 'assistant', content: 'Quer que eu prossiga?' },
            { role: 'user', content: 'continue' }, // duplicata da mensagem atual
        ],
    };
    const contextSemDuplicata = {
        sessionId: 'S2',
        recentMessages: [
            { role: 'assistant', content: 'Quer que eu prossiga?' },
        ],
    };
    const keyComDuplicata = router.buildCacheKey('continue', contextComDuplicata);
    const keySemDuplicata = router.buildCacheKey('continue', contextSemDuplicata);
    assert(
        keyComDuplicata === keySemDuplicata,
        'chave é idêntica com ou sem a duplicata no array bruto — buildCacheKey resolve a janela pela mesma função que buildClassificationMessages, não pode hashear um conjunto diferente do que foi realmente enviado ao LLM',
    );
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S71 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;

}

main().catch((err) => {
    console.error('S71 erro inesperado:', err);
    process.exitCode = 1;
});
