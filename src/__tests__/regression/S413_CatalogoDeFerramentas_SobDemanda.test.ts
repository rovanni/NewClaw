/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S413 (ADR-021)
 * A seleção de ferramentas por categoria é DICA DE ECONOMIA, não proibição: o que fica de fora vai num catálogo de uma linha dentro
 * da meta-ferramenta `carregar_ferramenta`, o agente carrega o que precisar, e a ferramenta carregada continua nos passos seguintes.
 *
 * ORIGEM (Windows, 15/10/2026, 23:46): "Consegue passar os próximos feriados do documento [PDF]?" → categoria `vision` → 9 de 22
 * ferramentas, sem `read_document` e sem `exec_command`. O agente tentou `read` no PDF e desistiu — a leitura de PDF estava
 * corrigida e no ar, mas a ferramenta não foi oferecida. Medição: em ~450 de ~460 turnos o agente recebia 9–13 de 22 ferramentas.
 *
 * REGRESSÃO SE: uma ferramenta registrada voltar a ficar invisível para o agente; carregar não acrescentar a definição completa;
 * um nome inexistente ser aceito; ou a ferramenta carregada sumir no passo seguinte do mesmo goal.
 *
 * Execução: npx ts-node src/__tests__/regression/S413_CatalogoDeFerramentas_SobDemanda.test.ts
 */
import { AgentLoop } from '../../loop/AgentLoop';
import { AgentFSM } from '../../loop/AgentFSM';
import { GoalExecutionLoop } from '../../loop/GoalExecutionLoop';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}

const ferramenta = (name: string, description: string) => ({ name, description, parameters: { type: 'object', properties: { x: { type: 'string' } } }, execute: async () => ({ success: true, output: '' }) });
const REGISTRO = [
    ferramenta('read', 'Ler um arquivo de texto do workspace.'),
    ferramenta('write', 'Criar ou sobrescrever um arquivo.'),
    ferramenta('edit', 'Editar um arquivo.'),
    ferramenta('memory_search', 'Buscar na memória.'),
    ferramenta('memory_write', 'Gravar na memória.'),
    ferramenta('send_document', 'Enviar um documento ao usuário.'),
    ferramenta('send_audio', 'Enviar áudio ao usuário.'),
    ferramenta('web_search', 'Pesquisar na web.'),
    ferramenta('web_navigate', 'Abrir uma página.'),
    ferramenta('read_document', 'Extrai e retorna o conteúdo textual de um documento (PDF, DOCX, ODT, TXT, etc.) salvo no workspace. Use quando…'),
    ferramenta('exec_command', 'Executa um comando no shell do sistema.'),
];

function agente(): any {
    const loop = Object.create(AgentLoop.prototype) as any;
    loop.tools = new Map(REGISTRO.map(t => [t.name, t]));
    loop.ferramentasDoTurno = new Map();
    loop.ts = () => '';
    return loop;
}
const quieto = <T>(fn: () => T): T => {
    const orig = process.stdout.write.bind(process.stdout);
    (process.stdout.write as unknown) = (): boolean => true;
    try { return fn(); } finally { process.stdout.write = orig; }
};
const nomes = (defs: Array<{ name: string }>) => defs.map(d => d.name);

