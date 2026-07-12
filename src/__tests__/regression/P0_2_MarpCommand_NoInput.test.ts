/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — P0.2
 * Marp: comandos executados sem arquivo de entrada causam stdin error
 *
 * HIPÓTESE ORIGINAL: O AgentLoop LLM reconstrói comandos marp a partir da descrição do step.
 *           Quando o step diz "execute marp to convert", o LLM gera:
 *           `marp --no-stdin -o output.html`  (sem arquivo de entrada)
 *           em vez de:
 *           `marp entrada.md --no-stdin -o output.html`
 *
 *           Isso causa: "Currently waiting data from stdin stream"
 *           mesmo com --no-stdin (a flag impede espera infinita, mas o erro ainda aparece)
 *
 * HISTÓRICO DE FIX (2 rodadas):
 *   1) Detector adicionado em RiskAnalyzer.ts (isMarpWithoutInputFile/isMarpWithoutNoStdin/
 *      addMarpNoStdin + equivalentes pandoc).
 *   2) 01/07/2026: essas funções foram MOVIDAS de RiskAnalyzer.ts para exec_command.ts,
 *      porque RiskAnalyzer só roda quando GoalExecutionLoop.isComplexPlan() decide acionar o
 *      Q2 (>=3 steps, ou exec_command+write/send juntos) — um plano de 1 step só com
 *      "exec_command: marp arquivo.md" (o caso mais comum) pulava o Q2 inteiro e a correção
 *      nunca era aplicada (mesma classe de bug já identificada pro encaminhamento de
 *      PowerShell). exec_command.ts roda incondicionalmente pra toda chamada.
 *      Este teste foi atualizado para importar as funções REAIS de exec_command.ts em vez de
 *      reimplementar a lógica localmente, e para checar a localização correta da checagem.
 *
 * Execução: npx ts-node src/__tests__/regression/P0_2_MarpCommand_NoInput.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import {
    isMarpWithoutInputFile,
    isMarpWithoutNoStdin,
    addMarpNoStdin,
    isPandocWithoutInputFile,
    hasPandocInvalidNoStdin,
    removePandocNoStdin,
} from '../../tools/exec_command';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
    if (condition) {
        console.log(`  ✅ ${message}`);
        passed++;
    } else {
        console.error(`  ❌ FALHOU: ${message}`);
        failed++;
    }
}

// ── Comandos reais do log que causaram erro ───────────────────────────────────

console.log('\n=== P0.2 — Comandos Marp sem arquivo de entrada (função real de exec_command.ts) ===');

const FAILING_COMMANDS = [
    'marp --no-stdin -o slides_modelo_incremental',
    'npx marp --no-stdin',
    'npx @marp-team/marp-cli -o output.html',
    'marp --pdf /home/venus/newclaw/workspace/slides.md',  // --pdf antes do arquivo
];

const VALID_COMMANDS = [
    'marp slides.md --no-stdin -o output.html',
    'npx @marp-team/marp-cli slides.md -o slides.pptx',
    'marp modelo_incremental.md --no-stdin -o modelo_incremental.html',
    'npx marp aula.md --no-stdin -o aula.html',
];

console.log('\nComandos que DEVEM ser detectados como incompletos (fail-fast em exec_command.ts):');
for (const cmd of FAILING_COMMANDS) {
    assert(
        isMarpWithoutInputFile(cmd),
        `isMarpWithoutInputFile detecta: "${cmd.slice(0, 60)}"`
    );
}

console.log('\nComandos que NÃO devem ser sinalizados (têm arquivo de entrada):');
for (const cmd of VALID_COMMANDS) {
    assert(
        !isMarpWithoutInputFile(cmd),
        `isMarpWithoutInputFile NÃO sinaliza: "${cmd.slice(0, 60)}"`
    );
}

// ── Auto-fix: --no-stdin ausente no marp, presente indevidamente no pandoc ────

console.log('\n=== P0.3 — Auto-fix de --no-stdin (marp obrigatório, pandoc inválido) ===');

assert(
    isMarpWithoutNoStdin('marp entrada.md -o saida.html'),
    'isMarpWithoutNoStdin detecta marp sem --no-stdin'
);
assert(
    !isMarpWithoutNoStdin('marp entrada.md --no-stdin -o saida.html'),
    'isMarpWithoutNoStdin NÃO sinaliza marp que já tem --no-stdin'
);
assert(
    addMarpNoStdin('marp entrada.md -o saida.html') === 'marp entrada.md --no-stdin -o saida.html',
    'addMarpNoStdin injeta --no-stdin logo após o arquivo .md'
);

assert(
    isPandocWithoutInputFile('pandoc -o saida.html'),
    'isPandocWithoutInputFile detecta pandoc sem arquivo de entrada'
);
assert(
    !isPandocWithoutInputFile('pandoc entrada.md -o saida.html'),
    'isPandocWithoutInputFile NÃO sinaliza pandoc com arquivo de entrada'
);
assert(
    hasPandocInvalidNoStdin('pandoc entrada.md --no-stdin -o saida.html'),
    'hasPandocInvalidNoStdin detecta --no-stdin indevido (flag exclusiva do marp)'
);
assert(
    removePandocNoStdin('pandoc entrada.md --no-stdin -o saida.html') === 'pandoc entrada.md -o saida.html',
    'removePandocNoStdin remove a flag inválida sem quebrar o resto do comando'
);

// ── Verificar que SKILL.md não tem --no-stdin como obrigatório ────────────────

console.log('\n=== P0.2 — SKILL.md: --no-stdin como instrução obrigatória ===');

const skillPath = path.join(process.cwd(), 'skills', 'pptx-generator', 'SKILL.md');
let skillContent = '';
try {
    skillContent = fs.readFileSync(skillPath, 'utf-8');
} catch {
    console.error('  ⚠️ Não foi possível ler skills/pptx-generator/SKILL.md');
}

if (skillContent) {
    const hasMandatoryFormat = /OBRIGATÓRIO.*--no-stdin|--no-stdin.*OBRIGATÓRIO|NUNCA.*marp.*sem.*arquivo|arquivo.*ANTES/i.test(skillContent);
    console.log(`  → SKILL.md tem instrução explícita de formato obrigatório: ${hasMandatoryFormat}`);
}

// ── Verificar que a checagem vive em exec_command.ts (local correto) e NÃO ────
// voltou a ser reintroduzida em RiskAnalyzer.ts (regressão da correção de 01/07/2026)

console.log('\n=== P0.2 — Localização da checagem: exec_command.ts (correto), não RiskAnalyzer.ts ===');

const execCommandPath = path.join(process.cwd(), 'src', 'tools', 'exec_command.ts');
const execCommandContent = fs.readFileSync(execCommandPath, 'utf-8');
assert(
    /function isMarpWithoutInputFile/.test(execCommandContent),
    'exec_command.ts contém isMarpWithoutInputFile (roda incondicionalmente pra toda chamada)'
);

const riskAnalyzerPath = path.join(process.cwd(), 'src', 'loop', 'RiskAnalyzer.ts');
const riskAnalyzerContent = fs.readFileSync(riskAnalyzerPath, 'utf-8');
assert(
    !/isMarpWithoutInputFile|isMarpWithoutNoStdin|addMarpNoStdin/.test(riskAnalyzerContent),
    'RiskAnalyzer.ts NÃO reintroduziu a checagem (evita reviver o bug de isComplexPlan() pular o fix)'
);

// ── RELATÓRIO ─────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(60)}`);
console.log(`P0.2 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exit(1);
