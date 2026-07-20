/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S130 (CodeQL alert #57, js/command-line-injection, Critical)
 *
 * `SkillInstaller.install({git})` montava o comando com `exec(\`git clone "${gitUrl}" "${dest}"\`)`
 * — gitUrl passava só por `isValidGitUrl()`, que valida o prefixo (`https://<host>/`) e a
 * ausência de `..`, mas não restringe nenhum caractere do resto da URL. Uma URL contendo `"`
 * seguido de um separador de comando do shell (`&` no cmd.exe do Windows, `;`/backtick no POSIX)
 * escapava das aspas e injetava um comando arbitrário no processo do NewClaw.
 *
 * Fix: `execFile('git', ['clone', gitUrl, dest])` — array de args, sem shell no meio. `gitUrl`
 * nunca é interpretado por um interpretador de comandos, então não existe caractere que "escape"
 * de um argumento pra outro.
 *
 * Este teste roda o `SkillInstaller` de verdade (sem mock de `child_process`) com uma URL
 * adversarial que, no código antigo, injetava um comando que cria um arquivo-marcador. Prova
 * dupla: (1) o marcador nunca é criado — nenhum comando injetado rodou; (2) `install()` retorna
 * `success:false` (git falha normalmente, tratando a URL toda como argumento, não como injeção
 * silenciosamente engolida).
 *
 * Execução: npx ts-node src/__tests__/regression/S130_SkillInstaller_GitCloneCommandInjection.test.ts
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { SkillInstaller } from '../../skills/SkillInstaller';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  OK ${message}`); passed++; }
    else { console.error(`  FALHOU: ${message}`, detail ?? ''); failed++; }
}

async function main() {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'newclaw-s130-'));
    const skillsDir = path.join(workDir, 'skills');
    const markerPath = path.join(workDir, 'PWNED.marker');

    console.log('\n=== S130.1 — URL adversarial (payload de comando pro shell do Windows, "&") não executa comando injetado ===');
    {
        const installer = new SkillInstaller(skillsDir, workDir);
        // O payload precisa ficar ANTES do último "/" da URL: SkillInstaller.install() deriva
        // repoName de gitUrl.split('/').pop() e passa isso por sanitizeArg() (whitelist estrita)
        // antes mesmo de chegar no git clone — um payload no último segmento seria barrado por
        // essa checagem upstream, não pela correção testada aqui (execFile na linha do clone).
        // Colocando o payload num segmento do MEIO da URL e um nome de repo limpo no final,
        // o payload sobrevive até a chamada de execFile de verdade.
        const maliciousUrl = `https://example.invalid/x" & type nul > "${markerPath}" & "y/legit-repo`;
        const result = await installer.install({ git: maliciousUrl });

        assert(!fs.existsSync(markerPath), 'nenhum arquivo-marcador criado (comando injetado não rodou)', fs.existsSync(markerPath));
        assert(result.success === false, 'install() retorna success:false (git trata a URL inteira como argumento inválido)', result);
    }

    console.log('\n=== S130.2 — URL adversarial (payload estilo POSIX, ";") também não executa comando injetado ===');
    {
        const installer = new SkillInstaller(skillsDir, workDir);
        const markerPath2 = path.join(workDir, 'PWNED2.marker');
        const maliciousUrl = `https://example.invalid/x"; touch "${markerPath2}"; echo "y/legit-repo-2`;
        const result = await installer.install({ git: maliciousUrl });

        assert(!fs.existsSync(markerPath2), 'nenhum arquivo-marcador criado (payload POSIX também não escapa)', fs.existsSync(markerPath2));
        assert(result.success === false, 'install() retorna success:false', result);
    }

    console.log('\n=== S130.3 — URL de git válida e legítima ainda funciona (regressão do caminho feliz) ===');
    {
        const installer = new SkillInstaller(skillsDir, workDir);
        // Repo real, pequeno, público — prova que execFile com array de args não quebrou o
        // clone legítimo (timeout de 60s do próprio SkillInstaller cobre lentidão de rede).
        const result = await installer.install({ git: 'https://github.com/octocat/Hello-World.git' });
        assert(result.success === true, 'clone de URL legítima ainda funciona depois da migração pra execFile', result);
        if (result.success && result.data?.path) {
            assert(fs.existsSync(result.data.path), 'diretório clonado existe de fato no disco', result.data.path);
        }
    }

    console.log(`\n=== RESULTADO: ${passed} passou, ${failed} falhou ===`);
    fs.rmSync(workDir, { recursive: true, force: true });
    if (failed > 0) process.exit(1);
}

main().catch(err => { console.error(err); process.exit(1); });
