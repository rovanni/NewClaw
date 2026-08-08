/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S153
 *
 * Contexto: `send_audio.ts` ganhou uma terceira engine, Piper (offline, GPL-3.0, invocado só
 * como subprocesso — nunca linkado ao processo do NewClaw). Motivação: node-edge-tts (S152)
 * depende dos servidores da Microsoft a cada requisição — sem SLA, risco real de escala. Piper
 * roda 100% local, mas exige Python configurado — a MESMA classe de fragilidade que motivou a
 * troca para node-edge-tts como padrão em primeiro lugar (docs/Auditorias/2026-07-26/LIMITACAO_EDGE_TTS_PYTHON_2026-07-26.md).
 *
 * Resolução: Piper é OPCIONAL — só ativado quando o operador já baixou os modelos
 * (`PIPER_MODELS_DIR`, nunca assumido por padrão — "Nunca Adivinhar"). Detecção ausente =
 * comportamento idêntico ao anterior a esta mudança (node-edge-tts continua o padrão de
 * fábrica). Presença dos arquivos É o sinal explícito de que o operador quer o modo offline.
 *
 * Cobre:
 *   1. Sem PIPER_MODELS_DIR configurado com os arquivos reais, findPiperInstallation() nunca
 *      ativa o Piper — generateAudio() se comporta exatamente como antes (S152 continua válido).
 *   2. No código-fonte, Piper é tentado ANTES de node-edge-tts (ordem de preferência quando
 *      detectado).
 *   3. Falha do Piper cai para node-edge-tts, não propaga o erro nem quebra o fluxo.
 *   4. runCommandWithStdin nunca usa shell (sem risco de injeção via texto do usuário).
 *   5. Fim a fim (com fake bus): sem Piper instalado nesta máquina, o tool continua gerando e
 *      "enviando" áudio normalmente via node-edge-tts — prova viva de que nada quebrou.
 *
 * Execução: npx ts-node src/__tests__/regression/S153_SendAudio_PiperOptionalLayer.test.ts
 */
import * as fs from 'fs';
import * as path from 'path';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

const src = fs.readFileSync(path.join(__dirname, '..', '..', 'tools', 'send_audio.ts'), 'utf-8');

