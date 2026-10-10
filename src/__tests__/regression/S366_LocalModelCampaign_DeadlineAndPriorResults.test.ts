/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S366 (campanha "desempenho com modelo local", 09/10/2026)
 *
 * Produção, 08/10/2026, com um servidor local OpenAI-compatível (modelo de 120B, um pedido por vez):
 *   - o juiz, com orçamento de 46 s, esperou 2 × 240 s e a resposta certa foi bloqueada (9 min);
 *   - o validador de passo estourou 2 × 8 s;
 *   - a etapa que consolidava a resposta via 150–200 chars de cada passo anterior e refez as consultas
 *     ("Top 10 losers" 2×, Bitcoin de novo) e gravou a memória que o passo seguinte do plano gravaria de novo.
 *
 * S366-1 — o prazo de quem chamou vale para a CHAMADA INTEIRA: a reserva não começa depois que ele acabou, e
 *          continua valendo quando a primeira falha cedo (servidores HTTP reais na máquina).
 * S366-2 — raciocínio 'desligado' pedido pela chamada chega ao servidor OpenAI-compatível quando o operador
 *          declarou o controle de raciocínio; sem declaração, nada é enviado (a API oficial pode recusar).
 * S366-3 — a regra de dividir orçamento de caracteres é uma só (shared/orcamentoDeTexto), usada pelo juiz.
 * S366-4 — a etapa do agente recebe os resultados INTEIROS dos passos anteriores e os próximos passos do plano;
 *          corte só para caber, declarado; o juiz recebe a mesma fonte.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import * as net from 'net';
import { AddressInfo } from 'net';
import { ProviderFactory } from '../../core/ProviderFactory';
import { OpenAIProvider } from '../../core/OpenAIProvider';
import { limiteComum } from '../../shared/orcamentoDeTexto';
import { GoalExecutionLoop } from '../../loop/GoalExecutionLoop';
import './_fixtures/motorLegado';   // juízes simulados no formato antigo → formato do motor único (ADR-014)

let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string, detail?: unknown): void {
    if (cond) { console.log(`  ✅ ${msg}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${msg}`, detail ?? ''); failed++; }
}
const ler = (...p: string[]) => fs.readFileSync(path.join(process.cwd(), ...p), 'utf-8');

/** Servidor OpenAI-compatível: 'trava' nunca responde ao chat; 'ok' responde na hora. Registra os corpos. */
function servidor(modo: 'trava' | 'ok'): Promise<{ url: string; corpos: any[]; pedidos: () => number; fechar: () => Promise<void> }> {
    const corpos: any[] = [];
    const abertos: http.ServerResponse[] = [];
    const srv = http.createServer((req, res) => {
        if (req.url?.endsWith('/models')) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"data":[{"id":"m"}]}'); return; }
        let b = '';
        req.on('data', c => { b += c; });
        req.on('end', () => {
            corpos.push(JSON.parse(b || '{}'));
            if (modo === 'trava') { abertos.push(res); return; }
            const corpo = corpos[corpos.length - 1];
            if (corpo.stream) {
                res.writeHead(200, { 'Content-Type': 'text/event-stream' });
                res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: null }] })}\n\n`);
                res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
                res.end('data: [DONE]\n\n');
            } else {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }));
            }
        });
    });
    return new Promise(ok => srv.listen(0, '127.0.0.1', () => ok({
        url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}/v1`,
        corpos,
        pedidos: () => corpos.length,
        // Fecha tudo e ESPERA: no Windows, sair com conexões ainda fechando derruba o processo (0xC0000409).
        fechar: () => new Promise<void>(fim => {
            abertos.forEach(r => { try { r.destroy(); } catch { /* */ } });
            srv.closeAllConnections();
            srv.close(() => fim());
        }),
    })));
}
function portaFechada(): Promise<number> {
    return new Promise(resolve => {
        const s = net.createServer();
        s.listen(0, '127.0.0.1', () => { const p = (s.address() as AddressInfo).port; s.close(() => resolve(p)); });
    });
}

