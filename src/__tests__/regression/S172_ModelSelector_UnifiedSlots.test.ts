/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S172
 * Seletor unificado de modelos: os 10 destinos (6 categorias de tarefa + classificador + 3
 * componentes internos) são uma estrutura só, e as tabelas que dependem dela ficam coerentes.
 *
 * CONTEXTO (02/08/2026): antes, 6 destinos se escolhiam clicando numa tabela e 4 exigiam digitar
 * o nome exato do modelo (`gemma-4-12B-it-Q4_K_M.gguf`) em campos de texto livre. Para um usuário
 * leigo era impossível acertar, e um erro de digitação virava 404 em runtime sem aviso na tela.
 * Os 4 campos foram removidos e todos passaram a sair da mesma lista.
 *
 * LIMITAÇÃO ASSUMIDA: este projeto não tem jsdom configurado (mesma situação registrada na S135),
 * então não dá para executar o código da view aqui. O comportamento em si — clicar num slot,
 * escolher na tabela, aplicar, e o "usar para tudo" preservando slots incompatíveis — foi
 * verificado ao vivo no dashboard em 02/08/2026, com a configuração conferida no .env depois.
 * O que este arquivo protege são os INVARIANTES entre as estruturas: são eles que quebram em
 * silêncio quando alguém adiciona ou renomeia um destino meses depois.
 *
 * REGRESSÃO SE: um destino novo entrar sem capacidade mínima declarada (a tabela passaria a
 * listar modelos incompatíveis para ele); um componente interno voltar a ganhar `provider_<x>`
 * (chave que ninguém lê); os campos de texto livre voltarem; ou o "usar para tudo" deixar de
 * respeitar a capacidade exigida por slot.
 *
 * Execução: npx ts-node src/__tests__/regression/S172_ModelSelector_UnifiedSlots.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

const viewPath = path.join(process.cwd(), 'src', 'dashboard', 'public', 'config', 'views', 'ModelosView.js');
const src = fs.readFileSync(viewPath, 'utf-8');

/** Recorta um bloco pelo nome e devolve seu conteúdo — evita casar acidentalmente com outro
 *  trecho do arquivo que use as mesmas palavras. */
function block(startMarker: string, endMarker: string): string {
    const i = src.indexOf(startMarker);
    if (i === -1) return '';
    const j = src.indexOf(endMarker, i + startMarker.length);
    return src.slice(i, j === -1 ? undefined : j);
}

console.log('\n=== S172 — os 10 destinos vivem numa estrutura única ===');
const metaBlock = block('function getCategoryMeta()', '\n}');
const slots = [...metaBlock.matchAll(/key:\s*'([^']+)'/g)].map(m => m[1]);
{
    const esperados = ['chat', 'code', 'vision', 'light', 'analysis', 'execution', 'classifierModel', 'plannerModel', 'riskModel', 'observerModel'];
    assert(slots.length === 10, `10 destinos declarados (obtido: ${slots.length} — ${slots.join(', ')})`);
    for (const e of esperados) {
        assert(slots.includes(e), `destino '${e}' presente`);
    }
}

console.log('\n=== S172 — todo destino tem capacidade mínima declarada ===');
{
    // Sem entrada em CATEGORY_CAPABILITY o filtro da tabela não se aplica àquele destino, e ele
    // passa a oferecer modelos incompatíveis (ex.: um modelo de embedding para conversar).
    const capBlock = block('const CATEGORY_CAPABILITY', '};');
    for (const slot of slots) {
        assert(new RegExp(`\\b${slot}\\s*:`).test(capBlock), `'${slot}' tem capacidade mínima declarada`);
    }
}

console.log('\n=== S172 — componentes internos não ganham provider próprio ===');
{
    // `provider_<categoria>` só existe para as 6 categorias de tarefa. Gravá-lo para um componente
    // interno criaria uma chave que nenhuma parte do sistema lê — lixo que confunde quem for
    // depurar a configuração depois.
    const internalKeys = [...block('const INTERNAL_KEYS', ';').matchAll(/'([^']+)'/g)].map(m => m[1]);
    const declaradosInternal = [...metaBlock.matchAll(/key:\s*'([^']+)'[^}]*internal:\s*true/g)].map(m => m[1]);
    assert(internalKeys.length === 4, `INTERNAL_KEYS tem 4 entradas (obtido: ${internalKeys.join(', ')})`);
    assert(
        declaradosInternal.every(k => internalKeys.includes(k)) && internalKeys.every(k => declaradosInternal.includes(k)),
        'INTERNAL_KEYS e os destinos marcados internal:true são a MESMA lista — duas fontes divergentes silenciariam a regra',
        { internalKeys, declaradosInternal }
    );
    assert(
        /INTERNAL_KEYS\.includes\(routingSelectedCategory\)/.test(src),
        'a gravação de provider_<cat> checa INTERNAL_KEYS antes'
    );
    assert(
        /if\s*\(!meta\.internal\s*&&\s*provider\)/.test(src),
        '"usar para tudo" também só grava provider para destinos de tarefa'
    );
}

