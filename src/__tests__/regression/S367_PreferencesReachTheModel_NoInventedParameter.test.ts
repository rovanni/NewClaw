/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S367 (campanha 069, 09/10/2026)
 *
 * Produção, 09/10/2026: "Vai chover amanhã de manhã?" foi respondida com a previsão de OUTRA cidade, que ninguém
 * escreveu (nem o usuário, nem a memória). A preferência "Clima padrão: <cidade>" existia, mas:
 *   - o bloco de memória do agente só aceitava preferência com palavra em comum com a pergunta (regra A1 do
 *     planejador: `[SKIPPED] tier1 ... quickRel=0.000 reason="behavioral-pref requires rel>0"`);
 *   - o destaque "aplicar antes de responder" usava o mesmo critério de palavras;
 *   - o fast path buscava a cidade com "city Nome da cidade" (sem o pedido) e cortava por fusedScore ≥ 0,50;
 *   - sem o dado, o modelo preencheu a cidade por conta própria.
 *
 * S367-1 — o bloco de preferências leva TODAS as preferências, com corte declarado só se não couber.
 * S367-2 — o bloco de memória do agente usa esse bloco, sem decidir relevância por palavras.
 * S367-3 — o extrator de parâmetro do fast path recebe as preferências e o pedido, sem corte por similaridade.
 * S367-4 — o prompt do agente diz o que fazer com parâmetro obrigatório ausente: perguntar, nunca preencher.
 */

import * as fs from 'fs';
import * as path from 'path';
import { ContextBuilder } from '../../loop/ContextBuilder';
import { UnifiedIntentRouter } from '../../loop/UnifiedIntentRouter';

let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string, detail?: unknown): void {
    if (cond) { console.log(`  ✅ ${msg}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${msg}`, detail ?? ''); failed++; }
}
const ler = (...p: string[]) => fs.readFileSync(path.join(process.cwd(), ...p), 'utf-8');

console.log('\n=== S367-1 — bloco de preferências: todas, corte só se não couber e declarado ===');
{
    const prefs = [
        { nome: 'Clima padrão', texto: 'Sem cidade informada, considere a cidade X para a previsão do tempo.' },
        { nome: 'Cripto', texto: 'river = criptomoeda, não o time.' },
        { nome: 'Formato', texto: 'Respostas curtas.\nSem tabelas.' },
    ];
    const bloco = ContextBuilder.blocoDePreferencias(prefs, 3200);
    assert(bloco.startsWith(ContextBuilder.CABECALHO_PREFERENCIAS), 'cabeçalho constante (o mesmo que o classificador reconhece)');
    assert(prefs.every(p => bloco.includes(p.nome)), 'todas as preferências entram, sem escolha por palavra em comum com a pergunta');
    assert(/aplique cada uma somente quando o pedido tratar do assunto dela/.test(bloco), 'quem decide se uma se aplica é o LLM — a instrução diz isso');
    assert(bloco.includes('Respostas curtas. Sem tabelas.'), 'quebras de linha do conteúdo viram espaço (uma linha por preferência)');
    const apertado = ContextBuilder.blocoDePreferencias([{ nome: 'A', texto: 'x'.repeat(5000) }, { nome: 'B', texto: 'curta' }], 400);
    assert(/\[cortado: \d+ de 5000 caracteres\]/.test(apertado) && apertado.includes('curta'), 'sem espaço para tudo: o maior é cortado com o corte declarado, o curto entra inteiro');
    assert(ContextBuilder.blocoDePreferencias([], 3200) === '', 'sem preferências → bloco vazio');
}

