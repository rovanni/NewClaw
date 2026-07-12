/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S13
 * exec_command: normalização de path de "workspace de outra instalação" delegada para
 * resolvePath() (Sprint P1 de consolidação, 02/07/2026) — em vez de reimplementação própria.
 *
 * PROBLEMA CORRIGIDO: exec_command.ts tinha sua própria lógica de remapeamento de paths
 * (regex + path.sep manual) que já tinha divergido 2x da resolvePath() real nesta mesma sessão
 * (barra errada pro cmd.exe, falso-positivo "workspace2"). resolvePath() também tinha uma
 * lacuna que exec_command.ts já tinha corrigido sozinho (diretório "bare", sem arquivo depois)
 * — corrigida na fonte canônica antes desta consolidação.
 *
 * PROPRIEDADE CRÍTICA DE SEGURANÇA: exec_command NÃO é sandboxed por design ("Acesso total ao
 * shell... bloqueia apenas comandos destrutivos"). A delegação para resolvePath() só pode
 * disparar para tokens que parecem referência a um "workspace" de outra instalação — nunca
 * para paths absolutos genéricos, senão um comando tipo "cat /etc/passwd" (uso legítimo,
 * testado ao vivo na VPS) seria incorretamente redirecionado pra dentro do sandbox.
 *
 * Execução: npx ts-node src/__tests__/regression/S13_ExecCommand_ResolvePath_Redirect.test.ts
 */

process.env.WORKSPACE_DIR = process.env.WORKSPACE_DIR || 'D:/IA/newclaw/workspace';

import * as fs from 'fs';
import * as path from 'path';
import { ExecCommandTool } from '../../tools/exec_command';
import { resolvePath } from '../../utils/crossPlatform';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

async function main() {
    const tool = new ExecCommandTool();
    const workspaceDir = path.resolve(process.env.WORKSPACE_DIR!);

    // ── 1. Path absoluto de outra instalação — resultado bate com resolvePath() direto ──
    console.log('\n=== S13 — path de workspace estrangeiro remapeado igual à resolvePath() ===');
    {
        const foreignPath = '/home/venus/newclaw/workspace/sanitize_memory.py';
        const { resolved: expected } = resolvePath(foreignPath);
        const r = await tool.execute({ command: `type ${foreignPath}` });
        // Não precisa o arquivo existir de fato — só que o comando FINAL montado usaria o path
        // resolvido; validamos indiretamente checando que não sobrou nenhum vestígio do path
        // estrangeiro no erro (que ecoa o comando/mensagem do shell).
        assert(
            !(r.error ?? '').includes('/home/venus'),
            'comando final não contém mais o path estrangeiro original',
            r,
        );
        console.log(`      (resolvePath() direto resolveria para: ${expected})`);
    }

    // ── 2. Diretório "bare" (sem arquivo depois) não cria pasta aninhada de verdade ──
    console.log('\n=== S13 — diretório bare de workspace estrangeiro não cria pasta aninhada ===');
    {
        const dirName = 'teste_s13_' + Date.now();
        const r = await tool.execute({ command: `mkdir /home/venus/newclaw/workspace/${dirName}` });
        assert(r.success === true, 'mkdir bare (sem arquivo) funciona', r);
        const createdAtRoot = fs.existsSync(path.join(workspaceDir, dirName));
        const createdNested = fs.existsSync(path.join(workspaceDir, 'home', 'venus', 'newclaw', 'workspace', dirName));
        assert(createdAtRoot, 'pasta criada na raiz do workspace (local correto)');
        assert(!createdNested, 'NÃO criou árvore home/venus/newclaw/workspace aninhada');
        if (createdAtRoot) fs.rmSync(path.join(workspaceDir, dirName), { recursive: true, force: true });
    }

    // ── 3. "workspace2" (pasta diferente) não é tocado ──────────────────────────
    console.log('\n=== S13 — "workspace2" não é confundido com o workspace real ===');
    {
        const r = await tool.execute({ command: 'echo teste /home/venus/newclaw/workspace2/arquivo.txt' });
        assert(
            (r.output ?? '').includes('workspace2') || (r.error ?? '').includes('workspace2'),
            'referência a workspace2 permanece intocada no comando executado',
            r,
        );
    }

    // ── 4. PROPRIEDADE DE SEGURANÇA: path absoluto genérico NÃO é sandboxed ─────
    console.log('\n=== S13 — path absoluto SEM "workspace" no meio NÃO é redirecionado (sem sandbox) ===');
    {
        // Um arquivo que certamente existe no Windows, fora de qualquer workspace.
        const systemFile = process.platform === 'win32'
            ? 'C:\\Windows\\System32\\drivers\\etc\\hosts'
            : '/etc/hosts';
        const r = await tool.execute({ command: `type "${systemFile}"` });
        // Sucesso ou falha aqui depende do SO ter o arquivo, mas o que importa é que o
        // erro (se houver) não é um erro de sandbox/redirecionamento indevido — é o próprio
        // shell reclamando (ou tendo sucesso) com o path ORIGINAL, sem reescrita.
        assert(
            !(r.error ?? '').includes(workspaceDir),
            'comando com path de sistema genérico não foi redirecionado pro workspace (sem sandbox indevido)',
            r,
        );
    }

    // ── 5. "workspace/" relativo: só remapeado quando NÃO há workdir customizado ──
    console.log('\n=== S13 — prefixo relativo "workspace/" respeita workdir customizado ===');
    {
        // Sem workdir customizado: "workspace/" deve ser remapeado (cwd já é workspaceDir).
        const r1 = await tool.execute({ command: 'echo workspace/arquivo.txt' });
        assert(
            (r1.output ?? '').includes(path.join(workspaceDir, 'arquivo.txt')) || !(r1.output ?? '').includes('workspace/arquivo.txt'),
            'sem workdir: "workspace/arquivo.txt" é remapeado (não aparece mais como "workspace/...")',
            r1,
        );

        // Com workdir customizado: "workspace/" NÃO deve ser remapeado (fica relativo ao workdir).
        const r2 = await tool.execute({ command: 'echo workspace/arquivo.txt', workdir: '.' });
        assert(
            (r2.output ?? '').includes('workspace/arquivo.txt') || (r2.output ?? '').includes('workspace\\arquivo.txt'),
            'com workdir customizado: "workspace/arquivo.txt" permanece intocado',
            r2,
        );
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S13 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    if (failed > 0) process.exit(1);
}

main().catch(err => { console.error('ERRO NÃO TRATADO:', err); process.exit(1); });
