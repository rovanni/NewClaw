/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S460 (29/10/2026, ADR-019, achado A1 da issue 066)
 *
 * ORIGEM: 17–19/10/2026, Linux — o assistente pediu "a senha de app" e a usuária respondeu só com os 4 grupos de 4 letras. Sem
 * palavra de credencial na MESMA mensagem, `detectarSegredos` não a reconhecia: o valor ficou em `messages`, `agent_traces`,
 * `memory_nodes`, `memory_classifications`, em 4 linhas do log, num script do workspace e nos prompts da nuvem.
 *
 * O contexto é a última fala do assistente (fato estrutural da conversa, lido do banco pelo SessionManager — sem LLM).
 *
 * REGRESSÃO SE: a resposta sozinha a um pedido de senha (senha de app, valor com cara de senha, PIN) deixar de ir ao cofre; o
 * MessageBus deixar de passar a última fala do assistente ao cofre; a fala do assistente deixar de vir do banco; ou se
 * prosa, uma resposta comum depois de um pedido de senha, ou uma resposta depois de falar de "palavra-chave", virar segredo.
 *
 * Execução: npx ts-node src/__tests__/regression/S460_Cofre_SenhaRespondidaSozinha.test.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { detectarSegredos } from '../../shared/segredos';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}

console.log('\n=== S460 — senha respondida sozinha, depois do pedido ===\n');

// Valores sintéticos — nenhum é credencial real.
const SENHA_APP = 'qwer tyui opas dfgh';
const PEDIDO = 'Para configurar o e-mail, me envie a senha de app gerada na sua conta.';
const ctx = { ultimaFalaDoAssistente: PEDIDO };

assert(detectarSegredos(SENHA_APP).length === 0, 'sem contexto, 4×4 letras sozinhas continuam não sendo senha');
assert(detectarSegredos(SENHA_APP, ctx).includes(SENHA_APP), 'depois do pedido, a senha de app sozinha é reconhecida (o caso real)');
assert(detectarSegredos(`  ${SENHA_APP}. `, ctx).includes(SENHA_APP), 'com espaços e ponto final');
assert(detectarSegredos('Xk9#mP2vL7', ctx).includes('Xk9#mP2vL7'), 'um valor só com cara de senha');
assert(detectarSegredos('`Xk9#mP2vL7`', ctx).includes('Xk9#mP2vL7'), 'entre crases, sem as crases');
assert(detectarSegredos('48291375', { ultimaFalaDoAssistente: 'Qual é o token que chegou por SMS?' }).includes('48291375'), 'código numérico pedido como token');
assert(detectarSegredos('Pa55word!x', { ultimaFalaDoAssistente: 'What is the password?' }).includes('Pa55word!x'), 'en');

assert(detectarSegredos('sim, pode usar a mesma de antes', ctx).length === 0, 'prosa depois do pedido não é senha');
assert(detectarSegredos('ainda não gerei', ctx).length === 0, 'resposta curta comum não é senha');
assert(detectarSegredos('esta casa fica logo ali', ctx).length === 0, 'quatro palavras de quatro letras que não são o padrão da senha de app');
assert(detectarSegredos('relatorio_2026.md', { ultimaFalaDoAssistente: 'Qual palavra-chave devo usar? E as chaves do JSON?' }).length === 0,
    '"chave" no sentido comum não abre o contexto de credencial');
assert(detectarSegredos('Xk9#mP2vL7', { ultimaFalaDoAssistente: null }).length === 0, 'sem fala anterior do assistente, valor solto não é guardado');

console.log('\nFiação: MessageBus passa a última fala do assistente; SessionManager a lê do banco');
{
    const raiz = path.join(__dirname, '..', '..');
    const bus = fs.readFileSync(path.join(raiz, 'channels', 'MessageBus.ts'), 'utf-8');
    const sm = fs.readFileSync(path.join(raiz, 'session', 'SessionManager.ts'), 'utf-8');
    assert(/protegerEntrada\(msg\.text, undefined, \{ ultimaFalaDoAssistente: this\.ultimaFalaDoAssistente\(msg\) \}\)/.test(bus),
        'protegerEntrada recebe a última fala do assistente');
    assert(/detectarSegredos\(texto, \{ ultimaFalaDoAssistente: this\.ultimaFalaDoAssistente\(msg\) \}\)/.test(bus),
        'o caminho de falha do cofre usa o mesmo contexto (nada passa em claro)');
    const corpo = sm.slice(sm.indexOf('ultimaFalaDoAssistente(key'));
    assert(/this\.memory\.getRecentMessages\(this\.conversationId\(key\), 1\)/.test(corpo.slice(0, 400)) && /role === 'assistant'/.test(corpo.slice(0, 400)),
        'SessionManager lê a última mensagem do banco e só a devolve se for do assistente');
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S460 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
process.exit(failed > 0 ? 1 : 0);
