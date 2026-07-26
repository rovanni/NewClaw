/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S152
 *
 * Contexto: `send_audio.ts` dependia exclusivamente do CLI Python `edge-tts`
 * (`resolveEdgeTtsCommand()`/`resolvePython3Runtime`, já testado em S37). Quando não há runtime
 * Python 3 instalado/configurado (caso real desta máquina — confirmado por S37-4 falhando por
 * pré-requisito de ambiente), `send_audio` falhava com `spawn edge-tts ENOENT` sem nenhuma
 * alternativa — reproduzido em produção (25/07/2026) e em ambiente isolado de verificação
 * (26/07/2026, docs/Auditorias/2026-07-26/LIMITACAO_EDGE_TTS_PYTHON_2026-07-26.md).
 *
 * Correção: `node-edge-tts` (pacote npm, WebSocket direto ao serviço da Microsoft, sem Python)
 * passa a ser o motor PRIMÁRIO. O CLI Python continua existindo como fallback (S37 continua
 * válido e coberto). Avaliado e rejeitado antes disso: o pacote npm `edge-tts` (nome parecido,
 * projeto diferente) — licença CC BY-NC-SA (não-comercial) + conflito de peer-dependency +
 * instabilidade de lockfile ao instalar (docs/Auditorias/2026-07-26/LIMITACAO_EDGE_TTS_PYTHON_2026-07-26.md).
 * `node-edge-tts` é MIT, sem peer-deps, instalação puramente aditiva (confirmado:
 * `npm install` só adicionou 19 pacotes, 0 removidos, 215 linhas adicionadas no lockfile).
 *
 * Cobre:
 *   1. node-edge-tts é tentado ANTES do CLI Python (ordem de fallback no código-fonte);
 *   2. fallback de voz (para DEFAULT_VOICE) existe nas DUAS camadas, não só na antiga;
 *   3. só escala para o CLI Python se node-edge-tts falhar de ponta a ponta;
 *   4. subprocess real: node-edge-tts gera um MP3 de verdade nesta máquina (smoke test ao vivo,
 *      sem depender de Python — ao contrário de S37-4/5, este não tem pré-requisito de ambiente).
 *
 * Execução: npx ts-node src/__tests__/regression/S152_SendAudio_NodeEdgeTtsPrimary.test.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { EdgeTTS } from 'node-edge-tts';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

const src = fs.readFileSync(path.join(__dirname, '..', '..', 'tools', 'send_audio.ts'), 'utf-8');

async function main(): Promise<void> {

console.log('\n=== S152-1 — node-edge-tts é tentado antes do CLI Python (ordem no código-fonte) ===');
{
    const npmIdx = src.indexOf('generateViaNodeEdgeTts(text, voice, mp3File)');
    const cliIdx = src.indexOf('Falling back to Python edge-tts CLI');
    assert(npmIdx !== -1, 'chamada a generateViaNodeEdgeTts() existe em generateAudio()');
    assert(cliIdx !== -1, 'fallback para o CLI Python existe em generateAudio()');
    assert(npmIdx !== -1 && cliIdx !== -1 && npmIdx < cliIdx, 'node-edge-tts aparece ANTES do fallback Python no código-fonte (ordem de tentativa)');
}

console.log('\n=== S152-2 — fallback de voz para DEFAULT_VOICE existe nas duas camadas ===');
{
    const npmSection = src.slice(src.indexOf('generateViaNodeEdgeTts(text, voice, mp3File)'), src.indexOf('Falling back to Python edge-tts CLI'));
    const cliSection = src.slice(src.indexOf('Falling back to Python edge-tts CLI'));
    assert(/DEFAULT_VOICE/.test(npmSection), 'camada node-edge-tts tenta DEFAULT_VOICE se a voz pedida falhar');
    assert(/DEFAULT_VOICE/.test(cliSection), 'camada CLI Python (fallback) também tenta DEFAULT_VOICE se a voz pedida falhar');
}

console.log('\n=== S152-3 — só escala para o CLI Python se node-edge-tts falhar de ponta a ponta ===');
{
    // A chamada a resolveEdgeTtsCommand() (que dispara a resolução do runtime Python) só deve
    // aparecer DEPOIS do bloco catch de node-edge-tts, nunca antes/incondicionalmente.
    const generateAudioBody = src.slice(src.indexOf('private async generateAudio'), src.indexOf('private async generateViaNodeEdgeTts'));
    const resolveCallIdx = generateAudioBody.indexOf('this.resolveEdgeTtsCommand()');
    const npmCatchIdx = generateAudioBody.indexOf('node-edge-tts failed with default voice too');
    assert(resolveCallIdx !== -1, 'resolveEdgeTtsCommand() (caminho Python) é chamado em generateAudio()');
    assert(npmCatchIdx !== -1 && resolveCallIdx > npmCatchIdx, 'resolveEdgeTtsCommand() só é chamado DEPOIS de node-edge-tts esgotar as tentativas');
}

console.log('\n=== S152-4 — subprocess real: node-edge-tts gera MP3 de verdade (sem depender de Python) ===');
{
    const outFile = path.join(os.tmpdir(), `_s152_test_audio_${Date.now()}.mp3`);
    try {
        const tts = new EdgeTTS({ voice: 'pt-BR-AntonioNeural', lang: 'pt-BR', rate: '-5%' });
        await tts.ttsPromise('Teste de regressão S152 do NewClaw.', outFile);
        const stats = fs.statSync(outFile);
        assert(stats.size > 0, `MP3 gerado com sucesso via node-edge-tts (${stats.size} bytes)`, stats.size);
    } catch (err) {
        assert(false, 'node-edge-tts gerou áudio real via WebSocket (Microsoft)', err);
    } finally {
        try { fs.unlinkSync(outFile); } catch { /* não existia */ }
    }
}

console.log(`\n${'─'.repeat(60)}`);
console.log(failed === 0 ? `✅ S152 passou (${passed} verificações)` : `❌ S152: ${failed} falha(s) de ${passed + failed}`);
process.exitCode = failed === 0 ? 0 : 1;

}

main().catch((err) => {
    console.error('S152 erro inesperado:', err);
    process.exitCode = 1;
});