console.log('\n=== S367-2 — bloco de memória do agente: preferências pelo bloco, sem decisão por palavras ===');
{
    const cb = ler('src', 'loop', 'ContextBuilder.ts');
    const corpo = cb.slice(cb.indexOf('async buildContext('), cb.indexOf('static readonly CABECALHO_PREFERENCIAS'));
    assert(/const prefsBlock = ContextBuilder\.blocoDePreferencias\(\s*this\.memory\.getPreferences\(\)/.test(corpo), 'usa a fonte única de preferências');
    assert(/const blocks = \[prefsBlock,/.test(corpo) && /const header = \[prefsBlock,/.test(corpo), 'o bloco vai no contexto normal e também no caminho sem nós selecionados');
    assert(!/hasDirectMatch/.test(corpo) && !/INSTRUCOES PERSONALIZADAS/.test(corpo), 'saiu o destaque decidido por coincidência de palavras');
    assert(/if \(n\.type === 'preference' \|\| n\.type === 'trait'\) continue;/.test(corpo), 'preferência não aparece duas vezes (bloco + lista de contexto)');
    assert(!/INSTRUCOES PERSONALIZADAS/.test(ler('src', 'session', 'SessionContext.ts')) && !/INSTRUCOES PERSONALIZADAS/.test(ler('src', 'loop', 'agentPrompts.ts')),
        'nenhum texto do sistema aponta mais para o bloco antigo');
}

console.log('\n=== S367-3 — fast path: o extrator recebe as preferências e o pedido, sem corte por similaridade ===');
{
    const al = ler('src', 'loop', 'AgentLoop.ts');
    const corpo = al.slice(al.indexOf('private async resolveMissingParameterFromEvidence('), al.indexOf('private static readonly FAST_PATH_ALLOWED'));
    assert(!/fusedScore >= 0\.50/.test(corpo), 'saiu o corte fusedScore ≥ 0,50 (a evidência certa podia nem chegar ao extrator)');
    assert(/const searchQuery = `\$\{intentContext \?\? ''\} \$\{paramName\} \$\{cleanDesc\}`/.test(corpo), 'a busca na memória usa o PEDIDO do usuário, não só o nome do parâmetro');
    assert(/this\.memory\.getPreferences\(\)/.test(corpo) && /\[preferência salva\]/.test(corpo), 'todas as preferências salvas vão como evidência, da fonte única');
    assert(/NEVER GUESS/.test(corpo) && /return `\{"value": null\}`|\{"value": null\}/.test(corpo), 'o extrator continua devolvendo null quando a evidência não sustenta um valor');
}

console.log('\n=== S367-4 — parâmetro obrigatório ausente: perguntar, nunca preencher ===');
{
    const prompts = ler('src', 'loop', 'agentPrompts.ts');
    assert(/Parâmetro obrigatório de ferramenta[\s\S]{0,300}PERGUNTE ao usuário — nunca preencha um valor por conta própria/.test(prompts),
        'o prompt do agente diz o que fazer (09/10: o modelo escreveu uma cidade que ninguém informou)');
}

async function coerenciaDoAtalho(): Promise<void> {
    console.log('\n=== S367-5 — atalho do roteador só vale se for coerente com a categoria que o próprio modelo escolheu ===');
    // Achado na navegação (09/10): "Guarde isto: minha cidade padrão para a previsão do tempo é X" voltou como
    // memory_operation + tool=current_time; o atalho da hora respondeu "🕐 01:37" e nada foi gravado.
    const rotear = async (saida: object, texto: string) => {
        const pf = { chatWithFallback: async () => ({ status: 'success', content: JSON.stringify(saida), attempts: [] }) } as any;
        return new UnifiedIntentRouter(undefined, pf).route(texto);
    };
    const incoerente = await rotear({ category: 'memory_operation', cognitiveLoad: 'minimal', confidence: 0.95, toolName: 'current_time', toolParams: {} }, 'guarde a preferência A');
    assert(incoerente.toolName === undefined && incoerente.executionMode !== 'direct', `memory_operation + current_time → atalho ignorado (toolName=${incoerente.toolName}, modo=${incoerente.executionMode})`);
    const clima = await rotear({ category: 'memory_operation', cognitiveLoad: 'minimal', confidence: 0.95, toolName: 'weather', toolParams: {} }, 'guarde a preferência B');
    assert(clima.toolName === undefined, 'memory_operation + weather → atalho ignorado');
    const hora = await rotear({ category: 'information', cognitiveLoad: 'minimal', confidence: 0.95, toolName: 'current_time', toolParams: {} }, 'que horas são agora C');
    assert(hora.toolName === 'current_time' && hora.executionMode === 'direct', 'information + current_time continua sendo o atalho da hora');
    const tempo = await rotear({ category: 'information', cognitiveLoad: 'minimal', confidence: 0.95, toolName: 'weather', toolParams: { city: 'X' } }, 'tempo em X D');
    assert(tempo.toolName === 'weather', 'information + weather continua sendo o atalho do tempo');
}

coerenciaDoAtalho().then(() => {
    console.log(`\nS367 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    if (failed > 0) process.exitCode = 1;
}).catch(e => { console.error(e); process.exitCode = 1; });
