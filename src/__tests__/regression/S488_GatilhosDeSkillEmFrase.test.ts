/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S488 (ADR-040: gatilhos de skill viraram palavras soltas)
 *
 * Medido na produção Windows (17/11/2026): o modelo que aprende a skill propunha FRASES ("o que tenho hoje"), o
 * `SkillLearner` as juntava com espaço e o `extractTriggerKeywords` as quebrava em palavras; o casamento era `includes` de cada
 * palavra. "que", "para", "como" casavam em quase toda mensagem (p90 de 8 skills por mensagem) e "rea" casava dentro de "área".
 * O bloco de skills era cortado em 500 tokens com um `[...truncated]` só.
 *
 * Cada bloco abaixo reprova o código de antes:
 *   1. casamento: palavra dentro de outra não casa; frase inteira casa; plural regular casa.
 *   2. formato do campo `trigger`: as frases voltam iguais (antes: join(' ') sem volta); continua regex válida.
 *   3. aprendizado real (SkillLearner + SkillLoader, banco em memória, pasta temporária): o SKILL.md sai com as frases.
 *   4. trocarGatilhos (migração D2): banco e arquivo mudam; devolve o valor anterior.
 *   5. bloco de skills acima do teto: o corte é declarado com o nome das skills que ficaram de fora.
 *   6. o pedido ao modelo ensina frases (antes, o exemplo era ["palavras", "que", "indicam", "o pedido"]).
 *
 * Execução: npx ts-node src/__tests__/regression/S488_GatilhosDeSkillEmFrase.test.ts
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import { gatilhoCasa, matchSkillByTrigger, campoDeGatilhos, frasesDoCampoDeGatilhos } from '../../skills/SkillDiscovery';
import { SkillLoader, type Skill } from '../../skills/SkillLoader';
import { SkillLearner } from '../../loop/SkillLearner';
import { blocoDeSkillsNoLimite, estimateTokens } from '../../loop/ContextBuilder';
import {
    gatilhosValidos, interpretarGatilhos, interpretarResposta, montarPedidoDeAprendizado, montarPedidoDeGatilhos, REGRA_DOS_GATILHOS,
} from '../../loop/aprendizadoDeSkills';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}
const skill = (name: string, triggers: string[]): Skill => ({ name, description: 'd', triggers, tools: [], content: '', globalContent: '' } as unknown as Skill);

