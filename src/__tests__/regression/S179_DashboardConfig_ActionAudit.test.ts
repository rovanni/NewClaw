/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S179 (Sprint 1)
 * Toda ação de configuração deixa rastro — inclusive a que não faz nada.
 *
 * CONTEXTO (sessão de diagnóstico 02/08/2026): um operador relatou que os botões da aba Modelos
 * "não respondiam". Reproduzido em 16 minutos de interação real com a tela. O que o audit log do
 * servidor registrou nesse período:
 *
 *     [ModelRegistryService] llamafile discovery failed: fetch failed     (a cada 60s)
 *     [ModelRegistryService] Modelo local discovery failed: fetch failed  (a cada 60s)
 *
 * Nada mais. Zero linhas sobre qualquer ação na tela. E o estado real ao final:
 *     UI mostrava:  "Ollama (Local + Cloud) — Online · 6 disponíveis · Sistema pronto ✅ Sim"
 *     servidor:     defaultProvider = llamafile
 *     .env:         DEFAULT_PROVIDER=llamafile
 *
 * DUAS LACUNAS:
 *
 *  1. O servidor só registra quando o Salvar dá certo (`POST /api/config`, `Provider switched
 *     to:`, `Persisted to .env`). Tudo que acontece antes disso é invisível — e mudanças no
 *     painel são locais até o Salvar, então o caminho inteiro ficava sem instrumentação.
 *
 *  2. `rt-applyBtn` e `rt-applyAllBtn` saem por um `return` mudo quando não há modelo
 *     selecionado. Sem toast, sem log, sem efeito: do lado de fora, idêntico a um botão
 *     quebrado. Era exatamente o sintoma relatado.
 *
 * CORREÇÃO: `Store` audita transições de configuração (funil único de toda mudança), e
 * `logAcaoUI()` registra a AÇÃO em si — inclusive quando o resultado é "nada feito, porque X".
 *
 * REGRESSÃO SE: uma ação de configuração voltar a ser silenciosa; se um `return` mudo voltar aos
 * botões de aplicar; ou — o oposto — se o log passar a despejar credenciais ou a repetir ruído
 * de polling.
 *
 * Execução: npx ts-node src/__tests__/regression/S179_DashboardConfig_ActionAudit.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

const P = (...p: string[]) => path.join(process.cwd(), 'src', 'dashboard', 'public', 'config', ...p);
const STATE = fs.readFileSync(P('state.js'), 'utf-8');
const MODELOS = fs.readFileSync(P('views', 'ModelosView.js'), 'utf-8');

// Extrai as funções puras de state.js para exercitar o comportamento de verdade.
function carregarResumo(): (chave: string, valor: unknown) => string {
    const i = STATE.indexOf('function resumirValor(');
    if (i < 0) throw new Error('resumirValor não encontrada');
    let d = 0, j = i;
    for (; j < STATE.length; j++) {
        if (STATE[j] === '{') d++;
        else if (STATE[j] === '}') { d--; if (d === 0) break; }
    }
    const sens = STATE.match(/const CAMPO_SENSIVEL = [^;]+;/)?.[0];
    if (!sens) throw new Error('CAMPO_SENSIVEL não encontrada');
    return new Function(`${sens}\n${STATE.slice(i, j + 1)}\nreturn resumirValor;`)();
}
const resumirValor = carregarResumo();

console.log('\n=== S179-1 — credenciais NUNCA vão para o log ===');
{
    // O configStore guarda API keys reais de provedores. Diagnóstico não pode virar vazamento —
    // o projeto é público no GitHub e o console é copiado e colado em issues.
    for (const campo of ['geminiKey', 'anthropicKey', 'ollamaApiKey', 'groqKey', 'openrouterKey', 'deepseekKey']) {
        const saida = resumirValor(campo, 'sk-ant-valor-secreto-de-verdade-123456');
        assert(
            !/sk-ant|secreto|123456/.test(saida),
            `'${campo}': valor real não aparece (saída: ${saida})`,
            saida,
        );
        assert(saida === '<definido>', `'${campo}': registra só a presença`, saida);
    }
    assert(resumirValor('geminiKey', '') === '<vazio>', 'campo de credencial vazio é distinguível de preenchido');
    assert(
        /password|secret|token|senha/.test(String(STATE.match(/const CAMPO_SENSIVEL = [^;]+;/)?.[0])),
        'a lista de campos sensíveis cobre password/secret/token/senha além de key',
    );
}

