/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S384 (auditoria da suíte, Fase F, 10/10/2026): arquivos sem consumidor, ferramentas sem registro e shims.
 *
 * A auditoria achou 16 arquivos de produção que nenhum `import` alcança a partir de `src/index.ts`. Ausência de referência estática
 * NÃO prova código morto (barrels e shims existem para consumidores externos/legados) e, por regra do projeto, nenhum deles foi
 * apagado por falta de cobertura. O que este teste faz é impedir que o conjunto cresça EM SILÊNCIO:
 *
 * S384-1 — ALCANÇABILIDADE: o conjunto de arquivos de produção fora do alcance de `src/index.ts` é exatamente o conjunto declarado em
 *          `SEM_CONSUMIDOR` (cada entrada com categoria e justificativa). Arquivo novo sem consumidor → falha pedindo uma decisão;
 *          entrada declarada que passou a ser alcançada → falha pedindo para sair do registro (nada fica desatualizado).
 * S384-2 — REGISTRO DE FERRAMENTAS: toda classe `ToolExecutor` de `src/tools` é instanciada em `AgentController` (único ponto de registro)
 *          ou consta em `FERRAMENTAS_NAO_REGISTRADAS`. É a classe do incidente de 16/08/2026: `api_request` era citada como disponível
 *          em GoalPlanner/AgentLoop e nunca tinha sido registrada — o LLM não conseguia cumprir o plano que a escolhesse.
 * S384-3 — SHIMS `@deprecated`: continuam apontando para o MESMO objeto do módulo canônico (quem ainda importa pelo caminho antigo não
 *          recebe uma cópia nem perde o símbolo).
 * S384-4 — BARRELS: cada `index.ts` exporta os símbolos que declara.
 *
 * Execução: npx ts-node src/__tests__/regression/S384_Reachability_ToolRegistration_ShimContracts.test.ts
 */
import * as fs from 'fs';
import * as path from 'path';

// Verificação em tempo de compilação (o ts-node checa tipos): o shim de tipos tem de continuar equivalente ao canônico.
import type { CapabilityStatus as StatusShim, EnvironmentCapabilities as EnvShim } from '../../core/CapabilityTypes';
import type { CapabilityStatus as StatusCanon, EnvironmentCapabilities as EnvCanon } from '../../core/CapabilityRegistry';
type Igual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const tiposDoShimSaoOsCanonicos: [Igual<StatusShim, StatusCanon>, Igual<EnvShim, EnvCanon>] = [true, true];

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}

const SRC = path.resolve(__dirname, '..', '..');

