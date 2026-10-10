/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S377 (ADR-016, 10/10/2026: "o juiz tem que ser escolhido como o modelo de visão, e explicado")
 *
 * 13 de 15 falhas de grounding vieram de um modelo de raciocínio longo escolhido como juiz sem o usuário perceber: o
 * assistente aplica o modelo a tudo, e a tela chamava o juiz de "ObserverValidator", sem dizer o que ele faz nem que precisa
 * ser rápido. Agora o juiz tem grupo próprio, explicação em linguagem de leigo e uma lista de candidatos montada só com FATOS.
 *
 * S377-1 — rápido/lento sai SÓ da medição padronizada (a capacidade declarada não separa: o Ollama declara `thinking`
 *          até para o modelo que respondeu em 2 s).
 * S377-2 — GET /api/models/judge (fatos + soberania) e POST /api/models/judge/medir (uma conferência real, registrada).
 * S377-3 — a tela: grupo e explicação do juiz, lista pela classe medida, botão Medir, aviso no "usar para tudo", três idiomas.
 *
 * Execução: npx ts-node src/__tests__/regression/S377_JudgeModelPicker_FastOptionsFromCatalogFacts.test.ts
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import express from 'express';
import { PerfilDoJuiz, perfilDoJuizDoProcesso, LIMITE_JUIZ_RAPIDO_MS } from '../../validation/perfilDoJuiz';
import { createModelsRouter } from '../../dashboard/routes/models';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}
const ler = (rel: string): string => fs.readFileSync(path.join(process.cwd(), rel), 'utf-8');

async function main(): Promise<void> {

console.log('\n=== S377-1 — rápido/lento sai só da medição padronizada ===');
{
    const p = new PerfilDoJuiz();
    assert(p.desempenho('nunca-testado') === undefined && p.classeDoJuiz('nunca-testado') === 'sem_medicao', 'modelo nunca testado: sem número e "sem medição" (a tela não inventa)');
    p.registrarSondagem('rapido', true, 2500);
    p.registrarSondagem('lento', true, LIMITE_JUIZ_RAPIDO_MS + 1);
    p.registrarSondagem('reprovou-o-obvio', false, 1000);
    assert(p.classeDoJuiz('rapido') === 'rapido' && p.classeDoJuiz('lento') === 'lento', 'dentro do limite = rápido; acima = lento');
    assert(p.classeDoJuiz('reprovou-o-obvio') === 'lento', 'quem não aprova uma resposta claramente verdadeira não serve como juiz, por rápido que seja');
    assert(p.desempenho('rapido')?.sondagem?.ms === 2500 && p.desempenho('rapido')?.classe === 'rapido', 'a medição e a classe chegam à tela', p.desempenho('rapido'));
    const falho = new PerfilDoJuiz();
    falho.registrarSondagem('f', true, 1000);
    for (let i = 0; i < 2; i++) { falho.registrar('f', 'livre', false, 1); falho.registrar('f', 'desligado', false, 1); }
    assert(falho.classeDoJuiz('f') === 'lento' && falho.desempenho('f')?.disjuntorAberto === true, 'disjuntor aberto no uso real vale mais que uma sondagem antiga');
    const arq = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 's377-')), 'perfil.json');
    const grava = new PerfilDoJuiz(arq); grava.registrarSondagem('m', true, 4000);
    assert(new PerfilDoJuiz(arq).classeDoJuiz('m') === 'rapido', 'a medição sobrevive ao reinício');
}

