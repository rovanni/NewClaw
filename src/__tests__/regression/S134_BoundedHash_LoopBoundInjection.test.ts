/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S134 (CodeQL alerts #1, #2, js/loop-bound-injection)
 *
 * `ClassificationMemory.hash()` e `UnifiedIntentRouter.hashInput()` tinham a MESMA fórmula de
 * hash (djb2-style) duplicada, cada uma com `for (let i = 0; i < text.length; i++)` sem limite
 * superior — texto de input de usuário (mensagem de chat, janela de contexto recente) pode ser
 * arbitrariamente grande, e o loop é síncrono (bloqueia a event loop) por tempo proporcional ao
 * tamanho. Consolidado em `shared/boundedHash.ts` com truncamento antes do loop.
 *
 * Execução: npx ts-node src/__tests__/regression/S134_BoundedHash_LoopBoundInjection.test.ts
 */

import { boundedHash } from '../../shared/boundedHash';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  OK ${message}`); passed++; }
    else { console.error(`  FALHOU: ${message}`, detail ?? ''); failed++; }
}

/** Fórmula original (ClassificationMemory.hash / UnifiedIntentRouter.hashInput antes desta correção), sem limite — usada só pra provar equivalência em input curto. */
function originalUnboundedHash(text: string): string {
    let h = 0;
    for (let i = 0; i < text.length; i++) {
        h = ((h << 5) - h + text.charCodeAt(i)) | 0;
    }
    return Math.abs(h).toString(36);
}

async function main() {
    console.log('\n=== S134.1 — input curto/normal: boundedHash produz EXATAMENTE o mesmo valor da fórmula original ===');
    {
        const cases = ['', 'oi', 'Assistente de TI', 'a'.repeat(500), 'preciso que você gere um relatório de vendas'];
        for (const c of cases) {
            const expected = originalUnboundedHash(c);
            const actual = boundedHash(c);
            assert(actual === expected, `hash idêntico ao original pra input de ${c.length} chars`, { expected, actual });
        }
    }

    console.log('\n=== S134.2 — input muito grande (5.000.000 chars) completa rápido, não trava a event loop ===');
    {
        const huge = 'x'.repeat(5_000_000);
        const start = Date.now();
        const result = boundedHash(huge);
        const elapsed = Date.now() - start;
        assert(elapsed < 50, `boundedHash(5M chars) completa em <50ms (loop bounded, não itera os 5M)`, `${elapsed}ms`);
        assert(typeof result === 'string' && result.length > 0, 'retorna um hash válido mesmo truncando', result);
    }

    console.log('\n=== S134.3 — truncamento é determinístico: mesmo prefixo (>10k chars) sempre produz o mesmo hash ===');
    {
        const prefix = 'y'.repeat(10_000);
        const a = boundedHash(prefix + 'AAAA...resto-diferente-1');
        const b = boundedHash(prefix + 'BBBB...resto-completamente-diferente-2');
        assert(a === b, 'dois inputs com o mesmo prefixo de 10k chars (só o resto difere) produzem o mesmo hash — truncamento consistente, não um bug de comparação parcial acidental', { a, b });
    }

    console.log(`\n=== RESULTADO: ${passed} passou, ${failed} falhou ===`);
    if (failed > 0) process.exit(1);
}

main().catch(err => { console.error(err); process.exit(1); });
