/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S295
 *
 * CONTEXTO (log de auditoria, 23/09/2026): o usuário pediu para analisar uma pasta em outro drive.
 * O 1º plano leu a pasta com exec_command (funcionou). Um replan trocou por `read` na mesma
 * pasta → "⛔ Caminho fora do sandbox" (determinístico) → o replan seguinte abandonou o objetivo
 * e o goal terminou em "Não consegui completar". Nem a descrição do `read` nem o erro diziam ao
 * Planner que existe uma fronteira de raízes, nem qual ferramenta a ultrapassa.
 *
 * REGRESSÃO SE: o erro de sandbox deixar de listar as raízes permitidas / a alternativa, ou a
 * descrição do `read` deixar de declarar a fronteira.
 *
 * Execução: npx ts-node src/__tests__/regression/S295_SandboxError_ExposesAllowedRoots.test.ts
 */
import * as os from 'os';
import * as path from 'path';
import { resolvePath } from '../../utils/crossPlatform';
import { ReadTool } from '../../tools/read_tool';

let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string, detail?: unknown): void {
    if (cond) { console.log(`  OK ${msg}`); passed++; }
    else { console.error(`  FALHOU: ${msg}`, detail ?? ''); failed++; }
}

// Caminho absoluto fora de qualquer raiz permitida, portável (raiz do sistema de arquivos).
const outside = path.parse(os.homedir()).root === path.parse(process.cwd()).root
    ? path.join(path.parse(os.homedir()).root, 'nao_existe_fora_do_sandbox', 'pasta')
    : path.join(path.parse(process.cwd()).root, 'nao_existe_fora_do_sandbox', 'pasta');

console.log('\n=== S295.1 — erro de sandbox expõe raízes permitidas e a alternativa ===');
{
    const r = resolvePath(outside);
    assert(!!r.error, 'caminho fora das raízes é rejeitado', r);
    assert((r.error || '').includes(os.homedir()), 'lista a raiz da pasta do usuário', r.error);
    assert((r.error || '').includes(os.tmpdir()), 'lista a pasta temporária', r.error);
    assert(/exec_command/.test(r.error || ''), 'aponta exec_command como alternativa', r.error);
}

console.log('\n=== S295.2 — controle negativo: caminho permitido não gera erro ===');
{
    const r = resolvePath(path.join(os.homedir(), 'qualquer.txt'));
    assert(!r.error, 'caminho dentro da pasta do usuário continua permitido', r);
}

console.log('\n=== S295.3 — descrição do read declara a fronteira ===');
{
    const desc = (new (ReadTool as any)() as { description: string }).description;
    assert(/exec_command/.test(desc) && /workspace/.test(desc), 'descrição cita as raízes e exec_command', desc);
}

console.log(`\nS295 RESULTADO: ${passed} passou | ${failed} falhou`);
process.exit(failed > 0 ? 1 : 0);