console.log('\n=== S179-2 — valores normais aparecem, e grandes são truncados ===');
{
    assert(resumirValor('defaultProvider', 'ollama') === 'ollama', 'valor simples aparece inteiro');
    assert(resumirValor('modelRouter', { chat: 'glm-5.2:cloud' }) === '{"chat":"glm-5.2:cloud"}', 'objeto pequeno vira JSON legível');

    const gigante = resumirValor('systemPrompt', 'x'.repeat(500));
    assert(gigante.length <= 91, `texto longo é truncado (obtido: ${gigante.length} chars)`);
    assert(gigante.endsWith('…'), 'truncamento é visível, não silencioso');
}

console.log('\n=== S179-3 — o funil único de configuração é auditado, o resto não ===');
{
    assert(
        /set\(k, v\)\s*\{\s*const antes = this\.#s\[k\]; this\.#s\[k\] = v; this\.#auditar\(k, antes, v, 'alterado na tela — NÃO SALVO'\)/.test(STATE),
        'set() registra a transição e diz explicitamente que ainda NÃO foi salvo',
    );
    assert(
        /this\.#auditar\(k, antes\[k\], this\.#s\[k\], 'carregado do servidor'\)/.test(STATE),
        'patch() distingue hidratação do servidor de edição do usuário',
    );
    assert(
        /if \(de === para\) return; \/\/ re-render escrevendo o mesmo valor não é uma ação/.test(STATE),
        're-render que reescreve o mesmo valor não polui o log',
    );

    // Auditar runtimeStore/providersStore repetiria no console o mesmo erro que o servidor já
    // comete com o `discovery failed` de minuto em minuto.
    const auditados = (STATE.match(/\}, \/\* auditado \*\/ true\)/g) ?? []).length;
    assert(auditados === 1, `apenas UM store é auditado — o de configuração (encontrados: ${auditados})`);
    assert(
        /export const configStore = new Store\(\{[\s\S]*?\}, \/\* auditado \*\/ true\);/.test(STATE),
        'e é o configStore',
    );
}

console.log('\n=== S179-4 — os botões que saíam calados agora explicam o "nada feito" ===');
{
    assert(
        /logAcaoUI\('aplicar', `NADA FEITO — nenhum modelo selecionado \(categoria alvo: \$\{routingSelectedCategory\}\)`\)/.test(MODELOS),
        'Aplicar sem seleção registra o motivo, com a categoria alvo',
    );
    assert(
        /logAcaoUI\('usar-para-tudo', 'NADA FEITO — nenhum modelo selecionado e a categoria atual está vazia'\)/.test(MODELOS),
        'Usar para tudo sem seleção registra o motivo',
    );

    // Guarda contra a volta do padrão: um `return` sem log antes dele.
    assert(
        !/rt-applyBtn'\)\?\.addEventListener\('click', async e => \{\s*if \(!routingPendingModel\) return;/.test(MODELOS),
        'o return mudo do Aplicar não voltou',
    );
    assert(
        !/const model = routingPendingModel \|\| \(configStore\.get\('modelRouter'\) \|\| \{\}\)\[routingSelectedCategory\];\s*if \(!model\) return;/.test(MODELOS),
        'o return mudo do Usar para tudo não voltou',
    );
}

console.log('\n=== S179-5 — as ações que funcionam também deixam rastro ===');
{
    for (const [acao, desc] of [
        ['selecionar-modelo', 'seleção de linha da tabela'],
        ['aplicar', 'aplicar a uma categoria'],
        ['usar-para-tudo', 'aplicar a todas'],
        ['definir-provedor-principal', 'trocar o provedor principal'],
        ['voltar-para-ollama', 'voltar ao Ollama'],
    ]) {
        assert(
            new RegExp(`logAcaoUI\\('${acao}'`).test(MODELOS),
            `${desc} é registrada`,
        );
    }
    assert(
        /import \{ configStore, providersStore, logAcaoUI \} from '\.\.\/state\.js'/.test(MODELOS),
        'o logger vem do mesmo módulo que já é a fonte do estado — nenhum módulo novo criado',
    );
}

console.log('\n=== S179-6 — prefixos estáveis, para o log ser filtrável ===');
{
    assert(/console\.info\(`\[ui:config\] /.test(STATE), 'transições de estado usam o prefixo [ui:config]');
    assert(/console\.info\(`\[ui:acao\] /.test(STATE), 'ações usam o prefixo [ui:acao]');
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S179 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
console.log(`\nCOBERTURA:`);
console.log(`  Credenciais nunca logadas: testado`);
console.log(`  Truncamento visível de valores grandes: testado`);
console.log(`  Só o store de configuração é auditado: testado`);
console.log(`  "Nada feito" passou a explicar o motivo: testado`);
console.log(`  Ações bem-sucedidas registradas: testado`);
if (failed > 0) process.exit(1);