async function main(): Promise<void> {
    console.log('\n=== S488-1 — casamento: frase inteira, com fronteira de palavra ===');
    // Gatilhos reais da produção (SKILL.md de 17/11/2026) que casavam por dentro de outra palavra.
    assert(!matchSkillByTrigger(skill('rea-agents-recon', ['rea']), 'qual a área do círculo?'), '"rea" não casa dentro de "área"');
    assert(!matchSkillByTrigger(skill('status-watchlist-criptomoedas', ['cap']), 'qual a capital da França?'), '"cap" não casa dentro de "capital"');
    assert(!matchSkillByTrigger(skill('consulta-agenda', ['o que tenho hoje', 'minha agenda']), 'como está o tempo hoje?'), 'frase do gatilho ausente: não casa (antes "como"/"está"/"hoje" soltos casavam)');
    assert(matchSkillByTrigger(skill('consulta-agenda', ['o que tenho hoje', 'minha agenda']), 'Oi! O que tenho HOJE?'), 'frase inteira casa, sem diferença de maiúsculas');
    assert(gatilhoCasa('quero ver minhas agendas', 'minha agenda') === false && gatilhoCasa('tem aulas amanhã?', 'aula'), 'plural regular de uma palavra casa ("aula" → "aulas"); frase diferente não');
    assert(gatilhoCasa('gera o arquivo.pptx', 'pptx') && gatilhoCasa('roda o rust-101', 'rust'), 'termo raro sozinho casa ao lado de pontuação e hífen');
    assert(!gatilhoCasa('qualquer coisa', '  '), 'gatilho vazio nunca casa');
    // Caso real da prévia de 17/11: o modelo escreveu "como esta minha agenda" (sem acento).
    assert(gatilhoCasa('Como está minha agenda?', 'como esta minha agenda') && gatilhoCasa('como esta minha agenda', 'como está minha agenda'), 'acento não muda a frase (nos dois sentidos)');
    assert(!gatilhoCasa('a área toda', 'rea') && !gatilhoCasa('a area toda', 'rea'), 'sem acento, "rea" continua sem casar dentro de "área"/"area"');

    console.log('\n=== S488-2 — formato do campo `trigger`: as frases voltam iguais ===');
    const frases = ['o que tenho hoje', 'kahoot.it', 'morluto/rea', 'segunda-feira', 'quanto custa (aprox)'];
    const campo = campoDeGatilhos(frases);
    assert(JSON.stringify(frasesDoCampoDeGatilhos(campo)) === JSON.stringify(frases), 'ida e volta sem perda (com ponto, barra, hífen e parênteses)', { campo, volta: frasesDoCampoDeGatilhos(campo) });
    let regexOk = false;
    try { const r = new RegExp(campo, 'i'); regexOk = r.test('oi, o que tenho hoje?') && r.test('abre kahoot.it') && !r.test('kahootxit'); } catch { regexOk = false; }
    assert(regexOk, 'o campo continua sendo regex válida e casa as frases (caminho do banco, scoreSkillMatch)', campo);
    const antiga = frasesDoCampoDeGatilhos('(clima|tempo|temperatura|previs[aã]o|chovendo)');
    assert(antiga.includes('clima') && antiga.includes('previs') && antiga.includes('tempo') && !antiga.some(p => /[()[\]]/.test(p)), 'regex escrita à mão (formato antigo): sai em palavras, sem metacaractere', antiga);
    const espaco = frasesDoCampoDeGatilhos('agenda compromissos como está minha agenda o que tenho hoje');
    assert(espaco.length === 1, 'campo antigo de palavras com espaço (ADR-017 até 17/11) volta como UMA frase — sem adivinhar onde cortava', espaco);
    assert(JSON.stringify(gatilhosValidos(['  Minha   Agenda ', 'minha agenda', 'a, b', 'x', 'linha\nquebrada', 'ok'])) === JSON.stringify(['minha agenda', 'ok']),
        'forma: espaços normalizados, repetido sai, vírgula/quebra de linha/curto demais saem', gatilhosValidos(['  Minha   Agenda ', 'minha agenda', 'a, b', 'x', 'linha\nquebrada', 'ok']));

    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-s488-'));
    try {
        console.log('\n=== S488-3 — aprendizado real: o SKILL.md sai com as frases ===');
        const dirSkills = path.join(base, 'skills');
        fs.mkdirSync(dirSkills, { recursive: true });
        const db = new Database(':memory:');
        const learner = new SkillLearner(db, dirSkills);
        const respostaDoModelo = JSON.stringify({
            aprender: true, motivo: 'procedimento reutilizável', nome: 'consulta-agenda-teste', titulo: 'Consultar a agenda',
            descricao: 'Quando a pessoa pergunta o que tem na agenda do dia.', gatilhos: ['O que tenho hoje', 'minha agenda', 'compromissos de amanhã'],
            ferramentas: ['exec_command'], procedimento: 'Rode o script da agenda e leia o resultado com calma, passo a passo.', cuidados: '', aviso: 'Aprendi a consultar sua agenda.',
        });
        const r = await learner.aprenderComTrajetoria({
            goalId: 'g-s488', pedido: 'o que tenho hoje?', objetivo: 'consultar agenda', plataforma: process.platform, segredos: [],
            trajetoria: [{ ferramenta: 'exec_command', argumentos: 'python agenda.py', ok: true }, { ferramenta: 'read', argumentos: 'saida.txt', ok: true }],
        }, async () => respostaDoModelo);
        assert(r.aprendida === true, 'a skill foi aprendida', r);
        const arquivo = path.join(dirSkills, 'aprendida_consulta_agenda_teste', 'SKILL.md');
        const texto = fs.existsSync(arquivo) ? fs.readFileSync(arquivo, 'utf8') : '';
        assert(/^triggers: o que tenho hoje,minha agenda,compromissos de amanhã$/m.test(texto), 'triggers: as frases, separadas por vírgula (antes: "tenho,hoje,minha,agenda,...")', texto.match(/^triggers:.*$/m)?.[0]);
        const carregada = new SkillLoader(dirSkills).loadAll().find(s => s.name === 'consulta-agenda-teste');
        assert(JSON.stringify(carregada?.triggers) === JSON.stringify(['o que tenho hoje', 'minha agenda', 'compromissos de amanhã']), 'o SkillLoader lê as mesmas frases', carregada?.triggers);
        assert(!!carregada && !matchSkillByTrigger(carregada, 'que horas são?') && matchSkillByTrigger(carregada, 'quais compromissos de amanhã?'), 'a skill aprendida não casa "que horas são?" e casa a frase dela');

        console.log('\n=== S488-4 — trocarGatilhos (migração D2): banco e arquivo, com o valor anterior devolvido ===');
        const linha = db.prepare(`SELECT id, trigger FROM auto_skills WHERE name = 'consulta-agenda-teste'`).get() as { id: string; trigger: string };
        db.prepare('UPDATE auto_skills SET trigger = ? WHERE id = ?').run('agenda compromissos como está minha agenda', linha.id);
        const anterior = learner.trocarGatilhos(linha.id, ['como está minha agenda', 'agenda da semana']);
        assert(anterior === 'agenda compromissos como está minha agenda', 'devolve o valor anterior, para a reversão', anterior);
        const depois = fs.readFileSync(arquivo, 'utf8');
        assert(/^triggers: como está minha agenda,agenda da semana$/m.test(depois) && depois.includes('## Procedimento'), 'SKILL.md regerado com os gatilhos novos e o mesmo corpo', depois.match(/^triggers:.*$/m)?.[0]);
        assert(learner.trocarGatilhos('nao-existe', ['x y']) === null, 'skill inexistente: null, nada gravado');
        assert(learner.skillsAprendidasPorTrajetoria().length === 1, 'a lista das aprendidas por trajetória acha a skill');
        db.close();
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }

    console.log('\n=== S488-5 — bloco de skills acima do teto: o corte é declarado ===');
    const nomes = Array.from({ length: 18 }, (_, i) => `skill-${i + 1}`);
    // Cada skill (~2,3 mil caracteres) passa sozinha do teto de 500 tokens (~1.750): a primeira é cortada no meio, como na
    // produção (mediana dos SKILL.md: 3.191 caracteres).
    const bloco = nomes.map(n => `### SKILL MANUAL: ${n}\n${'Procedimento longo da skill. '.repeat(80)}`).join('\n\n');
    const cortado = blocoDeSkillsNoLimite(bloco, 500);
    assert(/\[corte do sistema: bloco de skills limitado a 500 tokens — \d+ de \d+ caracteres mostrados\./.test(cortado), 'diz quanto foi mostrado do total', cortado.slice(-300));
    assert(cortado.includes('Cortada no meio: skill-1.') && nomes.slice(1).every(n => cortado.includes(n)), 'nomeia a skill cortada no meio e todas as que não couberam');
    assert(cortado.length <= Math.floor(500 * 3.5), 'o bloco com a declaração cabe no teto', cortado.length);
    assert(blocoDeSkillsNoLimite('### SKILL: curta\nok', 500) === '### SKILL: curta\nok' && estimateTokens('### SKILL: curta\nok') < 500, 'dentro do teto: igual');

    console.log('\n=== S488-6 — o pedido ao modelo ensina frases ===');
    const pedido = montarPedidoDeAprendizado({ pedido: 'p', objetivo: 'o', plataforma: 'win32', trajetoria: [], skillsExistentes: [], segredos: [] });
    assert(pedido.includes(REGRA_DOS_GATILHOS) && !pedido.includes('"palavras", "que", "indicam"'), 'regra das frases no pedido; o exemplo de palavras soltas saiu');
    const pg = montarPedidoDeGatilhos({ nome: 'n', descricao: 'd', corpo: 'c' });
    assert(pg.includes(REGRA_DOS_GATILHOS) && pg.includes('NOME: n'), 'o pedido de regeração usa a mesma regra');
    assert(JSON.stringify(interpretarGatilhos('```json\n{"gatilhos": ["Minha agenda", "o que tenho hoje"]}\n```')) === JSON.stringify({ gatilhos: ['minha agenda', 'o que tenho hoje'] }), 'resposta de gatilhos: forma lida');
    assert('erro' in interpretarGatilhos('{"gatilhos": []}') && 'erro' in interpretarGatilhos('sem json'), 'sem gatilho na forma ou sem JSON: erro, nada inventado');
    const r6 = interpretarResposta(JSON.stringify({ aprender: true, motivo: 'm', nome: 'abc', titulo: 'Título', descricao: 'uma descrição boa', gatilhos: ['a, b', 'frase boa'], ferramentas: ['read'], procedimento: 'x'.repeat(50), cuidados: '', aviso: 'aviso' }));
    assert(r6.tipo === 'aprender' && JSON.stringify(r6.proposta.gatilhos) === '["frase boa"]', 'aprendizado: gatilho com vírgula é recusado na forma', r6);

    console.log(`\n${'─'.repeat(60)}\nS488: ${passed} ok, ${failed} falha(s)`);
    process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
