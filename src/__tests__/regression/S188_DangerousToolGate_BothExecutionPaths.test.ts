/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S188 (ADR-005)
 *
 * Defeito observado em EXECUÇÃO REAL (04/08/2026, instância isolada, modo SAFE confirmado por
 * API): um pedido roteado para o GoalOrchestrator executava `exec_command` sem gate nenhum —
 * `[TOOL-DISPATCH] ... [GoalStep] outcome=success ... blockers=[none]`, diretório criado, nenhuma
 * AuthTransaction. O mesmo comando pelo caminho do AgentLoop era barrado.
 *
 * Causa: a pergunta "precisa de autorização?" morava DENTRO de um caminho de execução
 * (`AgentLoop`, com `isSafeExecCommand` privado). Step de plano com `toolName` explícito nunca
 * passa por lá — e nada impedia que outros caminhos nascessem igualmente sem gate.
 *
 * O que este teste trava:
 *   1. a decisão é do `ToolRegistry` e vale igual para quem perguntar (paridade entre caminhos);
 *   2. modo SAFE barra `exec_command` não-trivial; DEVELOPER (auto_approve_exec) não barra;
 *   3. comando de leitura-apenas não é barrado em modo nenhum — o gate não pode virar atrito;
 *   4. o caminho de goal, ao barrar, CRIA a transação e devolve `authOptions` no formato
 *      `auth:<approve|reject>:<txnId>` (foi a falta disso que fez o pre-flight antigo ser
 *      removido: goal preso sem transação e sem botão).
 *
 * Execução: npx ts-node src/__tests__/regression/S188_DangerousToolGate_BothExecutionPaths.test.ts
 */

import { ToolRegistry } from '../../core/ToolRegistry';
import { permissionRegistry } from '../../core/PermissionRegistry';
import { OperationalMode } from '../../core/CapabilityMode';
import { isReadOnlyExecCommand } from '../../tools/exec_command';

let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string, detail?: unknown): void {
    if (cond) { console.log(`  OK ${msg}`); passed++; }
    else { console.error(`  FALHOU: ${msg}`, detail ?? ''); failed++; }
}

