/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S208
 * Substituição que atravessa fronteira vira fato na resposta (`RFC-005` §1.4, Sprint 022).
 *
 * CONTEXTO: é o incidente que originou a RFC-005. Produção, 05/08/2026 — o turno pediu
 * `GLM-4.7-Flash` (local), o llamafile não respondeu, e a resposta veio de `glm-5.2:cloud`. O
 * usuário recebeu resposta de nuvem tendo configurado modelo local, sem nenhum aviso. A Sprint 020
 * parou de contabilizar aquilo como avaria; a 021 deu como proibir a troca; esta faz o usuário
 * ficar sabendo quando ela acontece.
 *
 * O MECANISMO, e por que não é o Core escrevendo texto: o fato entra nas mensagens enviadas ao
 * provider substituto, junto com o pedido de verbalizá-lo. Quem redige é o LLM — que já recebeu
 * `buildLanguageDirective` no system prompt e portanto responde no idioma da conversa. Texto fixo
 * emitido pelo Core sairia sempre em português (`ARCHITECTURE.md`, "Gaps conhecidos"), que é
 * justamente o que a `RFC-004` decidiu parar de fazer.
 *
 * REGRESSÃO SE: o aviso passar a ser injetado em chamadas que não vão ao usuário (classificador,
 * extrator de goal, validador — a saída deles é estruturada e um aviso a corromperia); a troca de
 * um provedor de nuvem por outro equivalente passar a ser anunciada (é a resiliência ordinária que
 * o §1.2 autoriza a ser silenciosa); uma substituição entre dois recursos DA MÁQUINA do usuário for
 * anunciada como se tivesse saído dela; ou o array de mensagens original for mutado.
 *
 * Execução: npx ts-node src/__tests__/regression/S208_SubstitutionAnnounced.test.ts
 */

import { ProviderFactory } from '../../core/ProviderFactory';
import type { LLMMessage, LLMResponse, ILLMProvider, ToolDefinition, ChatOptions } from '../../core/providerTypes';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

/** URL impossível de parsear: falha imediata e NÃO retentável (ver S207). */
const MORTO = 'endpoint-de-teste-sem-servidor';

/**
 * Provider-espião: anota as mensagens que recebeu e responde com sucesso.
 *
 * Substitui rede por observação direta — é o que permite verificar o que o substituto REALMENTE
 * recebeu, em vez de confiar num sinalizador que o próprio código sob teste preencheu.
 */
class ProviderEspiao implements ILLMProvider {
    readonly name = 'espiao';
    recebidas: LLMMessage[][] = [];
    setModel(_model: string): void { /* o espião não troca de modelo */ }
    async chat(messages: LLMMessage[], _tools?: ToolDefinition[], _options?: ChatOptions): Promise<LLMResponse> {
        this.recebidas.push(messages);
        return { content: 'resposta do substituto' };
    }
}

/**
 * Provider que sempre falha, de forma permanente.
 *
 * "falha sintética permanente" não casa com nenhum padrão retentável do `chatWithFallback` — sem
 * isso cada tentativa custaria ~10s de backoff (ver S207). Como o recurso declarado precisa ser
 * loopback para a fronteira existir, e uma URL loopback inalcançável dá "fetch failed" (retentável),
 * o stub é a única forma de ter as duas coisas: endereço local declarado E falha barata.
 */
class ProviderQuebrado implements ILLMProvider {
    readonly name = 'quebrado';
    setModel(_model: string): void { /* nunca chega a ser usado */ }
    async chat(): Promise<LLMResponse> { throw new Error('falha sintética permanente'); }
}

function substituirInstancia(pf: ProviderFactory, nome: string, instancia: ILLMProvider): void {
    (pf as unknown as { providers: Map<string, ILLMProvider> }).providers.set(nome, instancia);
}

/** Injeta o espião como um provider a mais, sob o nome pedido. */
function comEspiao(pf: ProviderFactory, nome: string): ProviderEspiao {
    const espiao = new ProviderEspiao();
    substituirInstancia(pf, nome, espiao);
    return espiao;
}

