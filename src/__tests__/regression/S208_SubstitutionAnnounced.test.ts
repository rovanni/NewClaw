/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S208
 * Nenhuma substituição de provedor: a falha do recurso escolhido é o resultado (diretiva de 14/10/2026).
 *
 * CONTEXTO: é o incidente que originou a RFC-005. Produção, 05/08/2026 — o turno pediu
 * `GLM-4.7-Flash` (local), o llamafile não respondeu, e a resposta veio de `glm-5.2:cloud`. O
 * usuário recebeu resposta de nuvem tendo configurado modelo local, sem nenhum aviso. A Sprint 020
 * parou de contabilizar aquilo como avaria; a 021 deu como proibir a troca; a 022 (versão anterior
 * deste teste) fazia o usuário ficar sabendo quando ela acontecia — o fato da troca entrava nas
 * mensagens do substituto.
 *
 * 14/10/2026 — diretiva da mantenedora: "O sistema é para utilizar somente os modelos escolhidos pelo
 * usuário via dashboard ou na configuração inicial, não deve ter nenhum modelo em código nem de
 * fallback". A cadeia passou a ter só o provedor declarado (ProviderFactory.getFallbackOrder) e a
 * refação sem streaming no Ollama só vale quando o declarado JÁ é o Ollama. Não há mais troca a
 * anunciar: três cenários provam que o substituto nunca é chamado; a Sprint 4 removeu a política (RFC-005) e o anúncio, e S208-4 trava a remoção.
 *
 * REGRESSÃO SE: qualquer outro provedor — nuvem ou local —
 * responder no lugar do escolhido; a falha do escolhido voltar como sucesso; ou
 * o array de mensagens de quem chamou for mutado.
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

/** Provider-espião: anota as mensagens que recebeu e responde com sucesso — se for chamado, houve substituição. */
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
 * Provider que sempre falha, de forma permanente — "falha sintética permanente" não casa com nenhum
 * padrão retentável do `chatWithFallback` (sem isso cada tentativa custaria ~10s de backoff, ver S207).
 */
class ProviderQuebrado implements ILLMProvider {
    readonly name = 'quebrado';
    // Com modelo escolhido: sem ele, o ProviderFactory responde "nenhum modelo escolhido" antes de tentar — e o teste
    // provaria a guarda de modelo, não a falha do recurso escolhido.
    readonly model = 'm-escolhido';
    setModel(_model: string): void { /* nunca chega a ser usado */ }
    async chat(): Promise<LLMResponse> { throw new Error('falha sintética permanente'); }
}

function substituirInstancia(pf: ProviderFactory, nome: string, instancia: ILLMProvider): void {
    (pf as unknown as { providers: Map<string, ILLMProvider> }).providers.set(nome, instancia);
}

function comEspiao(pf: ProviderFactory, nome: string): ProviderEspiao {
    const espiao = new ProviderEspiao();
    substituirInstancia(pf, nome, espiao);
    return espiao;
}

/** O recurso declarado falha na hora, e o circuito começa limpo (o registro de circuitos é singleton de módulo). */
function declaradoFalha(pf: ProviderFactory, nome: string): void {
    substituirInstancia(pf, nome, new ProviderQuebrado());
    pf.circuitBreakers.resetAll();
}

const PERGUNTA: LLMMessage[] = [{ role: 'user', content: 'qual é a capital da França?' }];

type Cenario = { titulo: string; declarado: string; substituto: string; ollamaUrl: string; customProviders: Array<Record<string, unknown>> };

const CENARIOS: Cenario[] = [
    { titulo: 'S208-1 — local declarado, nuvem disponível', declarado: 'Modelo local', substituto: 'Nuvem', ollamaUrl: MORTO,
      customProviders: [{ label: 'Modelo local', baseUrl: 'http://127.0.0.1:8080/v1', model: 'm-local' }, { label: 'Nuvem', baseUrl: 'https://api.exemplo.test/v1', model: 'm-nuvem' }] },
    { titulo: 'S208-2 — nuvem declarada, outra nuvem disponível', declarado: 'Nuvem A', substituto: 'Nuvem B', ollamaUrl: MORTO,
      customProviders: [{ label: 'Nuvem A', baseUrl: 'https://a.exemplo.test/v1', model: 'm-a' }, { label: 'Nuvem B', baseUrl: 'https://b.exemplo.test/v1', model: 'm-b' }] },
    { titulo: 'S208-3 — local declarado, Ollama local disponível', declarado: 'Modelo local', substituto: 'ollama', ollamaUrl: 'http://localhost:11434',
      customProviders: [{ label: 'Modelo local', baseUrl: 'http://127.0.0.1:8080/v1', model: 'm-local' }] },
];

async function main(): Promise<void> {
    for (const c of CENARIOS) {
        console.log(`\n=== ${c.titulo} ===`);
        const pf = new ProviderFactory({ defaultProvider: c.declarado, ollamaUrl: c.ollamaUrl, ollamaModel: 'm-ollama', customProviders: c.customProviders } as any);
        const espiao = comEspiao(pf, c.substituto);
        declaradoFalha(pf, c.declarado);
        const original = [...PERGUNTA];
        const r = await pf.chatWithFallback(PERGUNTA, undefined, c.declarado, 2000);
        assert(espiao.recebidas.length === 0, `"${c.substituto}" nunca é chamado no lugar de "${c.declarado}"`, espiao.recebidas.length);
        assert((r.attempts || []).length >= 1 && (r.attempts || []).every(a => a.provider === c.declarado), 'o escolhido foi de fato tentado, e só ele', r.attempts);
        assert(r.status !== 'success', `a falha do escolhido é o resultado (${r.status}), não mascarada`, r.status);
        assert(PERGUNTA.length === original.length && PERGUNTA[0].content === original[0].content, 'o array de mensagens de quem chamou não é mutado');
    }

    console.log('\n=== S208-4 — a política de substituição e o anúncio saíram do código (Sprint 4) ===');
    {
        const fs = require('fs') as typeof import('fs');
        const path = require('path') as typeof import('path');
        const ler = (...p: string[]) => fs.readFileSync(path.join(process.cwd(), 'src', ...p), 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
        const pf = ler('core', 'ProviderFactory.ts');
        const tipos = ler('core', 'providerTypes.ts');
        assert(!/mensagensComFatoDaSubstituicao|substituicaoAtravessaFronteira|resolveSubstitutionPolicy|SUBSTITUTION_POLICY/.test(pf), 'o ProviderFactory não tem mais política nem anúncio de substituição');
        assert(!/SubstitutionPolicy|anunciarSubstituicao|policy_strict|substitution\?:/.test(tipos), 'os tipos também saíram (sem campo que ninguém preenche)');
    }

    console.log(`\nS208 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
