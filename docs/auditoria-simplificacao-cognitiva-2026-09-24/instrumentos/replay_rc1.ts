/* RFC-008 / RC1 — replay do PLANO INICIAL do pedido de 14/07 (goals nxx12 e 1q551, texto idêntico), host-context OFF x HOST.
 *
 *   --dry  : provider FALSO; só mede o prompt (off vs host), confere o conjunto de ferramentas e as guardas. Não chama LLM.  (padrão)
 *   --real : provider REAL (ProviderFactory), N execuções por braço, ordem dos braços ALTERNADA a cada rodada.
 *
 * Uso (a partir da raiz do repositório):
 *   TS_NODE_PROJECT=tsconfig.json TS_NODE_TRANSPILE_ONLY=true \
 *     node node_modules/ts-node/dist/bin.js <este-arquivo> <copia.db> [--dry|--real] [N]
 * `<copia.db>` = CÓPIA do banco de produção (com -wal/-shm); abre só em leitura. Em --real: OLLAMA_URL, OLLAMA_MODEL,
 * PLANNER_MODEL e DEFAULT_PROVIDER no ambiente. Só imprime métricas agregadas; não imprime conteúdo de conversa.
 *
 * COMO O BRAÇO "host" É SIMULADO: o modo `on` do RC1 NÃO existe no código. O bloco é gerado pela função REAL
 * `buildHostAppContextBlock` (src/shared/hostAppContext.ts) e inserido no prompt por um wrapper de `chatWithFallback`,
 * imediatamente DEPOIS da linha "OBJETIVO GLOBAL". Isto testa o efeito da INFORMAÇÃO, não a integração (A3/A10 da RFC).
 *
 * ESTADO DO GOAL (sem anacronismo): só objective/userIntent do goal; attempts, blockers, estratégias e plano atual VAZIOS —
 * é o estado de um goal recém-criado. O banco não guarda memória, contexto de capacidades, reflexão nem o slideContext real.
 *
 * LIMITES CONHECIDOS: (1) prompt mais leve que o de produção (sem memória nem CapabilityRegistry); (2) modelo atual do planner
 * (PLANNER_MODEL), possivelmente diferente do de 14/07; (3) o slideContext é SINTÉTICO (o real não foi guardado); (4) uma única
 * mensagem; (5) no `powerpoint_control` da `main` só existe a ação addTextBox (getPresentation/getSlide estão só na branch remota).
 */
process.env.WORKSPACE_DIR = process.env.WORKSPACE_DIR || require('path').join(require('os').tmpdir(), 'newclaw-harness-workspace');
import { GoalPlanner } from '../../../src/loop/GoalPlanner';
import { ToolRegistry } from '../../../src/core/ToolRegistry';
import { buildHostAppContextBlock } from '../../../src/shared/hostAppContext';
import { Goal } from '../../../src/loop/GoalTypes';

const Database = require('better-sqlite3');
const GOAL_SUFFIX = 'nxx12';                       // texto idêntico ao de 1q551 (verificado por comparação direta)
const dbPath = process.argv[2];
const mode = process.argv.includes('--real') ? 'real' : 'dry';
const N = Number(process.argv.find(a => /^\d+$/.test(a)) ?? (mode === 'real' ? 10 : 1));

