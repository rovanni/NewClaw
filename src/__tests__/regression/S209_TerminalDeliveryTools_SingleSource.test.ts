/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S209
 * "Esta tool encerra o turno?" tem um único ponto de definição.
 *
 * CONTEXTO: a investigação de 07/08/2026
 * (`docs/analises-arquiteturais/INVESTIGACAO_TERMINO_DE_TURNO_E_FATOS_DE_ENTREGA_2026-08-07.md`)
 * encontrou a lista de ferramentas terminais escrita LITERALMENTE três vezes dentro do
 * `AgentLoop.ts`, nos três pontos que encerram o turno. É a mesma classe de defeito que a `ADR-005`
 * §4.1 descarta: regra copiada diverge na primeira mudança — e a próxima ferramenta de entrega
 * provavelmente entraria em um ou dois dos três lugares.
 *
 * A mesma investigação encontrou que duas das quatro entradas — `send_image` e `send_video` — não
 * têm arquivo em `src/tools/` nem registro. Eram entradas mortas, herdadas por cópia.
 *
 * REGRESSÃO SE: a lista voltar a ser escrita dentro de um caminho de execução; um nome sem tool
 * correspondente entrar nela; ou alguém unificá-la com `TERMINAL_TOOLS` do `CMIBuffer`, que responde
 * a uma pergunta diferente (conclusão de workflow para corte de chunk, não fim de turno).
 *
 * Execução: npx ts-node src/__tests__/regression/S209_TerminalDeliveryTools_SingleSource.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { ToolRegistry, TERMINAL_DELIVERY_TOOLS } from '../../core/ToolRegistry';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

const AGENT_LOOP = fs.readFileSync(path.join(process.cwd(), 'src', 'loop', 'AgentLoop.ts'), 'utf-8');

console.log('\n=== S209-1 — nenhuma lista literal dentro do caminho de execução ===');
{
    assert(
        !/const\s+terminalTools\s*=/.test(AGENT_LOOP),
        'AgentLoop não define a lista localmente — pergunta ao ToolRegistry',
        AGENT_LOOP.match(/const\s+terminalTools\s*=.*/)?.[0],
    );
    // Desde a `ADR-007` (Sprint 028) a decisão de encerrar não é só "esta tool é terminal?" — é
    // `endsTurn(nome, resultado)`, que também considera se há fato sobre a entrega a comunicar.
    // A regra combinada mora no ToolRegistry pelo mesmo motivo da lista: espalhada, divergiria.
    const usos = (AGENT_LOOP.match(/ToolRegistry\.endsTurn\(/g) || []).length;
    assert(usos >= 3, 'os três pontos de encerramento consultam o ponto único', usos);
}

console.log('\n=== S209-2 — a lista só contém ferramentas que existem ===');
{
    for (const nome of TERMINAL_DELIVERY_TOOLS) {
        const arquivo = path.join(process.cwd(), 'src', 'tools', `${nome}.ts`);
        assert(fs.existsSync(arquivo), `"${nome}" tem tool correspondente em src/tools/`, arquivo);
    }
    assert(TERMINAL_DELIVERY_TOOLS.length > 0, 'a lista não está vazia', TERMINAL_DELIVERY_TOOLS.length);
}

console.log('\n=== S209-3 — comportamento do predicado ===');
{
    assert(ToolRegistry.isTerminalDelivery('send_audio'), 'send_audio encerra o turno');
    assert(ToolRegistry.isTerminalDelivery('send_document'), 'send_document encerra o turno');
    assert(!ToolRegistry.isTerminalDelivery('exec_command'), 'exec_command não encerra o turno');
    assert(!ToolRegistry.isTerminalDelivery('send_image'), 'send_image não está na lista — a tool não existe');
    assert(!ToolRegistry.isTerminalDelivery('send_video'), 'send_video não está na lista — a tool não existe');
}

console.log('\n=== S209-4 — não confundir com a lista do CMIBuffer ===');
{
    // `CMIBuffer.TERMINAL_TOOLS` responde "concluiu uma unidade de trabalho?" para cortar chunk da
    // memória conversacional, e por isso inclui write/edit. Unificar as duas misturaria perguntas
    // diferentes — este teste trava a separação, não a semelhança.
    assert(
        !TERMINAL_DELIVERY_TOOLS.includes('write') && !TERMINAL_DELIVERY_TOOLS.includes('edit'),
        'escrever arquivo não encerra turno — a lista de fim de turno não herda a de corte de chunk',
        TERMINAL_DELIVERY_TOOLS,
    );
    const CMI = fs.readFileSync(path.join(process.cwd(), 'src', 'memory', 'conversational', 'CMIBuffer.ts'), 'utf-8');
    assert(/TERMINAL_TOOLS\s*=\s*new Set/.test(CMI), 'o CMIBuffer mantém a sua própria lista, de propósito');
}

console.log(`\nS209 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
console.log(`\nCOBERTURA:`);
console.log(`  Ponto único de definição, consultado pelos três encerramentos: testado`);
console.log(`  Nenhum nome sem tool correspondente: testado`);
console.log(`  Predicado responde certo para dentro e fora da lista: testado`);
console.log(`  Separação em relação ao conceito do CMIBuffer: testado`);
if (failed > 0) process.exit(1);
