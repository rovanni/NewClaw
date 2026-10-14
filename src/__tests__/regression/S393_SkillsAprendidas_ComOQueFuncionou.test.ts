/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S393: skills aprendidas com o que funcionou (ADR-017, estilo Hermes).
 *
 * Origem: os bancos de produção (14/10/2026) mostraram que as skills aprendidas automaticamente eram moldes de ~350 bytes ("use
 * <ferramenta> para processar a solicitação"), enquanto a skill que resolveu o Gmail (6,9 KB, configuração validada) foi escrita pelo
 * agente a pedido — no workspace, onde o SkillLoader não lê. A mantenedora pediu: aprender sozinho e só avisar o usuário.
 *
 * REGRESSÃO SE: o aprendizado chamar o LLM sem portão (trajetória curta, modo desligado); o pedido ao LLM levar SAÍDAS de
 * ferramentas ou um segredo usado na tarefa; uma skill com segredo, nome repetido ou forma inválida ser gravada; a skill aprendida
 * não nascer ativa e carregável pelo SkillLoader, com a origem declarada; o aviso não chegar ao canal da conversa ou não trazer o
 * comando de desfazer; o molde genérico voltar a ser proposto com o aprendizado automático ligado; os dois pontos de conclusão
 * deixarem de registrar o aprendizado.
 *
 * Execução: npx ts-node src/__tests__/regression/S393_SkillsAprendidas_ComOQueFuncionou.test.ts
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import {
    coletarSegredos, interpretarResposta, mascarar, modoDeAprendizado, montarPedidoDeAprendizado, montarTrajetoria, motivoParaRecusar,
} from '../../loop/aprendizadoDeSkills';
import { SkillLearner } from '../../loop/SkillLearner';
import { SkillLoader } from '../../skills/SkillLoader';
import { GoalExecutionLoop } from '../../loop/GoalExecutionLoop';
import { traceManager } from '../../core/ExecutionTrace';
import { WebChannelAdapter } from '../../channels/WebChannelAdapter';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}
const esperar = (ms: number) => new Promise(r => setTimeout(r, ms));

// Valores de teste com a FORMA de credenciais, montados por concatenação (nada real).
const SENHA_DE_APP = ['abcd', 'efgh', 'ijkl', 'mnop'].join(' ');
const TOKEN_ENV = 'tk_' + 'teste'.repeat(4);
const SAIDA_DE_FERRAMENTA = 'CONTEUDO-DA-CAIXA-DE-ENTRADA-QUE-NAO-PODE-IR-PARA-A-SKILL';

const PROPOSTA_OK = {
    aprender: true, motivo: 'configuração de e-mail reutilizável', nome: 'Gmail via himalaya', titulo: 'Ler o Gmail com o himalaya',
    descricao: 'Quando o usuário pedir para ver os e-mails do Gmail neste computador.', gatilhos: ['gmail', 'e-mails', 'caixa de entrada'],
    ferramentas: ['exec_command'], procedimento: '1. Rode `himalaya envelope list -a <conta>`.\n2. Leia a mensagem com `himalaya message read -a <conta> <id>`.',
    cuidados: 'A senha de app fica em <SEGREDO> na configuração do himalaya.', aviso: 'Aprendi a ler o seu Gmail pelo himalaya.',
};

