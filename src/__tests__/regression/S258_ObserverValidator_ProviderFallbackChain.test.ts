/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S258
 *
 * Origem: campanha de investigação "clima não entregue" (2026-08-24) — prompt.txt (conversas
 * reais com o NewClaw) cruzado com logs/newclaw-audit.log, três turnos reais (16:11, 17:45,
 * 19:12), todos terminando em "Não consegui confirmar se a resposta é sustentada pelos dados
 * obtidos nesta tentativa."
 *
 * CAUSA RAIZ: `ObserverValidator.validate()` e `.validateGrounding()` chamavam
 * `providerFactory.getProviderWithModel(this.observerModel)` diretamente — UM único provider fixo
 * (sempre `this.defaultProvider`, porque `getProviderWithModel()` sem `providerName` explícito cai
 * nele — ver comentário em `ProviderFactory.getProviderWithModel()`), sem NENHUM fallback. Com o
 * provedor padrão do usuário apontando para um modelo local lento (GLM-4.7-Flash 30B, ~150s por
 * resposta comum neste hardware), o juiz de grounding nunca tinha como concluir dentro do orçamento
 * de `getBudgetAuxiliar('validacao')` (até 120s) — mesmo com `OBSERVER_MODEL=glm-5.2:cloud`
 * configurado (nunca chegava a ser usado: `getProviderWithModel` ignora qual provedor o nome do
 * modelo pertence, só olha `this.defaultProvider`). Resultado observado nos 3 turnos: SEMPRE
 * `UNVALIDATED`, entrega SEMPRE bloqueada — inclusive no turno 19:12, onde a ferramenta `weather`
 * teve sucesso e trouxe dado real (log 19:18:14), e mesmo assim a resposta nunca chegou ao usuário.
 *
 * MESMA classe de bug do incidente River #2 (11/08/2026, GoalPlanner.callPlannerLLM, S221-S224/
 * S222): um provider único e fixo, sem cadeia de fallback, degradando um turno inteiro mesmo
 * havendo outro provider saudável disponível. A correção aqui é a MESMA já estabelecida e testada
 * naquele incidente — trocar a chamada direta por `chatWithFallback`, reusando o mecanismo de
 * resiliência que o resto do AgentLoop já usa, em vez de inventar um novo.
 *
 * REGRESSÃO SE: `validate()` ou `validateGrounding()` voltarem a chamar `getProviderWithModel()`
 * diretamente (perde o fallback); ou pararem de repassar `this.observerModel` como modelOverride
 * (perde a role determinística já configurada pelo operador); ou passarem `preferredProvider` fixo
 * (mudaria a ordem de fallback sem necessidade, mesma regra da S222).
 *
 * Execução: npx ts-node src/__tests__/regression/S258_ObserverValidator_ProviderFallbackChain.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { ObserverValidator, EvidenceItem } from '../../loop/ObserverValidator';
import type { ProviderFactory, LLMResult } from '../../core/ProviderFactory';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

function makeValidator(chatWithFallback: ProviderFactory['chatWithFallback'], observerModel = 'glm-5.2:cloud'): ObserverValidator {
    const fakeProviderFactory = {
        getProviderWithModel: () => {
            throw new Error('S258: validate()/validateGrounding() não devem mais chamar getProviderWithModel diretamente');
        },
        chatWithFallback,
        getBudgetAuxiliar: (perfil: 'classificacao' | 'validacao') => {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const { getBudgetAuxiliar } = require('../../shared/auxTimeout');
            return getBudgetAuxiliar(perfil, null, null);
        },
    } as unknown as ProviderFactory;
    return new ObserverValidator(fakeProviderFactory, observerModel);
}

const EVID: EvidenceItem[] = [{ id: 'E1', tool: 'weather', output: 'Cornélio Procópio: 17.9°C, parcialmente nublado' }];