/**
 * Prepara o cenário: o recurso declarado falha na hora, e o circuito começa limpo.
 *
 * O `circuitRegistry` é um singleton de módulo — sem o reset, o circuito aberto por um bloco vaza
 * para o seguinte e o `chatWithFallback` devolve `ALL_PROVIDERS_CIRCUIT_OPEN` antes de exercitar
 * qualquer coisa. É o débito "a suíte não isola estado entre testes", registrado na Fase 0;
 * enquanto ele existir, cada teste que compartilha esse registro precisa se defender sozinho.
 */
function declaradoFalha(pf: ProviderFactory, nome: string): void {
    substituirInstancia(pf, nome, new ProviderQuebrado());
    pf.circuitBreakers.resetAll();
}

const PERGUNTA: LLMMessage[] = [{ role: 'user', content: 'qual é a capital da França?' }];

async function main(): Promise<void> {
    const envOriginal = process.env.SUBSTITUTION_POLICY;
    delete process.env.SUBSTITUTION_POLICY;

    try {
        console.log('\n=== S208-1 — local declarado → substituto remoto: o fato chega ao modelo ===');
        {
            const pf = new ProviderFactory({
                defaultProvider: 'Modelo local',
                ollamaUrl: MORTO,
                customProviders: [
                    { label: 'Modelo local', baseUrl: 'http://127.0.0.1:8080/v1' },
                    { label: 'Nuvem', baseUrl: 'https://api.exemplo.test/v1' },
                ],
            });
            const espiao = comEspiao(pf, 'Nuvem');
            declaradoFalha(pf, 'Modelo local');

            const original = [...PERGUNTA];
            const r = await pf.chatWithFallback(PERGUNTA, undefined, 'Modelo local', 2000, undefined, undefined,
                { anunciarSubstituicao: true });

            assert(r.status === 'success', 'o turno completa pelo substituto', r.status);
            assert(espiao.recebidas.length === 1, 'o substituto foi chamado', espiao.recebidas.length);

            const recebidas = espiao.recebidas[0] ?? [];
            const fato = recebidas.find(m => m.role === 'system' && String(m.content).includes('[FATO DO SISTEMA]'));
            assert(!!fato, 'o fato da substituição chegou ao modelo que respondeu', recebidas);
            assert(
                String(fato?.content).includes('Modelo local') && String(fato?.content).includes('Nuvem'),
                'e nomeia os dois recursos: o que o usuário escolheu e o que respondeu',
                fato?.content,
            );
            assert(
                /idioma da conversa/i.test(String(fato?.content)),
                'pede verbalização no idioma da conversa — o Core não escreve a frase',
                fato?.content,
            );
            assert(
                r.substitution?.declared === 'Modelo local' && r.substitution?.used === 'Nuvem' && r.substitution?.announced === true,
                'e o resultado carrega o fato estruturado',
                r.substitution,
            );

            assert(
                PERGUNTA.length === original.length && PERGUNTA[0].content === original[0].content,
                'o array de mensagens de quem chamou não é mutado',
                PERGUNTA,
            );
        }

        console.log('\n=== S208-2 — sem opt-in, nada é injetado (chamadas estruturadas) ===');
        {
            const pf = new ProviderFactory({
                defaultProvider: 'Modelo local',
                ollamaUrl: MORTO,
                customProviders: [
                    { label: 'Modelo local', baseUrl: 'http://127.0.0.1:8080/v1' },
                    { label: 'Nuvem', baseUrl: 'https://api.exemplo.test/v1' },
                ],
            });
            const espiao = comEspiao(pf, 'Nuvem');
            declaradoFalha(pf, 'Modelo local');

            const r = await pf.chatWithFallback(PERGUNTA, undefined, 'Modelo local', 2000);

            const recebidas = espiao.recebidas[0] ?? [];
            assert(
                !recebidas.some(m => String(m.content).includes('[FATO DO SISTEMA]')),
                'classificador/extrator/validador não recebem aviso — a saída deles é estruturada',
                recebidas,
            );
            assert(r.substitution?.announced === false,
                'a substituição é registrada, mas não anunciada', r.substitution);
        }

        console.log('\n=== S208-3 — nuvem → nuvem não atravessa fronteira, logo não anuncia ===');
        {
            const pf = new ProviderFactory({
                defaultProvider: 'Nuvem A',
                ollamaUrl: MORTO,
                customProviders: [
                    { label: 'Nuvem A', baseUrl: 'https://a.exemplo.test/v1' },
                    { label: 'Nuvem B', baseUrl: 'https://b.exemplo.test/v1' },
                ],
            });
            const espiao = comEspiao(pf, 'Nuvem B');
            declaradoFalha(pf, 'Nuvem A');

            const r = await pf.chatWithFallback(PERGUNTA, undefined, 'Nuvem A', 2000, undefined, undefined,
                { anunciarSubstituicao: true });

            const recebidas = espiao.recebidas[0] ?? [];
            assert(
                !recebidas.some(m => String(m.content).includes('[FATO DO SISTEMA]')),
                'dois provedores equivalentes se cobrindo é resiliência ordinária, e pode ser silenciosa (§1.2)',
                recebidas,
            );
            assert(r.substitution?.announced === false, 'registrada, não anunciada', r.substitution);
        }

        console.log('\n=== S208-4 — local → local NÃO é anunciado como se tivesse saído da máquina ===');
        {
            const pf = new ProviderFactory({
                defaultProvider: 'Modelo local',
                // Ollama nativo em loopback: continua sendo a máquina do usuário. Anunciar "saiu da
                // sua máquina" aqui seria um aviso FALSO — pior que aviso nenhum.
                ollamaUrl: 'http://localhost:11434',
                customProviders: [{ label: 'Modelo local', baseUrl: 'http://127.0.0.1:8080/v1' }],
            });
            const espiao = comEspiao(pf, 'ollama');
            declaradoFalha(pf, 'Modelo local');

            const r = await pf.chatWithFallback(PERGUNTA, undefined, 'Modelo local', 2000, undefined, undefined,
                { anunciarSubstituicao: true });

            const recebidas = espiao.recebidas[0] ?? [];
            assert(
                !recebidas.some(m => String(m.content).includes('[FATO DO SISTEMA]')),
                'llamafile local caindo para Ollama local não atravessa fronteira de localidade',
                recebidas,
            );
            assert(r.substitution?.announced === false, 'registrada, não anunciada', r.substitution);
        }

        console.log('\n=== S208-5 — `estrita` não chega a anunciar: não há substituição ===');
        {
            const pf = new ProviderFactory({
                defaultProvider: 'Modelo local',
                ollamaUrl: MORTO,
                customProviders: [
                    { label: 'Modelo local', baseUrl: MORTO, substitutionPolicy: 'estrita' },
                    { label: 'Nuvem', baseUrl: 'https://api.exemplo.test/v1' },
                ],
            });
            const espiao = comEspiao(pf, 'Nuvem');
            declaradoFalha(pf, 'Modelo local');

            const r = await pf.chatWithFallback(PERGUNTA, undefined, 'Modelo local', 2000, undefined, undefined,
                { anunciarSubstituicao: true });

            assert(espiao.recebidas.length === 0, 'o substituto nem chega a ser chamado', espiao.recebidas.length);
            assert(r.fallbackReason === 'policy_strict', 'a recusa continua valendo', r.fallbackReason);
            assert(r.substitution === undefined, 'e não há substituição a registrar', r.substitution);
        }

        console.log(`\nS208 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
        console.log(`\nCOBERTURA:`);
        console.log(`  Fato entregue ao modelo substituto, com pedido de verbalização: testado`);
        console.log(`  Resultado carrega a substituição estruturada: testado`);
        console.log(`  Sem opt-in, chamadas estruturadas não recebem aviso: testado`);
        console.log(`  Nuvem→nuvem e local→local não anunciam: testado`);
        console.log(`  Mensagens de quem chamou não são mutadas: testado`);
        console.log(`  estrita continua recusando antes de qualquer anúncio: testado`);
    } finally {
        if (envOriginal === undefined) delete process.env.SUBSTITUTION_POLICY;
        else process.env.SUBSTITUTION_POLICY = envOriginal;
    }

    if (failed > 0) process.exit(1);
}

main().catch(err => { console.error('Erro inesperado:', err); process.exit(1); });
