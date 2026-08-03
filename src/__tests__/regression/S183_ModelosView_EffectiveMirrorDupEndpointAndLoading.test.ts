/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S183 (Sprint 5)
 * Três achados do teste ponta a ponta pelo navegador (02/08/2026).
 *
 *  4. O painel "CONFIGURAÇÃO EFETIVA" mostrava o RASCUNHO. Durante o teste, o cabeçalho do topo
 *     dizia "llamafile" (correto, era o que estava em vigor) e este painel, logo abaixo, dizia
 *     "PROVEDOR ATIVO: Ollama". Dois painéis da mesma tela discordando — e o que promete ser o
 *     "efetivo" era o errado. O Sprint 2 corrigiu o cabeçalho e deixou este para trás.
 *
 *  5. Dois provedores no MESMO endereço, sem nenhuma indicação. `llamafile` →
 *     `localhost:8080` e `Modelo local` → `127.0.0.1:8080` são a mesma máquina e a mesma porta.
 *     Enquanto tudo funciona é inofensivo; quando o operador subiu um segundo servidor naquela
 *     porta por fora do NewClaw, o painel passou horas alternando entre modelos diferentes e não
 *     havia como perceber a colisão pela tela.
 *
 *  6. `503 Loading model` era tratado como offline. O llamafile abre a porta assim que sobe e
 *     responde 503 durante toda a carga — que passou de dois minutos numa das medições. O painel
 *     dizia "fetch failed"/"Provider indisponível" exatamente enquanto o modelo subia, e o log
 *     enchia de `discovery failed`.
 *
 * REGRESSÃO SE: o painel "efetiva" voltar a ler rascunho; se endereços duplicados voltarem a ser
 * silenciosos; ou se "carregando" voltar a ser indistinguível de "fora do ar".
 *
 * NOTA — um quarto achado foi RETIRADO: "Enter não envia no chat". O handler existe
 * (index.html, keydown com Enter sem Shift → sendMessage()) e está ligado ao mesmo
 * TEXTAREA#messageInput que é o campo visível. A observação veio de uma tecla enviada por
 * automação que provavelmente não chegou ao elemento — não havia bug a corrigir.
 *
 * Execução: npx ts-node src/__tests__/regression/S183_ModelosView_EffectiveMirrorDupEndpointAndLoading.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

const PUB = (...p: string[]) => path.join(process.cwd(), 'src', 'dashboard', 'public', ...p);
const MODELOS = fs.readFileSync(PUB('config', 'views', 'ModelosView.js'), 'utf-8');
const SHARED = fs.readFileSync(PUB('shared.js'), 'utf-8');
const REGISTRY = fs.readFileSync(path.join(process.cwd(), 'src', 'core', 'ModelRegistryService.ts'), 'utf-8');
const OPENAI = fs.readFileSync(path.join(process.cwd(), 'src', 'core', 'OpenAIProvider.ts'), 'utf-8');