async function main(): Promise<void> {

console.log('\n=== S258-1 — estrutural: nem validate() nem validateGrounding() usam mais um provider fixo ===');
{
    const source = fs.readFileSync(path.join(__dirname, '../../loop/ObserverValidator.ts'), 'utf-8');

    const startValidate = source.indexOf('async validate(');
    const endValidate = source.indexOf('\n    private buildCorrectedResponse');
    const bodyValidate = source.slice(startValidate, endValidate);
    assert(!/\.getProviderWithModel\(/.test(bodyValidate), 'validate() não CHAMA mais getProviderWithModel (menção em comentário é esperada)');
    assert(/this\.providerFactory\.chatWithFallback\(/.test(bodyValidate), 'validate() chama chatWithFallback');
    assert(/this\.observerModel/.test(bodyValidate), 'validate() ainda repassa observerModel (como modelOverride, não mais preso a getProviderWithModel)');

    const startGrounding = source.indexOf('async validateGrounding(');
    const endGrounding = source.indexOf('\n    /**\n     * Validação ESTRUTURAL');
    const bodyGrounding = source.slice(startGrounding, endGrounding);
    assert(!/\.getProviderWithModel\(/.test(bodyGrounding), 'validateGrounding() não CHAMA mais getProviderWithModel (menção em comentário é esperada)');
    assert(/this\.providerFactory\.chatWithFallback\(/.test(bodyGrounding), 'validateGrounding() chama chatWithFallback');
    assert(/orcamento\.timeoutMs/.test(bodyGrounding), 'validateGrounding() continua usando o orçamento de getBudgetAuxiliar(\'validacao\') — nenhuma constante de timeout nova');
}

console.log('\n=== S258-2 — validateGrounding(): repassa observerModel como modelOverride, preferredProvider livre ===');
{
    let capturedArgs: unknown[] = [];
    const validator = makeValidator((async (...args: unknown[]) => {
        capturedArgs = args;
        return { status: 'success', content: '{"claims":[{"claim":"17.9°C","verdict":"SUPPORTED","evidence_id":"E1"}]}', attempts: [] } as LLMResult;
    }) as ProviderFactory['chatWithFallback'], 'glm-5.2:cloud');

    const verdict = await validator.validateGrounding('Está 17.9°C em Cornélio Procópio.', EVID);

    assert(verdict.state === 'VALIDATED', 'juiz concluiu normalmente quando chatWithFallback tem sucesso', verdict);
    assert(capturedArgs[5] === 'glm-5.2:cloud', 'observerModel repassado como modelOverride (preserva a role configurada pelo operador)', capturedArgs[5]);
    assert(capturedArgs[2] === undefined, 'preferredProvider não é fixado — ordem de fallback continua a padrão', capturedArgs[2]);
}

console.log('\n=== S258-3 — validateGrounding(): provider preferido (local) falha, fallback (ollama) resolve — CASO REAL DO INCIDENTE ===');
{
    // Reproduz exatamente o que os 3 turnos do prompt.txt deveriam ter feito: "Modelo local"
    // indisponível/lento não pode mais significar "juiz nunca conclui". chatWithFallback já
    // decide sozinho quando cair para o próximo provider — o teste simula o resultado FINAL
    // agregado que ele devolve nesse cenário (mesma técnica do S222-4).
    const validator = makeValidator((async () => ({
        status: 'success',
        content: '{"claims":[{"claim":"parcialmente nublado","verdict":"SUPPORTED","evidence_id":"E1"}]}',
        attempts: [
            { provider: 'Modelo local', model: 'default', duration: 30011, status: 'error' as const, errorMessage: 'This operation was aborted' },
            { provider: 'Modelo local', model: 'default', duration: 41567, status: 'error' as const, errorMessage: 'This operation was aborted' },
            { provider: 'ollama', model: 'glm-5.2:cloud', duration: 2100, status: 'success' as const },
        ],
    } as LLMResult)) as ProviderFactory['chatWithFallback']);

    const verdict = await validator.validateGrounding('Cornélio Procópio está parcialmente nublado.', EVID);

    assert(verdict.state === 'VALIDATED', 'resposta grounded é ENTREGUE quando o provedor padrão falha mas o fallback resolve — este é exatamente o caso que faltava nos 3 turnos reais', verdict);
}

console.log('\n=== S258-4 — validateGrounding(): quando TODOS os providers falham, ainda é UNVALIDATED (fail-closed preservado) ===');
{
    const validator = makeValidator((async () => ({
        status: 'error',
        content: '',
        attempts: [
            { provider: 'Modelo local', model: 'default', duration: 30011, status: 'error' as const, errorMessage: 'This operation was aborted' },
            { provider: 'ollama', model: 'glm-5.2:cloud', duration: 5000, status: 'error' as const, errorMessage: 'ECONNREFUSED' },
        ],
    } as LLMResult)) as ProviderFactory['chatWithFallback']);

    const verdict = await validator.validateGrounding('Está chovendo.', EVID);

    assert(verdict.state === 'UNVALIDATED', 'ADR-010 §9 preservado: falha de TODOS os providers ainda nunca vira aprovação', verdict);
    assert(/juiz não concluiu/.test(verdict.reason), 'motivo nomeia a falha do juiz, não um erro genérico', verdict.reason);
}

console.log('\n=== S258-5 — validate() (Q3, checagem de qualidade pós-execução): mesmo fallback, mesmo contrato ===');
{
    const validator = makeValidator((async () => ({
        status: 'success',
        content: '{"approved":true,"confidence":0.8,"reason":"resposta atende ao pedido"}',
        attempts: [
            { provider: 'Modelo local', model: 'default', duration: 30011, status: 'error' as const, errorMessage: 'This operation was aborted' },
            { provider: 'ollama', model: 'glm-5.2:cloud', duration: 1800, status: 'success' as const },
        ],
    } as LLMResult)) as ProviderFactory['chatWithFallback']);

    // toolUsed fora de KNOWN_GOOD_TOOLS ('weather' teria aprovação determinística e nunca chegaria
    // ao LLM) — precisa passar pelas 4 checagens determinísticas sem concluir, só assim cai no
    // caminho LLM que este teste quer exercitar.
    const result = await validator.validate(
        'pergunta', 'intent', 'ferramenta_sem_regra_conhecida',
        'saída legítima da ferramenta, com conteúdo suficiente pra não ser tratada como erro/vazia',
        'Aqui está uma resposta final completa, com mais de quinze caracteres.',
    );

    assert(result.approved === true, 'validate() também se recupera quando o provedor padrão falha mas o fallback resolve', result);
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S258 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;

}

main().catch((err) => {
    console.error('S258 erro inesperado:', err);
    process.exitCode = 1;
});