// ── Conjunto de ferramentas de PRODUÇÃO (AgentController.registerSkills), com stubs onde o construtor exige serviços ──
const STUB = {} as never;
const FACTORIES: Array<[string, () => unknown]> = [
    ['powerpoint_control', () => require('../../../src/tools/powerpoint_control').powerpointControlTool],
    ['exec_command', () => new (require('../../../src/tools/exec_command').ExecCommandTool)()],
    ['web_search', () => new (require('../../../src/tools/web_search').WebSearchTool)()],
    ['web_navigate', () => new (require('../../../src/tools/web_navigate').WebNavigateTool)()],
    ['write', () => new (require('../../../src/tools/write_tool').WriteTool)()],
    ['edit', () => new (require('../../../src/tools/edit_tool').EditTool)()],
    ['read', () => new (require('../../../src/tools/read_tool').ReadTool)()],
    ['memory_search', () => new (require('../../../src/tools/memory_search').MemorySearchTool)(STUB)],
    ['memory_write', () => new (require('../../../src/tools/memory_write').MemoryWriteTool)({ getFacade: () => ({}) } as never, STUB)],
    ['read_document', () => new (require('../../../src/tools/read_document').ReadDocumentTool)(STUB, STUB)],
    ['list_workspace', () => new (require('../../../src/tools/list_workspace').ListWorkspaceTool)()],
    ['refresh_workspace', () => new (require('../../../src/tools/refresh_workspace').RefreshWorkspaceTool)(STUB)],
    ['analyze_workspace_groups', () => new (require('../../../src/tools/analyze_workspace_groups').AnalyzeWorkspaceGroupsTool)(STUB)],
    ['organize_workspace', () => new (require('../../../src/tools/organize_workspace').OrganizeWorkspaceTool)(STUB, STUB)],
    ['send_audio', () => new (require('../../../src/tools/send_audio').SendAudioTool)(STUB)],
    ['send_document', () => new (require('../../../src/tools/send_document').SendDocumentTool)(STUB)],
    ['memory_admin', () => new (require('../../../src/tools/memory_admin').MemoryAdminTool)({ getGraphRepository: () => ({}) } as never)],
    ['ssh_exec', () => new (require('../../../src/tools/ssh_exec').SshExecTool)()],
    ['crypto_analysis', () => new (require('../../../src/tools/crypto_analysis').CryptoAnalysisTool)()],
    ['api_request', () => new (require('../../../src/tools/api_request').ApiRequestTool)()],
    ['weather', () => new (require('../../../src/tools/weather').WeatherTool)()],
    ['schedule', () => new (require('../../../src/tools/schedule_tool').ScheduleTool)(STUB)],
];
const registered: string[] = [];
const failed: string[] = [];
for (const [name, make] of FACTORIES) {
    try { ToolRegistry.register(make() as never); registered.push(name); }
    catch (e) { if (/já|already|duplic/i.test(String(e))) registered.push(name); else failed.push(`${name}: ${String(e).slice(0, 60)}`); }
}

// ── Bloco de host: função REAL de produção; slideContext SINTÉTICO (o real de 14/07 não foi guardado) ──
const HOST_BLOCK = buildHostAppContextBlock({
    hostApp: 'powerpoint',
    slideContext: { presentationTitle: 'Seguranca de Redes.pptx', currentSlide: 3, totalSlides: 12, slideTexts: ['Firewall e DMZ', 'Camada de rede', 'Modelo OSI'] },
});
const HOST_MARK = 'AMBIENTE DA CONVERSA';
function injectHostBlock(prompt: string): string {
    const m = prompt.match(/^OBJETIVO GLOBAL:.*$/m);
    if (!m || m.index === undefined) return prompt;               // prompt mínimo (retry) não tem a linha: não recebe o bloco
    const end = m.index + m[0].length;
    return `${prompt.slice(0, end)}\n${HOST_BLOCK}${prompt.slice(end)}`;
}

function loadGoal(): Goal {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const r = db.prepare('select id, session_key, conversation_id, objective, user_intent from goals where id like ?').get(`%${GOAL_SUFFIX}`);
    if (!r) throw new Error(`goal *${GOAL_SUFFIX} não está na cópia`);
    const now = Date.now();
    return {
        id: r.id, sessionKey: r.session_key, conversationId: r.conversation_id,
        userIntent: r.user_intent, objective: r.objective, status: 'pending',
        currentPlan: [], attempts: [], blockers: [], toolsTried: [], strategiesTried: [], successCriteria: [], sentArtifacts: [],
        retryBudget: 3, replanBudget: 5, confidence: 0.8, requiresAuth: false, authorizationScope: [],
        createdAt: now, updatedAt: now, expiresAt: now + 3_600_000,
    } as unknown as Goal;
}