async function main(): Promise<void> {

console.log('\n=== S153-1 — Piper é tentado ANTES de node-edge-tts no código-fonte ===');
{
    const piperIdx = src.indexOf('findPiperInstallation()');
    const npmIdx = src.indexOf('generateViaNodeEdgeTts(text, voice, mp3File)');
    assert(piperIdx !== -1, 'findPiperInstallation() é chamado em generateAudio()');
    assert(npmIdx !== -1, 'generateViaNodeEdgeTts() continua sendo chamado');
    assert(piperIdx !== -1 && npmIdx !== -1 && piperIdx < npmIdx, 'Piper aparece ANTES de node-edge-tts (ordem de preferência quando detectado)');
}

console.log('\n=== S153-2 — falha do Piper cai para node-edge-tts sem propagar o erro ===');
{
    const generateAudioBody = src.slice(src.indexOf('private async generateAudio'), src.indexOf('private async generateViaNodeEdgeTts'));
    assert(/catch \(piperErr\)/.test(generateAudioBody), 'bloco catch(piperErr) existe — falha do Piper é capturada, não propagada');
    assert(!/throw piperErr/.test(generateAudioBody), 'erro do Piper nunca é relançado (sempre cai para a próxima engine)');
}

console.log('\n=== S153-3 — detecção do Piper exige modelo E config E binário (nunca assume) ===');
{
    const detectBody = src.slice(src.indexOf('private findPiperInstallation'), src.indexOf('private async generateViaPiper'));
    assert(/existsSync\(model\)/.test(detectBody) && /existsSync\(config\)/.test(detectBody), 'checa existência real de modelo e config (não infere)');
    // Migrado na Sprint 035 (`ADR-008`): a sondagem passou de `which('piper')` (dois estados) para
    // `probeCommand` (três), e o retorno deixou de ser `null` para todos os casos. O que a asserção
    // protege continua sendo o mesmo — nunca assumir que o binário está lá.
    assert(/probeCommand\('piper'\)/.test(detectBody), 'checa o binário piper por sondagem explícita, nunca assume');
    assert(/kind: 'binario-ausente'/.test(detectBody), 'ausência VERIFICADA tem estado próprio');
    assert(/kind: 'binario-indeterminado'/.test(detectBody), 'e "não consegui verificar" não se confunde com ela');
    assert(/kind: 'nao-declarado'/.test(detectBody), 'assim como "o usuário não declarou TTS local"');
}

console.log('\n=== S153-4 — runCommandWithStdin nunca usa shell (texto do usuário nunca é reinterpretado) ===');
{
    const stdinFnBody = src.slice(src.indexOf('private runCommandWithStdin'));
    assert(/execFile\(/.test(stdinFnBody), 'usa execFile (sem shell) para o subprocesso do Piper');
    assert(!/shell:\s*true/.test(stdinFnBody), 'nunca passa shell:true');
    assert(/child\.stdin\?\.write/.test(stdinFnBody), 'texto é escrito via stdin, nunca como argumento interpolado em string de comando');
}

console.log('\n=== S153-5 — sem Piper instalado, a geração de áudio (pré-ffmpeg) continua via node-edge-tts ===');
{
    // Garante que este teste roda num ambiente onde o Piper genuinamente NÃO está instalado —
    // se PIPER_MODELS_DIR real existir, o teste ainda é válido (só documenta que rodou noutro modo).
    delete process.env.PIPER_MODELS_DIR;
    delete process.env.PIPER_BIN;

    // generateAudio() é privado — testado via reflexão, mesmo padrão pragmático já aceito
    // nesta suíte quando o alternativa seria reimplementar toda a cadeia de mocks de execute().
    // Isola especificamente a etapa que esta Sprint mudou (qual engine gera o áudio bruto),
    // sem depender de ffmpeg estar instalado nesta máquina (gap conhecido e não relacionado —
    // ver S37, mesma máquina).
    const { SendAudioTool } = await import('../../tools/send_audio');
    const fakeBus = {} as unknown as import('../../channels/MessageBus').MessageBus;
    const tool = new SendAudioTool(fakeBus) as unknown as {
        // Desde a `ADR-007` (Sprint 028) devolve também os fatos sobre a entrega, ao lado do
        // arquivo: quando o Piper foi DECLARADO e falhou, o texto do usuário saiu da máquina, e
        // isso precisa chegar a quem verbaliza. Aqui o Piper nem está instalado, então `fatos` vem
        // vazio — não há recurso declarado a proteger (`SOBERANIA_DA_CONFIGURACAO.md` §1.1).
        generateAudio(text: string, voice: string, audioDir: string, timestamp: number): Promise<{ file: string; fatos: string[] }>;
    };

    const os = await import('os');
    const audioDir = os.tmpdir();
    const timestamp = Date.now();
    let rawFile = '';
    try {
        const geracao = await tool.generateAudio('Teste de regressão S153, camada opcional do Piper.', 'pt-BR-AntonioNeural', audioDir, timestamp);
        rawFile = geracao.file;
        assert(
            geracao.fatos.length === 0,
            'sem Piper instalado não há fato a comunicar — o usuário não declarou TTS local',
            geracao.fatos,
        );
        const stats = fs.statSync(rawFile);
        assert(rawFile.endsWith('.mp3'), 'sem Piper detectado, o arquivo bruto é .mp3 (node-edge-tts), não .wav (Piper)', rawFile);
        assert(stats.size > 0, `áudio real gerado via node-edge-tts (${stats.size} bytes)`, stats.size);
    } catch (err) {
        assert(false, 'generateAudio() continua funcionando sem Piper instalado', err);
    } finally {
        try { if (rawFile) fs.unlinkSync(rawFile); } catch { /* não existia */ }
    }
}

console.log(`\n${'─'.repeat(60)}`);
console.log(failed === 0 ? `✅ S153 passou (${passed} verificações)` : `❌ S153: ${failed} falha(s) de ${passed + failed}`);
process.exitCode = failed === 0 ? 0 : 1;

}

main().catch((err) => {
    console.error('S153 erro inesperado:', err);
    process.exitCode = 1;
});