async function main(): Promise<void> {
    const intencaoDoIncidente = { category: 'vision', confidence: 0.85, intent: 'extrair info do pdf' };

    console.log('\n=== S413-1 — o que a seleção deixa de fora aparece no catálogo (o agente sabe que existe) ===');
    const loop = agente();
    const lista = quieto(() => loop.buildToolDefs(intencaoDoIncidente, [], new Set())) as Array<{ name: string; description: string; parameters: unknown }>;
    assert(!nomes(lista).includes('read_document'), 'a seleção de "vision" continua sem read_document (a economia de hoje fica)', nomes(lista));
    const meta = lista.find(d => d.name === AgentLoop.CARREGAR_FERRAMENTA);
    assert(!!meta && /- read_document: Extrai e retorna o conteúdo textual de um documento \(PDF, DOCX, ODT, TXT, etc/.test(meta.description) && /- exec_command: /.test(meta.description),
        'carregar_ferramenta traz read_document e exec_command no catálogo, uma linha cada (gerada da própria descrição)', meta?.description);
    assert(!/- read: /.test(meta?.description ?? ''), 'o catálogo só lista o que NÃO veio completo');

    console.log('\n=== S413-2 — o agente pede, o código valida e acrescenta a definição completa ===');
    const ctx = { channel: 'web', chatId: 'c', ferramentasCarregadas: new Set<string>() };
    loop.ferramentasDoTurno.set('conv', lista);
    const fsm = new AgentFSM(); fsm.transition('START_TURN');
    const mensagens: Array<{ role: string; content: string }> = [];
    await quieto(() => loop.dispatchSingleNativeToolCall(
        { id: 't1', name: AgentLoop.CARREGAR_FERRAMENTA, arguments: { nomes: ['read_document', 'leitor_magico'] } },
        2, ctx, 'conv', 'feriados do pdf', {} as any, { steps: [] } as any, new AbortController().signal,
        new Set(), new Map(), new Map(), new Set(), new Set(), new Map(), new Map(), new Map(), new Map(), [],
        mensagens, {} as any, false, undefined, 20, 4, 0, [], 0, 10, 10, 5, (ev: string, m?: Record<string, unknown>) => fsm.transition(ev as any, m),
    ));
    const rd = lista.find(d => d.name === 'read_document');
    assert(!!rd && JSON.stringify(rd.parameters).includes('properties'), 'read_document entrou na lista do turno com a definição COMPLETA (parâmetros)', nomes(lista));
    const resposta = mensagens[mensagens.length - 1]?.content ?? '';
    assert(/Carregadas: read_document/.test(resposta) && /Não existem: leitor_magico/.test(resposta), 'a resposta diz o que carregou e recusa o nome inexistente', resposta);
    const metaDepois = lista.find(d => d.name === AgentLoop.CARREGAR_FERRAMENTA);
    assert(!!metaDepois && !/- read_document:/.test(metaDepois.description) && /- exec_command:/.test(metaDepois.description), 'o catálogo é atualizado: read_document sai, exec_command continua');
    assert(ctx.ferramentasCarregadas.has('read_document'), 'e fica registrada na memória do goal');

    console.log('\n=== S413-3 — carregada fica carregada: o passo seguinte do goal já recebe a ferramenta ===');
    const proximo = quieto(() => agente().buildToolDefs(intencaoDoIncidente, [], ctx.ferramentasCarregadas)) as Array<{ name: string }>;
    assert(nomes(proximo).includes('read_document'), 'no passo seguinte, read_document vem completa sem pedir de novo', nomes(proximo));
    const goalLoop = Object.create(GoalExecutionLoop.prototype) as any;
    goalLoop.ferramentasPorGoal = new Map();
    assert(goalLoop.ferramentasCarregadasDoGoal('g1') === goalLoop.ferramentasCarregadasDoGoal('g1') && goalLoop.ferramentasCarregadasDoGoal('g1') !== goalLoop.ferramentasCarregadasDoGoal('g2'),
        'o GoalExecutionLoop entrega o MESMO conjunto a todos os passos de um goal (e outro a cada goal)');

    console.log('\n=== S413-4 — sem nada de fora, não há meta-ferramenta ===');
    const todas = quieto(() => agente().buildToolDefs({ category: 'desconhecida', confidence: 0.3 }, [], new Set())) as Array<{ name: string }>;
    assert(todas.length === REGISTRO.length && !nomes(todas).includes(AgentLoop.CARREGAR_FERRAMENTA), 'todas as ferramentas enviadas → sem catálogo nem meta-ferramenta');

    console.log('\n=== S413-5 — o critério da árvore é MEDIDO a cada turno, no log ===');
    {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const src = require('fs').readFileSync(require('path').join(__dirname, '../../loop/AgentLoop.ts'), 'utf-8') as string;
        assert(/\[TOOLS-CATALOGO\] completas=/.test(src) && /catalogo_chars=\$\{catalogoChars\} contexto_chars=\$\{initialContextChars\}/.test(src) && /arvore_compensaria=\$\{catalogoChars > initialContextChars\}/.test(src),
            'setupTurn registra o tamanho do catálogo, o do contexto da chamada e se a árvore compensaria (ADR-021, Fase 4, item 5)');
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S413 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    process.exit(failed > 0 ? 1 : 0);
}
main().catch(err => { console.error('S413 erro inesperado:', err); process.exit(1); });
