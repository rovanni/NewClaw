/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S253
 *
 * Sprint C4.5 (2026-08-23) — achados do teste leigo via navegador (`/qa-only`) contra o
 * Assistente de Configuração (ConfigWizard.js), reportados em
 * `.gstack/qa-reports/qa-report-configwizard-2026-08-23.md`. Cobre os 3 achados de UX/conteúdo
 * (ISSUE-003/004/005) que não são máquina de estados — S250 cobre ISSUE-001/002 (mesma sprint,
 * arquivo separado porque pertencem à suíte do fluxo Ollama).
 *
 * Verifica:
 * 1. ISSUE-003 — existe uma regra `:disabled` global pra `.btn` em `config.css` (não escopada ao
 *    Wizard) — investigação confirmou que NENHUMA classe `.btn*` tinha esse estado, então o botão
 *    "Próximo" desabilitado usava a mesma aparência destacada de um botão pronto pra clicar, em
 *    QUALQUER lugar do dashboard que usa `.btn`, não só no Wizard.
 * 2. ISSUE-004 — o badge ⚠️ na aba "Escolher Modelo" tem `title` explicando o que representa,
 *    reaproveitando o MESMO texto (`internal_warn_title`/`internal_warn_body`) já usado no aviso
 *    completo mais abaixo na página — investigação em `checkInternalModels()` confirmou que o
 *    badge significa "plannerModel/riskModel/observerModel sem valor", não um texto novo inventado.
 * 3. ISSUE-005 — a frase sobre "Cloud" do Ollama foi verificada tecnicamente correta antes de
 *    mudar (OllamaProvider.ts:108 confirma: modelos :cloud são lidos via o MESMO /api/tags local,
 *    o Ollama local funciona como ponte) — a correção é só de clareza (uma frase de ponte
 *    explicando o "porquê"), nunca uma mudança de comportamento, nos três idiomas.
 */

import * as fs from 'fs';
import * as path from 'path';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

const CSS = fs.readFileSync(
    path.join(process.cwd(), 'src', 'dashboard', 'public', 'config', 'config.css'),
    'utf-8',
);
const CW = fs.readFileSync(
    path.join(process.cwd(), 'src', 'dashboard', 'public', 'config', 'components', 'ConfigWizard.js'),
    'utf-8',
);
const MODELOS = fs.readFileSync(
    path.join(process.cwd(), 'src', 'dashboard', 'public', 'config', 'views', 'ModelosView.js'),
    'utf-8',
);
const SHARED = fs.readFileSync(
    path.join(process.cwd(), 'src', 'dashboard', 'public', 'shared.js'),
    'utf-8',
);

console.log('\n=== S253-1 — ISSUE-003: .btn:disabled existe, global, não escopado ao Wizard ===');
{
    assert(/\.btn:disabled\s*\{[^}]*opacity/.test(CSS), '.btn:disabled define opacity reduzida (sinal visual de inativo)');
    assert(/\.btn:disabled\s*\{[^}]*cursor:\s*not-allowed/.test(CSS), '.btn:disabled define cursor:not-allowed');
    assert(
        !/\.config-wizard[\s.#][^{]*:disabled|#ml-configWizard[^{]*:disabled/.test(CSS),
        'a regra não está escopada a um seletor específico do Wizard (é .btn:disabled, vale pro dashboard inteiro)',
    );
}

console.log('\n=== S253-2 — ISSUE-004: badge ⚠️ da aba routing tem title explicando o que representa ===');
{
    assert(
        /id="ml-routingTabWarn"[^>]*title="\$\{esc\(t\('internal_warn_title'\)\)\} \$\{esc\(t\('internal_warn_body'\)\)\}"/.test(MODELOS),
        'o span do badge tem title com internal_warn_title + internal_warn_body (texto já existente, não inventado)',
    );
}

console.log('\n=== S253-3 — ISSUE-005: copy do modo Cloud do Ollama tem a frase de ponte, nos 3 idiomas, sem mudar a afirmação técnica ===');
{
    const locales: Array<[string, RegExp]> = [
        ['pt-BR', /ml_cw_ollama_mode_hint: "Local usa modelos baixados no seu computador\. Cloud usa modelos maiores na nuvem do Ollama — o Ollama instalado no seu computador faz a ponte com essa nuvem \(autenticada por chave\), por isso ainda precisa dele rodando localmente\."/],
        ['en-US', /ml_cw_ollama_mode_hint: "Local uses models downloaded on your machine\. Cloud uses bigger models hosted on Ollama's cloud — the Ollama app on your machine acts as the bridge to that cloud \(authenticated by a key\), which is why it still needs to be running locally\."/],
        ['es-ES', /ml_cw_ollama_mode_hint: "Local usa modelos descargados en tu equipo\. Cloud usa modelos más grandes alojados en la nube de Ollama — el Ollama instalado en tu equipo hace de puente con esa nube \(autenticada con una clave\), por eso igual necesita estar corriendo localmente\."/],
    ];
    for (const [locale, re] of locales) {
        assert(re.test(SHARED), `${locale}: ml_cw_ollama_mode_hint explica a ponte local↔nuvem, mantendo a afirmação original (ainda precisa do Ollama local)`);
    }
    // A afirmação técnica em si (Ollama local necessário mesmo em modo Cloud) não mudou — só
    // ganhou a explicação do porquê. Confirma que as 3 versões continuam dizendo a mesma coisa
    // (nenhuma ficou "cloud é 100% remoto", o que seria tecnicamente errado — ver OllamaProvider.ts:108).
    assert(
        /ainda precisa dele rodando localmente/.test(SHARED) && /still needs to be running locally/.test(SHARED) && /igual necesita estar corriendo localmente/.test(SHARED),
        'as 3 versões preservam a afirmação técnica verificada (Ollama local necessário mesmo em modo Cloud)',
    );
}

console.log('\n=== S253-4 — achado na auditoria C7 (2026-08-23): campo "pasta dos modelos locais" sem <label> ===');
{
    // Investigação: dos 7 <input> do Wizard (ollamaUrl, ollamaKey, customLabel, customUrl,
    // customKey, localDir, nativeKey), só localDir não tinha <label class="form-label"> associado —
    // um usuário de leitor de tela chegando nesse campo ouviria só "campo de texto", sem nome
    // acessível, diferente de todos os outros 6 campos do mesmo Wizard. Reaproveita a chave
    // ml_local_dir_label já existente (usada em ModelosView.js:ROTULOS), nenhum texto novo.
    const fn = CW.slice(CW.indexOf('function renderLocalFolder('), CW.indexOf('async function testLocalFolder('));
    // Achado ao vivo (campanha FP, Directory Picker): o <input> ganhou um <div style="display:flex">
    // envolvendo ele + o botão "Procurar..." — o <label> não está mais imediatamente adjacente ao
    // <input> em string, mas a associação programática (for=/id=) continua a mesma. Janela de até
    // 120 chars tolera o wrapper novo sem voltar a aceitar qualquer coisa no meio.
    assert(
        /<label class="form-label" for="ml-cw-localDir">\$\{t\('ml_local_dir_label'\)\}<\/label>[\s\S]{0,120}<input type="text" class="form-input" id="ml-cw-localDir"/.test(fn),
        'renderLocalFolder() agora tem <label> associado ao campo #ml-cw-localDir, mesmo padrão dos outros 6 campos do Wizard',
        fn,
    );
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S253 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exit(1);
