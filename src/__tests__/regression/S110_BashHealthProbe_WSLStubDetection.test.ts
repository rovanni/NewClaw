/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S110
 *
 * Achado real (logs de instalação Windows, 2026-07-12): o agente tentou
 * `bash scripts/html2pdf.sh ...` 4 vezes seguidas, sempre com
 * "WSL (10 - Relay) ERROR: CreateProcessCommon:818: execvpe(/bin/bash) failed: No such
 * file or directory" — o launcher stub do WSL (bash.exe) está no PATH, mas não há
 * nenhuma distro Linux instalada/registrada. Isso queimou um ciclo de replan inteiro
 * (budget desperdiçado) antes do agente trocar de estratégia por conta própria.
 *
 * Causa raiz: EnvironmentProbe nunca verificava 'bash' — nem via `where`/`command -v`
 * (que teria dado o mesmo falso positivo, já que o stub existe como arquivo). O agente só
 * descobria o problema empiricamente, em runtime, depois de já ter tentado.
 *
 * Fix: isBashFunctional() (crossPlatform.ts) roda `bash -c "exit 0"` de verdade e decide
 * pelo exit code — não apenas presença no PATH. EnvironmentProbe.probe() agora inclui
 * 'bash' em `tools`, então "bash indisponível" aparece no bloco injetado no prompt de
 * planejamento ANTES de qualquer tentativa.
 *
 * Execução: npx ts-node src/__tests__/regression/S110_BashHealthProbe_WSLStubDetection.test.ts
 */

import fs from 'fs';
import path from 'path';
import { isBashFunctional, commandExists, isWindows } from '../../utils/crossPlatform';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

async function main() {
    console.log('\n=== S110.1 — isBashFunctional() nunca trava e sempre resolve um boolean ===');
    {
        const start = Date.now();
        const result = await isBashFunctional();
        const elapsed = Date.now() - start;
        assert(typeof result === 'boolean', 'isBashFunctional() resolve para boolean', result);
        assert(elapsed < 5000, `isBashFunctional() resolve rápido (${elapsed}ms < 5000ms) — não trava o probe`, elapsed);
    }

    console.log('\n=== S110.2 — Invariante: se isBashFunctional()===true, bash necessariamente existe no PATH ===');
    {
        // A implicação nunca pode ser violada: um bash que roda de verdade tem que estar no
        // PATH. O INVERSO é o falso positivo que este fix existe para fechar — commandExists
        // pode ser true (stub do WSL presente) com isBashFunctional false (stub não funciona).
        const functional = await isBashFunctional();
        const exists = commandExists('bash');
        assert(!functional || exists, 'isBashFunctional=true ⇒ commandExists("bash")=true (implicação nunca violada)', { functional, exists });
        if (isWindows && exists && !functional) {
            console.log('  ℹ️  Falso positivo do WSL stub reproduzido nesta máquina: bash.exe presente no PATH, porém não funcional — exatamente o caso do achado 2026-07-12.');
        }
    }

    console.log('\n=== S110.3 — EnvironmentProbe.probe() inclui "bash" via isBashFunctional() (não via where/command -v) ===');
    {
        const probePath = path.join(process.cwd(), 'src', 'core', 'EnvironmentProbe.ts');
        const source = fs.readFileSync(probePath, 'utf-8');

        assert(
            /import\s*\{[^}]*isBashFunctional[^}]*\}\s*from\s*['"]\.\.\/utils\/crossPlatform['"]/.test(source),
            'EnvironmentProbe importa isBashFunctional de utils/crossPlatform'
        );
        assert(
            /tools\[['"]bash['"]\]\s*=\s*await\s+isBashFunctional\(\)/.test(source),
            'EnvironmentProbe atribui tools["bash"] usando isBashFunctional() (probe de execução real)'
        );
        assert(
            !/TOOLS_TO_PROBE\s*=\s*\[[^\]]*['"]bash['"]/.test(source),
            '"bash" NÃO está em TOOLS_TO_PROBE (evita o falso positivo do where/command -v genérico)'
        );
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S110 RESULTADO: ${passed} passou | ${failed} falhou`);
    if (failed > 0) process.exit(1);
}

main().catch(err => { console.error('ERRO NÃO TRATADO:', err); process.exit(1); });
