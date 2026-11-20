/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S495 (SPEC-002 do AIGESYNC, sprint 11)
 * `newclaw backup`, `newclaw import` e `newclaw restore <a.zip>` saem com código de erro quando falham.
 *
 * ORIGEM: o AIGESYNC sincroniza as instalações rodando `newclaw backup` e `newclaw import <zip> --sim` e decide pelo
 * código de saída. Medido em 20/11/2026: nos dois comandos, toda falha (NewClaw não compilado, arquivo não encontrado,
 * pacote inválido, importação que lança erro) imprimia "❌ ..." e saía com código 0 — uma importação que falhou parecia
 * feita, e o AIGESYNC avançaria o cursor daquela máquina sem que nada tivesse entrado.
 *
 * REGRESSÃO SE: qualquer um dos casos de falha abaixo sair com 0; o caso de sucesso sair com algo diferente de 0; ou
 * `newclaw import` sem arquivo sair com algo diferente de 2 (uso inválido).
 *
 * Roda o `bin/newclaw` de verdade (processo Node separado) numa instalação temporária: primeiro sem `dist/`, depois com
 * um `dist/core/backupDoConhecimento.js` falso que falha conforme o nome do arquivo.
 *
 * Execução: npx ts-node src/__tests__/regression/S495_CLI_FalhaSaiComCodigoDeErro.test.ts
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

const CLI_ORIGINAL = path.resolve(__dirname, '..', '..', '..', 'bin', 'newclaw');

/** Módulo falso: o nome do arquivo decide a falha. Só o que a CLI usa nos três comandos. */
const MODULO_FALSO = `
exports.lerPacote = async (p) => {
  if (p.includes('invalido')) throw new Error('pacote invalido (teste S495)');
  return { manifesto: { criadoEm: 'x', sistema: 'teste', app: '0', contagens: {} }, avisos: [] };
};
exports.caminhosDaInstalacao = (d) => ({ dados: d });
exports.comTravaDeSync = async (_c, fn) => fn();
exports.importarPacote = async (p) => {
  if (p.includes('falha')) throw new Error('importacao falhou (teste S495)');
  return { memorias: { importadas: 1, jaExistiam: 0, paraRevisar: 0, preferenciasEmConflito: [] },
    skills: { novas: 0, iguais: 0, comDiferenca: [], paraRevisar: [] }, skillsAprendidas: 0, pacoteDeSeguranca: 's.zip' };
};
exports.restaurarPacote = async (p) => {
  if (p.includes('falha')) throw new Error('restauracao falhou (teste S495)');
  return { skills: 0, banco: false, env: false, skillsParaRevisar: [], pacoteDeSeguranca: 's.zip' };
};
exports.criarPacote = async () => { throw new Error('criar pacote falhou (teste S495)'); };
`;

function rodar(instalacao: string, args: string[]): { codigo: number | null; saida: string } {
    const r = spawnSync(process.execPath, [path.join(instalacao, 'bin', 'newclaw'), ...args], {
        cwd: instalacao, encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { codigo: r.status, saida: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

function main(): void {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 's495-'));
    try {
        const inst = path.join(base, 'instalacao');
        fs.mkdirSync(path.join(inst, 'bin'), { recursive: true });
        fs.copyFileSync(CLI_ORIGINAL, path.join(inst, 'bin', 'newclaw'));
        for (const nome of ['ok.zip', 'invalido.zip', 'falha.zip']) fs.writeFileSync(path.join(base, nome), 'zip de teste');
        const zip = (nome: string) => path.join(base, nome);

        console.log('\n=== S495-1 — NewClaw não compilado (sem dist/) ===');
        for (const args of [['backup'], ['import', zip('ok.zip'), '--sim'], ['restore', zip('ok.zip'), '--sim']]) {
            const r = rodar(inst, args);
            assert(r.codigo === 1 && /não foi compilado/.test(r.saida), `newclaw ${args[0]} sem dist/ sai com 1`, r);
        }

        console.log('\n=== S495-2 — com dist/, falhas de cada etapa ===');
        fs.mkdirSync(path.join(inst, 'dist', 'core'), { recursive: true });
        fs.writeFileSync(path.join(inst, 'dist', 'core', 'backupDoConhecimento.js'), MODULO_FALSO);
        const casos: Array<[string[], number, RegExp, string]> = [
            [['import', zip('nao-existe.zip'), '--sim'], 1, /Arquivo não encontrado/, 'import de arquivo que não existe'],
            [['import', zip('invalido.zip'), '--sim'], 1, /pacote invalido/, 'import de pacote inválido'],
            [['import', zip('falha.zip'), '--sim'], 1, /importacao falhou/, 'import que lança erro na mesclagem'],
            [['restore', zip('nao-existe.zip'), '--sim'], 1, /Arquivo não encontrado/, 'restore de arquivo que não existe'],
            [['restore', zip('invalido.zip'), '--sim'], 1, /pacote invalido/, 'restore de pacote inválido'],
            [['restore', zip('falha.zip'), '--sim'], 1, /restauracao falhou/, 'restore que lança erro'],
            [['backup'], 1, /criar pacote falhou/, 'backup que lança erro'],
            [['import'], 2, /Use: newclaw import/, 'import sem arquivo é uso inválido'],
        ];
        for (const [args, esperado, texto, nome] of casos) {
            const r = rodar(inst, args);
            assert(r.codigo === esperado && texto.test(r.saida), `${nome}: sai com ${esperado}`, r);
        }

        console.log('\n=== S495-3 — sucesso continua saindo com 0 ===');
        for (const args of [['import', zip('ok.zip'), '--sim'], ['restore', zip('ok.zip'), '--sim']]) {
            const r = rodar(inst, args);
            assert(r.codigo === 0 && /✅/.test(r.saida), `newclaw ${args[0]} que deu certo sai com 0`, r);
        }
    } finally {
        try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* ok */ }
    }
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S495 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    process.exit(failed > 0 ? 1 : 0);
}
main();
