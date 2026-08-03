/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S180 (Sprint 2)
 * A Visão Geral mostra o que está EM VIGOR no servidor, nunca o rascunho da tela.
 *
 * CONTEXTO (diagnóstico 02/08/2026): trocando o provedor na aba Modelos, o cartão de status
 * inteiro reagia na hora — "Ollama (Local + Cloud) — Online · 6 disponíveis · Modelo padrão …
 * · Sistema pronto ✅ Sim". Ao mesmo tempo:
 *
 *     GET /api/config  →  defaultProvider = llamafile
 *     .env             →  DEFAULT_PROVIDER=llamafile
 *
 * Ou seja: a tela exibiu por 15 minutos um estado que nunca existiu. Para um usuário leigo o
 * efeito é cruel — mexe, tudo fica verde e coerente, fecha a página, e nada foi aplicado. O
 * aviso "Há alterações não salvas" existia, mas no botão lateral, competindo com um cabeçalho
 * grande dizendo que estava tudo pronto.
 *
 * CAUSA: `updateOverview()` e `activeProviderHealth()` liam `configStore.snap()` — o rascunho.
 * Área de ESTADO exibindo INTENÇÃO. É a diretriz "Nunca Adivinhar" aplicada à interface: diante
 * de duas verdades possíveis, a tela escolhia a que ainda não era verdade.
 *
 * CORREÇÃO: o store passa a manter um espelho do que o servidor tem (`salvo()`), atualizado só
 * na hidratação e após um save CONFIRMADO. A Visão Geral lê esse espelho; o que foi alterado e
 * não salvo aparece em um bloco próprio, com cor própria.
 *
 * REGRESSÃO SE: o cartão de status voltar a refletir edição não salva; se o espelho se mover sem
 * confirmação do servidor (um save que falhou não pode "virar verdade"); ou se a hidratação
 * inicial passar a marcar tudo como pendente.
 *
 * Execução: npx ts-node src/__tests__/regression/S180_DashboardOverview_ReflectsServerNotDraft.test.ts
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
const APP = fs.readFileSync(P('app.js'), 'utf-8');
const MODELOS = fs.readFileSync(P('views', 'ModelosView.js'), 'utf-8');

/** Carrega a classe Store de verdade, para exercitar comportamento e não só formato. */
function carregarStore(): new (init?: Record<string, unknown>, auditado?: boolean) => {
    get(k: string): unknown; set(k: string, v: unknown): void; patch(p: Record<string, unknown>): void;
    salvo(k: string): unknown; pendente(k: string): boolean; camposPendentes(): string[]; marcarSalvo(): void;
} {
    const i = STATE.indexOf('class Store {');
    let d = 0, j = i;
    for (; j < STATE.length; j++) {
        if (STATE[j] === '{') d++;
        else if (STATE[j] === '}') { d--; if (d === 0) break; }
    }
    const sens = STATE.match(/const CAMPO_SENSIVEL = [^;]+;/)?.[0] ?? '';
    const resumo = (() => {
        const a = STATE.indexOf('function resumirValor(');
        let dd = 0, b = a;
        for (; b < STATE.length; b++) {
            if (STATE[b] === '{') dd++;
            else if (STATE[b] === '}') { dd--; if (dd === 0) break; }
        }
        return STATE.slice(a, b + 1);
    })();
    return new Function(`${sens}\n${resumo}\n${STATE.slice(i, j + 1)}\nreturn Store;`)();
}
const Store = carregarStore();

console.log('\n=== S180-1 — reproduz o incidente: editar não muda o que está valendo ===');
{
    const s = new Store({ defaultProvider: 'llamafile', modelRouter: { chat: 'GLM-4.6V-Flash-Q3_K_M.gguf' } });

    s.set('defaultProvider', 'ollama'); // exatamente o que eu fiz na tela

    assert(s.get('defaultProvider') === 'ollama', 'o rascunho registra a escolha do operador');
    assert(
        s.salvo('defaultProvider') === 'llamafile',
        'mas o que está VALENDO continua sendo llamafile — era isto que a tela escondia',
        s.salvo('defaultProvider'),
    );
    assert(s.pendente('defaultProvider') === true, 'o campo é reportado como pendente');
    assert(s.camposPendentes().includes('defaultProvider'), 'e aparece na lista de pendências');
}

console.log('\n=== S180-2 — só um save CONFIRMADO move o que está valendo ===');
{
    const s = new Store({ defaultProvider: 'llamafile' });
    s.set('defaultProvider', 'ollama');
    assert(s.salvo('defaultProvider') === 'llamafile', 'antes de salvar, o vigente não se move');

    s.marcarSalvo();
    assert(s.salvo('defaultProvider') === 'ollama', 'depois do save confirmado, passa a valer');
    assert(s.pendente('defaultProvider') === false, 'e deixa de ser pendência');
    assert(s.camposPendentes().length === 0, 'sem pendências restantes');
}