console.log('\n=== S377-2 — as rotas do juiz ===');
{
    perfilDoJuizDoProcesso.registrarSondagem('modelo-rapido', true, 3000);
    const catalogo = [
        { id: 'modelo-rapido', provider: 'ollama', label: 'a', capabilities: ['chat', 'reasoning'], status: 'available' },
        { id: 'modelo-nao-medido', provider: 'ollama', label: 'b', capabilities: ['chat', 'reasoning'], status: 'available' },
        { id: 'modelo-da-nuvem', provider: 'ollama', label: 'c', capabilities: ['chat'], status: 'available' },
        { id: 'so-embeddings', provider: 'ollama', label: 'd', capabilities: ['embedding'], status: 'available' },
    ];
    const chamados: Array<string | undefined> = [];
    const itens = [
        { item: '18 °C', confere: 'sim', trecho: 'Temperatura: 18 °C', evidencia: 'E1' },
        { item: 'umidade de 60%', confere: 'sim', trecho: 'Umidade: 60%', evidencia: 'E1' },
    ];
    const ctx: any = {
        config: {},
        modelRegistryService: { getCatalog: async () => catalogo },
        providerFactory: {
            modeloPermitidoPelaSoberania: (id: string) => id !== 'modelo-da-nuvem',
            getBudgetAuxiliar: () => ({ timeoutMs: 30_000, origem: 'padrao', latenciaTipicaMs: null }),
            chatWithFallback: async (_m: unknown, _t: unknown, _p: unknown, _to: unknown, _s: unknown, modelo: string | undefined) => {
                chamados.push(modelo);
                return { status: 'success', content: JSON.stringify({ estado: 'aprovado', itens }), attempts: [] };
            },
        },
    };
    const app = express();
    app.use(express.json());
    app.use('/api/models', createModelsRouter(ctx));
    const servidor = app.listen(0);
    const base = `http://127.0.0.1:${(servidor.address() as { port: number }).port}/api/models`;
    const r: any = await (await fetch(`${base}/judge`)).json();
    const por = Object.fromEntries((r.modelos as any[]).map(m => [m.id, m]));
    assert(r.success === true && r.modelos.length === 3 && !por['so-embeddings'], 'só modelos que conversam entram na lista', r.modelos.map((m: any) => m.id));
    assert(por['modelo-rapido'].declaraRaciocinio === true && por['modelo-rapido'].classe === 'rapido', 'declarar raciocínio não faz do modelo "lento": a classe vem da medição');
    assert(por['modelo-nao-medido'].classe === 'sem_medicao' && por['modelo-nao-medido'].medido === null, 'sem medição, a tela não inventa classe nem tempo');
    assert(por['modelo-da-nuvem'].permitido === false && por['modelo-rapido'].permitido === true, 'a soberania do operador chega à tela (quem roda só local não recebe sugestão de nuvem)');

    const medir = async (model: unknown) => fetch(`${base}/judge/medir`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model }) });
    const ok: any = await (await medir('modelo-nao-medido')).json();
    assert(ok.success === true && ok.resultado.ok === true && ok.resultado.classe === 'rapido' && chamados.length === 1 && chamados[0] === 'modelo-nao-medido', 'Medir faz UMA conferência real, no modelo pedido (não no juiz configurado)', { ok, chamados });
    assert(perfilDoJuizDoProcesso.classeDoJuiz('modelo-nao-medido') === 'rapido', 'e registra a medição no perfil');
    assert((await medir('modelo-da-nuvem')).status === 403 && chamados.length === 1, 'modelo que a soberania não permite não é chamado');
    assert((await medir('nao-existe')).status === 404 && (await medir(undefined)).status === 400, 'modelo fora do catálogo ou ausente é recusado');
    servidor.close();

    const rota = ler('src/dashboard/routes/models.ts');
    const trecho = rota.slice(rota.indexOf("router.get('/judge'"), rota.indexOf("router.get('/cloud-catalog'"));
    const sondagem = ler('src/validation/sondagemDoJuiz.ts');
    assert(trecho.length > 100 && !/glm|gemma|qwen|llama|swift|gpt|claude/i.test(trecho + sondagem), 'nenhum nome de modelo no código — a classificação vem da medição');
}

console.log('\n=== S377-3 — a tela ===');
{
    const view = ler('src/dashboard/public/config/views/ModelosView.js');
    assert(/key: 'observerModel'[^}]*judge: true/.test(view), 'o juiz é uma categoria própria (judge: true), com a mesma chave de gravação');
    assert(/id="rt-judgeExplain"/.test(view) && /t\('judge_explain'\)/.test(view), 'a explicação do juiz está sempre visível na tela');
    assert(!/label: 'ObserverValidator'/.test(view), 'o nome técnico "ObserverValidator" não aparece mais como rótulo');
    assert(/getJudgeCandidates\(\)/.test(view) && /c\.permitido/.test(view) && /c\.classe/.test(view), 'a lista vem dos fatos do servidor: soberania e classe medida');
    assert(/data-judge-measure/.test(view) && /medirJuiz\(/.test(view), 'cada modelo tem o botão Medir');
    assert(!/capabilities[^;\n]*reasoning[^;\n]*rapido/.test(view), 'a tela não decide "rápido" pela capacidade declarada');
    assert(/judge_applyall_warn/.test(view), '"usar para tudo" avisa quando o juiz fica com um modelo que pensa muito');
    const shared = ler('src/dashboard/public/shared.js');
    for (const k of ['judge_label', 'judge_explain', 'judge_show_all', 'judge_tag_fast', 'judge_tag_slow', 'judge_tag_unmeasured', 'judge_measure_btn', 'judge_status_none', 'judge_status_fast', 'judge_status_slow', 'ml_cat_group_judge']) {
        assert((shared.match(new RegExp(`\\b${k}:`, 'g')) || []).length === 3, `${k}: presente nos três idiomas`);
    }
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S377 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;
}

main().catch(e => { console.error(e); process.exit(1); });
