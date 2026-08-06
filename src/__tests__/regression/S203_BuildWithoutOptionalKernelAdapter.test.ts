/// <reference types="node" />
/**
 * S203 — O projeto compila e roda sem o pacote opcional `newclaw-kernel-adapter`.
 *
 * BUG REAL (06/08/2026): o operador rodou `newclaw update` numa segunda máquina e a atualização
 * falhou no build:
 *
 *     src/loop/CognitiveKernelGate.ts:27:49 - error TS2307:
 *       Cannot find module 'newclaw-kernel-adapter' or its corresponding type declarations.
 *     ❌ Falha na atualização: Command failed: npm run build
 *
 * Causa: `newclaw-kernel-adapter` é um pacote NÃO publicado, declarado como
 * `file:../newclaw-kernel-adapter` — caminho relativo que só resolve na máquina onde os dois
 * repositórios são irmãos. Em qualquer outra instalação (outra máquina do autor, VPS, ou qualquer
 * clone do repositório público) o caminho não existe, e o `import` estático quebrava o build.
 *
 * A ironia está no cabeçalho do próprio arquivo, que sempre prometeu:
 *
 *     "CircuitBreaker: qualquer exceção (Kernel quebrado, dependência ausente) sempre cai em
 *      {action:'proceed'} — o Kernel nunca pode travar um Goal real por estar indisponível."
 *
 * A promessa estava implementada e correta — mas só para runtime. Um `import` estático falha na
 * compilação, antes de qualquer `try/catch` existir. A proteção era real e inalcançável.
 *
 * Este teste trava as três condições que fazem a promessa valer também para a ausência do pacote.
 *
 * Execução: npx ts-node src/__tests__/regression/S203_BuildWithoutOptionalKernelAdapter.test.ts
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.join(__dirname, '..', '..', '..');
const GATE = path.join(ROOT, 'src', 'loop', 'CognitiveKernelGate.ts');

let failures = 0;
function check(ok: boolean, label: string, detail = '') {
    if (ok) {
        console.log(`  OK   ${label}`);
    } else {
        failures++;
        console.error(`  FALHOU: ${label}${detail ? ' → ' + detail : ''}`);
    }
}

async function main() {
    console.log('S203 — Build e execução sem o pacote opcional do Cognitive Kernel\n');

    const gateSource = fs.readFileSync(GATE, 'utf-8');
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8')) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        optionalDependencies?: Record<string, string>;
    };

    // ── 1. Nenhum import estático do pacote opcional ──────────────────────────
    {
        const staticImport = /^\s*import\s[^;]*from\s+['"]newclaw-kernel-adapter['"]/m;
        check(
            !staticImport.test(gateSource),
            'CognitiveKernelGate não tem import estático do adapter (quebraria o build sem o pacote)',
            (gateSource.match(staticImport) || [''])[0].trim(),
        );
        check(
            /require\(\s*['"]newclaw-kernel-adapter['"]\s*\)/.test(gateSource),
            'o adapter é carregado sob demanda, em runtime',
        );
        check(
            /try\s*\{[\s\S]{0,200}require\(\s*['"]newclaw-kernel-adapter['"]/.test(gateSource),
            'o carregamento está protegido por try/catch — ausência não lança',
        );
    }

    // ── 2. A dependência não é obrigatória ────────────────────────────────────
    {
        const nome = 'newclaw-kernel-adapter';
        check(
            !(pkg.dependencies && nome in pkg.dependencies),
            'o pacote não está em "dependencies" (npm install falharia em máquina sem o repo irmão)',
        );
        check(
            !(pkg.devDependencies && nome in pkg.devDependencies),
            'o pacote não está em "devDependencies"',
        );
        check(
            !!(pkg.optionalDependencies && nome in pkg.optionalDependencies),
            'o pacote está declarado em "optionalDependencies"',
        );
    }

    // ── 3. Nenhum outro arquivo importa o pacote estaticamente ────────────────
    {
        const suspeitos: string[] = [];
        const varrer = (dir: string) => {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, e.name);
                if (e.isDirectory()) { varrer(full); continue; }
                if (!e.name.endsWith('.ts')) continue;
                if (full === GATE || full === __filename) continue;
                const src = fs.readFileSync(full, 'utf-8');
                if (/^\s*import\s[^;]*from\s+['"]newclaw-kernel-adapter['"]/m.test(src)) {
                    suspeitos.push(path.relative(ROOT, full));
                }
            }
        };
        varrer(path.join(ROOT, 'src'));
        check(
            suspeitos.length === 0,
            'nenhum outro arquivo do projeto importa o adapter estaticamente',
            suspeitos.join(', '),
        );
    }

    // ── 4. O gate responde "proceed" e não lança, com o Kernel desligado ──────
    {
        delete process.env.COGNITIVE_KERNEL_ENABLED;   // default: desligado
        const { avaliarGoal } = await import('../../loop/CognitiveKernelGate');
        const goalFalso = {
            id: 'goal_s203', sessionKey: 'sess', conversationId: 'conv', createdAt: Date.now(),
        } as unknown as import('../../loop/GoalTypes').Goal;
        const storeFalso = {
            getPrecedentStats: () => ({ completados: 0, terminais: 0 }),
        } as unknown as import('../../loop/GoalStore').GoalStore;

        let threw = false;
        let result: { action?: string } = {};
        try {
            result = await avaliarGoal(goalFalso, storeFalso);
        } catch {
            threw = true;
        }
        check(!threw, 'avaliarGoal não lança');
        check(result.action === 'proceed', 'o goal segue normalmente quando o Kernel está desligado', String(result.action));
    }

    console.log(failures === 0 ? '\n✅ S203 passou' : `\n❌ S203: ${failures} falha(s)`);
    process.exitCode = failures === 0 ? 0 : 1;
}

main();
