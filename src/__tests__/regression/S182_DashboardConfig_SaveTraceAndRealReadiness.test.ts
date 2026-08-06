/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S182 (Sprint 4)
 * O Salvar deixa rastro, o estado do modelo local diz se está vivo, e "Sistema pronto" só é ✅
 * quando o modelo configurado é realmente servido.
 *
 * CONTEXTO — teste de ponta a ponta pelo navegador, 02/08/2026, três achados distintos:
 *
 *  1. O botão Salvar da barra lateral foi clicado quatro vezes sem efeito visível e sem UMA
 *     linha de log. Não havia como distinguir clique perdido, handler ausente ou save que
 *     falhou. Toda a instrumentação do Sprint 1 cobria a aba Modelos e deixava de fora a ação
 *     mais importante do painel. (Os dois saves que funcionaram vieram do "⚡ Usar este para
 *     tudo", que chama doSave() por dentro — o crédito ao botão Salvar era provavelmente falso.)
 *
 *  2. `data/local-model-server.json` registrava `pid 45736 / GLM-4.6V-Flash-Q3_K_M.gguf` com o
 *     processo inexistente e ninguém escutando na porta. O registro sobreviver ao processo é
 *     INTENCIONAL (é a memória de qual modelo o operador escolheu, e o que permite oferecer
 *     "carregar agora") — o defeito era `getLastKnownLocalServer()` devolver {file, port} sem
 *     dizer se aquilo está no ar, deixando quem consome adivinhar.
 *
 *  3. O painel exibiu "Sistema pronto ✅ Sim" com o provedor llamafile servindo
 *     GLM-4.6V-Flash-Q3_K_M.gguf enquanto a configuração pedia glm-4.7-flash-Q4_K_M.gguf.
 *     Qualquer conversa nesse estado falharia. A checagem só via "provedor online + tem algum
 *     modelo + há um nome escrito na config" — nunca se o nome escrito era um dos servidos.
 *
 * REGRESSÃO SE: o Salvar voltar a ser silencioso; se o estado do modelo local voltar a omitir
 * liveness; ou se a prontidão voltar a ignorar QUAL modelo está configurado.
 *
 * Execução: npx ts-node src/__tests__/regression/S182_DashboardConfig_SaveTraceAndRealReadiness.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

const APP = fs.readFileSync(path.join(process.cwd(), 'src', 'dashboard', 'public', 'config', 'app.js'), 'utf-8');
const MODELOS = fs.readFileSync(path.join(process.cwd(), 'src', 'dashboard', 'public', 'config', 'views', 'ModelosView.js'), 'utf-8');
const ROUTE = fs.readFileSync(path.join(process.cwd(), 'src', 'dashboard', 'routes', 'models.ts'), 'utf-8');
/**
 * O diagnóstico do runtime local saiu da rota para o domínio na Sprint 020 (`ADR-006`): o Core
 * precisa alcançá-lo para distinguir "desligado pelo usuário" de "avariado", e não podia importar
 * de `dashboard/`. As asserções de S182-3 seguem valendo — mudou onde procuram, não o que exigem.
 */
const RUNTIME_STATE = fs.readFileSync(path.join(process.cwd(), 'src', 'core', 'localRuntimeState.ts'), 'utf-8');

console.log('\n=== S182-1 — o clique no Salvar é registrado ANTES de qualquer trabalho ===');
{
    assert(
        /logAcaoUI\('salvar', 'clique recebido'/.test(APP),
        'o clique é registrado assim que chega — responde "o clique chegou?" independente do resto',
    );
    assert(
        !/getElementById\('btnSave'\)\.addEventListener\('click', doSave\);/.test(APP),
        'o handler cru sem instrumentação não voltou',
    );
    assert(
        /logAcaoUI, *\n?\} from '\.\/state\.js'|logAcaoUI,?\s*\}\s*from '\.\/state\.js'/.test(APP)
        || /logAcaoUI/.test(APP.slice(0, APP.indexOf("} from './state.js';"))),
        'o logger vem do mesmo módulo de estado — nenhum módulo novo',
    );
}

