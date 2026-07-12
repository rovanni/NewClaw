/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S87 (Sprint 0.10, achado L31 — inconsistência ssh_exec × exec_command)
 *
 * Prova que `SshExecTool.execute()` (`src/tools/ssh_exec.ts`) agora trata exit code ≠ 0 do
 * comando remoto como falha (`success:false`), mesmo quando há output parcial — mesmo contrato
 * já usado por `ExecCommandTool` (`src/tools/exec_command.ts:405-416`, "Non-zero exit is a
 * failure — reject so the caller sees success: false").
 *
 * ANTES da correção: qualquer output não-vazio (`stdout`/`stderr`) fazia o callback do `exec()`
 * RESOLVER como sucesso, independente do exit code — um comando remoto real como
 * `ls /caminho/inexistente` (exit≠0, mensagem de erro em stderr) era reportado como
 * `success:true`. Isso alimentava `GoalEvaluator`/`GoalAttempt.result` com um falso positivo.
 *
 * `child_process.exec` é monkey-patched no módulo `child_process` (mesma instância que
 * `ssh_exec.ts` importa via `import { exec } from 'child_process'`, resolvida em tempo de
 * chamada pelo CommonJS gerado pelo `tsc`/`ts-node`) — sem executar SSH real, sem depender de
 * rede ou de um servidor remoto alcançável.
 *
 * Execução: npx ts-node src/__tests__/regression/S87_SshExec_ExitCodeConsistency.test.ts
 */

// require (não `import * as`) — o namespace de um `import` ESM é somente-leitura, não dá para
// monkey-patchar `.exec`; o módulo CommonJS retornado por `require` é o mesmo objeto mutável
// que `ssh_exec.ts` lê via `import { exec } from 'child_process'` (interop do tsc/ts-node
// resolve `.exec` no objeto do módulo em tempo de CHAMADA, não captura uma referência fixa no
// import) — o monkey-patch abaixo é visto pelo código sob teste.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const cp = require('child_process');

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  OK ${message}`); passed++; }
    else { console.error(`  FALHOU: ${message}`, detail ?? ''); failed++; }
}

type ExecCallback = (error: (Error & { code?: number }) | null, stdout: string, stderr: string) => void;
function withFakeExec<T>(fakeImpl: (cmd: string, cb: ExecCallback) => void, run: () => Promise<T>): Promise<T> {
    const original = cp.exec;
    cp.exec = (cmd: string, optsOrCb: unknown, maybeCb?: ExecCallback) => {
        const cb = (typeof optsOrCb === 'function' ? optsOrCb : maybeCb) as ExecCallback;
        fakeImpl(cmd, cb);
    };
    return run().finally(() => { cp.exec = original; });
}

async function main() {
    // Import tardio (depois que o monkey-patch de child_process.exec já pode estar em vigor
    // para cada cenário) — SshExecTool lê `exec` do módulo compartilhado a cada chamada.
    const { SshExecTool } = await import('../../tools/ssh_exec');
    const tool = new SshExecTool();

    console.log('\n=== S87.1 — exit code ≠0 COM output parcial: success=false (ANTES: true) ===');
    {
        const result = await withFakeExec(
            (_cmd, cb) => {
                const err = Object.assign(new Error('Command failed: ssh ...'), { code: 2 });
                cb(err, '', 'ls: cannot access /nope: No such file or directory\n');
            },
            () => tool.execute({ host: 'test@fakehost', command: 'ls /nope' }),
        );
        assert(
            result.success === false,
            `success===false para exit code 2 com stderr não-vazio (ANTES: true — mascarava falha real) — obtido: ${result.success}`,
            result
        );
        assert(
            !!result.error?.includes('No such file or directory') && !!result.error?.includes('[exit code: 2]'),
            `error preserva o output real do comando remoto + exit code — obtido: "${result.error}"`,
            result
        );
    }

    console.log('\n=== S87.2 — exit code 0: success=true (comportamento correto, não afetado) ===');
    {
        const result = await withFakeExec(
            (_cmd, cb) => cb(null, 'arquivo1.txt\narquivo2.txt\n', ''),
            () => tool.execute({ host: 'test@fakehost', command: 'ls' }),
        );
        assert(result.success === true, `success===true para exit code 0 — obtido: ${result.success}`, result);
        assert(result.output.includes('arquivo1.txt'), 'output contém o stdout real', result);
    }

    console.log('\n=== S87.3 — exit code ≠0 SEM output, mensagem de auth: mantém o branch amigável existente ===');
    {
        const result = await withFakeExec(
            (_cmd, cb) => cb(Object.assign(new Error('Permission denied (publickey).'), { code: 255 }), '', ''),
            () => tool.execute({ host: 'test@fakehost', command: 'ls' }),
        );
        assert(result.success === false, 'success===false para falha de autenticação SSH', result);
        assert(
            (result.error ?? '').includes('SSH authentication failed'),
            `mensagem amigável de autenticação preservada (não regrediu) — obtido: "${result.error}"`,
            result
        );
    }

    console.log('\n=== S87.4 — exit code ≠0 SEM output e sem padrão amigável reconhecido: success=false (já era antes) ===');
    {
        const result = await withFakeExec(
            (_cmd, cb) => cb(Object.assign(new Error('spawn ssh ENOENT'), { code: undefined }), '', ''),
            () => tool.execute({ host: 'test@fakehost', command: 'ls' }),
        );
        assert(result.success === false, 'success===false quando não há output nem padrão amigável reconhecido', result);
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S87 RESULTADO: ${passed} passou | ${failed} falhou`);
    if (failed > 0) process.exit(1);
}

main().catch(err => { console.error('ERRO NÃO TRATADO:', err); process.exit(1); });
