/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S36
 * Investigação de log real (log_conversa_newclaw.txt + newclaw-audit.log, 04/07/2026
 * 20:06-20:12 e 22:08-22:13): usuário pediu áudio com previsão do tempo e o goal
 * falhou repetidamente (14 tentativas, 5 replans, ~4min de execução na 1ª conversa),
 * sempre com respostas genéricas tipo "Não consegui completar" / "Erro em 'unknown'".
 *
 * Rastreamento no audit log revelou 3 bugs sistêmicos independentes (não um bug
 * isolado do weather ou do send_audio):
 *
 *   BUG 1 — detectMissingRequiredArgs('send_audio', ...) validava a chave ERRADA
 *   ('file_path' — copiado de send_document logo acima na mesma função) quando o
 *   schema real de send_audio.ts exige 'text'. Consequência real observada no log:
 *   "[SanitizePlanSteps] step 3: 'send_audio' sem 'file_path' obrigatório —
 *   converting to AgentLoop step" — um step de send_audio CORRETO (com text, sem
 *   file_path) era rebaixado para um step genérico de AgentLoop, perdendo o
 *   binding direto e confiável à tool.
 *
 *   BUG 2 — detectMissingRequiredArgs() não tinha NENHUMA entrada para 'weather'.
 *   Isso deixava a "CR#3" do RiskAnalyzer (rejeita plano se >50% dos tool-steps
 *   têm args inválidos) cega para weather sem 'city' — confirmado no log:
 *   RiskAnalyzer trocou web_search→weather via revisão LLM (Q2), mas o toolArgs
 *   resultante não tinha 'city', e o dispatch subsequente falhou em 3ms com
 *   "Erro em 'weather': Cidade não informada." sem o CR#3 nunca ter barrado isso.
 *   Nem buildToolContracts() (GoalPlanner) nem o prompt de revisão do RiskAnalyzer
 *   documentavam o schema de weather/send_audio para a LLM de troca de tools.
 *
 *   BUG 3 — AgentLoop.ts, nos DOIS caminhos de tool-calling (nativo e
 *   "ATOMIC-TOOL", usado por modelos sem function-calling nativo), tinha um
 *   fallback genérico "[FALHA] ... Tente uma abordagem diferente ou use seu
 *   conhecimento interno" para QUALQUER erro de tool fora de 3 padrões
 *   especial-cased (read not found / binary read / exec_command no such file).
 *   O texto REAL do erro (result.error, ex: "spawn edge-tts ENOENT" ou "Cidade
 *   não informada.") era computado em errorText mas NUNCA incluído na mensagem
 *   devolvida ao LLM — confirmado no log: 6-10+ chamadas repetidas de send_audio
 *   com "ERROR: spawn edge-tts ENOENT" por conversa, sem nenhuma linha de log
 *   subsequente de GoalEvaluator/classificação (essas chamadas passavam pelo
 *   AgentLoop nativo/ATOMIC-TOOL, não pelo GoalEvaluator.classifyError() que já
 *   tinha o parsing correto). O LLM nunca via a causa real e reformulava a frase
 *   às cegas repetidamente — exatamente o padrão observado nos dois logs.
 *
 * Escopo tocado: src/loop/GoalPlanner.ts, src/loop/RiskAnalyzer.ts,
 * src/loop/AgentLoop.ts. Nenhuma tool alterada (weather.ts/send_audio.ts já
 * estavam corretos — os bugs eram todos de leitura/propagação incorreta do
 * contrato já existente).
 *
 * Execução: npx ts-node src/__tests__/regression/S36_AudioWeatherFailureFeedback.test.ts
 */

process.env.WORKSPACE_DIR = process.env.WORKSPACE_DIR || 'D:/IA/newclaw/workspace';

import * as fs from 'fs';
import * as path from 'path';
import { detectMissingRequiredArgs } from '../../loop/GoalPlanner';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

function readSource(relPath: string): string {
    return fs.readFileSync(path.join(process.cwd(), relPath), 'utf-8');
}

async function main(): Promise<void> {

// ── BUG 1: send_audio valida 'text', não 'file_path' ──

console.log('\n=== S36-1 — send_audio: detectMissingRequiredArgs valida "text" (schema real), não "file_path" ===');
{
    const validReal = detectMissingRequiredArgs('send_audio', { text: 'Previsão do tempo para hoje...' });
    assert(validReal === null, 'send_audio com "text" (uso real/correto) NÃO é mais rebaixado a AgentLoop', validReal);

    const missingText = detectMissingRequiredArgs('send_audio', { file_path: 'audio.mp3' });
    assert(typeof missingText === 'string' && /text/.test(missingText), 'send_audio SEM "text" (mesmo com file_path) é corretamente sinalizado como inválido', missingText);

    const bothFine = detectMissingRequiredArgs('send_audio', {});
    assert(typeof bothFine === 'string', 'send_audio sem nenhum arg continua sinalizado como inválido', bothFine);
}

// ── BUG 2: weather agora validado ──

console.log('\n=== S36-2 — weather: detectMissingRequiredArgs agora cobre "city" (antes não existia entrada) ===');
{
    const validCity = detectMissingRequiredArgs('weather', { city: 'Belo Horizonte' });
    assert(validCity === null, 'weather com "city" é válido', validCity);

    const missingCity = detectMissingRequiredArgs('weather', {});
    assert(typeof missingCity === 'string' && /city/.test(missingCity), 'weather SEM "city" agora é sinalizado (reproduz o gap real do incidente)', missingCity);

    // Reproduz o cenário exato do log: RiskAnalyzer troca web_search→weather sem herdar city
    const staleArgsFromWebSearch = detectMissingRequiredArgs('weather', { query: 'previsão do tempo Belo Horizonte' });
    assert(typeof staleArgsFromWebSearch === 'string', 'toolArgs herdados de um web_search (sem city) são detectados como inválidos para weather', staleArgsFromWebSearch);
}

// ── BUG 2b: schemas documentados nos dois prompts (GoalPlanner + RiskAnalyzer) ──

console.log('\n=== S36-3 — weather/send_audio documentados nos 2 blocos de SCHEMAS OBRIGATÓRIOS ===');
{
    const plannerSrc = readSource('src/loop/GoalPlanner.ts');
    assert(/weather:\s*\{"city"/.test(plannerSrc), 'buildToolContracts() (GoalPlanner) documenta schema de weather', null);
    assert(/send_audio:\s*\{"text"/.test(plannerSrc), 'buildToolContracts() (GoalPlanner) documenta schema de send_audio', null);

    const riskSrc = readSource('src/loop/RiskAnalyzer.ts');
    assert(/weather:\s*\{"city"/.test(riskSrc), 'prompt de revisão do RiskAnalyzer documenta schema de weather', null);
    assert(/send_audio:\s*\{"text"/.test(riskSrc), 'prompt de revisão do RiskAnalyzer documenta schema de send_audio', null);
}

// ── BUG 3: AgentLoop propaga o texto real do erro nos 2 caminhos ──

console.log('\n=== S36-4 — AgentLoop: texto real do erro chega ao LLM nos 2 caminhos de tool-calling ===');
{
    const src = readSource('src/loop/AgentLoop.ts');

    assert(!/Tente uma abordagem diferente ou use seu conhecimento interno/.test(src),
        'mensagem genérica sem causa real foi removida de AMBOS os caminhos (nenhuma ocorrência restante)', null);

    const hasNativeReasonVar = /const reason = errorText\.trim\(\)\.slice\(0, 300\)/.test(src);
    const nativeUsesReason = (src.match(/falhou: \$\{reason\}/g) ?? []).length >= 1;
    assert(hasNativeReasonVar && nativeUsesReason, 'caminho de tool-calling nativo inclui o texto real do erro (reason) na mensagem ao LLM', { hasNativeReasonVar, nativeUsesReason });

    const hasAtomicReasonVar = /const atomicReason = \(result\.error \?\? result\.output \?\? ''\)/.test(src);
    const atomicUsesReason = (src.match(/falhou: \$\{atomicReason\}/g) ?? []).length >= 1;
    assert(hasAtomicReasonVar && atomicUsesReason, 'caminho ATOMIC-TOOL (modelos sem function-calling nativo) TAMBÉM inclui o texto real do erro — a 2ª cópia do bug não ficou para trás', { hasAtomicReasonVar, atomicUsesReason });

    // Reproduz especificamente os 2 erros observados no incidente real
    const edgeTtsError = 'Erro ao gerar áudio: spawn edge-tts ENOENT';
    const weatherError = "Erro em 'weather': Cidade não informada.";
    const truncatedEdge = edgeTtsError.trim().slice(0, 300);
    const truncatedWeather = weatherError.trim().slice(0, 300);
    assert(truncatedEdge === edgeTtsError, 'erro real do edge-tts (ENOENT) cabe inteiro no truncamento de 300 chars — chegaria completo ao LLM', truncatedEdge);
    assert(truncatedWeather === weatherError, 'erro real do weather (Cidade não informada) cabe inteiro no truncamento de 300 chars', truncatedWeather);
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S36 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;

}

main().catch((err) => {
    console.error('S36 erro inesperado:', err);
    process.exitCode = 1;
});
