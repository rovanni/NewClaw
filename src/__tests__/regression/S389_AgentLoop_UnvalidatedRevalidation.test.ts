/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S389 (Campanha 2 — Sprint J1; política revista em 14/10/2026)
 *
 * Incidente real (12/10/2026 07:46): o agente coletou os e-mails do usuário no 1º minuto, mas o juiz de grounding estourou o prazo
 * (UNVALIDATED). O código de então descartava a resposta e o goal replanejava por 33 minutos. A Sprint J1 passou a REVALIDAR a mesma
 * resposta (mais uma chamada inteira do juiz, ~200 s) antes de descartar.
 *
 * Decisão da mantenedora (14/10/2026, ADR-010 — adendo): quando o juiz NÃO CONCLUI, a resposta é ENTREGUE com um aviso explícito de que
 * não foi conferida — sem a segunda espera e sem replanejar. Quando o juiz CONCLUI e acha problema (REJECTED/NOT_EVALUABLE), continua
 * bloqueando, com a correção dirigida (S394). O nome do arquivo foi mantido para preservar o histórico.
 *
 * REGRESSÃO SE: UNVALIDATED voltar a bloquear ou a pagar uma segunda chamada do juiz; o aviso sumir ou sair fora do idioma configurado;
 * ou REJECTED/NOT_EVALUABLE passarem a ser entregues.
 *
 * Execução: npx ts-node src/__tests__/regression/S389_AgentLoop_UnvalidatedRevalidation.test.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { AgentLoop } from '../../loop/AgentLoop';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

const fonte = fs.readFileSync(path.join(process.cwd(), 'src', 'loop', 'AgentLoop.ts'), 'utf-8');

console.log('\n=== S389-1 — UNVALIDATED: entrega com aviso, sem segunda chamada do juiz ===');
{
    const i = fonte.indexOf("if (g.state === 'UNVALIDATED')");
    const bloco = fonte.slice(i, fonte.indexOf('}', fonte.indexOf('return AgentLoop.comAvisoSemVeredito(response);', i)) + 1);
    assert(i > -1 && bloco.includes('return AgentLoop.comAvisoSemVeredito(response);'), 'o ramo UNVALIDATED devolve a resposta com o aviso', bloco.slice(0, 200));
    assert(!/validateGrounding\(/.test(bloco), 'o ramo UNVALIDATED NÃO chama o juiz de novo (a espera de ~200 s saiu)');
    assert(/resposta_entregue_sem_veredito/.test(bloco), 'o efeito vai para o gravador de voo');
    assert(fonte.indexOf("if (g.state === 'UNVALIDATED')") > fonte.indexOf('const supportedClaims = g.claims.filter'), 'vem depois da tentativa de resposta parcial (que só existe com afirmações confirmadas)');
    assert(/groundingBlockedMessage\(g\.state, turnState\.groundingBlock\.unconfirmedClaims\)/.test(fonte), 'REJECTED/NOT_EVALUABLE continuam bloqueando');
}

console.log('\n=== S389-2 — o aviso, nos três idiomas suportados ===');
{
    const r = AgentLoop.comAvisoSemVeredito('Faz 18 °C.  ', 'pt-BR');
    assert(r.startsWith('Faz 18 °C.') && r.endsWith(AgentLoop.AVISO_SEM_VEREDITO['pt-BR']) && /não consegui conferir/i.test(r), 'pt-BR: resposta íntegra + aviso', r);
    assert(AgentLoop.comAvisoSemVeredito('ok', 'en-US').endsWith(AgentLoop.AVISO_SEM_VEREDITO['en-US']) && /could not check/.test(AgentLoop.AVISO_SEM_VEREDITO['en-US']), 'en-US');
    assert(AgentLoop.comAvisoSemVeredito('ok', 'es-ES').endsWith(AgentLoop.AVISO_SEM_VEREDITO['es-ES']) && /No pude verificar/.test(AgentLoop.AVISO_SEM_VEREDITO['es-ES']), 'es-ES');
    assert(AgentLoop.comAvisoSemVeredito('ok', 'xx-YY').endsWith(AgentLoop.AVISO_SEM_VEREDITO['pt-BR']), 'idioma desconhecido → pt-BR (o padrão do projeto)');
}

console.log(`\nResultado: ${passed} passaram, ${failed} falharam.`);
if (failed > 0) process.exit(1);