async function main() {
    console.log('\n=== S188 — gate de ação perigosa vale nos DOIS caminhos de execução (ADR-005) ===');

    ToolRegistry.register({
        name: 'exec_command', description: 'test', parameters: {},
        execute: async () => ({ success: true, output: 'ok' }),
    }, { dangerous: true });
    ToolRegistry.register({
        name: '__s188_safe_tool__', description: 'test', parameters: {},
        execute: async () => ({ success: true, output: 'ok' }),
    });

    console.log('\n--- S188.1 — modo SAFE barra comando não-trivial ---');
    permissionRegistry.setMode(OperationalMode.SAFE, 'test-s188-safe');
    {
        assert(ToolRegistry.requiresAuthorization('exec_command', { command: 'mkdir sprint1-auth-test' }),
            'SAFE: `mkdir` (o comando exato do incidente real) exige autorização');
        assert(ToolRegistry.requiresAuthorization('exec_command', { command: 'pip install requests' }),
            'SAFE: instalação exige autorização');
        assert(!ToolRegistry.requiresAuthorization('__s188_safe_tool__', {}),
            'tool não marcada como dangerous nunca exige autorização');
    }

    console.log('\n--- S188.2 — leitura-apenas não é barrada (o gate não pode virar atrito) ---');
    {
        for (const cmd of ['ls -la', 'echo oi', 'cat arquivo.txt', 'cd /tmp && ls', 'node --version']) {
            assert(!ToolRegistry.requiresAuthorization('exec_command', { command: cmd }),
                `SAFE: "${cmd}" é leitura-apenas e passa sem autorização`);
        }
        // ...mas leitura-apenas não pode ser confundida com escrita disfarçada
        assert(ToolRegistry.requiresAuthorization('exec_command', { command: 'echo x > /etc/passwd' }),
            'SAFE: redirecionamento para arquivo exige autorização mesmo começando com comando seguro');
        assert(ToolRegistry.requiresAuthorization('exec_command', { command: 'cat lista.txt | rm -rf /tmp/x' }),
            'SAFE: pipe para comando destrutivo exige autorização');
    }

    console.log('\n--- S188.3 — DEVELOPER (auto_approve_exec) não barra ---');
    permissionRegistry.setMode(OperationalMode.DEVELOPER, 'test-s188-dev', true);
    {
        assert(permissionRegistry.can('auto_approve_exec'), 'pré-requisito: DEVELOPER concede auto_approve_exec');
        assert(!ToolRegistry.requiresAuthorization('exec_command', { command: 'mkdir qualquer' }),
            'DEVELOPER: o mesmo comando não exige autorização — o modo continua mandando');
    }

    console.log('\n--- S188.4 — paridade: os dois caminhos fazem a MESMA pergunta ---');
    permissionRegistry.setMode(OperationalMode.SAFE, 'test-s188-parity');
    {
        const fs = require('fs');
        const path = require('path');
        const agentLoopSrc = fs.readFileSync(path.join(__dirname, '../../loop/AgentLoop.ts'), 'utf-8');
        const goalLoopSrc = fs.readFileSync(path.join(__dirname, '../../loop/GoalExecutionLoop.ts'), 'utf-8');

        assert(/ToolRegistry\.requiresAuthorization\(/.test(agentLoopSrc),
            'AgentLoop consulta ToolRegistry.requiresAuthorization');
        assert(/ToolRegistry\.requiresAuthorization\(/.test(goalLoopSrc),
            'GoalExecutionLoop consulta ToolRegistry.requiresAuthorization (o caminho que não tinha gate)');
        assert(!/private isSafeExecCommand/.test(agentLoopSrc),
            'a cópia privada da regra saiu do AgentLoop — não há segunda fonte para divergir');
        assert(/createTransaction\(/.test(goalLoopSrc),
            'o caminho de goal cria a transação ao barrar (sem isso o goal ficaria preso sem botão)');
    }

    console.log('\n--- S188.5 — a função de leitura-apenas é independente de SO e de idioma ---');
    {
        // Não depende de texto de interface nem de mensagem traduzida: só estrutura do comando.
        // Limite conhecido, declarado em ADR-005 §6 e travado aqui para não mudar sem decisão:
        // caminho com ESPAÇO (o caso "C:\Program Files\..." do Windows) não é reconhecido como
        // leitura-apenas — o primeiro token vira "C:/Program". O efeito é pedir autorização a
        // mais, nunca a menos: o gate erra para o lado seguro. Afrouxar exigiria tokenizar
        // respeitando aspas, o que mudaria o que conta como seguro — decisão, não ajuste.
        assert(!isReadOnlyExecCommand('exec_command', { command: 'C:/Program Files/nodejs/node --version' }),
            'caminho com espaço (Program Files) falha para o lado seguro: pede autorização');
        assert(isReadOnlyExecCommand('exec_command', { command: 'C:/nodejs/node --version' }),
            'caminho absoluto estilo Windows sem espaço é reconhecido pelo basename');
        assert(isReadOnlyExecCommand('exec_command', { command: '/usr/local/bin/marp --version' }),
            'caminho absoluto estilo Unix é reconhecido pelo basename');
        assert(!isReadOnlyExecCommand('exec_command', { command: 'ls\nls\nls\nls' }),
            'script multi-linha nunca é leitura-apenas, em qualquer SO');
        assert(!isReadOnlyExecCommand('outra_tool', { command: 'ls' }),
            'a função só fala sobre exec_command');
    }

    permissionRegistry.setMode(OperationalMode.SAFE, 'test-s188-restore');
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S188 RESULTADO: ${passed} passou | ${failed} falhou`);
    if (failed > 0) process.exit(1);
    process.exit(0);
}

main().catch(err => { console.error('Erro no teste S188:', err); process.exit(1); });