type Arm = 'off' | 'host';
let currentArm: Arm = 'off';
function makePlanner(real: boolean): { planner: GoalPlanner; prompts: string[] } {
    const prompts: string[] = [];
    const wrap = (orig: (m: Array<{ content: string }>, ...r: unknown[]) => Promise<unknown>) =>
        async (m: Array<{ content: string }>, ...rest: unknown[]) => {
            const first = m[0]?.content ?? '';
            const content = currentArm === 'host' ? injectHostBlock(first) : first;
            prompts.push(content);
            return orig([{ ...m[0], content }, ...m.slice(1)], ...rest);
        };
    if (!real) {
        const OK = JSON.stringify({ steps: [{ id: 'step_1', description: 'x', toolName: 'read', toolArgs: { path: 'a.txt' } }], strategy: 'dry', successCriteria: [] });
        const chat = async () => ({ content: OK });
        const pf = { getProviderWithModel: () => ({ chat }), chatWithFallback: wrap(async () => ({ status: 'success', content: OK, attempts: [] })) } as never;
        return { planner: new GoalPlanner(pf, { findBlockerLessons: () => '', findHardConstraints: () => [] } as never), prompts };
    }
    const { ProviderFactory } = require('../../../src/core/ProviderFactory');
    const pf = new ProviderFactory({
        ollamaUrl: process.env.OLLAMA_URL, ollamaModel: process.env.OLLAMA_MODEL, ollamaApiKey: process.env.OLLAMA_API_KEY,
        defaultProvider: process.env.DEFAULT_PROVIDER || 'ollama',
    });
    pf.chatWithFallback = wrap(pf.chatWithFallback.bind(pf));
    const planner = new GoalPlanner(pf, { findBlockerLessons: () => '', findHardConstraints: () => [] } as never);
    if (process.env.PLANNER_MODEL) (planner as unknown as { model?: string }).model = process.env.PLANNER_MODEL;
    return { planner, prompts };
}

