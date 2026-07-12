/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S90
 * computeToolInputKey() — dedup de send_document por file_path, não por JSON completo.
 *
 * BUG REAL (auditoria + reprodução ao vivo, 10-11/07/2026, log_conversa_newclaw.txt):
 * o dedup "duro" de chamadas de ferramenta repetidas (usedToolInputs/blockedKeyCount em
 * AgentLoop.ts, bloqueia após 3 repetições idênticas) usava `tool:JSON.stringify(args)` como
 * chave. send_document costuma variar a legenda/args não essenciais a cada tentativa mesmo
 * reenviando o MESMO arquivo — o JSON nunca repete exatamente, então o dedup duro nunca
 * disparava para essa ferramenta. Só o guard semântico de deferSendDocument (por file_path,
 * em GoalExecutionLoop) percebia a repetição, mas ele só pede pro modelo parar por texto, sem
 * cortar o loop. Resultado real: send_document repetido nos steps 6, 7 e 9 de um mesmo goal
 * (goal_1783739436377_gzysa) até um SAFETY-GUARD de OUTRA ferramenta (exec_command,
 * same_tool_limit=4) cortar por acidente.
 *
 * FIX: computeToolInputKey() chaveia send_document por file_path (ou path, fallback já usado
 * em GoalExecutionLoop.deferSendDocument) — repetições da mesma tool pro mesmo arquivo, com
 * legenda/args diferentes, agora colidem na mesma chave e caem no dedup duro já existente.
 * Demais ferramentas continuam com a chave antiga (JSON completo), sem alteração de contrato.
 *
 * Execução: npx ts-node src/__tests__/regression/S90_ComputeToolInputKey_SendDocumentFilePathScoped.test.ts
 */

import { computeToolInputKey } from '../../loop/planning/computeToolInputKey';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

console.log('\n=== S90-1 — send_document: mesma file_path, legendas diferentes → MESMA chave ===');
{
    const k1 = computeToolInputKey('send_document', { file_path: 'aula.pptx', caption: 'Aqui está a aula!' });
    const k2 = computeToolInputKey('send_document', { file_path: 'aula.pptx', caption: 'Segue o arquivo solicitado.' });
    assert(k1 === k2, `chaves iguais apesar da legenda diferente (k1=${k1}, k2=${k2})`);
}

console.log('\n=== S90-2 — send_document: file_paths diferentes → chaves diferentes ===');
{
    const k1 = computeToolInputKey('send_document', { file_path: 'aula.pptx' });
    const k2 = computeToolInputKey('send_document', { file_path: 'outro_arquivo.pptx' });
    assert(k1 !== k2, `chaves diferentes para arquivos diferentes (k1=${k1}, k2=${k2})`);
}

console.log('\n=== S90-3 — send_document: aceita fallback "path" (mesmo campo usado por GoalExecutionLoop.deferSendDocument) ===');
{
    const k1 = computeToolInputKey('send_document', { file_path: 'aula.pptx' });
    const k2 = computeToolInputKey('send_document', { path: 'aula.pptx' });
    assert(k1 === k2, `"file_path" e "path" produzem a mesma chave para o mesmo arquivo (k1=${k1}, k2=${k2})`);
}

console.log('\n=== S90-4 — send_document sem file_path/path → cai no fallback por JSON completo (não quebra) ===');
{
    const k = computeToolInputKey('send_document', { caption: 'sem caminho nenhum' });
    assert(k.startsWith('send_document:'), `chave ainda identifica a tool (k=${k})`, k);
    assert(k.includes('caption'), `fallback usa o JSON completo quando não há file_path (k=${k})`, k);
}

console.log('\n=== S90-5 — demais ferramentas continuam chaveadas pelo JSON completo (sem regressão) ===');
{
    const k1 = computeToolInputKey('read', { path: 'notas.md' });
    const k2 = computeToolInputKey('read', { path: 'notas.md', encoding: 'utf8' });
    assert(k1 !== k2, `"read" com argumentos diferentes continua gerando chaves diferentes (k1=${k1}, k2=${k2})`);

    const k3 = computeToolInputKey('exec_command', { command: 'dir' });
    const k4 = computeToolInputKey('exec_command', { command: 'dir' });
    assert(k3 === k4, `"exec_command" com os MESMOS argumentos continua colidindo normalmente (k3=${k3}, k4=${k4})`);
}

console.log('\n=== S90-6 — send_audio (sem file_path estável) não é afetado pela regra especial ===');
{
    const k1 = computeToolInputKey('send_audio', { text: 'previsão do tempo' });
    const k2 = computeToolInputKey('send_audio', { text: 'previsão do tempo, tentativa 2' });
    assert(k1 !== k2, `send_audio continua chaveado por JSON completo — cada texto novo é uma chave nova (k1=${k1}, k2=${k2})`);
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S90 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exit(1);
