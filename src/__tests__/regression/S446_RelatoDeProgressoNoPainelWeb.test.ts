/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S446 (ADR-027)
 * No painel web, o relato de progresso de um objetivo longo aparece DURANTE o trabalho e some quando a resposta sai.
 *
 * INCIDENTE REAL (teste no Strata, 23/10/2026): o relato saía a cada minuto, mas o canal web o guardava como "entrega
 * pendente" (orphanedDeliveries, fila de 10) e só o mostrava colado na resposta final — 10 relatos de uma vez, no fim,
 * com o prefixo "📎 Entrega pendente de uma tarefa anterior". Telegram e os demais canais mandam na hora.
 *
 * REGRESSÃO SE: o relato voltar a entrar na fila de entregas; não for o ÚLTIMO (acumular); não sumir quando a resposta
 * final sai; uma mensagem do sistema que NÃO é relato deixar de chegar como antes; ou a fiação servidor → tela quebrar.
 *
 * Execução: npx ts-node src/__tests__/regression/S446_RelatoDeProgressoNoPainelWeb.test.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { WebChannelAdapter } from '../../channels/WebChannelAdapter';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}

async function main(): Promise<void> {
    console.log('\n=== S446-1 — relato: só o último, sem entrar na resposta final ===');
    const web = new WebChannelAdapter();
    web.registerAsyncTurn('turno-1', 'conversa-1');
    await web.sendToChat('conversa-1', { text: '⏳ Ainda estou trabalhando no seu pedido (há 1 min).', format: 'markdown', progresso: true });
    await web.sendToChat('conversa-1', { text: '⏳ Ainda estou trabalhando no seu pedido (há 2 min).', format: 'markdown', progresso: true });
    const atual = web.progressoAtual('conversa-1');
    assert(!!atual && /há 2 min/.test(atual.texto) && typeof atual.em === 'number', 'o painel lê o ÚLTIMO relato (substitui o anterior)', atual);
    assert(web.progressoAtual('outra-conversa') === undefined, 'cada conversa tem o seu (nada vaza para outra)');
    const final = await web.send({ text: 'O script concluiu 48 etapas.', format: 'markdown' }, 'turno-1') as any;
    assert(final?.text === 'O script concluiu 48 etapas.', 'a resposta final sai limpa, sem "Entrega pendente" nem relatos colados', final?.text);
    assert(web.progressoAtual('conversa-1') === undefined, 'o relato some quando a resposta final sai');

    console.log('\n=== S446-1b — resposta final pelo caminho da requisição já expirada: o relato também some ===');
    const espera = web.waitForResponse('req-exp', 'conversa-exp', 50).catch(() => 'expirou');
    await web.sendToChat('conversa-exp', { text: '⏳ relato', format: 'markdown', progresso: true });
    assert(await espera === 'expirou', 'a espera HTTP expirou antes do fim do goal');
    await web.send({ text: 'Resposta atrasada', format: 'markdown' }, 'req-exp');
    assert(web.progressoAtual('conversa-exp') === undefined, 'a resposta atrasada também limpa o relato da conversa');

    console.log('\n=== S446-2 — mensagem do sistema que NÃO é relato: chega como antes (na próxima resposta) ===');
    web.registerAsyncTurn('turno-2', 'conversa-2');
    await web.sendToChat('conversa-2', { text: '🧠 Aprendi algo novo.', format: 'markdown' });
    const r2 = await web.send({ text: 'Resposta', format: 'markdown' }, 'turno-2') as any;
    assert(/Entrega pendente/.test(r2?.text ?? '') && /Aprendi algo novo/.test(r2?.text ?? ''), 'o aviso comum continua mesclado na próxima resposta', r2?.text);

    console.log('\n=== S446-3 — fiação: o aviso do objetivo é marcado; a rota devolve; a tela mostra e limpa ===');
    const raiz = process.cwd();
    const ler = (rel: string) => fs.readFileSync(path.join(raiz, rel), 'utf-8');
    const ctrl = ler('src/core/AgentController.ts');
    const rota = ler('src/dashboard/routes/chat.ts');
    const tela = ler('src/dashboard/public/index.html');
    assert(/setAvisoAoUsuario\([\s\S]{0,400}progresso: true/.test(ctrl), 'o relato do objetivo sai marcado como andamento (progresso: true)');
    assert(/progressoAtual\?\.\(conversationId\)/.test(rota) && /\.\.\.\(progresso \? \{ progresso \} : \{\}\)/.test(rota), 'GET /api/chat/active devolve o relato da conversa');
    assert(/progresso = null \} = await res\.json\(\)/.test(tela) && /renderProgress\(\(mine \|\| pending\) \? progresso : null\)/.test(tela), 'o polling do turno lê o relato e só o mostra com trabalho em andamento');
    assert(/id="progressReportSlot"/.test(tela) && /function renderProgress\(progresso\)/.test(tela) && /md\(progresso\.texto\)/.test(tela), 'a tela tem o cartão e passa o texto pelo md() (escapa HTML)');
    assert(/function hideStatus\(\)[\s\S]{0,300}renderProgress\(null\)/.test(tela), 'ao terminar ou parar (hideStatus), o cartão some');

    console.log('\n=== S446-4 — página recarregada durante o goal: a resposta que chega pelo servidor aparece na conversa aberta ===');
    const sync = tela.slice(tela.indexOf('async function syncFromServer()'), tela.indexOf('async function syncFromServer()') + 5000);
    assert(/if \(localId === currentConvId\) abertaMudou = true;/.test(sync) && /save\(\); renderSidebar\(\);\s*if \(abertaMudou\) renderChat\(\);/.test(sync),
        'syncFromServer redesenha a conversa aberta quando o servidor trouxe mensagens novas para ela (antes: só a lista lateral)');

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S446 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    process.exit(failed > 0 ? 1 : 0);
}
main().catch((err) => { console.error('S446 erro inesperado:', err); process.exit(1); });
