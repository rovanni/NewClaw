/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S271
 *
 * Achado real (26/08/2026, prompt.txt + newclaw-audit.log): "Vai chover amanhã?" — a ferramenta
 * `weather` retornou dados limpos e estruturados, a síntese teve sucesso, mas o juiz de
 * groundedness abortou por timeout (`[STREAM] ABORTED: This operation was aborted`, budget de
 * 15000ms) e o texto parcial de "thinking" recuperado não era JSON válido
 * (`saída do juiz sem estrutura válida — UNVALIDATED`). O usuário recebeu o bloqueio genérico,
 * mesmo a ferramenta tendo funcionado perfeitamente.
 *
 * Rastreamento no log confirmou que ISSO NÃO É NOVO — o mesmo padrão
 * ("[GROUNDING] estado=UNVALIDATED", por timeout ou saída malformada) já aparece em
 * 16/08, 17/08 e 24/08 (7 ocorrências antes desta), então não foi introduzido pelas correções
 * anteriores desta campanha (categoria no aprendizado, recuperação parcial).
 *
 * Causa raiz: `CircuitBreaker.recordSuccess(duration)` é chamado por TODO `chatWithFallback`
 * bem-sucedido (`ProviderFactory.ts`), sem distinguir o TIPO de chamada — uma média móvel única
 * por provedor mistura chamadas rápidas (roteamento, classificação, várias por turno) com a
 * chamada pesada de julgamento de grounding (multi-afirmação, modelo de raciocínio). Como as
 * chamadas rápidas são mais frequentes, `getLatenciaTipicaMs('ollama')` fica cronicamente baixa,
 * e `latencia × fator` (perfil `validacao`, ADR-010 §8) raramente supera o piso — o piso de
 * 15000ms VIRA o orçamento de fato para grounding, mesmo esse julgamento tipicamente precisando
 * de ~8-21s+ neste modelo.
 *
 * Correção: piso do perfil `validacao` subiu de 15000ms para 30000ms — parâmetro dentro do MESMO
 * mecanismo que a ADR-010 §8 já decidiu reutilizar (getBudgetAuxiliar), não uma constante nova
 * nem um mecanismo novo. Segmentar a latência típica por tipo de chamada (correção estrutural
 * mais completa) fica registrada como melhoria pendente, fora do escopo desta correção pontual.
 *
 * Execução: npx ts-node src/__tests__/regression/S271_AuxTimeout_ValidacaoFloorRaised.test.ts
 */

import { getBudgetAuxiliar } from '../../shared/auxTimeout';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  OK ${message}`); passed++; }
    else { console.error(`  FALHOU: ${message}`, detail ?? ''); failed++; }
}

function fonteFixa(latenciaMs: number | null) {
    return { getLatenciaTipicaMs: () => latenciaMs };
}

async function main(): Promise<void> {

console.log('\n=== S271-1 — piso do perfil validacao subiu de 15000ms para 30000ms (achado real: 15s abortava julgamentos legítimos) ===');
{
    // Latência baixa (o cenário real: chamadas rápidas dominando a média do provedor) — antes
    // caía no piso de 15000ms; agora o mesmo cenário cai no piso de 30000ms.
    const orc = getBudgetAuxiliar('validacao', 'ollama', fonteFixa(2_000)); // 2000*4=8000, abaixo do piso
    assert(orc.timeoutMs === 30_000, `com latência medida baixa (2000ms), o orçamento usa o NOVO piso (30000ms), não mais 15000ms (recebido: ${orc.timeoutMs}ms)`, orc);
}

console.log('\n=== S271-2 — reprodução do achado: 15000ms era insuficiente para o julgamento real observado (~8-21s+) ===');
{
    // O caso real (log 18:33:17-18:33:32): abortou aos 15039ms sem concluir, ainda "pensando".
    // Outros julgamentos reais no mesmo log só concluíram com veredito válido entre 8s e 21s+.
    // Com o piso antigo, um julgamento de ~20s SEMPRE abortava; com o novo piso, tem margem.
    const duracaoRealObservadaMs = 20_000;
    const orcAntigo = 15_000;
    const orcNovo = getBudgetAuxiliar('validacao', 'ollama', fonteFixa(2_000)).timeoutMs;
    assert(duracaoRealObservadaMs > orcAntigo, 'sanity: a duração real observada (~20s) já excedia o piso antigo (15s) — por isso abortava', { duracaoRealObservadaMs, orcAntigo });
    assert(duracaoRealObservadaMs < orcNovo, 'com o novo piso (30s), a mesma duração real observada (~20s) agora cabe no orçamento', { duracaoRealObservadaMs, orcNovo });
}

console.log('\n=== S271-3 — não regride o comportamento já coberto por S186: perfil validacao continua mais tolerante que classificacao, e o padrão (sem medição) continua 45000ms ===');
{
    const c = getBudgetAuxiliar('classificacao', 'ollama', fonteFixa(10_000));
    const v = getBudgetAuxiliar('validacao', 'ollama', fonteFixa(10_000));
    assert(v.timeoutMs > c.timeoutMs, 'validação continua tolerando mais que classificação para a mesma latência', { c: c.timeoutMs, v: v.timeoutMs });

    const semMedicao = getBudgetAuxiliar('validacao', 'ollama', fonteFixa(null));
    assert(semMedicao.timeoutMs === 45_000, 'sem medição, o padrão continua 45000ms (inalterado por este achado)', semMedicao);

    // Com latência ALTA o suficiente, o orçamento medido já superava os dois pisos (antigo e
    // novo) — este achado não muda esse caso, só o caso de latência baixa/média.
    const latenciaAlta = getBudgetAuxiliar('validacao', 'ollama', fonteFixa(10_000));
    assert(latenciaAlta.timeoutMs === 40_000, 'com latência alta (10000ms×4=40000ms, acima de ambos os pisos), o orçamento medido continua governando, não o piso', latenciaAlta);
}

console.log('\n=== S271-4 — teto subiu de 120000ms para 300000ms (modelos locais lentos), mecanismo (getBudgetAuxiliar, sem constante nova) intocado ===');
{
    const orcTeto = getBudgetAuxiliar('validacao', 'ollama', fonteFixa(999_999));
    assert(orcTeto.timeoutMs === 300_000, 'novo teto de 300000ms (5min) — dá espaço a um provedor local cuja latência medida justifique orçamento maior', orcTeto);

    // Provedor local "lento mas consistente": latência medida de 40s por chamada — antes o teto
    // de 120s cortava 40s×4=160s pela metade; agora cabe inteiro.
    const provedorLocalLento = getBudgetAuxiliar('validacao', 'Modelo local', fonteFixa(40_000));
    assert(provedorLocalLento.timeoutMs === 160_000, 'provedor com latência medida de 40s recebe orçamento de 160s (40s×4) — agora cabe sob o novo teto de 300s', provedorLocalLento);
}

console.log('\n=== S271-5 — o teto novo não é ilimitado: AGENT_RESPONSE_TIMEOUT_MS (10min, todo o turno) continua maior que o teto de grounding (5min) sozinho ===');
{
    const orcTeto = getBudgetAuxiliar('validacao', 'ollama', fonteFixa(999_999));
    const turnoInteiroMs = 10 * 60 * 1000;
    assert(orcTeto.timeoutMs < turnoInteiroMs, 'o teto de grounding fica abaixo do orçamento do turno inteiro — sobra margem para tool calls e síntese que já rodaram antes', { grounding: orcTeto.timeoutMs, turno: turnoInteiroMs });
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S271 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exit(1);

}

main().catch(err => { console.error('ERRO NÃO TRATADO:', err); process.exit(1); });
