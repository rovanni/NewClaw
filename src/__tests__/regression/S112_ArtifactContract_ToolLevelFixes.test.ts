/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S112
 *
 * Sprint F2 (revisão de código pós-piloto R1-R7, /code-review high sobre commits 4be42a5/
 * 9baa18e): dois achados confirmados em nível de tool, não de RiskAnalyzer:
 *
 * 1. write_tool.ts populava `artifactPaths` incondicionalmente no sucesso, sem checar
 *    MIN_DELIVERABLE_SIZE — diferente de exec_command.ts, que verifica tamanho antes de
 *    confiar numa declaração ARTIFACT:. Um write de conteúdo curto (não capturado por
 *    CONTENT_STUB_PATTERNS, que é só regex, sem limiar de tamanho) virava evidência
 *    "confiável" sem passar pela mesma régua.
 *
 * 2. exec_command.ts descartava o campo `error` de resolvePath() ao processar linhas
 *    ARTIFACT: — um path fora do sandbox ainda podia ser aceito como evidência verificada
 *    se `fs.statSync` confirmasse que o arquivo existe (ex: aponta pra um arquivo real fora
 *    do workspace).
 *
 * Execução: npx ts-node src/__tests__/regression/S112_ArtifactContract_ToolLevelFixes.test.ts
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { WriteTool } from '../../tools/write_tool';
import { ExecCommandTool } from '../../tools/exec_command';
import { extractVerifiedArtifacts } from '../../loop/planning/artifactContract';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'newclaw-s112-workspace-'));
process.env.WORKSPACE_DIR = workspaceDir;

async function main() {
    console.log('\n=== S112.1 — write_tool NÃO popula artifactPaths para conteúdo abaixo de MIN_DELIVERABLE_SIZE ===');
    {
        const tool = new WriteTool();
        const result = await tool.execute({ path: 'tmp/curto.txt', content: 'oi' }); // 2 bytes, real mas curto
        assert(result.success === true, 'write teve sucesso (conteúdo não é stub, só é curto)', result);
        assert(
            !result.artifactPaths || result.artifactPaths.length === 0,
            'artifactPaths NÃO foi populado para conteúdo abaixo de MIN_DELIVERABLE_SIZE',
            result.artifactPaths
        );
    }

    console.log('\n=== S112.2 — write_tool POPULA artifactPaths para conteúdo real e substantivo ===');
    {
        const tool = new WriteTool();
        const content = 'conteúdo real e substantivo, '.repeat(10); // > 200 bytes
        const result = await tool.execute({ path: 'tmp/substantivo.txt', content });
        assert(result.success === true, 'write teve sucesso', result);
        assert(
            Array.isArray(result.artifactPaths) && result.artifactPaths.length === 1,
            'artifactPaths populado normalmente para conteúdo substantivo (comportamento inalterado)',
            result.artifactPaths
        );
    }

    console.log('\n=== S112.3 — extractVerifiedArtifacts() ignora candidato cujo resolvePathFn sinaliza error, mesmo o arquivo existindo de verdade ===');
    {
        // Teste unitário direto (não via ExecCommandTool): resolvePath() real do projeto tem
        // os.tmpdir() na allowlist do sandbox por design (uso legítimo de outras tools) — não é
        // um path realista de "fora do sandbox" pra reproduzir o achado via arquivo real no
        // disco. Testa a função exatamente como ela decide: um resolvePathFn que sinaliza
        // error, mesmo apontando pra um arquivo que EXISTE de verdade e passaria em fs.statSync.
        const realFile = path.join(workspaceDir, 'existe_de_verdade.txt');
        fs.writeFileSync(realFile, 'conteúdo real, bytes suficientes para passar o limiar, '.repeat(5));

        const stdout = 'ARTIFACT: caminho/suspeito.txt';
        const verified = extractVerifiedArtifacts(stdout, () => ({ resolved: realFile, error: '⛔ Caminho fora do sandbox' }));

        assert(
            verified.length === 0,
            'candidato descartado por causa do error de resolvePathFn, mesmo o arquivo existindo e tendo tamanho suficiente',
            verified
        );
    }

    console.log('\n=== S112.4 — exec_command ACEITA declaração ARTIFACT: dentro do workspace (comportamento inalterado) ===');
    {
        const tool = new ExecCommandTool();
        const writeCmd = process.platform === 'win32'
            ? `powershell -Command "'conteudo real e substantivo dentro do workspace, '.PadRight(220,'x') | Out-File -Encoding utf8 tmp/dentro.txt" && echo ARTIFACT: tmp/dentro.txt`
            // `{1..220}` é expansão de chaves do bash — exec_command.ts spawna via Node
            // child_process.exec(), que no Linux usa /bin/sh (dash no Debian/Ubuntu, SEM
            // suporte a brace expansion). Achado real validando em VPS Ubuntu 24.04 (17/07/2026,
            // docs/issues/002): o comando original silenciosamente tratava "{1..220}" como token
            // literal em vez de expandir, gerando um tmp/dentro.txt curto demais e escondendo o
            // que este teste deveria provar. `awk` é POSIX/onipresente — não depende de bashismos.
            : `mkdir -p tmp && printf 'conteudo real e substantivo dentro do workspace, %s' "$(awk 'BEGIN{for(i=0;i<220;i++)printf "x"}')" > tmp/dentro.txt && echo "ARTIFACT: tmp/dentro.txt"`;
        const result = await tool.execute({ command: writeCmd });

        assert(result.success === true, 'comando executou com sucesso', result);
        assert(
            Array.isArray(result.artifactPaths) && result.artifactPaths.some(p => p.includes('dentro.txt')),
            'artifactPaths populado normalmente para declaração dentro do sandbox (comportamento inalterado)',
            result
        );
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S112 RESULTADO: ${passed} passou | ${failed} falhou`);
    try { fs.rmSync(workspaceDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    if (failed > 0) process.exit(1);
}

main().catch(err => { console.error('ERRO NÃO TRATADO:', err); process.exit(1); });
