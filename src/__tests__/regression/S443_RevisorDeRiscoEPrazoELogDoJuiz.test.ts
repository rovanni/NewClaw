/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S443
 * (1) O revisor que reescreve o plano reprovado pelo juiz de risco não usa mais um prazo fixo de 60 s: o prazo também respeita
 *     o trabalho medido do modelo (ADR-024), com ponto de partida declarado sem histórico — só estende.
 * (2) O log do juiz de grounding não diz "bloqueando entrega" para o veredito que é ENTREGUE com aviso.
 *
 * EVIDÊNCIA (produção Windows, outubro/2026): 50 revisões de plano, 31 cortadas aos 60 s — cortada, o plano original seguia e
 * os riscos apontados pelo juiz eram ignorados. Só 2 revisões concluíram (abaixo da amostra mínima de 5): sem ponto de
 * partida, o orçamento nunca se formava. E 35 vezes desde 15/10 o log dizia "UNVALIDATED — bloqueando entrega" na linha
 * imediatamente anterior a "entregando COM AVISO".
 *
 * Execução: npx ts-node src/__tests__/regression/S443_RevisorDeRiscoEPrazoELogDoJuiz.test.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { pontoDePartidaEmTokens, FOLGA } from '../../core/medidorDeTrabalho';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}
const src = (f: string) => fs.readFileSync(path.join(process.cwd(), 'src', ...f.split('/')), 'utf-8');

console.log('\n=== S443-1 — revisor de risco: prazo pelo trabalho, nunca menor que antes ===');
{
    const ra = src('loop/RiskAnalyzer.ts');
    assert(pontoDePartidaEmTokens('RiskAnalyzer:risk') === Math.ceil(5895 * FOLGA), 'ponto de partida declarado para o revisor');
    assert(/orcamentoPeloTrabalho\(this\.model \|\| undefined, undefined, 'RiskAnalyzer:risk', prompt\.length, \{ pontoDePartida: true \}\)/.test(ra), 'o revisor pede o prazo pelo trabalho');
    assert(/const prazoDoRevisor = Math\.max\(60_000, pelaTarefa\?\.prazoMs \?\? 0\);/.test(ra), 'só estende: nunca menos que os 60 s de antes');
    assert(/this\.callRiskLLM\(\s*\[\{ role: 'user', content: prompt \}\] as LLMMessage\[\],\s*prazoDoRevisor,/.test(ra), 'a chamada usa esse prazo (não mais o 60_000 fixo)');
}

console.log('\n=== S443-2 — o log do juiz diz o que acontece ===');
{
    const al = src('loop/AgentLoop.ts');
    assert(!/\[GROUNDING\] estado=\$\{g\.state\} — bloqueando entrega/.test(al), 'sem "bloqueando entrega" para qualquer estado');
    assert(/\[GROUNDING\] estado=\$\{g\.state\} — resposta não confirmada pelo juiz/.test(al), 'registra o veredito sem antecipar o destino');
    assert(/juiz não concluiu — entregando COM AVISO/.test(al), 'o destino de UNVALIDATED segue registrado à parte');
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S443 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;