console.log('\n=== S180-3 — hidratação do servidor não vira "alteração pendente" ===');
{
    // Sem isto, abrir a página marcaria TODOS os campos como alterados por você.
    const s = new Store({ defaultProvider: 'ollama', ollamaUrl: '' });
    s.patch({ defaultProvider: 'llamafile', ollamaUrl: 'http://localhost:11434' });

    assert(s.get('defaultProvider') === 'llamafile', 'o rascunho recebe o valor do servidor');
    assert(s.salvo('defaultProvider') === 'llamafile', 'o espelho também');
    assert(s.camposPendentes().length === 0, 'nenhuma pendência ao abrir a página', s.camposPendentes());
}

console.log('\n=== S180-4 — objetos são comparados por conteúdo, não por referência ===');
{
    // modelRouter é objeto; comparar por identidade marcaria pendência em todo re-render.
    const s = new Store({ modelRouter: { chat: 'a', code: 'b' } });
    s.set('modelRouter', { chat: 'a', code: 'b' });
    assert(s.pendente('modelRouter') === false, 'reescrever o mesmo conteúdo não é alteração');

    s.set('modelRouter', { chat: 'glm-5.2:cloud', code: 'b' });
    assert(s.pendente('modelRouter') === true, 'mudança real de conteúdo é detectada');
}

console.log('\n=== S180-5 — a Visão Geral lê o espelho, não o rascunho ===');
{
    assert(
        /const prov = configStore\.salvo\('defaultProvider'\) \|\| 'ollama';/.test(MODELOS),
        'a saúde reportada é a do provedor em vigor',
    );
    assert(
        /const provSalvo = cs\.salvo\('defaultProvider'\);/.test(MODELOS)
        && /const r = cs\.salvo\('modelRouter'\) \|\| \{\};/.test(MODELOS),
        'provedor e modelo exibidos vêm do espelho',
    );
    assert(
        !/function activeProviderHealth\(\) \{\s*const s = configStore\.snap\(\);/.test(MODELOS),
        'activeProviderHealth não volta a ler o rascunho',
    );
    assert(
        /const defaultModel = r\.chat \|\| cs\.salvo\('currentModel'\) \|\| cs\.salvo\('ollamaModel'\) \|\| '';/.test(MODELOS),
        'o modelo padrão exibido também vem do espelho, em toda a cadeia de fallback',
    );
}

console.log('\n=== S180-6 — a pendência tem lugar e cor próprios ===');
{
    assert(/<div id="ov-pending"/.test(MODELOS), 'existe um bloco dedicado, fora do cartão de status');
    assert(/function renderPendingChanges\(\)/.test(MODELOS), 'e uma função que o preenche');
    assert(/renderPendingChanges\(\);/.test(MODELOS), 'chamada a cada atualização da Visão Geral');

    const css = fs.readFileSync(P('config.css'), 'utf-8');
    assert(/\.ml-test-pending \{/.test(css), 'classe visual própria — nem o verde de "ok" nem o vermelho de "erro"');

    const shared = fs.readFileSync(path.join(process.cwd(), 'src', 'dashboard', 'public', 'shared.js'), 'utf-8');
    for (const chave of ['ml_ov_pending_title', 'ml_ov_pending_desc']) {
        const n = (shared.match(new RegExp(`${chave}:`, 'g')) ?? []).length;
        assert(n === 3, `'${chave}' presente nos 3 idiomas (encontradas: ${n})`);
    }
}

console.log('\n=== S180-7 — save que FALHA não move o que está valendo ===');
{
    // marcarSalvo() só pode ser chamado depois do await de apiSaveConfig, dentro do try.
    const bloco = APP.slice(APP.indexOf('await apiSaveConfig(config);'), APP.indexOf('await apiSaveConfig(config);') + 700);
    assert(
        /await apiSaveConfig\(config\);[\s\S]{0,600}configStore\.marcarSalvo\(\);/.test(bloco),
        'marcarSalvo() vem DEPOIS do servidor confirmar',
    );
    assert(
        !/configStore\.marcarSalvo\(\)[\s\S]{0,200}await apiSaveConfig/.test(APP),
        'e nunca antes — um save que falha não pode virar verdade',
    );
    // S182 (Sprint 4): o catch ganhou uma linha de log antes do toast. A garantia verificada
    // aqui é que a falha CHEGA ao operador, não que as duas linhas sejam adjacentes.
    assert(
        /\} catch \(e\) \{[\s\S]{0,300}showToast\('❌ ' \+ e\.message, 'error'\);/.test(APP),
        'a falha continua sendo reportada ao operador',
    );
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S180 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
console.log(`\nCOBERTURA:`);
console.log(`  Editar não altera o que está valendo: testado`);
console.log(`  Só save confirmado move o vigente: testado`);
console.log(`  Hidratação não vira pendência: testado`);
console.log(`  Comparação por conteúdo: testado`);
console.log(`  Visão Geral lendo o espelho: testado`);
console.log(`  Pendência com lugar, cor e 3 idiomas: testado`);
if (failed > 0) process.exit(1);
