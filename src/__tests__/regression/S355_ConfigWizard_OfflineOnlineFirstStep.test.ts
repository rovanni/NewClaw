/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S355 (Sprint D, 08/10/2026 — pedido do operador)
 *
 * "A primeira etapa do seletor de modelo deveria ser se a pessoa quer modelos offline ou online." Antes, a primeira
 * pergunta era "Qual provedor?", com 8 opções misturando o que roda no computador e o que roda na internet.
 *
 * Este teste EXECUTA a máquina de etapas real: recorta do ConfigWizard.js as funções puras (sem DOM nem rede — o mesmo
 * recorte que S250 descreve) e roda createWizardSession/stepsFor/canAdvance/next/back.
 *
 * REGRESSÃO SE: a primeira etapa deixar de ser offline/online, a lista de provedores deixar de ser filtrada, ou o
 * Ollama voltar a perguntar local/nuvem depois de a pessoa já ter respondido.
 *
 * Execução: npx ts-node src/__tests__/regression/S355_ConfigWizard_OfflineOnlineFirstStep.test.ts
 */
import * as fs from 'fs';
import * as path from 'path';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}

const CW = fs.readFileSync(path.join(process.cwd(), 'src', 'dashboard', 'public', 'config', 'components', 'ConfigWizard.js'), 'utf-8');
const inicio = CW.indexOf('const PROVIDER_CAPABILITIES');
const fim = CW.indexOf('function esc(');
const logica = CW.slice(inicio, fim);
// eslint-disable-next-line no-new-func
const W = new Function(`${logica}; return { PROVIDER_ORDER, PROVIDERS_BY_WHERE, PROVIDER_CAPABILITIES, createWizardSession, stepsFor, canAdvance, next, back };`)();

console.log('\n=== S355-1 — a primeira etapa é offline/online ===');
{
    const s = W.createWizardSession();
    assert(s.currentStep === 'where', `começa em 'where' (obtido ${s.currentStep})`);
    assert(JSON.stringify(W.stepsFor(s)) === JSON.stringify(['where', 'choose']), 'sem provedor: where → choose');
    assert(W.canAdvance(s) === false, 'não avança sem escolher offline/online');
    const s2 = W.next({ ...s, where: 'offline' });
    assert(s2.currentStep === 'choose', 'escolhido offline → vai para a lista de provedores');
}

console.log('\n=== S355-2 — a lista de provedores é filtrada pela resposta ===');
{
    const off = W.PROVIDER_ORDER.filter((id: string) => W.PROVIDERS_BY_WHERE.offline.includes(id));
    const on = W.PROVIDER_ORDER.filter((id: string) => W.PROVIDERS_BY_WHERE.online.includes(id));
    assert(JSON.stringify(off) === JSON.stringify(['local', 'ollama', 'custom']), `offline: modelo local, Ollama, OpenAI-compatible (${off})`);
    assert(!on.includes('local') && ['gemini', 'deepseek', 'groq', 'openrouter', 'anthropic', 'ollama', 'custom'].every(p => on.includes(p)), `online: provedores da internet, sem o modelo local (${on})`);
    assert(Object.keys(W.PROVIDER_CAPABILITIES).every((id: string) => off.includes(id) || on.includes(id)), 'nenhum provedor fica de fora das duas listas');
    assert(/PROVIDER_ORDER\.filter\(id => !session\.where \|\| PROVIDERS_BY_WHERE\[session\.where\]\.includes\(id\)\)/.test(CW), 'renderChooseProvider usa o filtro');
}

console.log('\n=== S355-3 — Ollama não repete a pergunta local/nuvem ===');
{
    const base = { ...W.createWizardSession(), currentStep: 'choose', provider: 'ollama', family: 'ollama' };
    const passos = W.stepsFor({ ...base, where: 'offline', ollamaMode: 'local' });
    assert(!passos.includes('ollamaMode') && passos[0] === 'where' && passos[1] === 'choose' && passos[2] === 'ollamaConfig', `offline + Ollama: ${passos.join(' → ')}`);
    const depois = W.next({ ...base, where: 'online', ollamaMode: 'cloud' });
    assert(depois.currentStep === 'ollamaConfig', `do choose vai direto para a configuração (obtido ${depois.currentStep})`);
    assert(/ollamaMode = id === 'ollama' && session\.where \? \(session\.where === 'offline' \? 'local' : 'cloud'\)/.test(CW), 'o clique no Ollama define o modo pela resposta de where');
    const semWhere = W.stepsFor({ ...base, where: undefined });
    assert(semWhere.includes('ollamaMode'), 'sem a resposta de where (sessão antiga), a etapa do modo continua existindo');
}

console.log('\n=== S355-4 — voltar preserva a resposta e zera o que foi acumulado ===');
{
    const noChoose = { ...W.createWizardSession(), where: 'online', currentStep: 'choose', provider: 'gemini', family: 'native' };
    const voltou = W.back(noChoose);
    assert(voltou.currentStep === 'where' && voltou.where === 'online' && voltou.provider === null, 'choose → where: mantém online selecionado, zera o provedor');
    const naCredencial = { ...W.createWizardSession(), where: 'online', currentStep: 'credential', provider: 'gemini', family: 'native', evidence: { x: 1 } };
    const voltou2 = W.back(naCredencial);
    assert(voltou2.currentStep === 'choose' && voltou2.where === 'online' && voltou2.provider === null && Object.keys(voltou2.evidence).length === 0, 'credencial → choose: mantém a resposta de where, zera provedor e evidência');
    assert(/id="ml-cw-back" \$\{session\.currentStep === 'where'/.test(CW), 'o botão Voltar fica desabilitado na primeira etapa (where)');
}

console.log('\n=== S355-5 — textos nos 3 idiomas ===');
{
    const shared = fs.readFileSync(path.join(process.cwd(), 'src', 'dashboard', 'public', 'shared.js'), 'utf-8');
    for (const k of ['ml_cw_where_title', 'ml_cw_where_hint', 'ml_cw_where_offline', 'ml_cw_where_online']) {
        assert((shared.match(new RegExp(`\\b${k}:`, 'g')) || []).length === 3, `${k} em pt/en/es`);
    }
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S355 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;
