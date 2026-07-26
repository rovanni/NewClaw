/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S154
 *
 * Sprint 005 (docs/sprints/... , docs/Auditorias/2026-07-26/AUDITORIA_CATALOGOS_FERRAMENTAS_2026-07-26.md) — 5.3.
 *
 * A auditoria de 2026-07-26 encontrou drift real, datado e não-hipotético entre os catálogos
 * de ferramentas do runtime:
 *   - `puppeteer`/`tesseract` existiam em KNOWN_DEPS (GoalEvaluator.ts) há 2 dias e continuavam
 *     ausentes de TOOLS_TO_PROBE (EnvironmentProbe.ts) — Caso 1 da auditoria.
 *   - `edge-tts` precisou de 2 commits separados (~11h de intervalo) para existir em ambos os
 *     catálogos — Caso 2 da auditoria — prova de que a sincronização é manual, sem nenhum gate.
 *   - `KNOWN_SYSTEM_DEPS` (RiskAnalyzer.ts) era uma cópia estática de nomes de pacote já
 *     presentes em KNOWN_DEPS[x].name — Caso 3 da auditoria, eliminado na Sprint 5.1 (agora
 *     KNOWN_SYSTEM_DEP_KEYS só guarda o ESCOPO de chaves, nunca o nome do pacote).
 *
 * Nenhum teste no repositório verificava paridade entre esses catálogos antes desta sprint
 * (auditoria, seção 7: "Nenhuma proteção contra drift existe hoje"). Este teste fecha esse gap:
 * qualquer entrada nova em KNOWN_DEPS que não seja também adicionada a TOOLS_TO_PROBE (ou à
 * lista de exceções abaixo, pequena e documentada) falha a suíte.
 *
 * Execução: npx ts-node src/__tests__/regression/S154_CatalogConsistency_KnownDepsToolsToProbeParity.test.ts
 */

import { KNOWN_DEPS } from '../../loop/GoalEvaluator';
import { KNOWN_SYSTEM_DEP_KEYS } from '../../loop/RiskAnalyzer';
import { TOOLS_TO_PROBE, NODE_REQUIRE_PROBE_TARGETS } from '../../core/EnvironmentProbe';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

// Exceções nomeadas, pequenas e intencionais, para chaves que não são "mais uma ferramenta" a
// probar por nenhum mecanismo (nem PATH, nem require()) — cada uma com razão verificável no
// código. Dependências que só precisam de um mecanismo de probe DIFERENTE (ex: puppeteer) não
// entram mais aqui a partir da Sprint 005/5.4: viram cobertura estrutural via
// DependencyInfo.probeVia (GoalTypes.ts) + NODE_REQUIRE_PROBE_TARGETS (EnvironmentProbe.ts) —
// a próxima dependência "require-only" fica coberta ao declarar o campo, não ao lembrar de
// atualizar esta lista.
const TOOLS_TO_PROBE_EXCEPTIONS: Record<string, string> = {
    pip:
        'alias de "pip3" em KNOWN_DEPS — mesma DependencyInfo exata (name: "python3-pip", ' +
        'mesmo installCmd), já coberto pelo probe de "pip3". Não é uma ferramenta adicional.',
};

function main() {
    console.log('\n=== S154.1 — Todo tool de KNOWN_DEPS está coberto: TOOLS_TO_PROBE, probeVia, ou exceção ===');
    {
        const probeSet = new Set(TOOLS_TO_PROBE);
        const nodeRequireSet = new Set(NODE_REQUIRE_PROBE_TARGETS);
        const missing: string[] = [];
        for (const key of Object.keys(KNOWN_DEPS)) {
            if (probeSet.has(key)) continue;
            if (nodeRequireSet.has(key)) continue;
            if (key in TOOLS_TO_PROBE_EXCEPTIONS) continue;
            missing.push(key);
        }
        assert(
            missing.length === 0,
            'nenhuma chave de KNOWN_DEPS ausente de TOOLS_TO_PROBE/probeVia sem exceção documentada',
            missing
        );
    }

    console.log('\n=== S154.2 — Casos de drift comprovados pela auditoria (Caso 1/2) ficam fechados ===');
    {
        assert(TOOLS_TO_PROBE.includes('tesseract'), '"tesseract" está em TOOLS_TO_PROBE (Caso 1 da auditoria)');
        assert(TOOLS_TO_PROBE.includes('edge-tts'), '"edge-tts" está em TOOLS_TO_PROBE (Caso 2 da auditoria)');
        assert(
            KNOWN_DEPS.puppeteer?.probeVia === 'node-require',
            '"puppeteer" declara probeVia: "node-require" em KNOWN_DEPS (não é binário de PATH)'
        );
        assert(
            NODE_REQUIRE_PROBE_TARGETS.includes('puppeteer'),
            '"puppeteer" é sondado de fato via probeNodeRequire() — cobertura estrutural, não silêncio nem lista de exceção manual'
        );
    }

    console.log('\n=== S154.3 — "bash" nunca entra em TOOLS_TO_PROBE (regressão de S110) ===');
    {
        // bash não é uma DependencyInfo em KNOWN_DEPS, então nunca seria pego pelo teste acima —
        // reafirma aqui a invariante de S110 (falso positivo do stub WSL) como guarda explícita.
        assert(!TOOLS_TO_PROBE.includes('bash'), '"bash" ausente de TOOLS_TO_PROBE (usa isBashFunctional() dedicado)');
    }

    console.log('\n=== S154.4 — Toda chave de KNOWN_SYSTEM_DEP_KEYS (RiskAnalyzer) resolve em KNOWN_DEPS ===');
    {
        // Sprint 5.1: RiskAnalyzer não guarda mais nome de pacote próprio — lê KNOWN_DEPS[x].name.
        // Se uma chave aqui não existir em KNOWN_DEPS, o aviso de risco "1b" silenciosamente para
        // de disparar para essa ferramenta (pkg vira undefined) sem nenhum erro visível.
        const orphanKeys = [...KNOWN_SYSTEM_DEP_KEYS].filter(k => !(k in KNOWN_DEPS));
        assert(
            orphanKeys.length === 0,
            'nenhuma chave de KNOWN_SYSTEM_DEP_KEYS órfã (todas existem em KNOWN_DEPS)',
            orphanKeys
        );
    }

    console.log('\n=== S154.5 — Lista de exceções permanece pequena e cada entrada é justificada ===');
    {
        const exceptionKeys = Object.keys(TOOLS_TO_PROBE_EXCEPTIONS);
        assert(exceptionKeys.length <= 5, `lista de exceções pequena (${exceptionKeys.length} <= 5)`, exceptionKeys);
        assert(
            exceptionKeys.every(k => TOOLS_TO_PROBE_EXCEPTIONS[k].length > 20),
            'toda exceção tem justificativa textual não-trivial (> 20 chars)',
        );
        // Exceção só faz sentido para chave que REALMENTE existe em KNOWN_DEPS — uma entrada
        // "morta" aqui (ferramenta removida de KNOWN_DEPS) deveria ser removida desta lista.
        const deadExceptions = exceptionKeys.filter(k => !(k in KNOWN_DEPS));
        assert(deadExceptions.length === 0, 'nenhuma exceção "morta" (toda chave existe em KNOWN_DEPS)', deadExceptions);
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S154 RESULTADO: ${passed} passou | ${failed} falhou`);
    if (failed > 0) process.exit(1);
}

main();
