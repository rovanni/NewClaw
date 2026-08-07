/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S207
 * Política de substituição por recurso (`RFC-005` §1.3, Sprint 021).
 *
 * CONTEXTO: até aqui o sistema não tinha como expressar "não troque". Um modelo local declarado que
 * não respondesse era substituído por um de nuvem, e a única política existente era a implícita —
 * sempre substituir, em silêncio. Esta Sprint introduz a política como valor de domínio e implementa
 * `estrita` por inteiro.
 *
 * LIMITAÇÃO TEMPORÁRIA, DELIBERADA: `anunciada` existe como valor e **ainda se comporta como
 * `livre`** — o mecanismo de anúncio é a Sprint 022. Está coberta abaixo (S207-4) de propósito: a
 * limitação fica visível num teste em vez de virar surpresa. A Sprint 022 ACRESCENTA a asserção do
 * anúncio; nenhuma asserção deste arquivo precisa ser removida, porque `anunciada` continua
 * substituindo — o que muda é a resposta passar a dizer isso.
 *
 * REGRESSÃO SE: `estrita` deixar de valer em qualquer um dos caminhos de substituição do
 * `chatWithFallback` (são dois — a ordem de fallback e o fallback não-streaming para o Ollama);
 * a ausência de provider preferido passar a invocar política (não há soberania sobre o que ninguém
 * declarou); ou um valor inválido de configuração derrubar a chamada em vez de cair no padrão.
 *
 * Execução: npx ts-node src/__tests__/regression/S207_SubstitutionPolicy_StrictEnforced.test.ts
 */

import { ProviderFactory } from '../../core/ProviderFactory';
import { isSubstitutionPolicy, DEFAULT_SUBSTITUTION_POLICY } from '../../core/providerTypes';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

/**
 * Endpoint que falha na hora e de forma NÃO retentável.
 *
 * Medido, não suposto: tanto conexão recusada (`http://127.0.0.1:9`) quanto esquema desconhecido
 * (`x://host`) produzem a mensagem "fetch failed", que ESTÁ na lista de erros retentáveis do
 * `chatWithFallback` — cada uma custaria ~10s de backoff por provider. Só uma URL impossível de
 * parsear escapa: dá "Failed to parse URL", que não casa com nenhum padrão retentável.
 *
 * O caminho de código exercitado é o mesmo (o provider lança, é capturado, segue para o próximo ou
 * para); o que muda é a suíte não passar um minuto dormindo.
 */
const ENDPOINT_MORTO = 'endpoint-de-teste-sem-servidor';

function resolver(pf: ProviderFactory, preferido?: string): string {
    return (pf as unknown as { resolveSubstitutionPolicy(p?: string): string })
        .resolveSubstitutionPolicy(preferido);
}

