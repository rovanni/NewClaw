/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S318 (RFC-008, modo `on`)
 * Quem escreve DENTRO do PowerPoint quer slides, mesmo sem dizer "pptx". Achado em 03/10/2026: o pedido
 * "Preciso criar uma aula sobre ..." feito pelo suplemento virou plano de buscar na memória e salvar
 * conhecimento — o contexto do hospedeiro só era logado (HOST_CONTEXT=shadow) e a skill pptx-generator
 * só casa por palavra-gatilho.
 *
 *   1  → hostContextMode: só 'on' e 'shadow' exatos; qualquer outra coisa é 'off' (caixa errada inclusive).
 *   2  → hostAppSkillNames: powerpoint → pptx-generator; canal comum, host desconhecido, protótipo → [].
 *   3  → appendHostBlock: sem bloco devolve o contexto IDÊNTICO; com bloco, acrescenta separado.
 *   4  → o bloco do PowerPoint declara o propósito do canal (slides) e continua só fato (sem imperativo).
 *   5  → AgentLoop.getSkillContextForQuery com skills REAIS: sem host a skill NÃO entra num pedido sem gatilho
 *        (reproduz o defeito); com host entra; pedido com gatilho não duplica; nome inexistente não quebra.
 *   6  → GoalExecutionLoop: o bloco só chega ao Planner sob mode === 'on' e nos TRÊS pontos de planejamento
 *        (plano inicial, replan, próximo marco); a sombra continua só logando.
 *   7  → GoalOrchestrator: skills do host só sob mode === 'on'.
 *   8  → REQUISITO OBRIGATÓRIO (03/10/2026): quem escreve dentro do PowerPoint quer texto nativo e editável. A skill
 *        pptx-generator proíbe o Marp (imagem por slide) nesse canal; a regra está no conteúdo que o Planner recebe
 *        (globalContent), vem ANTES do caminho Marp e casa com as palavras do bloco do host.
 *
 * Execução: npx ts-node src/__tests__/regression/S318_HostContextOn_PowerPointChannelPlansSlides.test.ts
 */
process.env.WORKSPACE_DIR = process.env.WORKSPACE_DIR || 'D:/IA/newclaw/workspace';

import fs from 'fs';
import path from 'path';
import {
    hostContextMode,
    hostAppSkillNames,
    appendHostBlock,
    buildHostAppContextBlock,
} from '../../shared/hostAppContext';
import { SkillLoader } from '../../skills/SkillLoader';
import { AgentLoop } from '../../loop/AgentLoop';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}

console.log('\n[1] hostContextMode — igualdade estrita');
assert(hostContextMode({ HOST_CONTEXT: 'on' }) === 'on', "'on' → on");
assert(hostContextMode({ HOST_CONTEXT: 'shadow' }) === 'shadow', "'shadow' → shadow");
for (const v of [undefined, '', 'off', 'ON', 'On', ' on', 'true', '1', 'shadow ', 'sombra']) {
    assert(hostContextMode({ HOST_CONTEXT: v }) === 'off', `${JSON.stringify(v)} → off`);
}
assert(hostContextMode({}) === 'off', 'variável ausente → off');

console.log('\n[2] hostAppSkillNames');
assert(JSON.stringify(hostAppSkillNames({ hostApp: 'powerpoint' })) === '["pptx-generator"]', 'powerpoint → [pptx-generator]');
for (const m of [undefined, {}, { hostApp: 'desconhecido' }, { hostApp: 42 }, { hostApp: null }, { hostApp: 'constructor' }, { hostApp: '__proto__' }, { channel: 'telegram' }]) {
    assert(hostAppSkillNames(m as never).length === 0, `sem skill para ${JSON.stringify(m)}`);
}
const a = hostAppSkillNames({ hostApp: 'powerpoint' });
a.push('x');
assert(hostAppSkillNames({ hostApp: 'powerpoint' }).length === 1, 'o retorno é cópia: mutar não contamina a tabela');

