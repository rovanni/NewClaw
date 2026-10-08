/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S343 (issue 065)
 *
 * O escopo do prompt do juiz de grounding era MAIOR que o da ADR-010: a §2 decide sobre "afirmações factuais
 * DERIVADAS DE FERRAMENTAS"; o prompt pedia "CADA afirmação factual da resposta". Com o gatilho "o turno usou alguma
 * ferramenta", uma aula escrita pelo agente virava dezenas de afirmações sem evidência possível — produção (06/10):
 * 1 VALIDATED em 22 julgamentos do glm-5.3, 95–317 s cada; 57 de 280 afirmações NOT_EVALUABLE. Agora o próprio juiz
 * (LLM — a distinção é semântica) julga só o que a resposta apresenta como DADO OBTIDO de ferramenta; um valor
 * atribuído a ferramenta continua sendo julgado mesmo no meio de texto redigido (armadilhas River/Clima).
 * Experimento real (19 casos, glm-5.3 e gemma4): docs/analises-arquiteturais/instrumentos-2026-10-06/.
 *
 * REGRESSÃO SE: o prompt voltar a pedir "cada afirmação factual"; a salvaguarda do valor atribuído a ferramenta sumir;
 * a agregação (REJECTED > NOT_EVALUABLE > VALIDATED; lista vazia = NOT_APPLICABLE) mudar.
 *
 * Execução: npx ts-node src/__tests__/regression/S343_GroundingJudge_ScopeIsToolDerivedData.test.ts
 */
import { ObserverValidator } from '../../loop/ObserverValidator';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}

function capturador(conteudo: string) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getBudgetAuxiliar } = require('../../shared/auxTimeout');
    const prompts: string[] = [];
    const factory = {
        chatWithFallback: async (msgs: Array<{ content: string }>) => {
            prompts.push(msgs[0].content);
            return { status: 'success', content: conteudo, attempts: [] };
        },
        getBudgetAuxiliar: (perfil: 'classificacao' | 'validacao') => getBudgetAuxiliar(perfil, null, null),
    } as unknown as import('../../core/ProviderFactory').ProviderFactory;
    return { factory, prompts };
}
const claims = (...cs: Array<[string, string]>) => JSON.stringify({ claims: cs.map(([c, v]) => ({ claim: c, evidence: ['E1'], verdict: v })) });
const PPTX = [{ id: 'E1', tool: 'exec_command', input: '{"command":"py -3 gerar_aula.py"}', output: 'Apresentação salva: aula.pptx (19 slides)' }];
const AULA = 'Gerei aula.pptx com 19 slides. A rede elétrica no Brasil opera em 60 Hz e P = V × I.';

async function main(): Promise<void> {
    console.log('\n=== S343-1 — o prompt enviado ao juiz restringe o escopo a dado obtido de ferramenta ===');
    {
        const { factory, prompts } = capturador(claims(['aula.pptx tem 19 slides', 'SUPPORTED']));
        await new ObserverValidator(factory, 'modelo-de-teste').validateGrounding(AULA, PPTX);
        const p = prompts[0] ?? '';
        assert(/apresenta como DADO OBTIDO das evidências/.test(p), 'escopo: afirmações apresentadas como dado obtido das evidências', p.slice(0, 200));
        assert(!/Para CADA afirmação factual da resposta/.test(p), 'não pede mais "CADA afirmação factual da resposta"');
        assert(/texto que o assistente redigiu \(explicação,\s*conteúdo didático, conhecimento geral/.test(p), 'texto redigido, conteúdo didático e conhecimento geral ficam fora');
        // Sprint V3: o juiz agora RECEBE o pedido (seção de contexto); o que a resposta só repete dele continua fora.
        assert(/o que a resposta só repete\s*do PEDIDO DO USUÁRIO/.test(p) && /o que o\s*assistente diz que fez ou vai fazer/.test(p), 'o que só repete o pedido e ações do assistente ficam fora');
        assert(/É dado obtido, mesmo no meio de\s*texto redigido — inclua-o/.test(p), 'salvaguarda: valor atribuído a ferramenta é julgado mesmo no meio de texto redigido (River/Clima)');
        assert(/REGRA CRÍTICA: ausência de contradição NÃO é suporte/.test(p), 'regra crítica da ADR-010 preservada');
        assert(p.includes(AULA) && p.includes('Apresentação salva: aula.pptx (19 slides)'), 'resposta e evidência chegam inteiras');
    }

    console.log('\n=== S343-2 — agregação inalterada ===');
    const estado = async (conteudo: string) => (await new ObserverValidator(capturador(conteudo).factory, 'modelo-de-teste').validateGrounding(AULA, PPTX)).state;
    assert(await estado(claims(['19 slides', 'SUPPORTED'])) === 'VALIDATED', 'só SUPPORTED → VALIDATED');
    assert(await estado(claims(['19 slides', 'SUPPORTED'], ['texto editável', 'NOT_EVALUABLE'])) === 'NOT_EVALUABLE', 'uma NOT_EVALUABLE → NOT_EVALUABLE');
    assert(await estado(claims(['25 slides', 'NOT_SUPPORTED'], ['texto editável', 'NOT_EVALUABLE'])) === 'REJECTED', 'NOT_SUPPORTED tem precedência → REJECTED');
    assert(await estado(JSON.stringify({ claims: [] })) === 'NOT_APPLICABLE', 'nenhuma afirmação de dado obtido → NOT_APPLICABLE (entrega segue)');

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S343 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    if (failed > 0) process.exitCode = 1;
}
main().catch((err) => { console.error('S343 erro inesperado:', err); process.exitCode = 1; });