async function main(): Promise<void> {
    const envOriginal = process.env.SUBSTITUTION_POLICY;

    try {
        console.log('\n=== S207-1 — o valor de domínio existe e se valida ===');
        {
            assert(isSubstitutionPolicy('estrita'), '`estrita` é política válida');
            assert(isSubstitutionPolicy('anunciada'), '`anunciada` é política válida');
            assert(isSubstitutionPolicy('livre'), '`livre` é política válida');
            assert(!isSubstitutionPolicy('strict'), 'valor fora do vocabulário é rejeitado');
            assert(
                DEFAULT_SUBSTITUTION_POLICY === 'anunciada',
                'o padrão para recurso declarado é `anunciada` — nem disruptivo, nem o defeito atual',
            );
        }

        console.log('\n=== S207-2 — resolução da política ===');
        {
            delete process.env.SUBSTITUTION_POLICY;
            const pf = new ProviderFactory({
                defaultProvider: 'Modelo local',
                ollamaUrl: ENDPOINT_MORTO,
                customProviders: [
                    { label: 'Modelo local', baseUrl: ENDPOINT_MORTO },
                    { label: 'Modelo teimoso', baseUrl: ENDPOINT_MORTO, substitutionPolicy: 'estrita' },
                ],
            });

            assert(resolver(pf, undefined) === 'livre',
                'sem provider preferido não há soberania a proteger — política `livre`');
            assert(resolver(pf, 'Modelo local') === 'anunciada',
                'provider sem política própria cai no padrão');
            assert(resolver(pf, 'Modelo teimoso') === 'estrita',
                'o que o provider declara vence o padrão');

            process.env.SUBSTITUTION_POLICY = 'estrita';
            assert(resolver(pf, 'Modelo local') === 'estrita', 'padrão global é respeitado');
            assert(resolver(pf, 'Modelo teimoso') === 'estrita', 'e o do provider continua vencendo');

            process.env.SUBSTITUTION_POLICY = 'strict';
            assert(resolver(pf, 'Modelo local') === 'anunciada',
                'valor inválido cai no padrão em vez de derrubar a chamada');
            delete process.env.SUBSTITUTION_POLICY;
        }

        console.log('\n=== S207-3 — `estrita`: nenhum substituto é tentado ===');
        {
            const pf = new ProviderFactory({
                defaultProvider: 'Modelo local',
                ollamaUrl: ENDPOINT_MORTO,
                customProviders: [{ label: 'Modelo local', baseUrl: ENDPOINT_MORTO, substitutionPolicy: 'estrita' }],
            });

            const r = await pf.chatWithFallback(
                [{ role: 'user', content: 'ping' }], undefined, 'Modelo local', 2000,
            );

            assert(r.status === 'error', 'a indisponibilidade É o resultado', r.status);
            assert(
                r.fallbackReason === 'policy_strict',
                'e o motivo é distinguível de um erro comum — havia substituto e ele foi recusado',
                r.fallbackReason,
            );
            const outros = (r.attempts ?? []).filter(a => a.provider !== 'Modelo local');
            assert(
                outros.length === 0,
                'nenhuma tentativa contra outro provedor — inclui o fallback não-streaming do Ollama, o segundo caminho de substituição',
                outros,
            );
            assert(
                /estrita/.test(r.fallbackMessage ?? ''),
                'a mensagem diz que houve recusa deliberada, não uma falha qualquer',
                r.fallbackMessage,
            );
        }

        console.log('\n=== S207-4 — `anunciada` ainda substitui (limitação temporária da Sprint 021) ===');
        {
            const pf = new ProviderFactory({
                defaultProvider: 'Modelo local',
                ollamaUrl: ENDPOINT_MORTO,
                customProviders: [{ label: 'Modelo local', baseUrl: ENDPOINT_MORTO, substitutionPolicy: 'anunciada' }],
            });

            const r = await pf.chatWithFallback(
                [{ role: 'user', content: 'ping' }], undefined, 'Modelo local', 2000,
            );

            const outros = (r.attempts ?? []).filter(a => a.provider !== 'Modelo local');
            assert(
                outros.length > 0,
                'substituição acontece — `anunciada` permite a troca (o que falta é anunciá-la, Sprint 022)',
                r.attempts,
            );
            assert(
                r.fallbackReason !== 'policy_strict',
                'e nunca é recusada como se fosse `estrita`',
                r.fallbackReason,
            );
        }

        console.log('\n=== S207-5 — sem política declarada, comportamento inalterado ===');
        {
            const pf = new ProviderFactory({
                defaultProvider: 'Modelo local',
                ollamaUrl: ENDPOINT_MORTO,
                customProviders: [{ label: 'Modelo local', baseUrl: ENDPOINT_MORTO }],
            });

            const r = await pf.chatWithFallback(
                [{ role: 'user', content: 'ping' }], undefined, 'Modelo local', 2000,
            );
            const outros = (r.attempts ?? []).filter(a => a.provider !== 'Modelo local');
            assert(outros.length > 0, 'cadeia de fallback percorrida como sempre foi', r.attempts);
            assert(r.fallbackReason !== 'policy_strict', 'nenhuma recusa por política', r.fallbackReason);
        }

        console.log(`\nS207 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
        console.log(`\nCOBERTURA:`);
        console.log(`  Vocabulário de política validado (estrita/anunciada/livre): testado`);
        console.log(`  Resolução: provider > global > padrão; inválido cai no padrão: testado`);
        console.log(`  Sem preferido, não há política a aplicar: testado`);
        console.log(`  estrita bloqueia os DOIS caminhos de substituição: testado`);
        console.log(`  anunciada ainda substitui — limitação temporária declarada: testado`);
        console.log(`  Ausência de política preserva o comportamento histórico: testado`);
    } finally {
        if (envOriginal === undefined) delete process.env.SUBSTITUTION_POLICY;
        else process.env.SUBSTITUTION_POLICY = envOriginal;
    }

    if (failed > 0) process.exit(1);
}

main().catch(err => { console.error('Erro inesperado:', err); process.exit(1); });
