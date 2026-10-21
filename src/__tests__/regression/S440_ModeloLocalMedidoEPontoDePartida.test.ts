/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S440
 * (1) O provedor compatível com OpenAI entrega à telemetria os números que o SERVIDOR mediu (`usage`; `timings` do
 *     llama-server) — é deles que sai a velocidade do modelo (ADR-024).
 * (2) Sem histórico do modelo num tipo de chamada, o agente e o classificador de objetivos usam o ponto de partida declarado
 *     (ADR-024, decisão 2) — só estende o prazo. Os juízes NÃO usam (o orçamento deles também vira limite de tokens).
 *
 * INCIDENTE REAL (21/10/2026): na produção, em mais de 100 chamadas ao modelo local (servidor compatível com OpenAI), a
 * velocidade nunca foi medida (`geracao=?tok/s`) — a extensão de prazo pelo trabalho nunca agiu para ele, mesmo com 43
 * conclusões do agente no histórico. Na validação real numa instância nova, o agente foi cortado aos 210 s pelo prazo
 * calibrado na nuvem e o classificador de objetivos estourou 15 s (o modelo leu o prompt a ~21 tokens/s).
 *
 * Execução: npx ts-node src/__tests__/regression/S440_ModeloLocalMedidoEPontoDePartida.test.ts
 */
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { OpenAIProvider } from '../../core/OpenAIProvider';
import { ProviderFactory } from '../../core/ProviderFactory';
import { medidorDoProcesso, observacaoDaChamada, pontoDePartidaEmTokens, FOLGA } from '../../core/medidorDeTrabalho';
import type { AttemptTelemetry } from '../../core/providerTypes';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}

const orcamento = (modelo: string, tipo: string, opcoes?: { pontoDePartida?: boolean }) =>
    (ProviderFactory.prototype.orcamentoPeloTrabalho as Function).call(
        { modeloPadraoDe: () => undefined, defaultProvider: 'x' }, modelo, undefined, tipo, 3550, opcoes);

async function main(): Promise<void> {
    console.log('\n=== S440-1 — o OpenAIProvider entrega os números do servidor à telemetria ===');
    {
        // Resposta no formato real do llama-server (medido no modelo local em 21/10): usage + timings + reasoning_content.
        const srv = http.createServer((req, res) => {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
                choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Oi', reasoning_content: 'pensando um pouco antes' } }],
                usage: { prompt_tokens: 120, completion_tokens: 39 },
                timings: { cache_n: 61, prompt_n: 59, prompt_ms: 2774.1, predicted_n: 39, predicted_ms: 2110.4 },
            }));
        });
        await new Promise<void>(r => srv.listen(0, '127.0.0.1', () => r()));
        const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}/v1`;
        const tele = { provider: 'Modelo local', model: 's440-local', startedAt: new Date().toISOString() } as AttemptTelemetry;
        try {
            await new OpenAIProvider('', 's440-local', base, 'Modelo local').chat([{ role: 'user', content: 'oi' }], undefined, { telemetry: tele });
        } finally { srv.close(); }
        assert(tele.evalTokens === 39 && tele.evalMs === 2110.4, 'tokens e tempo de geração do servidor', tele);
        assert(tele.promptTokens === 59 && tele.promptEvalMs === 2774.1, 'leitura: os tokens lidos AGORA (prompt_n, sem os do cache) e o tempo deles', tele);
        assert(tele.thinkingChars === 'pensando um pouco antes'.length && tele.contentChars === 2 && tele.doneReason === 'stop', 'raciocínio, conteúdo e motivo do fim', tele);

        const o = observacaoDaChamada({ modelo: 's440-local', modo: 'padrao', tipo: 'UnifiedIntentRouter:classifier', status: 'success', tentativa: tele, charsDeEntrada: 400, msTotal: 5000, canceladaPeloUsuario: false });
        assert(o.fonte === 'servidor' && o.tempos === 'servidor', 'a observação vira medição do servidor (antes: tempos=?)', o);
        medidorDoProcesso.registrar(o);
        const v = medidorDoProcesso.velocidade('s440-local', 'padrao');
        assert(!!v.geracao && Math.abs(v.geracao - 39 / 2.1104) < 0.5, 'a velocidade do modelo local passa a existir (~18,5 tok/s)', v);
    }

    console.log('\n=== S440-2 — ponto de partida sem histórico: só para quem pede ===');
    {
        const agente = orcamento('s440-local', 'AgentLoop:loop', { pontoDePartida: true });
        assert(!!agente && agente.origem === 'ponto_de_partida' && agente.tokens === pontoDePartidaEmTokens('AgentLoop:loop'), 'agente sem histórico: ponto de partida declarado', agente);
        assert(!!agente && agente.prazoMs > 210_000, 'no ritmo do modelo local, o prazo passa dos 210 s que cortaram a chamada real', agente?.prazoMs);
        assert(pontoDePartidaEmTokens('AgentLoop:synthesis') === pontoDePartidaEmTokens('AgentLoop:loop'), 'vale para as fases do agente (pelo componente)');
        assert(pontoDePartidaEmTokens('GoalExtractor:classifier') === Math.ceil(2754 * FOLGA), 'classificador de objetivos tem o seu');
        assert(orcamento('s440-local', 'ValidationEngine:saida_contra_evidencia', { pontoDePartida: true }) === null, 'tipo sem ponto declarado: segue sem orçamento');
        assert(orcamento('s440-local', 'AgentLoop:loop') === null, 'sem pedir (como os juízes): comportamento de antes, sem histórico não age');
        assert(orcamento('s440-sem-velocidade', 'AgentLoop:loop', { pontoDePartida: true }) === null, 'sem velocidade medida do modelo: não inventa prazo');

        for (let i = 0; i < 5; i++) {
            medidorDoProcesso.registrar({ modelo: 's440-local', modo: 'padrao', tipo: 'AgentLoop:loop', entradaTokens: 1000, saidaTokens: 800, raciocinioTokens: 0, respostaTokens: 800, msTotal: 50_000, desfecho: 'concluiu', fonte: 'servidor' } as any);
        }
        const comHistorico = orcamento('s440-local', 'AgentLoop:loop', { pontoDePartida: true });
        assert(!!comHistorico && comHistorico.origem === 'historico' && comHistorico.tokens === Math.ceil(800 * FOLGA), 'com 5 conclusões, vale o histórico do próprio modelo', comHistorico);
    }

    console.log('\n=== S440-3 — quem pede e quem não pede ===');
    {
        const src = (f: string) => fs.readFileSync(path.join(process.cwd(), 'src', ...f.split('/')), 'utf-8');
        assert(/orcamentoPeloTrabalho\(chatProfile\?\.model, undefined, `AgentLoop:\$\{phase\}`, totalChars, \{ pontoDePartida: true \}\)/.test(src('loop/AgentLoop.ts')), 'agente pede o ponto de partida');
        assert(/orcamentoPeloTrabalho\(this\.classifierModel, undefined, 'GoalExtractor:classifier', prompt\.length, \{ pontoDePartida: true \}\)/.test(src('loop/GoalExtractor.ts')), 'classificador de objetivos pede o ponto de partida');
        assert(!/pontoDePartida/.test(src('validation/ValidationEngine.ts')), 'juízes não pedem (o orçamento deles vira limite de tokens no provedor)');
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S440 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
