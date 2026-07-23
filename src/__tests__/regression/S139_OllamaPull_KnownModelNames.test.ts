/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S139
 *
 * Achado ao vivo (23/07/2026, usuário testando manualmente em localhost:3090): digitar um nome de
 * família conhecido mas incompleto (ex: "kimi") no campo "Puxar modelo" do Registry devolvia
 * "500 Internal Server Error" cru no console, sem explicação. Reproduzido contra Ollama real:
 *
 *   glm, kimi, deepseek, llama  → falham RÁPIDO com {"error":"pull model manifest: file does
 *                                  not exist"}, HTTP 500 (era propagado cru — 500 é semanticamente
 *                                  errado: é o pedido do usuário que está malformado, não o
 *                                  servidor quebrando).
 *   gemma, qwen                 → o Ollama fica tentando resolver o manifest e NUNCA responde —
 *                                  sem timeout no fetch, o botão "Instalar" travaria pra sempre.
 *
 * Este teste cobre os dois casos reais via interpretOllamaPullFailure()/interpretOllamaPullException()
 * — sem bater rede de verdade (mocks/strings capturados ao vivo), pra não deixar a suíte de
 * regressão dependente de rede/Ollama.
 */

import { interpretOllamaPullFailure, interpretOllamaPullException } from '../../dashboard/routes/ollamaPullError';

let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string, detail?: unknown): void {
    if (cond) { console.log(`  ✅ ${msg}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${msg}`, detail ?? ''); failed++; }
}

// Texto de erro real devolvido pelo Ollama (curl direto, 23/07/2026) para nomes incompletos
// que falham rápido.
const REAL_MANIFEST_ERROR = '{"error":"pull model manifest: file does not exist"}';

async function main() {
    console.log('\n=== S139 — Pull de nomes de família conhecidos (gemma/glm/kimi/qwen/deepseek/llama) ===');

    // 1. Nomes que falham RÁPIDO (confirmado ao vivo) — devem virar 400 com mensagem acionável,
    //    nunca mais 500 cru.
    for (const name of ['kimi', 'glm', 'deepseek', 'llama']) {
        const { status, error } = interpretOllamaPullFailure(name, REAL_MANIFEST_ERROR);
        assert(status === 400, `"${name}": status normalizado pra 400 (não 500 — é erro de input, não do servidor)`, status);
        assert(error.includes(name), `"${name}": mensagem cita o nome digitado`, error);
        assert(/tag completa|não encontrado/i.test(error), `"${name}": mensagem orienta a usar a tag completa`, error);
    }

    // 2. Nomes que TRAVAM (confirmado ao vivo: Ollama nunca responde) — a rota usa
    //    AbortSignal.timeout() no fetch, que gera um AbortError; interpretOllamaPullException()
    //    precisa reconhecer isso e não deixar o usuário com um "aborted" genérico.
    for (const name of ['gemma', 'qwen']) {
        const abortError = new DOMException('The operation was aborted', 'AbortError');
        const { status, error } = interpretOllamaPullException(name, abortError);
        assert(status === 408, `"${name}": timeout vira status 408 (não 500 genérico)`, status);
        assert(error.includes(name), `"${name}": mensagem cita o nome digitado`, error);
        assert(/tempo esgotado|ambíguo/i.test(error), `"${name}": mensagem explica que pode ser nome ambíguo`, error);
    }

    // 3. Nome válido completo — não deve cair em nenhum dos ramos de erro (a rota só chama
    //    interpretOllamaPullFailure/Exception quando pullRes NÃO é ok ou a chamada lança).
    //    Aqui só confirmamos que o texto de erro real não teria sido gerado por um nome válido —
    //    guard indireto: o regex de detecção não deve "vazar" falso positivo pra qualquer coisa.
    {
        const { error } = interpretOllamaPullFailure('kimi-k2.6:cloud', 'connection refused');
        assert(!/tag completa/i.test(error), 'erro de rede genérico não confunde com "nome incompleto"', error);
    }

    // 4. Exceção que NÃO é abort/timeout (erro de rede real) continua 500 — não escondida como
    //    se fosse um erro do usuário.
    {
        const { status, error } = interpretOllamaPullException('kimi-k2.6:cloud', new Error('fetch failed: ECONNREFUSED'));
        assert(status === 500, 'erro de rede real (não-abort) continua 500', status);
        assert(!/tempo esgotado/i.test(error), 'erro de rede real não é confundido com timeout', error);
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S139 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    if (failed > 0) process.exit(1);
    process.exit(0);
}

main().catch(err => {
    console.error('Erro no teste S139:', err);
    process.exit(1);
});
