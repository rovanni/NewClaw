/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S56
 * Investigação de log real (05/07/2026, 20:47, Telegram, correlationId=321b0506-06ba-4364-ab71-b115ed722250):
 *
 *   Usuário disse "ok", confirmando um plano que o assistente tinha descrito no turno
 *   anterior (ler o arquivo e ajustar os slides). UnifiedIntentRouter classificou
 *   deterministicamente como category=confirmation e enviou TODAS as ferramentas ao modelo
 *   (log: "[TOOLS] Sending all tools (category=confirmation, confidence=0.98)") — não houve
 *   restrição de tools. Mesmo assim, o modelo respondeu com toolCalls=0, tipo `final_answer`,
 *   isComplete=true, dizendo: "Entendido. Vou refazer a estrutura... Estou gerando o arquivo
 *   agora e te envio em instantes!" — e o turno terminou ali (FINAL_READY → DONE). Nenhum
 *   arquivo foi gerado, nenhum job em background foi criado. O usuário ficou esperando um
 *   envio que nunca chegaria (relato do próprio usuário: "fico esperando como bobo").
 *
 * Causa raiz: em `commitResponse`, quando nenhuma tool rodou no turno (`last === null`), o
 * código tinha UM bypass total: `if (!last) return response; // sem tool executada → sem
 * risco de alucinação de ação`. Essa suposição é falsa exatamente neste caso: a resposta
 * PROMETE uma ação em andamento/iminente ("estou gerando agora", "te envio em instantes"),
 * mas sem tool nenhuma rodando não existe job nenhum por trás da promessa — o "instantes"
 * nunca chega. O detector de falso-sucesso existente (`looksLikeFalseSuccess`) cobre
 * alegações de conclusão PASSADA ("foi gerado", "enviado com sucesso"); não cobre promessas
 * de ação em curso, e mesmo se cobrisse, o bypass `if (!last) return response` intercepta
 * antes de qualquer checagem chegar lá.
 *
 * Fix: novo helper `looksLikePendingActionPromise` (escopo estreito, deliberadamente
 * separado de `looksLikeFalseSuccess` — semântica diferente: promessa em curso, não
 * conclusão passada), checado ANTES do bypass `if (!last)`. Só dispara quando ZERO tools
 * rodaram no turno — uma resposta real "estou gerando" dita DURANTE/APÓS uma tool rodar
 * segue o caminho normal (last !== null), sem mudança de comportamento aí.
 *
 * Escopo tocado: loop/AgentLoop.ts (commitResponse + novo helper estático).
 *
 * Execução: npx ts-node src/__tests__/regression/S56_CommitResponse_PendingActionPromise.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`); failed++; }
}

const agentLoopPath = path.join(process.cwd(), 'src', 'loop', 'AgentLoop.ts');
const agentLoopSource = fs.readFileSync(agentLoopPath, 'utf-8');

// Reproduz os regexes exatos do patch, isolados do resto do AgentLoop (mesmo padrão dos
// testes anteriores — a classe real não pode ser instanciada fora do runtime completo).
function looksLikePendingActionPromise(text: string): boolean {
    return /\best(ou|á)\s+\w+ndo\b[^.!?]{0,40}\b(agora|neste\s+momento)\b/i.test(text)
        || /\b(te\s+|lhe\s+)?(envio|mando)\s+em\s+(instantes|breve|seguida)\b/i.test(text)
        || /\bj[aá]\s+j[aá](?![a-zà-ÿ])/i.test(text);
}

async function main(): Promise<void> {

console.log('\n=== S56-1 — AgentLoop.ts: guard de pending-action-promise existe e roda antes do bypass ===');
{
    assert(
        /private static looksLikePendingActionPromise\(text: string\): boolean/.test(agentLoopSource),
        'helper looksLikePendingActionPromise existe como método estático dedicado (não reaproveita looksLikeFalseSuccess)',
    );
    const guardIdx = agentLoopSource.indexOf('AgentLoop.looksLikePendingActionPromise(response)');
    const bypassIdx = agentLoopSource.indexOf('if (!last) return response; // sem tool executada');
    assert(guardIdx > -1 && bypassIdx > -1 && guardIdx < bypassIdx, 'checagem roda ANTES do bypass "sem tool executada → sem risco"');
}

console.log('\n=== S56-2 — reprodução isolada: frase real do incidente é detectada ===');
{
    const realResponse = 'Entendido. Vou refazer a estrutura da sua aula de Excel agora mesmo, aplicando rigorosamente a regra ' +
        'de no máximo 10 linhas por slide.\n\nPara que o material fique completo, vou dividir cada tópico em duas partes...' +
        '\n\nEstou gerando o arquivo agora e te envio em instantes!';
    assert(looksLikePendingActionPromise(realResponse), 'detecta a frase exata do incidente real ("estou gerando o arquivo agora e te envio em instantes")');
}

console.log('\n=== S56-3 — variações do mesmo padrão são detectadas ===');
{
    assert(looksLikePendingActionPromise('Estou processando os dados agora, aguarde.'), '"estou processando... agora" é detectado');
    assert(looksLikePendingActionPromise('Já já te mando o arquivo!'), '"já já" é detectado');
    assert(looksLikePendingActionPromise('Vou terminar e te envio em breve.'), '"te envio em breve" é detectado');
    assert(looksLikePendingActionPromise('Mando em instantes o resultado.'), '"mando em instantes" é detectado');
}

console.log('\n=== S56-4 — respostas legítimas (sem promessa de ação em curso) não disparam falso positivo ===');
{
    assert(!looksLikePendingActionPromise('Oi! Tudo bem? Como posso ajudar hoje?'), 'saudação simples não dispara');
    assert(!looksLikePendingActionPromise('O clima em Belo Horizonte hoje está ensolarado, 28°C.'), 'resposta informativa não dispara');
    assert(
        !looksLikePendingActionPromise('Posso gerar os slides para você, mas antes preciso confirmar: 10 linhas por slide está bom?'),
        'pergunta de clarificação (sem afirmar ação em curso) não dispara',
    );
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S56 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;

}

main().catch((err) => {
    console.error('S56 erro inesperado:', err);
    process.exitCode = 1;
});