// ── Registro declarado (caminhos relativos a src/) ───────────────────────────────────────────────────────────────────────────────────
type Categoria = 'shim-deprecado' | 'barrel' | 'sem-consumidor' | 'registro-duplicado' | 'ferramenta-nao-registrada';
const SEM_CONSUMIDOR: Record<string, { categoria: Categoria; porque: string }> = {
    'core/CapabilityProbe.ts': { categoria: 'shim-deprecado', porque: 'Shim vazio (`export {}`): a classe foi movida para CapabilityRegistry e não é mais exportada. Mantido por compatibilidade de caminho.' },
    'core/CapabilityTypes.ts': { categoria: 'shim-deprecado', porque: 'Re-exporta tipos de CapabilityRegistry (Fase 2.5). S384-3 trava a equivalência em tempo de compilação.' },
    'loop/ContextPlanner.ts': { categoria: 'shim-deprecado', porque: 'Re-exporta de ContextBuilder (Fase 2.1). S384-3 trava a identidade dos símbolos.' },
    'loop/ContextValidator.ts': { categoria: 'shim-deprecado', porque: 'Re-exporta de ResponseBuilder (Fase 2.2). S384-3 trava a identidade dos símbolos.' },
    'loop/DecisionPostProcessor.ts': { categoria: 'shim-deprecado', porque: 'Re-exporta de ResponseBuilder (Fase 2.2). S384-3 trava a identidade dos símbolos.' },
    'channels/index.ts': { categoria: 'barrel', porque: 'Barrel de conveniência dos canais; os consumidores importam cada módulo direto. S384-4 trava as exportações.' },
    'memory/conversational/index.ts': { categoria: 'barrel', porque: 'Barrel do CMI; os consumidores importam cada módulo direto. S384-4 trava as exportações.' },
    'session/index.ts': { categoria: 'barrel', porque: 'Barrel de session (v2); único importador de EventRanker. S384-4 trava as exportações.' },
    'core/StateStabilityGuard.ts': { categoria: 'sem-consumidor', porque: 'Lógica própria (61 linhas) sem nenhum import, teste ou menção em documento; só refatorações de tipo desde 16/05/2026. CANDIDATO À REMOÇÃO — decisão do dono; não apagado por falta de cobertura.' },
    'loop/GoalStateMachine.ts': { categoria: 'sem-consumidor', porque: 'Máquina de estados de goals (107 linhas) criada em 24/05/2026 e nunca ligada ao GoalOrchestrator; sem teste nem documento. CANDIDATO À LIGAÇÃO OU REMOÇÃO — decisão do dono.' },
    'memory/MemoryScoringEngine.ts': { categoria: 'sem-consumidor', porque: 'Lógica própria (97 linhas) sem import, teste ou documento; últimas mudanças só de refatoração. CANDIDATO À REMOÇÃO — decisão do dono.' },
    'session/EventRanker.ts': { categoria: 'sem-consumidor', porque: 'Importado somente pelo barrel session/index.ts (que também ninguém importa); criado em 27/04/2026 e sem uso desde então. CANDIDATO À REMOÇÃO — decisão do dono.' },
    'tools/ToolRegistry.ts': { categoria: 'registro-duplicado', porque: 'Registro de instância anterior; o registro oficial é core/ToolRegistry.ts (estático, usado por AgentController e rotas). Ninguém importa este.' },
    'tools/cmi_inspect.ts': { categoria: 'ferramenta-nao-registrada', porque: 'CMIInspectTool nunca é instanciada; "cmi_inspect" consta em GoalPlanner.STANDARD_TOOLS e na documentação técnica como ferramenta disponível.' },
    'tools/crypto_report.ts': { categoria: 'ferramenta-nao-registrada', porque: 'CryptoReportTool nunca é instanciada; "crypto_report" aparece na lista fixa de /api/tools e na documentação técnica.' },
    'tools/manage_memory.ts': { categoria: 'ferramenta-nao-registrada', porque: 'ManageMemoryTool nunca é instanciada (substituída por memory_search/memory_write/memory_admin); ainda listada na documentação técnica.' },
};
const FERRAMENTAS_NAO_REGISTRADAS: Record<string, string> = {
    CMIInspectTool: 'tools/cmi_inspect.ts',
    CryptoReportTool: 'tools/crypto_report.ts',
    ManageMemoryTool: 'tools/manage_memory.ts',
};

// ── Grafo de imports relativos (estáticos, dinâmicos e re-exports) ───────────────────────────────────────────────────────────────────
const RE_IMPORT = /(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)['"](\.{1,2}\/[^'"]*)['"]/g;

function listar(dir: string, acc: string[] = []): string[] {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const cheio = path.join(dir, e.name);
        const rel = path.relative(SRC, cheio).split(path.sep).join('/');
        if (e.isDirectory()) {
            if (e.name === '__tests__' || e.name === 'node_modules' || rel === 'dashboard/public') continue;
            listar(cheio, acc);
        } else if (/\.tsx?$/.test(e.name) && !/\.d\.ts$/.test(e.name) && !/\.negative\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name)) {
            acc.push(rel);
        }
    }
    return acc;
}

function resolver(de: string, alvo: string, existentes: Set<string>): string | null {
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(de), alvo));
    for (const c of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) if (existentes.has(c)) return c;
    return null;
}

function foraDoAlcance(): string[] {
    const arquivos = listar(SRC);
    const existentes = new Set(arquivos);
    const vistos = new Set<string>(['index.ts']);
    const fila = ['index.ts'];
    while (fila.length) {
        const atual = fila.pop() as string;
        const texto = fs.readFileSync(path.join(SRC, atual), 'utf-8');
        for (const m of texto.matchAll(RE_IMPORT)) {
            const r = resolver(atual, m[1], existentes);
            if (r && !vistos.has(r)) { vistos.add(r); fila.push(r); }
        }
    }
    return arquivos.filter(f => !vistos.has(f)).sort();
}

console.log('\n=== S384-1 — alcançabilidade: o conjunto sem consumidor é exatamente o declarado ===');
{
    const reais = foraDoAlcance();
    const declarados = Object.keys(SEM_CONSUMIDOR).sort();
    const novos = reais.filter(f => !declarados.includes(f));
    const obsoletos = declarados.filter(f => !reais.includes(f));
    assert(novos.length === 0, 'nenhum arquivo NOVO sem consumidor (decida: ligar, remover ou declarar com justificativa em SEM_CONSUMIDOR)', novos);
    assert(obsoletos.length === 0, 'nenhuma entrada declarada passou a ser alcançada (tire-a de SEM_CONSUMIDOR)', obsoletos);
    assert(declarados.every(f => fs.existsSync(path.join(SRC, f))), 'todo arquivo declarado ainda existe');
    assert(declarados.every(f => SEM_CONSUMIDOR[f].porque.length >= 40), 'toda entrada tem justificativa de verdade (>= 40 caracteres)');
    assert(declarados.length === 16, `o registro cobre os 16 arquivos levantados pela auditoria (tem ${declarados.length})`);
}

