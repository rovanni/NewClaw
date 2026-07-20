/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S133 (CodeQL alert #12, js/incomplete-sanitization)
 *
 * `ssh_exec.ts` construía `ssh ... '${escapedCommand}'` como STRING e rodava via `exec()`
 * (shell local). A escapagem manual (`command.replace(/"/g,'\\"').replace(/'/g,"'\\''")`)
 * escapava aspas duplas — desnecessário e ERRADO dentro de aspas simples (não são especiais ali;
 * escapá-las insere um backslash literal que corrompe o comando) — e não tratava backslashes
 * pré-existentes do input, deixando uma combinação ambígua capaz de escapar do wrapping de aspas
 * simples pretendido (CodeQL: "This does not escape backslash characters in the input").
 *
 * Fix: `execFile('ssh', [...args, sshTarget, command])` — array de argv, sem shell local
 * nenhum. `command` chega ao processo `ssh` como UM argumento literal, byte a byte, sem
 * nenhum parsing de shell no meio — elimina a classe inteira de bug (não só o caractere
 * específico que a escapagem manual esquecia).
 *
 * Este teste faz monkey-patch de `child_process.execFile` (mesmo padrão do S87) e captura o
 * array de argv de verdade passado pro `ssh` — prova que uma `command` adversarial (aspas,
 * backslashes, `$()`, ponto-e-vírgula) chega INTACTA como um único elemento do array, nunca
 * fragmentada/corrompida por parsing de shell local.
 *
 * Execução: npx ts-node src/__tests__/regression/S133_SshExec_NoLocalShellEscaping.test.ts
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const cp = require('child_process');

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  OK ${message}`); passed++; }
    else { console.error(`  FALHOU: ${message}`, detail ?? ''); failed++; }
}

type ExecFileCallback = (error: (Error & { code?: number }) | null, stdout: string, stderr: string) => void;

async function main() {
    const { SshExecTool } = await import('../../tools/ssh_exec');
    const tool = new SshExecTool();

    console.log('\n=== S133.1 — command adversarial (aspas, backslash, $(), ";") chega intacto no argv do ssh ===');
    {
        // Nenhum verbo destrutivo (rm/mkfs/dd/shutdown) — não pode ser bloqueado por
        // isDestructive() antes de chegar no execFile, senão o teste não captura nada.
        const adversarialCommand = 'echo "hello"; echo $(whoami) > /tmp/pwn; echo \\backslash\\ end \' quote';

        let capturedArgs: string[] | null = null;
        const original = cp.execFile;
        cp.execFile = (_file: string, args: string[], _opts: unknown, cb: ExecFileCallback) => {
            capturedArgs = args;
            cb(null, 'ok', '');
        };

        try {
            const result = await tool.execute({ host: 'test@fakehost', command: adversarialCommand });
            assert(result.success === true, 'execute() retorna sucesso (execFile mockado respondeu ok)', result);
        } finally {
            cp.execFile = original;
        }

        assert(capturedArgs !== null, 'execFile foi de fato chamado (comando não foi bloqueado por engano)', capturedArgs);
        const args = capturedArgs as unknown as string[];
        const commandCount = args.filter(a => a === adversarialCommand).length;
        assert(
            commandCount === 1,
            'a command adversarial aparece INTEIRA como um único elemento do argv, sem fragmentação',
            args
        );
        assert(
            args[args.length - 1] === adversarialCommand,
            'command é o último elemento do argv (depois do target ssh), formato esperado pelo protocolo ssh',
            args
        );
        // Nenhum elemento do argv deve conter fragmentos truncados/corrompidos do comando
        // original (ex: só "echo " sem o resto, sinal de que o parsing de shell local fatiou
        // a string em pedaços) — cada argv element é, ou o comando inteiro, ou uma flag/opção
        // do ssh, nunca uma fatia parcial do comando.
        const suspiciousFragments = args.filter(a =>
            a !== adversarialCommand && (adversarialCommand.includes(a) && a.length > 3 && !a.startsWith('-'))
        );
        assert(suspiciousFragments.length === 0, 'nenhum argv element é um fragmento parcial corrompido do comando', suspiciousFragments);
    }

    console.log(`\n=== RESULTADO: ${passed} passou, ${failed} falhou ===`);
    if (failed > 0) process.exit(1);
}

main().catch(err => { console.error(err); process.exit(1); });