async function main(): Promise<void> {

console.log('\n=== S393-1 — modo (APRENDIZADO_DE_SKILLS) ===');
assert(modoDeAprendizado(undefined) === 'automatico' && modoDeAprendizado('') === 'automatico', 'padrão: automático');
assert(modoDeAprendizado('proposta') === 'proposta' && modoDeAprendizado(' DESLIGADO ') === 'desligado' && modoDeAprendizado('xyz') === 'automatico', 'proposta / desligado / valor inválido → automático');

console.log('\n=== S393-2 — trajetória: ações na ordem, com argumentos; sub-turno expandido pelo rastro ===');
const rastro = [
    { type: 'tool_call', data: { tool: 'exec_command', input: { command: 'himalaya --version' } } },
    { type: 'tool_result', data: { tool: 'exec_command', success: true, output: SAIDA_DE_FERRAMENTA } },
    { type: 'tool_call', data: { tool: 'exec_command', input: { command: 'himalaya envelope list -a gmail' } } },
    { type: 'tool_result', data: { tool: 'exec_command', success: false, error: 'Account not found' } },
    { type: 'tool_call', data: { tool: 'exec_command', input: { command: 'himalaya envelope list -a pessoal' } } },
    { type: 'tool_result', data: { tool: 'exec_command', success: true, output: SAIDA_DE_FERRAMENTA } },
];
const tentativas = [
    { toolName: 'read', args: { path: 'config.toml' }, result: 'success', output: SAIDA_DE_FERRAMENTA },
    { toolName: 'agentloop', args: {}, result: 'success', traceId: 'trace-x', output: SAIDA_DE_FERRAMENTA },
    { toolName: 'agentloop', args: {}, result: 'success', traceId: 'sem-rastro' },
    { toolName: 'web_search', args: { query: 'erro himalaya' }, result: 'failure', error: 'timeout' },
];
const traj = montarTrajetoria(tentativas, (id) => (id === 'trace-x' ? rastro : undefined));
assert(traj.length === 5, `5 ações: read, 3 do sub-turno, web_search (o agentloop sem rastro não acrescenta nada) — ${traj.length}`, traj);
assert(traj[1].argumentos === '{"command":"himalaya --version"}' && traj[1].ok, 'argumentos do sub-turno vêm do rastro', traj[1]);
assert(!traj[2].ok && traj[2].erro === 'Account not found', 'falha do sub-turno com o erro', traj[2]);
assert(!traj[4].ok && traj[4].erro === 'timeout', 'falha de ação direta com o erro', traj[4]);
assert(!JSON.stringify(traj).includes(SAIDA_DE_FERRAMENTA), 'nenhuma SAÍDA de ferramenta entra na trajetória');

console.log('\n=== S393-3 — segredos: coletados, mascarados no pedido ao LLM ===');
const segredos = coletarSegredos({
    textos: [`a senha é ${SENHA_DE_APP}`],
    argumentos: [{ command: 'x', password: 'senha-do-arg-123' }],
    env: { MEU_API_TOKEN: TOKEN_ENV, OUTRA_COISA: 'valor-comum-longo' },
});
assert(segredos.includes(SENHA_DE_APP) && segredos.includes('senha-do-arg-123') && segredos.includes(TOKEN_ENV), 'senha de app do texto, argumento "password" e variável de ambiente sensível', segredos.length);
assert(!segredos.includes('valor-comum-longo'), 'variável de ambiente comum não é tratada como segredo');
const pedidoLLM = montarPedidoDeAprendizado({
    pedido: `minha senha é ${SENHA_DE_APP}, veja meus e-mails`, objetivo: 'ler e-mails', plataforma: 'windows', diretivaDeIdioma: 'Responda em português do Brasil.',
    trajetoria: [...traj, { ferramenta: 'exec_command', argumentos: `{"pass":"senha-do-arg-123"}`, ok: true }],
    skillsExistentes: [{ nome: 'pptx-generator', descricao: 'Converte Markdown em PPTX' }], segredos,
});
assert(!pedidoLLM.includes(SENHA_DE_APP) && !pedidoLLM.includes('senha-do-arg-123') && pedidoLLM.includes('<SEGREDO>'), 'o LLM nunca recebe o valor sensível — só <SEGREDO>');
assert(!pedidoLLM.includes(SAIDA_DE_FERRAMENTA), 'o LLM não recebe saídas de ferramentas');
assert(pedidoLLM.includes('veja meus e-mails') && pedidoLLM.includes('himalaya envelope list -a pessoal') && pedidoLLM.includes('falhou: Account not found'), 'recebe o pedido, as ações com argumentos e as falhas');
assert(pedidoLLM.includes('pptx-generator — Converte Markdown em PPTX') && pedidoLLM.includes('PLATAFORMA: windows') && pedidoLLM.includes('Responda em português do Brasil.'), 'recebe as skills existentes, a plataforma e a diretiva de idioma');
assert(mascarar('a b', ['a']) === '<SEGREDO> b', 'mascarar troca o valor');

console.log('\n=== S393-4 — interpretação e recusa da resposta ===');
assert(interpretarResposta('sem json').tipo === 'invalida', 'sem JSON → inválida');
assert(interpretarResposta('{"motivo":"x"}').tipo === 'invalida', 'sem "aprender" booleano → inválida');
const nao = interpretarResposta('```json\n{"aprender": false, "motivo": "tarefa trivial"}\n```');
assert(nao.tipo === 'nao_aprender' && nao.motivo === 'tarefa trivial', 'aprender=false (mesmo em bloco de código) → nada a aprender', nao);
const ok = interpretarResposta(JSON.stringify(PROPOSTA_OK));
assert(ok.tipo === 'aprender' && ok.proposta.nome === 'gmail-via-himalaya' && ok.proposta.gatilhos.includes('caixa de entrada'), 'proposta válida, nome normalizado em kebab-case', ok);
assert(interpretarResposta(JSON.stringify({ ...PROPOSTA_OK, procedimento: 'curto' })).tipo === 'invalida', 'procedimento curto demais → inválida');
if (ok.tipo === 'aprender') {
    assert(motivoParaRecusar(ok.proposta, { nomesExistentes: ['Gmail via Himalaya'], segredos: [] }) !== null, 'nome que já existe → recusada');
    assert(motivoParaRecusar({ ...ok.proposta, procedimento: `${ok.proposta.procedimento}\nsenha: ${SENHA_DE_APP}` }, { nomesExistentes: [], segredos: [SENHA_DE_APP] }) !== null, 'segredo usado na tarefa dentro da skill → recusada');
    assert(motivoParaRecusar({ ...ok.proposta, cuidados: 'chave sk-' + 'a'.repeat(30) }, { nomesExistentes: [], segredos: [] }) !== null, 'formato de credencial na skill → recusada');
    assert(motivoParaRecusar(ok.proposta, { nomesExistentes: ['outra'], segredos: [SENHA_DE_APP] }) === null, 'proposta limpa → aceita');
}

console.log('\n=== S393-5 — SkillLearner: portão, gravação, carregamento, desfazer ===');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-s393-'));
const modoOriginal = process.env.APRENDIZADO_DE_SKILLS;
try {
    const db = new Database(':memory:');
    const learner = new SkillLearner(db, dir);
    const entrada = { goalId: 'g1', pedido: `veja meus e-mails, senha ${SENHA_DE_APP}`, objetivo: 'ler e-mails', plataforma: 'windows', trajetoria: traj, segredos: [SENHA_DE_APP] };
    let chamadas = 0; let ultimoPedido = '';
    const llm = (resposta: string) => async (p: string) => { chamadas++; ultimoPedido = p; return resposta; };

    const curta = await learner.aprenderComTrajetoria({ ...entrada, trajetoria: [traj[0]] }, llm(JSON.stringify(PROPOSTA_OK)));
    assert(!curta.aprendida && chamadas === 0, 'trajetória com 1 ação bem-sucedida → o LLM nem é chamado', curta);
    process.env.APRENDIZADO_DE_SKILLS = 'desligado';
    const desligado = await learner.aprenderComTrajetoria(entrada, llm(JSON.stringify(PROPOSTA_OK)));
    assert(!desligado.aprendida && chamadas === 0, 'modo desligado → o LLM nem é chamado');
    delete process.env.APRENDIZADO_DE_SKILLS;

    const recusa = await learner.aprenderComTrajetoria(entrada, llm('{"aprender": false, "motivo": "nada novo"}'));
    assert(!recusa.aprendida && chamadas === 1 && fs.readdirSync(dir).length === 0, 'LLM diz que não vale aprender → nada gravado');
    assert(!ultimoPedido.includes(SENHA_DE_APP) && !ultimoPedido.includes(SAIDA_DE_FERRAMENTA), 'o pedido que chegou ao LLM não tem o segredo nem saídas de ferramenta');

    const vazou = await learner.aprenderComTrajetoria(entrada, llm(JSON.stringify({ ...PROPOSTA_OK, cuidados: `use ${SENHA_DE_APP}` })));
    assert(!vazou.aprendida && fs.readdirSync(dir).length === 0, 'skill com o segredo da tarefa → recusada, nada gravado', vazou);

    const r = await learner.aprenderComTrajetoria(entrada, llm(JSON.stringify(PROPOSTA_OK)));
    assert(r.aprendida && r.nome === 'gmail-via-himalaya', 'proposta válida → aprendida', r);
    const arquivo = path.join(dir, 'aprendida_gmail_via_himalaya', 'SKILL.md');
    assert(fs.existsSync(arquivo), 'SKILL.md na pasta própria da skill (aprendida_<nome>)', fs.readdirSync(dir));
    const linha = db.prepare("SELECT status, file_exported, source_tool FROM auto_skills WHERE name = 'gmail-via-himalaya'").get() as { status: string; file_exported: number; source_tool: string } | undefined;
    assert(linha?.status === 'active' && linha.file_exported === 1 && linha.source_tool === 'trajetoria', 'nasce ATIVA, exportada, com a origem "trajetoria"', linha);
    const loader = new SkillLoader(dir); loader.loadAll();
    const sk = loader.getSkill('gmail-via-himalaya');
    assert(!!sk && sk.description.startsWith('Quando o usuário pedir') && sk.content.includes('himalaya envelope list') && sk.content.includes('Aprendida automaticamente'), 'o SkillLoader carrega a skill, com o procedimento e a origem declarada', sk?.content.slice(0, 200));
    assert(!!sk && !sk.content.includes(SENHA_DE_APP), 'o pedido citado na origem vai com o segredo mascarado');
    assert(r.aprendida && r.aviso.includes('Aprendi a ler o seu Gmail') && r.aviso.includes('/skill_desativar gmail-via-himalaya'), 'aviso: frase do LLM + comando de desfazer literal', r);
    const repetida = await learner.aprenderComTrajetoria(entrada, llm(JSON.stringify(PROPOSTA_OK)));
    assert(!repetida.aprendida, 'a mesma skill não é criada duas vezes');

    assert(learner.deactivateSkillByName('gmail-via-himalaya') === 'gmail-via-himalaya' && !fs.existsSync(arquivo), '/skill_desativar: desativa pelo nome e remove o SKILL.md');
    assert(learner.deactivateSkillByName('nao-existe') === null, 'nome desconhecido → nada');

    console.log('\n=== S393-6 — o molde genérico deixa de ser proposto no modo automático (substitui, não soma) ===');
    for (let i = 0; i < 10; i++) learner.recordPattern('exec_command', true, 10, 'leitura_de_emails');
    const genericas = db.prepare("SELECT COUNT(*) n FROM auto_skills WHERE source_pattern = 'leitura_de_emails'").get() as { n: number };
    assert(genericas.n === 0, 'automático: nenhum molde "use exec_command para processar a solicitação"', genericas);
    process.env.APRENDIZADO_DE_SKILLS = 'proposta';
    for (let i = 0; i < 10; i++) learner.recordPattern('exec_command', true, 10, 'leitura_de_emails');
    const antigas = db.prepare("SELECT COUNT(*) n FROM auto_skills WHERE source_pattern = 'leitura_de_emails' AND status = 'proposed'").get() as { n: number };
    assert(antigas.n === 1, 'modo "proposta": o comportamento anterior continua disponível', antigas);
    delete process.env.APRENDIZADO_DE_SKILLS;

    console.log('\n=== S393-7 — GoalExecutionLoop: trajetória pelo rastro real, aviso no canal da conversa ===');
    const t = traceManager.startTrace('sessao', 'pedido');
    for (const p of rastro) traceManager.addStep(t, p.type as never, p.data);
    traceManager.completeTrace(t, 'completed');
    const avisos: Array<{ sessionKey: string; texto: string }> = [];
    const pedidosAoLLM: string[] = [];
    const db2 = new Database(':memory:');
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-s393b-'));
    const falso = {
        aprendizado: { skillLearner: new SkillLearner(db2, dir2), avisar: async (sessionKey: string, texto: string) => { avisos.push({ sessionKey, texto }); } },
        chamarLLMDeAprendizado: async (p: string) => { pedidosAoLLM.push(p); return JSON.stringify(PROPOSTA_OK); },
    };
    const goal = {
        id: 'goal_s393', sessionKey: 'telegram:123', userIntent: `veja meus e-mails ${SENHA_DE_APP}`, objective: 'ler e-mails',
        attempts: [{ toolName: 'agentloop', args: {}, result: 'success', traceId: t.id, output: SAIDA_DE_FERRAMENTA }],
    };
    (GoalExecutionLoop.prototype as unknown as { aprenderSkill: (g: unknown) => void }).aprenderSkill.call(falso, goal);
    for (let i = 0; i < 50 && avisos.length === 0; i++) await esperar(20);
    assert(pedidosAoLLM.length === 1 && pedidosAoLLM[0].includes('himalaya envelope list -a pessoal'), 'o pedido ao LLM traz as ações do sub-turno, tiradas do rastro');
    assert(!pedidosAoLLM[0]?.includes(SENHA_DE_APP), 'o segredo do pedido do usuário não vai ao LLM');
    assert(avisos.length === 1 && avisos[0].sessionKey === 'telegram:123' && avisos[0].texto.includes('/skill_desativar gmail-via-himalaya'), 'o aviso vai para a sessão do goal, com o desfazer', avisos);
    fs.rmSync(dir2, { recursive: true, force: true });

    const curtoGoal = { ...goal, id: 'goal_curto', attempts: [{ toolName: 'read', args: { path: 'x' }, result: 'success' }] };
    (GoalExecutionLoop.prototype as unknown as { aprenderSkill: (g: unknown) => void }).aprenderSkill.call(falso, curtoGoal);
    await esperar(50);
    assert(pedidosAoLLM.length === 1, 'goal com 1 ação: o LLM não é chamado');

    console.log('\n=== S393-8 — os dois pontos de conclusão registram o aprendizado ===');
    const fonte = fs.readFileSync(path.join(__dirname, '..', '..', 'loop', 'GoalExecutionLoop.ts'), 'utf-8');
    assert((fonte.match(/this\.registrarAprendizados\(/g) ?? []).length === 2, 'registrarAprendizados nos 2 pontos em que o goal é validado como concluído');
    assert((fonte.match(/this\.caseMemory\.captureIfEligible\(/g) ?? []).length === 1 && (fonte.match(/this\.operationalKnowledge\?\.captureFromGoal\(/g) ?? []).length === 1, 'Caso e conhecimento operacional não ficaram duplicados fora dele');

    console.log('\n=== S393-9 — canal web: o aviso chega mesclado na próxima resposta da sessão ===');
    const web = new WebChannelAdapter();
    await web.sendToChat('conv_1', { text: '💡 Aprendi algo', format: 'markdown' });
    const orfas = (web as unknown as { orphanedDeliveries: Map<string, Array<{ text: string }>> }).orphanedDeliveries.get('conv_1');
    assert(orfas?.[0]?.text === '💡 Aprendi algo', 'sendToChat do canal web guarda a mensagem como entrega da sessão', orfas);
    await web.stop();
} finally {
    if (modoOriginal === undefined) delete process.env.APRENDIZADO_DE_SKILLS; else process.env.APRENDIZADO_DE_SKILLS = modoOriginal;
    fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S393 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;
}

main().catch(e => { console.error(e); process.exit(1); });