console.log('\n=== S384-2 — registro de ferramentas: toda classe ToolExecutor está registrada ou declarada ===');
{
    const controller = fs.readFileSync(path.join(SRC, 'core', 'AgentController.ts'), 'utf-8');
    const dirTools = path.join(SRC, 'tools');
    const classes: Array<{ nome: string; arquivo: string }> = [];
    for (const f of fs.readdirSync(dirTools).filter(n => n.endsWith('.ts'))) {
        for (const m of fs.readFileSync(path.join(dirTools, f), 'utf-8').matchAll(/export class (\w+) implements ToolExecutor/g)) classes.push({ nome: m[1], arquivo: `tools/${f}` });
    }
    assert(classes.length >= 24, `a varredura encontrou as classes de ferramenta (${classes.length})`);
    const registradas = classes.filter(c => new RegExp(`new ${c.nome}\\(`).test(controller));
    const semRegistro = classes.filter(c => !registradas.includes(c)).map(c => c.nome).sort();
    const declaradas = Object.keys(FERRAMENTAS_NAO_REGISTRADAS).sort();
    assert(JSON.stringify(semRegistro) === JSON.stringify(declaradas),
        'as ferramentas sem registro são exatamente as declaradas (ferramenta nova precisa ser registrada em AgentController)',
        { semRegistro, declaradas });
    assert(declaradas.every(n => classes.some(c => c.nome === n && c.arquivo === FERRAMENTAS_NAO_REGISTRADAS[n])), 'cada declarada ainda existe no arquivo indicado');
    assert(Object.values(FERRAMENTAS_NAO_REGISTRADAS).every(a => SEM_CONSUMIDOR[a]?.categoria === 'ferramenta-nao-registrada'), 'as declaradas constam também em SEM_CONSUMIDOR');
}

console.log('\n=== S384-3 — shims @deprecated: mesmo objeto do módulo canônico ===');
{
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const probe = require('../../core/CapabilityProbe') as Record<string, unknown>;
    assert(Object.keys(probe).length === 0, 'CapabilityProbe continua sem exportar nada (a classe é interna ao CapabilityRegistry)', Object.keys(probe));
    assert(tiposDoShimSaoOsCanonicos[0] && tiposDoShimSaoOsCanonicos[1], 'CapabilityTypes: tipos equivalentes aos de CapabilityRegistry (checado na compilação)');

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const builder = require('../../loop/ContextBuilder') as Record<string, unknown>;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const planner = require('../../loop/ContextPlanner') as Record<string, unknown>;
    for (const nome of ['ContextPlanner', 'DEFAULT_TIER_BUDGETS', 'extractEntities', 'isPersonalMemoryQuery']) {
        assert(planner[nome] !== undefined && planner[nome] === builder[nome], `ContextPlanner (shim) → ${nome} é o mesmo objeto de ContextBuilder`);
    }
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const response = require('../../loop/ResponseBuilder') as Record<string, unknown>;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const validator = require('../../loop/ContextValidator') as Record<string, unknown>;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const postProcessor = require('../../loop/DecisionPostProcessor') as Record<string, unknown>;
    assert(validator.ContextValidator !== undefined && validator.ContextValidator === response.ContextValidator, 'ContextValidator (shim) é o mesmo objeto de ResponseBuilder');
    assert(postProcessor.DecisionPostProcessor !== undefined && postProcessor.DecisionPostProcessor === response.DecisionPostProcessor, 'DecisionPostProcessor (shim) é o mesmo objeto de ResponseBuilder');
}

console.log('\n=== S384-4 — barrels: exportam os símbolos que declaram ===');
{
    const esperado: Record<string, string[]> = {
        '../../session/index': ['SessionTranscript', 'SessionManager', 'estimateTokens', 'SessionContext', 'SessionLearner', 'EventRanker', 'SessionAutoCleaner'],
        '../../memory/conversational/index': ['CMIEngine', 'CMIRepository', 'CMIBuffer', 'CMIIngestionPipeline'],
        '../../channels/index': ['MessageBus', 'TelegramAdapter', 'DiscordAdapter', 'WhatsAppAdapter', 'SignalAdapter'],
    };
    for (const [modulo, nomes] of Object.entries(esperado)) {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const m = require(modulo) as Record<string, unknown>;
        const ausentes = nomes.filter(n => typeof m[n] !== 'function');
        assert(ausentes.length === 0, `${modulo.replace('../../', '')} exporta ${nomes.length} símbolos como função/classe`, ausentes);
    }
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S384 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;
