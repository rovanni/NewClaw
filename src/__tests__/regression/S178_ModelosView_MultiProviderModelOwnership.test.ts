/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S178
 * Um modelo pode ser servido por MAIS DE UM provedor — e isso não é inconsistência.
 *
 * CONTEXTO (instância real do operador, 02/08/2026): a aba Modelos exibia, em vermelho,
 *
 *     ⚠️ Configuração inconsistente
 *     Os modelos abaixo pertencem a outro provedor e vão falhar quando forem usados.
 *     Chat: o modelo GLM-4.6V-Flash-Q3_K_M.gguf é do provedor Modelo local, mas usa llamafile
 *     (repetido nas 6 categorias)
 *
 * sobre uma configuração que estava FUNCIONANDO. Verificação feita na hora:
 *   - `llamafile`     → http://localhost:8080/v1  → HTTP 200, serve GLM-4.6V-Flash-Q3_K_M.gguf
 *   - `Modelo local`  → http://127.0.0.1:8080/v1  → HTTP 200, serve GLM-4.6V-Flash-Q3_K_M.gguf
 * `localhost` e `127.0.0.1` são a mesma máquina, e a porta é a mesma: são dois apelidos para o
 * mesmo servidor. Nenhum dos dois estava errado, e nada ia falhar.
 *
 * CAUSA: o mapa modelo→provedor era montado com `Object.fromEntries()`, que admite UM valor por
 * chave. Com a mesma id de modelo aparecendo duas vezes no catálogo (uma por provedor), todas as
 * entradas menos a última eram descartadas em silêncio — e o provedor legítimo passava a ser
 * acusado de não ser o dono.
 *
 * Custo para quem não é técnico: a tela se contradizia ("llamafile — Online", "Sistema pronto:
 * Sim" logo acima de "vão falhar"), afirmava o futuro com certeza que não tinha, e oferecia duas
 * saídas inexistentes — trocar de provedor (os dois estavam certos) ou trocar de modelo (só havia
 * um). Seguir a instrução era o único jeito de realmente quebrar a configuração.
 *
 * REGRESSÃO SE: um modelo servido por vários provedores voltar a disparar falso alarme; ou — o
 * lado oposto — se o alarme legítimo deixar de disparar quando NENHUM provedor que serve o modelo
 * é o que está em uso (a classe de bug que a checagem foi criada para pegar, ver 7251572).
 *
 * Execução: npx ts-node src/__tests__/regression/S178_ModelosView_MultiProviderModelOwnership.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

const VIEW_PATH = path.join(process.cwd(), 'src', 'dashboard', 'public', 'config', 'views', 'ModelosView.js');
const SOURCE = fs.readFileSync(VIEW_PATH, 'utf-8');

// ModelosView.js é um módulo de browser com imports — extrai-se as duas funções puras da
// checagem e avalia-se em isolamento. Mesma abordagem de S10/S48/S175: reprodução verificada
// por asserções estruturais sobre o source real (S178-4).
function carregarHelpers(): {
    buildModelOwners: (c: Array<{ id: string; provider: string }>) => Map<string, Set<string>>;
    isModelOutsideProvider: (o: Map<string, Set<string>>, m: string, p: string) => boolean;
} {
    const pegar = (nome: string) => {
        const i = SOURCE.indexOf(`function ${nome}(`);
        if (i < 0) throw new Error(`função ${nome} não encontrada em ModelosView.js`);
        // Varre até a chave de fechamento equilibrada.
        let profundidade = 0, inicio = -1, j = i;
        for (; j < SOURCE.length; j++) {
            if (SOURCE[j] === '{') { if (inicio < 0) inicio = j; profundidade++; }
            else if (SOURCE[j] === '}') { profundidade--; if (profundidade === 0) break; }
        }
        return SOURCE.slice(i, j + 1);
    };
    const fabrica = new Function(
        `${pegar('buildModelOwners')}\n${pegar('isModelOutsideProvider')}\n`
        + 'return { buildModelOwners, isModelOutsideProvider };'
    );
    return fabrica();
}

const { buildModelOwners, isModelOutsideProvider } = carregarHelpers();

// O catálogo EXATO devolvido por /api/models/catalog na instância do incidente.
const CATALOGO_REAL = [
    { id: 'gemma4:e4b-it-qat', provider: 'ollama' },
    { id: 'nomic-embed-text:v1.5', provider: 'ollama' },
    { id: 'gemma4:cloud', provider: 'ollama' },
    { id: 'kimi-k2.7-code:cloud', provider: 'ollama' },
    { id: 'gemma4:31b-cloud', provider: 'ollama' },
    { id: 'glm-5.2:cloud', provider: 'ollama' },
    { id: 'GLM-4.6V-Flash-Q3_K_M.gguf', provider: 'llamafile' },
    { id: 'GLM-4.6V-Flash-Q3_K_M.gguf', provider: 'Modelo local' },
];
const MODELO = 'GLM-4.6V-Flash-Q3_K_M.gguf';

console.log('\n=== S178-1 — o catálogo real: um modelo, dois provedores, nenhum falso alarme ===');
{
    const owners = buildModelOwners(CATALOGO_REAL);
    const servidoPor = owners.get(MODELO);

    assert(!!servidoPor && servidoPor.size === 2, `os DOIS provedores são preservados (obtidos: ${servidoPor?.size})`);
    assert(!!servidoPor?.has('llamafile') && !!servidoPor?.has('Modelo local'), 'ambos constam como servindo o modelo');

    // As 6 categorias do incidente, todas com provedor efetivo = llamafile.
    for (const cat of ['chat', 'code', 'vision', 'light', 'analysis', 'execution']) {
        assert(
            isModelOutsideProvider(owners, MODELO, 'llamafile') === false,
            `categoria '${cat}': nenhum alarme — llamafile serve o modelo de fato`,
        );
    }
    assert(
        isModelOutsideProvider(owners, MODELO, 'Modelo local') === false,
        'e pelo outro apelido do mesmo servidor também não alarma',
    );
}

console.log('\n=== S178-2 — o alarme LEGÍTIMO continua disparando ===');
{
    // A classe de bug que a checagem existe para pegar (ver 7251572): o modelo escolhido não é
    // servido por NENHUM provedor em uso — daí sim vem o 404.
    const owners = buildModelOwners(CATALOGO_REAL);
    assert(
        isModelOutsideProvider(owners, MODELO, 'ollama') === true,
        'modelo .gguf com provedor efetivo ollama → alarme, como deve ser',
    );
    assert(
        isModelOutsideProvider(owners, 'glm-5.2:cloud', 'llamafile') === true,
        'modelo do Ollama com provedor efetivo llamafile → alarme',
    );
}

console.log('\n=== S178-3 — modelo desconhecido não recebe veredito ===');
{
    // "Nunca Adivinhar": sem o modelo no catálogo não há como afirmar a quem pertence.
    const owners = buildModelOwners(CATALOGO_REAL);
    assert(
        isModelOutsideProvider(owners, 'modelo-que-nao-esta-no-catalogo', 'llamafile') === false,
        'modelo ausente do catálogo segue sem acusação',
    );
    assert(
        isModelOutsideProvider(buildModelOwners([]), MODELO, 'llamafile') === false,
        'catálogo vazio não acusa nada',
    );
}

console.log('\n=== S178-4 — a estrutura antiga de dono único não voltou ===');
{
    assert(
        !/Object\.fromEntries\(catalog\.map\(m => \[m\.id, m\.provider\]\)\)/.test(SOURCE),
        'o mapa de dono único foi removido — era ele que descartava as duplicatas em silêncio',
    );
    assert(
        !/\bproviderOf\b/.test(SOURCE),
        'nenhum resquício de providerOf no arquivo',
    );

    const usos = (SOURCE.match(/isModelOutsideProvider\(/g) ?? []).length;
    assert(
        usos >= 3,
        `a regra é usada nos dois pontos (checagem + realinhamento) a partir de uma definição só (ocorrências: ${usos})`,
    );
    assert(
        /const owners = buildModelOwners\(catalog\);/.test(SOURCE),
        'os dois pontos constroem o mapa pela mesma função',
    );
}

console.log('\n=== S178-5 — o realinhamento automático não mexe no que já está certo ===');
{
    // realignRouterToProvider() reescrevia a configuração usando a mesma premissa de dono único:
    // trocar para um provedor que JÁ serve o modelo escolhido reescreveria uma escolha correta.
    const owners = buildModelOwners(CATALOGO_REAL);
    const roteador: Record<string, string> = {
        chat: MODELO, code: MODELO, vision: MODELO,
        light: MODELO, analysis: MODELO, execution: MODELO,
    };
    const stale = Object.keys(roteador).filter(k => isModelOutsideProvider(owners, roteador[k], 'llamafile'));
    assert(stale.length === 0, `nada é considerado desatualizado ao usar llamafile (obtidos: ${stale.length})`);

    const staleNoOllama = Object.keys(roteador).filter(k => isModelOutsideProvider(owners, roteador[k], 'ollama'));
    assert(staleNoOllama.length === 6, `mas trocar para ollama realinha as 6 categorias (obtidos: ${staleNoOllama.length})`);
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S178 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
console.log(`\nCOBERTURA:`);
console.log(`  Modelo servido por 2 provedores sem falso alarme: testado`);
console.log(`  Alarme legítimo preservado: testado`);
console.log(`  Modelo desconhecido sem veredito: testado`);
console.log(`  Estrutura de dono único removida: testado`);
console.log(`  Realinhamento não reescreve configuração correta: testado`);
if (failed > 0) process.exit(1);
