/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S398
 * O juiz de suficiência decide com o que uma pessoa usaria: as skills instaladas e a memória que de fato fala do assunto.
 *
 * INCIDENTE (14/10/2026, comparação Windows × Linux, mesma versão e mesmo modelo de juiz): "Alguma novidade no meu
 * e-mail?" foi REPROVADO no Windows (o juiz perguntou qual conta usar) e APROVADO no Linux. Nas duas máquinas a memória
 * chegou VAZIA ao juiz e a skill gmail-himalaya existia, mas ele não a via — teve de adivinhar se o acesso existia.
 *   1. a busca por palavras não achava a memória: o termo ficava "e-mail?" (com a pontuação), o teto de 4 termos pegava
 *      os primeiros da frase ("alguma", "novidade", "meu"…) e "e-mail" não casava com "email";
 *   2. as skills instaladas não eram entrada do juiz.
 *
 * REGRESSÃO SE: a pontuação voltar a ficar no termo; o teto voltar a escolher as primeiras palavras em vez das que carregam
 * o assunto; "e-mail" deixar de achar "email"; ou o juiz de suficiência deixar de receber as skills instaladas.
 *
 * Execução: npx ts-node src/__tests__/regression/S398_SuficienciaVeSkills_BuscaAchaEmail.test.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { MultiLayerRetriever } from '../../memory/MultiLayerRetriever';
import { descritorSuficienciaDoPedido } from '../../validation/tipos/suficienciaDoPedido';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}
const src = (...p: string[]) => fs.readFileSync(path.join(process.cwd(), 'src', ...p), 'utf-8');

console.log('\n=== S398-1 — termos da busca: sem pontuação, os que carregam o assunto, hífen nas duas formas ===');
{
    const db = new Database(':memory:');
    const r = new MultiLayerRetriever(db);
    const t = r.termosDaBusca('Alguma novidade no meu e-mail?');
    assert(t.includes('e-mail') && !t.some(x => /[?!.,]$/.test(x)), 'a pontuação sai das pontas ("e-mail?" → "e-mail")', t);
    assert(t.includes('email') && t.includes('mail'), 'palavra com hífen busca também a forma junta e as partes com 4+ letras', t);
    // Frase longa: com o teto antigo (os 4 PRIMEIROS: "você", "pode", "dizer", "alguma"), "e-mail" ficava de fora.
    const longa = r.termosDaBusca('Você pode me dizer se há alguma novidade no meu e-mail?');
    assert(longa.includes('e-mail') && longa.includes('novidade') && !longa.includes('você') && !longa.includes('meu'),
        'o teto de 4 fica com os termos mais longos, não com os primeiros da frase', longa);
    const t2 = r.termosDaBusca('Qual a previsão do tempo para amanhã?');
    assert(t2.includes('previsão') && t2.includes('amanhã'), 'acentos preservados e pontuação final removida', t2);
    db.close();
}

console.log('\n=== S398-2 — a memória sobre o Gmail aparece para "e-mail" ===');
{
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE memory_nodes (id TEXT PRIMARY KEY, name TEXT, content TEXT, type TEXT, lifecycle_state TEXT, confidence REAL, weight REAL)`);
    const ins = db.prepare('INSERT INTO memory_nodes (id, name, content, type) VALUES (?, ?, ?, ?)');
    ins.run('n1', 'gmail_himalaya_acesso_config', 'Setup de acesso ao Gmail via CLI himalaya: leitura IMAP testada.', 'infrastructure');
    ins.run('n2', 'himalaya_email_vps_status', 'Status do email na VPS.', 'project');
    ins.run('n3', 'clima_padrao', 'Cidade padrão para previsão do tempo.', 'preference');
    const ids = new MultiLayerRetriever(db).keywordSearch('Alguma novidade no meu e-mail?').map(c => c.nodeId);
    assert(ids.includes('n1') && ids.includes('n2'), 'os dois nós de e-mail/Gmail são encontrados (antes: nenhum)', ids);
    assert(!ids.includes('n3'), 'o nó do clima não entra por acaso', ids);
    db.close();
}

console.log('\n=== S398-3 — o juiz de suficiência recebe as skills instaladas ===');
{
    const skills = descritorSuficienciaDoPedido.entradas.find(e => e.nome === 'skills');
    assert(!!skills && skills.obrigatoria === false && skills.papel === 'contexto_da_execucao', 'o descritor declara a entrada "skills" (opcional, contexto da execução)', skills);
    assert(descritorSuficienciaDoPedido.checklist.some(c => /skill instalada já descreve como o assistente acessa/.test(c)), 'o checklist diz que acesso coberto por skill não é dado faltante');
    const orq = src('loop', 'GoalOrchestrator.ts');
    assert(/\{ pedido, preferencias, memoria, conversa, ferramentas, skills \}/.test(orq), 'verificarSuficiencia envia as skills ao motor');
    // Desde S435 (21/10/2026) a fonte carrega as skills antes do resumo: o cache só era preenchido pelo AgentLoop, que roda
    // DEPOIS da suficiência — o juiz recebeu `skills: 0 chars` em 13 chamadas de 15 a 19/10.
    assert(/this\.goalOrchestrator\.setResumoDasSkills\(\(\) => \{ this\.skillLoader\.loadAll\(\); return this\.skillLoader\.getSkillSummaries\(\); \}\)/.test(src('core', 'AgentController.ts')), 'o AgentController liga o resumo ao SkillLoader (carregado e lido a cada pedido)');
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S398 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
process.exit(failed > 0 ? 1 : 0);
