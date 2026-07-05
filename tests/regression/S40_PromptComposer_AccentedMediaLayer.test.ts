/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S40
 * Achado durante a auditoria multilíngue dos gates de content-stub (04-05/07/2026): a mesma
 * classe de bug corrigida em S39 (`\b` no JS não reconhece acento como caractere de palavra)
 * também existia em `PromptComposer.ts`, fora da cadeia de content-stub.
 *
 * LAYER_PATTERNS.media = /\b(v[ií]deo|[aá]udio|...)\b/i — a alternativa "[aá]udio" tem o
 * acento como PRIMEIRO caractere logo após o "\b" de abertura. Como "á" não é \w em JS, o "\b"
 * exige uma transição \w<->\W que nunca ocorre quando "áudio" é precedido por espaço/início de
 * string (o caso comum) — só "audio" (sem acento) casava. As demais alternativas acentuadas
 * (v[ií]deo, m[ií]dia, m[uú]sica) NÃO têm esse problema porque começam com consoante ASCII
 * (o acento fica no meio da palavra, não na borda do "\b").
 *
 * Reproduzido: PromptComposer.detectLayers("quero ouvir um áudio agora") não incluía 'media'
 * no Set retornado. Isso tem impacto mecanístico real em buildCompactEnv(): o filtro de
 * `caps.unavailableTools` (linha ~266) só mostra uma tool bloqueada mapeada em FALLBACK_LAYER
 * se a layer correspondente estiver no Set — com 'media' ausente, "ffmpeg" bloqueado e seus
 * fallbacks (moviepy, pil) são omitidos do bloco [ENV] injetado no prompt do GoalPlanner.
 *
 * Testada a hipótese de flag "u" (não resolve — \w continua ASCII-only mesmo com "u").
 *
 * Correção (commit f281c9c): trocar o "\b" de ABERTURA por "(?<!\w)" — assevera "não precedido
 * por caractere de palavra" sem depender de "á" ser classificado como \w. O "\b" de FECHAMENTO
 * foi mantido (todas as alternativas terminam em ASCII, sem o mesmo problema). Escopo: apenas
 * a linha `media` em LAYER_PATTERNS de src/core/PromptComposer.ts.
 *
 * Efeito colateral positivo do patch, descoberto em auditoria de reprodutibilidade posterior:
 * o regex ANTIGO tinha um falso-positivo pré-existente em contextos como "xáudio"/"_áudio"
 * (caractere de palavra imediatamente seguido de "á") — o "\b" antigo via a transição \w->\W
 * entre o caractere de palavra e o "á" (tratado como \W) como um boundary válido, ativando
 * 'media' incorretamente. O novo "(?<!\w)" corrige isso também: exige explicitamente que o
 * caractere ANTERIOR não seja de palavra, então "xáudio"/"_áudio" corretamente NÃO ativam
 * 'media' (mesmo comportamento de "xaudio"/"_audio", sem acento). O assert S40-6 protege essa
 * propriedade — sem ele, uma futura "simplificação" da regex poderia reintroduzir esse
 * falso-positivo sem quebrar nenhum teste.
 *
 * Promovido de src/__tests__/regression/ (local-only) para tests/regression/ (versionado) após
 * auditoria de maturidade: removida a linha `process.env.WORKSPACE_DIR = ...` do arquivo
 * original (caminho absoluto Windows específico da máquina do autor, não usado por
 * PromptComposer.ts em nenhum ponto — vestígio do template de outros testes da série que lêem
 * arquivos do workspace; PromptComposer opera só sobre strings em memória).
 *
 * Execução: npx ts-node tests/regression/S40_PromptComposer_AccentedMediaLayer.test.ts
 */

import { PromptComposer } from '../../src/core/PromptComposer';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