console.log('\n[3] appendHostBlock');
assert(appendHostBlock('ctx', '') === 'ctx', 'sem bloco → contexto idêntico');
assert(appendHostBlock(undefined, '') === undefined, 'sem bloco e sem contexto → undefined (idêntico)');
assert(appendHostBlock('ctx', 'BLOCO') === 'ctx\n\nBLOCO', 'com bloco → contexto + linha em branco + bloco');
assert(appendHostBlock(undefined, 'BLOCO') === 'BLOCO', 'sem contexto → só o bloco');
assert(appendHostBlock('', 'BLOCO') === 'BLOCO', 'contexto vazio → só o bloco, sem linhas em branco à frente');

console.log('\n[4] o bloco do PowerPoint declara o propósito do canal e continua só fato');
const block = buildHostAppContextBlock({ hostApp: 'powerpoint' });
assert(/pedido de criação de conteúdo/.test(block) && /apresentação de slides/.test(block), 'declara: criação de conteúdo neste canal = apresentação de slides');
const imperative = /\b(nunca|sempre|deve|devem|precisa|precisam|use|usar|utilize|presuma|procure|gere|evite|ignore|obrigat\w+|proibid\w+|n[aã]o\s+(use|gere|procure))\b/i;
assert(!imperative.test(block), 'nenhuma palavra imperativa no bloco', block.match(imperative)?.[0]);
assert(buildHostAppContextBlock({ hostApp: 'telegram' }) === '', 'canal comum: bloco vazio');

console.log('\n[5] skills reais: o pedido do suplemento, sem a palavra "pptx"');
const skillsDir = path.resolve(__dirname, '..', '..', '..', 'skills');
const loader = new SkillLoader(skillsDir);
assert(loader.loadAll().some(s => s.name === 'pptx-generator'), 'skill pptx-generator existe no repositório');
const fakeThis = { skillLoader: loader } as unknown as AgentLoop;
const getCtx = (q: string, host: string[] = []): string =>
    (AgentLoop.prototype.getSkillContextForQuery as (q: string, h?: string[]) => string).call(fakeThis, q, host);
