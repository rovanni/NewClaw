/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S496 (SPEC-002 do AIGESYNC, sprint 12)
 * `newclaw caminhos` informa em JSON as pastas desta instalação, pela mesma regra que backup/import usam.
 *
 * ORIGEM: o AIGESYNC sincroniza o workspace do NewClaw como pasta (14 GB medidos no PC não cabem no zip do pacote). A
 * pasta do workspace depende de WORKSPACE_DIR no .env, relativo à instalação. Copiar essa regra para o AIGESYNC criaria
 * duas fontes de verdade que podem divergir; o NewClaw passa a INFORMAR o caminho.
 *
 * REGRESSÃO SE: a saída não for uma linha JSON com raiz/dados/skills/workspace; WORKSPACE_DIR/SKILLS_DIR do .env forem
 * ignorados ou resolvidos fora da instalação; sem .env, os padrões não forem <raiz>/workspace e <raiz>/skills; ou o
 * comando sair com 0 quando o NewClaw não está compilado.
 *
 * Roda o bin/newclaw de verdade numa instalação temporária; o dist/ é um atalho para o módulo REAL
 * (src/core/backupDoConhecimento.ts via ts-node), não um falso.
 *
 * Execução: npx ts-node src/__tests__/regression/S496_CLI_CaminhosDaInstalacao.test.ts
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}

const REPO = path.resolve(__dirname, '..', '..', '..');

function rodar(inst: string): { codigo: number | null; saida: string; erro: string } {
    const env = { ...process.env };
    delete env.WORKSPACE_DIR;
    delete env.SKILLS_DIR;
    const r = spawnSync(process.execPath, [path.join(inst, 'bin', 'newclaw'), 'caminhos'], {
        cwd: os.tmpdir(), encoding: 'utf8', timeout: 120_000, env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { codigo: r.status, saida: (r.stdout ?? '').trim(), erro: r.stderr ?? '' };
}

function main(): void {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 's496-'));
    try {
        const inst = path.join(base, 'instalacao');
        fs.mkdirSync(path.join(inst, 'bin'), { recursive: true });
        fs.copyFileSync(path.join(REPO, 'bin', 'newclaw'), path.join(inst, 'bin', 'newclaw'));

        console.log('\n=== S496-1 — sem dist/: erro, nunca um caminho inventado ===');
        const sem = rodar(inst);
        assert(sem.codigo === 1 && sem.saida === '', 'sai com 1 e não imprime caminho', sem);

        fs.mkdirSync(path.join(inst, 'dist', 'core'), { recursive: true });
        const tsNode = require.resolve('ts-node', { paths: [REPO] });
        fs.writeFileSync(path.join(inst, 'dist', 'core', 'backupDoConhecimento.js'),
            `require(${JSON.stringify(tsNode)}).register({ transpileOnly: true, project: ${JSON.stringify(path.join(REPO, 'tsconfig.json'))} });\n` +
            `module.exports = require(${JSON.stringify(path.join(REPO, 'src', 'core', 'backupDoConhecimento.ts'))});\n`);

        console.log('\n=== S496-2 — sem .env: padrões da instalação ===');
        const padrao = rodar(inst);
        let j: Record<string, string> = {};
        try { j = JSON.parse(padrao.saida); } catch { /* fica vazio */ }
        assert(padrao.codigo === 0, 'sai com 0', padrao);
        assert(padrao.saida.split('\n').length === 1, 'uma linha só', padrao.saida);
        assert(j.raiz === inst, 'raiz = pasta da instalação', j);
        assert(j.dados === path.join(inst, 'data'), 'dados = <raiz>/data', j);
        assert(j.workspace === path.join(inst, 'workspace'), 'workspace = <raiz>/workspace', j);
        assert(j.skills === path.join(inst, 'skills'), 'skills = <raiz>/skills', j);

        console.log('\n=== S496-3 — WORKSPACE_DIR e SKILLS_DIR do .env, relativos à instalação ===');
        fs.writeFileSync(path.join(inst, '.env'), 'WORKSPACE_DIR=../meu-workspace\nSKILLS_DIR="./minhas-skills"\n');
        const comEnv = rodar(inst);
        try { j = JSON.parse(comEnv.saida); } catch { j = {}; }
        assert(comEnv.codigo === 0, 'sai com 0', comEnv);
        assert(j.workspace === path.resolve(inst, '../meu-workspace'), 'workspace do .env, resolvido a partir da instalação', j);
        assert(j.skills === path.resolve(inst, 'minhas-skills'), 'skills do .env (aspas removidas)', j);
    } finally {
        try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* ok */ }
    }
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S496 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    process.exit(failed > 0 ? 1 : 0);
}
main();
