/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S436
 * Quando a web_search falha, a recuperação automática NÃO troca a consulta do planejador por palavras soltas do pedido:
 * a falha volta como está (com o erro original no log), e reformular é do planejador.
 *
 * INCIDENTE REAL (Windows, 19/10/2026, "Qual o caminho para voice studio no meu pc?"): a busca planejada
 * `aplicativo "Voice Studio" Windows onde fica instalado caminho do programa` falhou e `enrichWithGoalEntities` a trocou
 * pelas palavras do pedido que não estavam nela — `"qual meu"`. O resultado (signos, nome) foi aceito como sucesso
 * ("succeeded after goal-aware enrichment"), depois marcado fora do assunto, e o ReflectionMemory registrou a falha contra
 * o web_search. A falha original nunca apareceu no log.
 *
 * Execução: npx ts-node src/__tests__/regression/S436_RecuperacaoNaoTrocaABusca.test.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { ProactiveRecovery } from '../../loop/ProactiveRecovery';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}

async function main(): Promise<void> {
    console.log('\n=== S436-1 — a busca que falha não é reescrita com palavras do pedido ===');
    const consultas: string[] = [];
    const webSearch = {
        name: 'web_search',
        async execute(args: Record<string, unknown>) {
            consultas.push(String(args.query));
            // Qualquer outra consulta "daria certo" — é exatamente o que fazia a troca parecer sucesso.
            return args.query === 'qual meu'
                ? { success: true, output: 'Resultados: signos, nome e propósito de vida' }
                : { success: false, output: '', error: 'Nenhum resultado (provedor de busca recusou: captcha)' };
        },
    };
    const original = { action: 'search', query: 'aplicativo "Voice Studio" Windows onde fica instalado caminho do programa' };
    const r = await new ProactiveRecovery().execute(
        'web_search', original, (n) => (n === 'web_search' ? webSearch as any : undefined), new Set<string>(), undefined,
        { toolsTried: [], userIntent: 'Qual o caminho para voice studio no meu pc?' },
    );
    assert(r.result.success === false && r.recovered === false, 'a falha volta como falha (não vira "recuperado")', r);
    assert(consultas.every(q => q === original.query), 'só a consulta do planejador foi executada', consultas);
    assert(JSON.stringify(r.finalArgs) === JSON.stringify(original), 'os argumentos finais são os do planejador', r.finalArgs);
    assert(/captcha/.test(r.result.error ?? ''), 'o erro original chega a quem chamou', r.result.error);

    console.log('\n=== S436-2 — o mecanismo saiu do código e a falha original é registrada ===');
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'loop', 'ProactiveRecovery.ts'), 'utf-8');
    assert(!/enrichWithGoalEntities\(/.test(src), 'enrichWithGoalEntities não existe mais');
    assert(/falhou com os argumentos do planejador/.test(src), 'a falha da primeira tentativa vai para o log');

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S436 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