// ── Classificação dos passos (heurística; CADA passo é logado para auditoria) ──
type Step = { toolName?: string; toolArgs?: Record<string, unknown>; description?: string };
function classify(st: Step) {
    const tool = st.toolName ?? 'agentloop';
    const args = JSON.stringify(st.toolArgs ?? {});
    const desc = st.description ?? '';
    const cmd = String(st.toolArgs?.command ?? '');
    const DECK = /\.pptx?\b|apresenta|slides?|powerpoint/i;
    const opensExisting = (tool === 'read' && /\.pptx?\b/i.test(args))
        || (tool === 'exec_command' && /Presentation\(\s*['"][^'"]+\.pptx?/i.test(cmd))
        || (tool === 'exec_command' && /\b(cat|type|Get-Content|unzip|7z)\b[^;&|]*\.pptx?\b/i.test(cmd));
    const discovers = tool === 'list_workspace' || tool === 'refresh_workspace';
    const huntStrict = opensExisting || (discovers && DECK.test(`${args} ${desc}`));
    const generates = (tool === 'exec_command' && /Presentation\(\s*\)|\.save\(|pptxgenjs|marp/i.test(cmd) && !opensExisting) || (tool === 'write' && /\.(pptx?|py|js)\b/i.test(args));
    return { tool, huntStrict, discovers, opensExisting, usesPpt: tool === 'powerpoint_control', generates, sends: tool === 'send_document' };
}

async function runArm(arm: Arm, real: boolean) {
    currentArm = arm;
    const { planner, prompts } = makePlanner(real);
    const t0 = Date.now();
    const plan = await planner.plan(loadGoal());
    return { steps: (plan?.steps ?? []) as Step[], prompt: prompts[0] ?? '', ms: Date.now() - t0 };
}

async function main() {
    console.log(`=== replay RC1 (plano inicial de 14/07) — modo=${mode} N=${N} ===`);
    console.log(`ferramentas registradas: ${registered.length}/${FACTORIES.length}${failed.length ? ' | FALHAS: ' + failed.join('; ') : ''}`);
    console.log(`powerpoint_control registrada: ${registered.includes('powerpoint_control')} | bloco de host: ${HOST_BLOCK.length} chars`);
    if (mode === 'dry') {
        const a = await runArm('off', false);
        const b = await runArm('host', false);
        console.log(`prompt off: ${a.prompt.length} chars | host: ${b.prompt.length} chars | acréscimo: ${b.prompt.length - a.prompt.length} chars (≈ ${Math.ceil((b.prompt.length - a.prompt.length) / 3.5)} tokens)`);
        console.log(`guarda — bloco no prompt off: ${a.prompt.includes(HOST_MARK)} (deve ser false) | no prompt host: ${b.prompt.includes(HOST_MARK)} (deve ser true)`);
        const i = b.prompt.indexOf(HOST_MARK), o = b.prompt.indexOf('OBJETIVO GLOBAL');
        console.log(`posição: bloco ${i > o ? 'DEPOIS' : 'ANTES'} de "OBJETIVO GLOBAL" (esperado: DEPOIS) | removendo o bloco o prompt volta ao off: ${b.prompt.replace(`\n${HOST_BLOCK}`, '') === a.prompt}`);
        console.log(`o prompt off já cita a ferramenta powerpoint_control (esperado: sim, está no conjunto): ${/powerpoint_control/.test(a.prompt)}`);
        console.log(`o prompt off cita "apresentacao.pptx" (esperado: não): ${/apresentacao\.pptx/i.test(a.prompt)}`);
        return;
    }
    const tally: Record<Arm, { n: number; hunt: number; discover: number; ppt: number; gen: number; send: number; empty: number; chars: number[]; ms: number[] }> = {
        off: { n: 0, hunt: 0, discover: 0, ppt: 0, gen: 0, send: 0, empty: 0, chars: [], ms: [] },
        host: { n: 0, hunt: 0, discover: 0, ppt: 0, gen: 0, send: 0, empty: 0, chars: [], ms: [] },
    };
    for (let i = 0; i < N; i++) {
        const order: Arm[] = i % 2 === 0 ? ['off', 'host'] : ['host', 'off'];     // alterna a ordem: sem viés de ordem/horário
        for (const arm of order) {
            console.log(`ARM-START arm=${arm} i=${i + 1} t=${new Date().toISOString()}`);
            let r = { steps: [] as Step[], prompt: '', ms: 0 };
            try { r = await runArm(arm, true); } catch (e) { console.log('RUN-ERRO ' + String(e).slice(0, 120)); }
            const cl = r.steps.map(classify);
            cl.forEach((c, k) => console.log(`STEP arm=${arm} i=${i + 1} n=${k + 1} tool=${c.tool} hunt=${c.huntStrict} discovers=${c.discovers} opens=${c.opensExisting} generates=${c.generates}`));
            const t = tally[arm];
            t.n++; t.chars.push(r.prompt.length); t.ms.push(r.ms);
            if (cl.some(c => c.huntStrict)) t.hunt++;
            if (cl.some(c => c.discovers)) t.discover++;
            if (cl.some(c => c.usesPpt)) t.ppt++;
            if (cl.some(c => c.generates)) t.gen++;
            if (cl.some(c => c.sends)) t.send++;
            if (cl.length === 0) t.empty++;
            console.log(`RUN arm=${arm} i=${i + 1} hunt_strict=${cl.some(c => c.huntStrict)} discover_any=${cl.some(c => c.discovers)} uses_ppt_tool=${cl.some(c => c.usesPpt)} generates=${cl.some(c => c.generates)} steps=${cl.length} promptHasHostBlock=${r.prompt.includes(HOST_MARK)} promptChars=${r.prompt.length} ms=${r.ms} tools=${cl.map(c => c.tool).join(',')}`);
        }
    }
    const med = (xs: number[]) => xs.length ? xs.slice().sort((x, y) => x - y)[Math.floor(xs.length / 2)] : 0;
    for (const arm of ['off', 'host'] as Arm[]) {
        const t = tally[arm];
        console.log(`RESULT ${arm.toUpperCase().padEnd(4)}: caça o deck como arquivo (estrito) ${t.hunt}/${t.n} | descobre workspace (qualquer) ${t.discover}/${t.n} | usa powerpoint_control ${t.ppt}/${t.n} | gera .pptx novo ${t.gen}/${t.n} | envia documento ${t.send}/${t.n} | planos vazios ${t.empty}/${t.n} | prompt p50 ${med(t.chars)} chars | tempo p50 ${med(t.ms)} ms`);
    }
}
main().then(() => process.exit(0)).catch(e => { console.error('ERRO:', e); process.exit(1); });