async function main(): Promise<void> {
    console.log('\n=== S366-1 — prazo de quem chamou vale para a chamada inteira ===');
    {
        const lento = await servidor('trava');
        const reserva = await servidor('ok');
        const pf = new ProviderFactory({ defaultProvider: 'Lento', ollamaUrl: 'http://127.0.0.1:1', customProviders: [
            { label: 'Lento', baseUrl: lento.url, model: 'm' },
            { label: 'Reserva', baseUrl: reserva.url, model: 'm' },
        ] } as any);
        const t0 = Date.now();
        const r = await pf.chatWithFallback([{ role: 'user', content: 'oi' }], undefined, 'Lento', 1500);
        const ms = Date.now() - t0;
        assert(r.status !== 'success', `prazo esgotado no primeiro: a chamada termina sem resposta (status ${r.status})`);
        assert(reserva.pedidos() === 0, `a reserva não recebeu pedido depois do prazo (pedidos: ${reserva.pedidos()})`);
        assert(ms < 4000, `terminou perto do prazo de 1,5 s, não com um prazo novo por tentativa (${ms} ms)`);
        await lento.fechar(); await reserva.fechar();

        const porta = await portaFechada();
        const reserva2 = await servidor('ok');
        const pf2 = new ProviderFactory({ defaultProvider: 'Fora', ollamaUrl: 'http://127.0.0.1:1', customProviders: [
            { label: 'Fora', baseUrl: `http://127.0.0.1:${porta}/v1`, model: 'm' },
            { label: 'Reserva', baseUrl: reserva2.url, model: 'm' },
        ] } as any);
        const r2 = await pf2.chatWithFallback([{ role: 'user', content: 'oi' }], undefined, 'Fora', 5000);
        assert(r2.status === 'success' && reserva2.pedidos() >= 1, `primeiro fora do ar (falha cedo): a reserva continua valendo (status ${r2.status})`);
        await reserva2.fechar();
    }

    console.log('\n=== S366-2 — raciocínio desligado por chamada no servidor OpenAI-compatível ===');
    {
        const s = await servidor('ok');
        await new OpenAIProvider('', 'm', s.url, 'L', { thinking: 'on' }).chat([{ role: 'user', content: 'x' }], undefined, { raciocinio: 'desligado' });
        assert(s.corpos[0]?.chat_template_kwargs?.enable_thinking === false, 'operador declarou "ligado" + chamada pede "desligado" → enable_thinking=false');
        await new OpenAIProvider('', 'm', s.url, 'L', { thinking: 'on' }).chat([{ role: 'user', content: 'x' }]);
        assert(s.corpos[1]?.chat_template_kwargs?.enable_thinking === true, 'sem pedido da chamada, vale a escolha do operador');
        await new OpenAIProvider('', 'm', s.url, 'L').chat([{ role: 'user', content: 'x' }], undefined, { raciocinio: 'desligado' });
        assert(s.corpos[2] && s.corpos[2].chat_template_kwargs === undefined, 'operador não declarou o controle → nada é enviado (a API oficial pode recusar o campo)');
        await s.fechar();
    }

    console.log('\n=== S366-3 — divisão do orçamento de caracteres: fonte única ===');
    {
        assert(limiteComum([100, 200], 1000) === Infinity, 'tudo cabe → nada é cortado');
        assert(limiteComum([100, 200], 0) === 0, 'nada cabe → 0');
        assert(limiteComum([100, 5000, 5000], 3100) === 1500, 'textos pequenos inteiros, os grandes cortados por igual');
        // Troca ao motor único (ADR-014): o juiz de grounding não corta mais nada (nem evidência, nem resposta); a regra de
        // `limiteComum` segue sendo a fonte única do corte declarado onde ele existe (a etapa do agente).
        const ov = ler('src', 'loop', 'ObserverValidator.ts');
        assert(!/limiteComum\(/.test(ov) && !/evidenceCapForBudget/.test(ov), 'o juiz de grounding não tem regra de corte própria — nada é cortado');
    }

    console.log('\n=== S366-4 — a etapa do agente recebe os resultados inteiros e os próximos passos ===');
    {
        const grande = 'BTC -1,48% 24h; ' + 'x'.repeat(4000) + ' FIM-DO-RESULTADO';
        const goal: any = {
            planGeneration: 0,
            currentPlan: [
                { id: 'step_1', toolName: 'crypto_analysis', description: 'maiores quedas', status: 'completed' },
                { id: 'step_2', toolName: 'web_navigate', description: 'notícias', status: 'completed' },
                { id: 'step_3', toolName: undefined, description: 'consolidar a resposta', status: 'pending' },
                { id: 'step_4', toolName: 'memory_write', description: 'salvar na memória', status: 'pending' },
            ],
            attempts: [
                { planStepId: 'step_1', planGeneration: 0, toolName: 'crypto_analysis', args: { action: 'losers' }, result: 'success', output: grande.slice(0, 300) },
                { planStepId: 'step_2', planGeneration: 0, toolName: 'web_navigate', args: { url: 'https://exemplo' }, result: 'success', output: 'notícia curta' },
                { planStepId: 'step_1', planGeneration: 1, toolName: 'crypto_analysis', args: {}, result: 'success', output: 'de outra geração' },
            ],
        };
        const passo = goal.currentPlan[2];
        const comEstado = GoalExecutionLoop.secaoDoPlanoParaEtapa(goal, passo, { saidasCompletas: new Map([['0:step_1', grande]]) } as any, 60000);
        assert(comEstado.includes('FIM-DO-RESULTADO'), 'o resultado completo da execução chega inteiro (não o trecho de 300 do registro)');
        assert(comEstado.includes('{"action":"losers"}') && comEstado.includes('notícia curta'), 'cada resultado vem com o que foi pedido à ferramenta');
        assert(/PRÓXIMOS PASSOS DO PLANO[\s\S]*step_4 · memory_write — salvar na memória/.test(comEstado), 'os passos seguintes do plano aparecem (para não serem antecipados)');
        assert(!/--- step_3/.test(comEstado), 'o próprio passo não entra como resultado anterior');
        assert(!comEstado.includes('de outra geração'), 'resultado de outra geração do plano não entra');

        const semEstado = GoalExecutionLoop.secaoDoPlanoParaEtapa(goal, passo, {} as any, 60000);
        assert(semEstado.includes('só o trecho guardado no registro do objetivo'), 'goal retomado (sem o estado da execução): o corte do registro é declarado');

        const apertado = GoalExecutionLoop.secaoDoPlanoParaEtapa(goal, passo, { saidasCompletas: new Map([['0:step_1', grande]]) } as any, 2000);
        assert(/cortado para caber: mostrando \d+ de \d+ caracteres/.test(apertado), 'sem orçamento para tudo: corte declarado, com quanto foi mostrado');

        const gel = ler('src', 'loop', 'GoalExecutionLoop.ts');
        assert(!gel.includes("'\\nOutputs relevantes dos steps anteriores:'") && !gel.includes("'\\nSteps já executados:'"),
            'a representação curta duplicada (150–200 chars) saiu do contexto cognitivo');
        assert(/output: state\.saidasCompletas\?\.get\(chaveDaSaida\(a\.planGeneration, a\.planStepId\)\) \?\? a\.output/.test(gel),
            'o juiz recebe a mesma fonte completa dos passos anteriores');
        assert(/state\.saidasCompletas\?\.set\(chaveDaSaida\(goal\.planGeneration, step\.id\), toolResult\.output\)/.test(gel)
            && /saidasCompletas: new Map\(\)/.test(gel), 'a saída completa de cada passo é guardada no estado local da execução');
        assert(/DECISION_PROMPT_MAX_CHARS - stepPromptSemResultados\.length/.test(gel), 'o orçamento da seção é o teto único de prompt de decisão');
    }

    console.log('\n=== S366-5 — "foi gerada uma explicação" não vira alegação de arquivo; gravação prevista é cobrada pela estrutura ===');
    {
        const gel = ler('src', 'loop', 'GoalExecutionLoop.ts');
        assert(!/pattern: \/foi\\s\+\(criad\[ao\]\|gerado\|gerada\)/.test(gel) && !gel.includes("label: 'criação ou geração de artefato'"),
            'a regex "foi criado/gerado" sobre a prosa do validador saiu (09/10: resposta pronta em 3 min 51 s virou 11 min)');
        const plano = (ferramentas: Array<string | undefined>) => ferramentas.map((t, i) => ({ id: `step_${i + 1}`, toolName: t, description: `passo ${i + 1}`, status: 'completed' }));
        const sem = GoalExecutionLoop.gravacaoPrevistaSemEvidencia({ currentPlan: plano(['crypto_analysis', undefined]), attempts: [] } as any);
        assert(sem === null, 'plano sem passo write → nada a cobrar (a pergunta das criptomoedas de 09/10)');
        const faltou = GoalExecutionLoop.gravacaoPrevistaSemEvidencia({ currentPlan: plano(['write', 'send_document']), attempts: [{ toolName: 'agentloop', result: 'success', output: 'texto' }] } as any);
        assert(faltou?.id === 'step_1', 'write previsto e nenhuma gravação → o passo de gravação é apontado');
        const dentro = GoalExecutionLoop.gravacaoPrevistaSemEvidencia({ currentPlan: plano(['write']), attempts: [{ toolName: 'agentloop', result: 'success', subToolCalls: ['write'] }] } as any);
        assert(dentro === null, 'gravação feita dentro de uma etapa do agente conta (o caso guufa, 29/07)');
        assert(/gravacaoPrevistaSemEvidencia\(goal\)[\s\S]{0,400}override_to_false/.test(gel), 'a checagem estrutural roda quando o validador diz achieved=true');
    }

    console.log(`\nS366 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(e => { console.error(e); process.exit(1); });