async function main(): Promise<void> {

// ── 1: texto exato do achado — "áudio" acentuado agora ativa a layer 'media' ──

console.log('\n=== S40-1 — "áudio" (acentuado) agora é reconhecido como palavra de mídia ===');
{
    const layers = PromptComposer.detectLayers('quero ouvir um áudio agora');
    assert(layers.has('media'), '"quero ouvir um áudio agora" ativa layer media', [...layers]);
}

// ── 2: demais positivos do mesmo regex, acentuados e não-acentuados — sem regressão ──

console.log('\n=== S40-2 — outras alternativas acentuadas/não-acentuadas do mesmo regex continuam OK ===');
{
    const positives = [
        'quero ouvir um audio agora',
        'quero criar um vídeo',
        'quero criar um video',
        'trabalhar com mídia',
        'trabalhar com midia',
        'criar uma música',
        'criar uma musica',
        'converter para mp3',
        'usar ffmpeg',
        'gerar uma imagem',
    ];
    for (const text of positives) {
        const layers = PromptComposer.detectLayers(text);
        assert(layers.has('media'), `"${text}" ativa layer media`, [...layers]);
    }
}

// ── 3: pontuação e posição — "áudio" isolado, com pontuação, maiúsculo ──

console.log('\n=== S40-3 — "áudio" em diferentes posições/pontuações/capitalização ===');
{
    const variants = ['áudio', 'áudio.', '(áudio)', '"áudio"', 'preciso de áudio, agora', 'ÁUDIO'];
    for (const text of variants) {
        const layers = PromptComposer.detectLayers(text);
        assert(layers.has('media'), `"${text}" ativa layer media`, [...layers]);
    }
}

// ── 4: negativos — nenhuma substring acidental (correção não pode virar match arbitrário) ──

console.log('\n=== S40-4 — negativos: substrings parecidas NÃO devem ativar media (sem falso positivo) ===');
{
    const negatives = ['audiovisual', 'videogame', 'fotografia', 'musical', 'imaginário'];
    for (const text of negatives) {
        const layers = PromptComposer.detectLayers(text);
        assert(!layers.has('media'), `"${text}" NÃO ativa layer media (substring, não é a palavra)`, [...layers]);
    }
}

// ── 5: impacto de Nível 3 — buildCompactEnv() muda de fato com ffmpeg bloqueado ──

console.log('\n=== S40-5 — buildCompactEnv() inclui "ffmpeg" bloqueado + fallbacks quando media é detectada ===');
{
    const capContext = [
        '• Ferramentas: python3,npm,git',
        '• Indisponíveis: ffmpeg,pandoc',
        '• Workspace: /workspace (leitura ✓, escrita ✓)',
    ].join('\n');

    const envComAcento = PromptComposer.buildCompactEnv(capContext, 'quero ouvir um áudio agora');
    assert(envComAcento.includes('ffmpeg'), 'ENV com goalText acentuado agora inclui "ffmpeg" bloqueado', envComAcento);
    assert(envComAcento.includes('fallbacks'), 'ENV com goalText acentuado agora inclui bloco de fallbacks', envComAcento);
}

// ── 6: boundary corrigida — "xáudio" NÃO deve ativar media (protege contra falso-positivo
//      pré-existente no regex antigo, onde um caractere de palavra colado a "á" satisfazia
//      incorretamente o "\b" de abertura) ──

console.log('\n=== S40-6 — "xáudio" (caractere de palavra colado a "á") NÃO ativa media, igual a "xaudio" ===');
{
    const layersAccented = PromptComposer.detectLayers('xáudio');
    assert(!layersAccented.has('media'), '"xáudio" NÃO ativa layer media (sem falso-positivo de boundary)', [...layersAccented]);
    const layersPlain = PromptComposer.detectLayers('xaudio');
    assert(!layersPlain.has('media'), '"xaudio" (controle, sem acento) também NÃO ativa layer media', [...layersPlain]);
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S40 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;

}

main().catch((err) => {
    console.error('S40 erro inesperado:', err);
    process.exitCode = 1;
});
