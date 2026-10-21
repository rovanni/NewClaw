/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S439
 * Variável de ambiente de nome sensível com valor curto (6–7 caracteres) também é mascarada — mesmo mínimo do cofre.
 *
 * INCIDENTE REAL (Linux, 17/10/2026, Telegram: "esqueci a senha do dashboard"): o agente leu DASHBOARD_PASSWORD no .env e
 * escreveu o valor na resposta (texto e áudio). O valor tinha 7 caracteres e `segredosConhecidos` só mascarava variável de
 * nome sensível a partir de 8 — foi em claro ao modelo de nuvem, ao log e ao Telegram.
 *
 * Execução: npx ts-node src/__tests__/regression/S439_SegredoCurtoDoAmbienteMascarado.test.ts
 */
import { segredosConhecidos, mascararSegredos } from '../../shared/segredos';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}

console.log('\n=== S439-1 — valor de 7 caracteres em variável sensível é mascarado ===');
{
    const env = { DASHBOARD_PASSWORD: 'abc2026', TELEGRAM_BOT_TOKEN: '123456:AAexemploexemploexemplo' } as NodeJS.ProcessEnv;
    const conhecidos = segredosConhecidos(env);
    assert(conhecidos.some(s => s.nome === 'DASHBOARD_PASSWORD'), 'a senha curta entra na lista de valores conhecidos', conhecidos.map(s => s.nome));
    const texto = mascararSegredos('Sua senha do painel é abc2026 — tudo junto.', conhecidos);
    assert(!texto.includes('abc2026') && texto.includes('<SEGREDO:DASHBOARD_PASSWORD>'), 'o valor sai do texto (resposta, log, prompt)', texto);
}

console.log('\n=== S439-2 — o que não é segredo continua de fora ===');
{
    const env = { DASHBOARD_PASSWORD: 'abc12', WHATSAPP_AUTH_DIR: './data/auth-x', TOKEN_TIMEOUT: '1200000' } as NodeJS.ProcessEnv;
    const nomes = segredosConhecidos(env).map(s => s.nome);
    assert(!nomes.includes('DASHBOARD_PASSWORD'), 'menos de 6 caracteres: fora (mesmo mínimo do cofre)', nomes);
    assert(!nomes.includes('WHATSAPP_AUTH_DIR') && !nomes.includes('TOKEN_TIMEOUT'), 'pasta/prazo com nome sensível não viram segredo', nomes);
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S439 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;