console.log('\n=== S172 — "usar para tudo" respeita a capacidade de cada destino ===');
{
    const applyAll = block("document.getElementById('rt-applyAllBtn')", 'document.getElementById(\'rt-applyBtn\')');
    assert(applyAll.length > 0, 'o botão "usar para tudo" existe');
    assert(
        /for\s*\(const meta of getCategoryMeta\(\)\)/.test(applyAll),
        'percorre a MESMA estrutura dos destinos — um destino novo entra sozinho, sem lista paralela'
    );
    assert(
        /CATEGORY_CAPABILITY\[meta\.key\]/.test(applyAll) && /skipped\.push/.test(applyAll),
        'pula destinos que o modelo não atende em vez de apontar, por exemplo, Visão para um modelo sem visão'
    );
    assert(
        /ml_routing_applied_all_partial/.test(applyAll),
        'avisa o que foi pulado — uma exceção silenciosa viraria falha só quando alguém mandasse uma foto'
    );
}

console.log('\n=== S172 — os campos de texto livre não voltaram ===');
{
    for (const id of ['ml-plannerModel', 'ml-riskModel', 'ml-observerModel']) {
        assert(!src.includes(`id="${id}"`), `campo de digitação '${id}' continua removido`);
    }
    assert(!/id="classifierModel"/.test(src), 'campo de digitação do classificador continua removido');
    assert(!/function internalCompRow/.test(src), 'a função que montava aqueles campos foi removida junto');
    // O ENDEREÇO do classificador é URL, não modelo: continua sendo campo de texto, e deve continuar.
    assert(/id="ml-classifierServer"/.test(src), 'o endereço do classificador segue como campo (é URL, não modelo)');
}

console.log('\n=== S172 — trocar de provedor realinha os modelos ===');
{
    // Falha real de 02/08/2026: trocar o provedor deixava os modelos do provedor anterior nas
    // categorias. Funcionava até o próximo restart, quando o Ollama respondia 404 model not found.
    const realign = block('function realignRouterToProvider', '\nfunction applyDefaultProviderChange');
    assert(realign.length > 0, 'realignRouterToProvider existe');
    // S178 (02/08/2026): a regra saiu do `if` inline e virou `isModelOutsideProvider()`, porque
    // um modelo pode ser servido por VÁRIOS provedores e o mapa de dono único descartava as
    // duplicatas em silêncio. A garantia protegida aqui é a mesma — não adivinhar sobre modelo
    // fora do catálogo —, agora verificada onde ela passou a morar.
    assert(
        /isModelOutsideProvider\(owners, mr\[k\], prov\)/.test(realign),
        'só troca modelos cujo provedor de origem é CONHECIDO e não serve o modelo — não adivinha sobre o que não está no catálogo'
    );
    assert(
        /if\s*\(!target\)\s*return null/.test(realign),
        'sem um modelo de destino conhecido, não mexe em nada'
    );
    assert(
        /realignRouterToProvider\(prov\)/.test(block('function applyDefaultProviderChange', '\n/**')),
        'roda em toda troca de provedor padrão, não só num caminho específico da UI'
    );
}

console.log('\n=== S172 — avisos de estado inconsistente e de modelo local fora do ar ===');
{
    const coherence = block('function checkConfigCoherence', '\n/**');
    assert(coherence.length > 0, 'checkConfigCoherence existe');
    assert(
        /const effective = mr\[`provider_\$\{cat\}`\] \|\| prov/.test(coherence),
        'compara contra o provedor EFETIVO da categoria (respeita override por perfil) — senão acusaria configuração correta'
    );
    assert(
        /if \(isModelOutsideProvider\(owners, model, effective\)\)/.test(coherence),
        'a acusação passa pela regra única — que exige o modelo conhecido E nenhum dos provedores que o servem ser o efetivo'
    );
    // A garantia "modelo desconhecido não é acusado" mudou de lugar junto com a regra: passou a
    // ser a primeira condição de isModelOutsideProvider(). Verificada na origem para não virar
    // uma promessa que ninguém guarda (cobertura de comportamento em S178-3).
    assert(
        /function isModelOutsideProvider[\s\S]{0,400}?return !!servedBy && servedBy\.size > 0 && !servedBy\.has\(provider\);/.test(src),
        'modelo ausente do catálogo não é acusado: não há como saber a que provedor pertence'
    );

    const localDown = block('function checkLocalModelDown', '\n/**');
    assert(localDown.length > 0, 'checkLocalModelDown existe');
    assert(
        /!isCustom \|\| !last \|\| \(health && health\.online\)/.test(localDown),
        'só avisa quando as três condições batem: provedor local em uso, offline, e há um modelo conhecido'
    );
    assert(
        /data-reload-local/.test(localDown),
        'oferece a ação de carregar — informar sem oferecer o caminho deixaria o usuário travado'
    );
    assert(
        !/serveLocalModel\(/.test(localDown),
        'não carrega sozinho: o servidor local ocupa a GPU e essa decisão é do dono da máquina'
    );
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S172 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
console.log(`\nCOBERTURA:`);
console.log(`  Estrutura única dos 10 destinos + capacidade declarada: testado`);
console.log(`  Separação destino de tarefa × componente interno: testado`);
console.log(`  "Usar para tudo" respeitando capacidade: testado`);
console.log(`  Campos de texto livre removidos: testado`);
console.log(`  Realinhamento ao trocar provedor: testado`);
console.log(`  Avisos de inconsistência e de modelo local parado: testado`);
if (failed > 0) process.exit(1);
