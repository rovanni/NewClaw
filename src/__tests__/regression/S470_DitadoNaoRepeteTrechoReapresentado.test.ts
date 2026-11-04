/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S470
 * Ditado do painel: um trecho final que o navegador reapresenta (ao retomar a sessão de reconhecimento depois de um
 * silêncio) não é escrito duas vezes no campo de mensagem. Fala repetida de verdade continua.
 *
 * ORIGEM: a correção nasceu na produção do Windows em 31/10/2026, editada direto em `src/dashboard/public/index.html`,
 * fora do git. Este teste e o mesmo código no repositório tiram essa diferença da produção (auditoria de 04/11/2026,
 * item P1-3).
 *
 * Executa o bloco `<ditado-puro>` do index.html REAL, isolado num contexto `vm` (sem DOM).
 *
 * Execução: npx ts-node src/__tests__/regression/S470_DitadoNaoRepeteTrechoReapresentado.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string, detail?: unknown): void {
    if (cond) { console.log(`  OK ${msg}`); passed++; }
    else { console.error(`  FALHOU: ${msg}`, detail ?? ''); failed++; }
}

const html = fs.readFileSync(path.join(process.cwd(), 'src', 'dashboard', 'public', 'index.html'), 'utf-8');
const inicio = html.indexOf('// <ditado-puro>');
const fim = html.indexOf('// </ditado-puro>');
assert(inicio >= 0 && fim > inicio, 'o index.html tem o bloco <ditado-puro> demarcado');

type Resultado = { isFinal: boolean; 0: { transcript: string } };
type Estado = { text: string; lastFinal: string };
const ctx: Record<string, unknown> = {};
vm.runInNewContext(html.slice(inicio, fim) + '\nthis.applyDictationResults = applyDictationResults;', ctx);
const aplicar = ctx.applyDictationResults as (s: Estado, r: Resultado[], de: number) => Estado & { interim: string };

const fin = (t: string): Resultado => ({ isFinal: true, 0: { transcript: t } });
const par = (t: string): Resultado => ({ isFinal: false, 0: { transcript: t } });

// Fala normal: parcial e depois final.
let s: Estado = { text: '', lastFinal: '' };
let r = aplicar(s, [par('olá tu')], 0);
assert(r.text === '' && r.interim === 'olá tu', 'parcial vai só para a prévia', r);
r = aplicar(s, [fin('olá tudo bem')], 0);
assert(r.text === 'olá tudo bem' && r.lastFinal === 'olá tudo bem', 'final entra no texto', r);
s = r;

// O caso da correção: depois de um silêncio o navegador reapresenta o mesmo trecho final.
r = aplicar(s, [fin('olá tudo bem')], 0);
assert(r.text === 'olá tudo bem', 'trecho final reapresentado sem fala nova não se repete', r);
s = r;

// Fala nova continua normalmente.
r = aplicar(s, [par('e você'), fin('e você')], 0);
assert(r.text === 'olá tudo bem e você', 'trecho novo entra com espaço', r);
s = r;

// Repetição de verdade ("sim", pausa, "sim"): passa por parcial antes, então fica.
r = aplicar({ text: 'sim', lastFinal: 'sim' }, [par('sim'), fin('sim')], 0);
assert(r.text === 'sim sim', 'fala repetida de verdade (com parcial no meio) é mantida', r);

// resultIndex: só os resultados novos do evento são aplicados.
r = aplicar({ text: 'um', lastFinal: 'um' }, [fin('um'), fin('dois')], 1);
assert(r.text === 'um dois', 'resultados anteriores a resultIndex não são reaplicados', r);

// Texto que já estava no campo antes do ditado.
r = aplicar({ text: 'Rascunho:', lastFinal: '' }, [fin('primeira frase')], 0);
assert(r.text === 'Rascunho: primeira frase', 'o ditado continua o texto que já estava no campo', r);

console.log(`\n${'─'.repeat(60)}`);
console.log(`S470 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
process.exit(failed > 0 ? 1 : 0);