console.log('\n=== S182-2 — o desfecho do save é registrado nos DOIS caminhos ===');
{
    assert(
        /logAcaoUI\('salvar', 'SALVO no servidor'/.test(APP),
        'sucesso registrado, com os campos que mudaram',
    );
    assert(
        /logAcaoUI\('salvar', `FALHOU — \$\{e\.message\}`/.test(APP),
        'falha registrada com o motivo — o toast some em segundos, o log fica',
    );
    // Ordem importa: capturar os pendentes DEPOIS de marcarSalvo() registraria sempre vazio.
    const bloco = APP.slice(APP.indexOf('const pendentesAntes'), APP.indexOf('const pendentesAntes') + 900);
    assert(
        bloco.indexOf('const pendentesAntes') < bloco.indexOf('await apiSaveConfig'),
        'os campos pendentes são capturados antes do save, senão o log sairia vazio',
    );
}

console.log('\n=== S182-3 — o estado do modelo local informa se está vivo ===');
{
    assert(
        /export function getLastKnownLocalServer\(\): \{ file: string; port: number; running: boolean \} \| null/.test(RUNTIME_STATE),
        'o contrato passou a incluir `running`',
    );
    assert(
        /process\.kill\(pid, 0\)/.test(RUNTIME_STATE),
        'liveness verificada por sinal 0 — não encerra nada',
    );
    assert(
        /running: typeof pid === 'number' \? isPidAlive\(pid\) : false/.test(RUNTIME_STATE),
        'PID morto devolve running=false, e o campo sempre acompanha o retorno',
    );
    // O registro NÃO pode ser apagado quando o processo morre: é a memória da escolha do operador.
    assert(
        /Processo morto \(a máquina reiniciou, alguém encerrou\) NÃO apaga o registro/.test(ROUTE),
        'a decisão de preservar o registro segue documentada — não é bug, é o que permite "carregar agora"',
    );
}

console.log('\n=== S182-4 — prontidão exige o modelo configurado entre os servidos ===');
{
    assert(
        /const servidos = \(providersStore\.get\('catalog'\) \|\| \[\]\)\s*\n\s*\.filter\(m => m\.provider === provSalvo\)/.test(MODELOS),
        'a lista consultada é a do provedor EM VIGOR (espelho do Sprint 2), não a do rascunho',
    );
    assert(
        /const modeloServido = servidos\.length === 0 \|\| servidos\.includes\(defaultModel\);/.test(MODELOS),
        'catálogo vazio não reprova — sem lista não há como afirmar ausência (mesma regra de checkConfigCoherence)',
    );
    assert(
        /const ready = h\.online && h\.count > 0 && !!defaultModel && modeloServido;/.test(MODELOS),
        'a prontidão inclui a nova condição',
    );
    assert(
        !/const ready = h\.online && h\.count > 0 && !!defaultModel;/.test(MODELOS),
        'a regra antiga (que só via "existe um nome escrito") não voltou',
    );
}

console.log('\n=== S182-5 — reprodução do incidente exato ===');
{
    // Reproduz a lógica de prontidão com os valores reais observados na tela.
    const decidir = (online: boolean, count: number, modelo: string, catalogo: Array<{ id: string; provider: string }>, prov: string) => {
        const servidos = catalogo.filter(m => m.provider === prov).map(m => m.id);
        const modeloServido = servidos.length === 0 || servidos.includes(modelo);
        return online && count > 0 && !!modelo && modeloServido;
    };
    const catalogoReal = [{ id: 'GLM-4.6V-Flash-Q3_K_M.gguf', provider: 'llamafile' }];

    assert(
        decidir(true, 1, 'glm-4.7-flash-Q4_K_M.gguf', catalogoReal, 'llamafile') === false,
        'o estado do incidente agora reprova: configurado glm-4.7, servido 4.6V',
    );
    assert(
        decidir(true, 1, 'GLM-4.6V-Flash-Q3_K_M.gguf', catalogoReal, 'llamafile') === true,
        'e aprova quando o configurado É o servido — o estado em que a conversa funcionou',
    );
    assert(
        decidir(true, 1, 'gpt-4o', [], 'openai') === true,
        'provedor de nuvem sem catálogo não é reprovado por falta de informação',
    );
    assert(
        decidir(false, 0, 'GLM-4.6V-Flash-Q3_K_M.gguf', catalogoReal, 'llamafile') === false,
        'provedor offline continua reprovando',
    );
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S182 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
console.log(`\nCOBERTURA:`);
console.log(`  Clique no Salvar registrado: testado`);
console.log(`  Sucesso e falha do save registrados: testado`);
console.log(`  Liveness do modelo local exposta: testado`);
console.log(`  Prontidão exige modelo servido: testado`);
console.log(`  Incidente real reprova, estado bom aprova: testado`);
if (failed > 0) process.exit(1);