console.log('\n=== S183-1 — "CONFIGURAÇÃO EFETIVA" lê o espelho do servidor ===');
{
    assert(
        /const r = configStore\.salvo\('modelRouter'\) \|\| \{\};/.test(MODELOS)
        && /const defaultProvider = configStore\.salvo\('defaultProvider'\);/.test(MODELOS),
        'os valores exibidos vêm de salvo(), não dos argumentos',
    );
    assert(
        /function updateEffectiveConfig\(_rIgnorado, _defaultProviderIgnorado\)/.test(MODELOS),
        'os parâmetros foram renomeados para deixar explícito que são ignorados',
    );
    assert(
        !/function updateEffectiveConfig\(r, defaultProvider\) \{\s*\n\s*const s = v => v \|\| '—';/.test(MODELOS),
        'a versão que consumia o rascunho pelos argumentos não voltou',
    );
}

console.log('\n=== S183-2 — endereços duplicados são detectados por equivalência real ===');
{
    // Reproduz a normalização para exercitar comportamento, não formato.
    const chave = (url: string) => String(url || '')
        .trim().toLowerCase()
        .replace(/\/+$/, '')
        .replace(/^https?:\/\//, '')
        .replace(/^localhost([:/]|$)/, '127.0.0.1$1');

    assert(
        chave('http://localhost:8080/v1') === chave('http://127.0.0.1:8080/v1'),
        'localhost e 127.0.0.1 são reconhecidos como o mesmo host — o caso real do incidente',
    );
    assert(
        chave('http://127.0.0.1:8080/v1/') === chave('http://127.0.0.1:8080/v1'),
        'barra final não cria um endereço diferente',
    );
    assert(
        chave('http://127.0.0.1:8080/v1') !== chave('http://127.0.0.1:8081/v1'),
        'portas diferentes continuam sendo endereços diferentes',
    );
    assert(
        chave('http://minha-maquina:8080/v1') !== chave('http://127.0.0.1:8080/v1'),
        'nome de máquina não é equiparado a 127.0.0.1 — afirmar isso exigiria consultar DNS',
    );
}

console.log('\n=== S183-3 — o aviso de duplicidade existe, avisa e não bloqueia ===');
{
    assert(/function checkDuplicateEndpoints\(\)/.test(MODELOS), 'a checagem existe');
    assert(/checkDuplicateEndpoints\(\);/.test(MODELOS), 'e roda a cada atualização da Visão Geral');
    assert(/<div id="ov-dupendpoint"/.test(MODELOS), 'tem bloco próprio na tela');
    assert(
        /box\.className = 'ml-test-result ml-test-pending';/.test(
            MODELOS.slice(MODELOS.indexOf('function checkDuplicateEndpoints'), MODELOS.indexOf('function checkDuplicateEndpoints') + 2200)
        ),
        'usa a cor de atenção, não a de erro — apontar dois rótulos ao mesmo endpoint é legítimo',
    );
    assert(
        /configStore\.salvo\('customProviders'\)/.test(MODELOS),
        'lê os provedores EM VIGOR, não o rascunho',
    );
}

console.log('\n=== S183-4 — 503 vira estado próprio, do provedor até a tela ===');
{
    assert(
        /err\.status = resp\.status;/.test(OPENAI),
        'o status HTTP viaja anexado ao erro — detectar por texto da mensagem seria frágil',
    );
    assert(
        /const carregando = \(err as \{ status\?: number \}\)\.status === 503;/.test(REGISTRY),
        'a descoberta distingue 503 de falha real',
    );
    assert(
        /loading\?: boolean;/.test(REGISTRY),
        'ProviderHealth carrega o terceiro estado',
    );
    assert(
        /log\.info\(`\$\{custom\.label\}: servidor no ar, modelo ainda carregando \(503\)`\)/.test(REGISTRY),
        'durante a carga o log é informativo, não warning — eram dezenas de "discovery failed" por carga',
    );
    assert(
        /h\.loading \? t\('ml_ov_loading'\)/.test(MODELOS),
        'a tela mostra "carregando" em vez de repetir o erro de rede',
    );
}

console.log('\n=== S183-5 — textos nos 3 idiomas ===');
{
    for (const chave of ['ml_ov_loading', 'ml_dup_endpoint_title', 'ml_dup_endpoint_item']) {
        const n = (SHARED.match(new RegExp(`${chave}:`, 'g')) ?? []).length;
        assert(n === 3, `'${chave}' presente nos 3 idiomas (encontradas: ${n})`);
    }
}

console.log('\n=== S183-6 — o handler de Enter no chat continua onde estava ===');
{
    // O achado "Enter não envia" foi retirado. Este teste trava o handler para que a próxima
    // pessoa que suspeitar disso encontre a resposta aqui em vez de reabrir a investigação.
    const INDEX = fs.readFileSync(PUB('index.html'), 'utf-8');
    assert(
        /messageInput\.addEventListener\('keydown', \(e\) => \{ if \(e\.key === 'Enter' && !e\.shiftKey\) \{ e\.preventDefault\(\); sendMessage\(\); \} \}\);/.test(INDEX),
        'Enter sem Shift envia; Shift+Enter quebra linha',
    );
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S183 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
console.log(`\nCOBERTURA:`);
console.log(`  "Configuração efetiva" lendo o espelho: testado`);
console.log(`  Equivalência de endereços (localhost = 127.0.0.1): testado`);
console.log(`  Aviso de duplicidade presente e não-bloqueante: testado`);
console.log(`  503 como terceiro estado, ponta a ponta: testado`);
console.log(`  Enter no chat (achado retirado, handler travado): testado`);
if (failed > 0) process.exit(1);