const pedido = 'Estou ensinando a disciplina de INSTALADOR E REPARADOR DE REDES. Preciso criar uma aula sobre: Eletricidade para redes, tensão de pico, frequência.';
assert(!getCtx(pedido).includes('### SKILL: pptx-generator'), 'SEM host: a skill NÃO entra (reproduz o defeito de 03/10/2026)');
assert(getCtx(pedido, ['pptx-generator']).includes('### SKILL: pptx-generator'), 'COM host powerpoint: a skill entra');
const comGatilho = getCtx('Gere um arquivo pptx sobre redes', ['pptx-generator']);
assert((comGatilho.match(/### SKILL: pptx-generator/g) ?? []).length === 1, 'pedido com gatilho + host: a skill aparece UMA vez (sem duplicar)');
assert(getCtx(pedido, ['skill-que-nao-existe']) === getCtx(pedido), 'nome inexistente: ignorado, resultado idêntico ao sem host');
assert(getCtx(pedido, []) === getCtx(pedido), 'lista vazia: idêntico ao comportamento anterior');

console.log('\n[6] GoalExecutionLoop — o bloco só chega ao Planner sob mode === "on"');
const root = path.resolve(__dirname, '..', '..');
const loopSrc = fs.readFileSync(path.join(root, 'loop', 'GoalExecutionLoop.ts'), 'utf8');
const calls = [...loopSrc.matchAll(/buildHostAppContextBlock\(/g)].length;
assert(calls === 3, `3 chamadas (gancho de sombra + plano inicial + estado do run) — foi ${calls}`);
const guarded = [...loopSrc.matchAll(/hostContextMode\(\) === 'on' \? buildHostAppContextBlock\(/g)].length;
assert(guarded === 2, `as duas chamadas que alimentam o Planner estão sob hostContextMode() === 'on' (foi ${guarded})`);
const planCalls = [...loopSrc.matchAll(/appendHostBlock\(await this\.contextualize\(/g)].length;
assert(planCalls === 3, `os 3 pontos de planejamento (inicial, replan, próximo marco) anexam o bloco (foi ${planCalls})`);
assert(!/this\.contextualize\([^)]*\);\s*\n[^\n]*planner\.(plan|replan)\(/.test(loopSrc), 'nenhum ponto de planejamento usa contextualize() sem passar pelo bloco');
const shadowIdx = loopSrc.indexOf("HOST_CONTEXT === 'shadow'");
const shadowHook = loopSrc.slice(shadowIdx, shadowIdx + 700);
assert(shadowIdx > -1 && /log\.info\([\s\S]*\[HOST-CONTEXT\]/.test(shadowHook) && !/(runtimeContext|q1Context|prompt|messages)\s*[+=]/.test(shadowHook), 'o gancho de sombra continua só logando');
const plannerSrc = fs.readFileSync(path.join(root, 'loop', 'GoalPlanner.ts'), 'utf8');
assert(!/hostAppContext|buildHostAppContextBlock/.test(plannerSrc), 'GoalPlanner não conhece o hospedeiro (recebe só texto de contexto)');

console.log('\n[7] GoalOrchestrator — skills do host só sob mode === "on"');
const orchSrc = fs.readFileSync(path.join(root, 'loop', 'GoalOrchestrator.ts'), 'utf8');
assert(/hostContextMode\(\) === 'on' \? hostAppSkillNames\(context\?\.metadata\) : \[\]/.test(orchSrc), "hostAppSkillNames só é consultado sob hostContextMode() === 'on'");
assert(/getSkillContextForQuery\(message, hostSkills\)/.test(orchSrc), 'a lista de skills do host é passada ao AgentLoop');

console.log('\n[8] REQUISITO OBRIGATÓRIO — suplemento do PowerPoint: texto nativo e editável (nunca Marp)');
const pptxSkill = loader.loadAll().find(sk => sk.name === 'pptx-generator');
const seen = pptxSkill?.globalContent ?? '';
const reqIdx = seen.indexOf('REQUISITO OBRIGATÓRIO');
assert(reqIdx > -1, 'a regra está no globalContent (o que o Planner realmente recebe), fora de TASK_ONLY');
const req = reqIdx > -1 ? seen.slice(reqIdx, reqIdx + 1600) : '';
assert(/texto nativo e editável/.test(req), 'declara: texto nativo e editável');
assert(/AMBIENTE DA CONVERSA/.test(req) && /suplemento Microsoft PowerPoint/.test(req), 'condiciona ao bloco do host (mesmas palavras do bloco)');
assert(/NUNCA use o Marp CLI nesse canal/.test(req), 'proíbe o Marp nesse canal');
assert(/Passo 0B/.test(req), 'aponta o caminho editável (Passo 0B: python-pptx/pptxgenjs)');
assert(/não verifique nem tente instalar o Marp/i.test(req), 'não perde ciclos verificando/instalando o Marp');
assert(/mesmo que a mensagem[\s\S]{0,80}n[aã]o diga/i.test(req), 'vale mesmo sem a palavra slide/pptx/editável na mensagem');
assert(reqIdx < seen.indexOf('Passo 0 — Verificar Marp'), 'a regra vem ANTES do Passo 0 (verificar Marp): o Planner a lê primeiro');
assert(reqIdx < seen.indexOf('AVISO IMPORTANTE'), 'a regra vem antes do aviso sobre o Marp');
const hostBlockText = buildHostAppContextBlock({ hostApp: 'powerpoint' });
assert(hostBlockText.includes('AMBIENTE DA CONVERSA') && hostBlockText.includes('suplemento Microsoft PowerPoint'), 'contrato skill↔bloco: as palavras que a skill cita existem no bloco do host');

console.log(`\n${passed} passaram, ${failed} falharam`);
process.exit(failed > 0 ? 1 : 0);
