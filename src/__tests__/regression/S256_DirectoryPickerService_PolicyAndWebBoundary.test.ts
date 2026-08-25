/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S256
 *
 * Campanha FP — FP.6.3 (investigação) → implementação. Cobre a parte de `DirectoryPickerService`
 * que é pura/determinística e testável sem sistema operacional específico: resolução de política ×
 * preferência, o algoritmo `resolveEffectiveRoot` (Web Picker parte de onde o usuário já digitou,
 * nunca uma lista de raízes do computador inteiro — objeção explícita da FP.6 §3-4, fechada na
 * FP.6.2), a fronteira de navegação (`ceilingFor`) e a listagem segura contra symlink
 * (`listDirectory`, resolve ANTES de checar fronteira — ordem que evita TOCTOU/symlink-bypass).
 *
 * Verifica:
 * 1. isNativePickerPolicyAllowed(): só `NEWCLAW_NATIVE_DIRECTORY_PICKER=true` autoriza; ausente ou
 *    qualquer outro valor nega (mesmo padrão de toda outra feature opcional do projeto).
 * 2. shouldAttemptNative(): preferência nunca ultrapassa a política — só true quando política=true
 *    E preferência != 'web'.
 * 3. resolveEffectiveRoot(): hint vazio/ausente → homedir(); hint existente → ele mesmo; hint
 *    inexistente/parcial → sobe até o ancestral mais próximo que existe (mesma regra cobre os
 *    casos "inexistente" e "parcialmente digitado" da FP.6.2, sem tratamento especial); UNC nunca
 *    entra na árvore assistida.
 * 4. ceilingFor(): homedir() quando a raiz efetiva está dentro dele; raiz da própria unidade/volume
 *    quando está fora — nunca uma lista de drives.
 * 5. listDirectory(): só diretórios, nunca arquivos; respeita a fronteira; canGoUp/parent corretos.
 * 6. listDirectory() + symlink: resolvido ANTES de checar fronteira — um link apontando pra fora do
 *    teto nunca aparece na listagem (teste condicional: pulado com aviso se o ambiente não permitir
 *    criar symlinks, ex. Windows sem privilégio elevado — não falha a suíte por isso).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
    isNativePickerPolicyAllowed,
    shouldAttemptNative,
    resolveEffectiveRoot,
    ceilingFor,
    listDirectory,
} from '../../core/DirectoryPickerService';

let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string, detail?: unknown): void {
    if (cond) { console.log(`  ✅ ${msg}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${msg}`, detail ?? ''); failed++; }
}

function withEnv<T>(key: string, value: string | undefined, fn: () => T): T {
    const prev = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    try {
        return fn();
    } finally {
        if (prev === undefined) delete process.env[key];
        else process.env[key] = prev;
    }
}

function main() {
    console.log('\n=== S256-1 — isNativePickerPolicyAllowed(): só "true" autoriza ===');
    {
        assert(withEnv('NEWCLAW_NATIVE_DIRECTORY_PICKER', 'true', isNativePickerPolicyAllowed) === true, 'ENV="true" → autorizado');
        assert(withEnv('NEWCLAW_NATIVE_DIRECTORY_PICKER', 'false', isNativePickerPolicyAllowed) === false, 'ENV="false" → negado');
        assert(withEnv('NEWCLAW_NATIVE_DIRECTORY_PICKER', undefined, isNativePickerPolicyAllowed) === false, 'ENV ausente → negado (mesmo padrão de toda outra feature opcional)');
        assert(withEnv('NEWCLAW_NATIVE_DIRECTORY_PICKER', 'TRUE', isNativePickerPolicyAllowed) === false, 'ENV="TRUE" (maiúsculo) → negado — comparação exata, sem normalização heurística');
    }

    console.log('\n=== S256-2 — shouldAttemptNative(): preferência nunca ultrapassa a política ===');
    {
        withEnv('NEWCLAW_NATIVE_DIRECTORY_PICKER', 'false', () => {
            assert(shouldAttemptNative('native') === false, 'política negada + preferência native → nunca tenta');
            assert(shouldAttemptNative(undefined) === false, 'política negada + sem preferência → nunca tenta');
        });
        withEnv('NEWCLAW_NATIVE_DIRECTORY_PICKER', 'true', () => {
            assert(shouldAttemptNative('native') === true, 'política permitida + preferência native → tenta');
            assert(shouldAttemptNative(undefined) === true, 'política permitida + preferência ausente → tenta (default native)');
            assert(shouldAttemptNative('web') === false, 'política permitida + preferência web → não tenta nativo');
        });
    }

    console.log('\n=== S256-3 — resolveEffectiveRoot(): assiste a partir do hint, nunca uma lista de raízes ===');
    {
        const home = os.homedir();
        assert(resolveEffectiveRoot(undefined) === home, 'hint ausente → homedir()');
        assert(resolveEffectiveRoot('') === home, 'hint vazio → homedir()');
        assert(resolveEffectiveRoot('   ') === home, 'hint só espaço → homedir()');

        const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'ncdp-s256-'));
        const nested = path.join(fixture, 'IA_Offline', 'models');
        fs.mkdirSync(nested, { recursive: true });
        try {
            assert(resolveEffectiveRoot(nested) === path.resolve(nested), 'hint apontando pra pasta existente → ele mesmo (caso "válido" da FP.6.2)');
            assert(resolveEffectiveRoot(path.join(nested, 'typo')) === path.resolve(nested), 'hint inexistente (1 nível a mais) → sobe pro ancestral mais próximo que existe');
            assert(resolveEffectiveRoot(path.join(fixture, 'IA_Offline', 'mod')) === path.resolve(path.join(fixture, 'IA_Offline')), 'hint parcialmente digitado → mesma regra do inexistente, sem caso especial');
            assert(resolveEffectiveRoot(path.join(fixture, 'nada', 'aqui', 'existe')) === fixture, 'hint com vários níveis inexistentes → sobe até o fixture, que existe');
        } finally {
            fs.rmSync(fixture, { recursive: true, force: true });
        }

        assert(resolveEffectiveRoot('\\\\servidor\\share\\models') === home, 'hint UNC → nunca assistido, cai pra homedir() (decisão fechada na FP.6)');
    }

    console.log('\n=== S256-3b — achado ao vivo no QA (UX-02, 2026-08-24): hint não-absoluto nunca vira raiz de navegação ===');
    {
        // Reproduzido ao vivo: um hint sem os separadores certos (`D:IAIA_Offlinemodels`, típico
        // de um typo que engoliu as barras) era silenciosamente enxertado em cima de
        // process.cwd() por path.resolve() e podia abrir o painel numa pasta sem nenhuma relação
        // com o que a pessoa digitou. Confirmado via teste direto nesta máquina que
        // path.isAbsolute('D:foo') === false — "drive-relative" é sintaxe real e documentada do
        // Windows, não um caso inventado. A correção exige path.isAbsolute(hint) antes de
        // resolver — nunca um padrão de string tipo "contém barra?".
        const home = os.homedir();
        assert(resolveEffectiveRoot('D:IAIA_Offlinemodels') === home, 'hint "drive-relative" do Windows (sem separador após os dois-pontos) → homedir(), nunca enxertado em cima do cwd do servidor');
        assert(resolveEffectiveRoot('D:foo') === home, 'mesmo caso, forma mínima → homedir()');
        assert(resolveEffectiveRoot('IA_Offline/models') === home, 'hint relativo (sem drive/raiz nenhuma) → homedir(), nunca relativo ao cwd do servidor');
        assert(resolveEffectiveRoot('não é um caminho de verdade') === home, 'texto arbitrário sem forma de caminho → homedir()');
        // Achado DURANTE esta própria investigação (não do QA original): um "quase-UNC" malformado
        // (sem separador entre servidor e share) engana path.win32.parse(...).root, que devolve só
        // "\" (um separador) em vez de "\\" (dois) — o guard de UNC original checava .root, que
        // não pegava este caso. Corrigido pra checar o prefixo da string bruta.
        assert(resolveEffectiveRoot('\\\\servidorsharemodels') === home, 'UNC malformado (sem separador servidor/share) também cai pra homedir(), não escapa pelo gap do parser');
    }

    console.log('\n=== S256-4 — ceilingFor(): homedir() dentro, raiz da unidade fora — nunca lista de drives ===');
    {
        const home = os.homedir();
        assert(ceilingFor(home) === home, 'a própria homedir() é seu próprio teto');
        assert(ceilingFor(path.join(home, 'Documents', 'x')) === home, 'caminho dentro de homedir() → teto é homedir()');

        // Caminho fora de homedir(): sintético, não precisa existir de fato — ceilingFor() é
        // puramente sobre strings de caminho, não toca o filesystem.
        const outside = path.resolve(path.parse(home).root, '__ncdp_s256_outside__', 'deep', 'path');
        const expectedRoot = path.parse(outside).root;
        assert(ceilingFor(outside) === expectedRoot, 'caminho fora de homedir() → teto é a raiz da própria unidade/volume, nunca homedir() nem uma lista de drives');
    }

    console.log('\n=== S256-5 — listDirectory(): só diretórios, respeita fronteira, canGoUp/parent corretos ===');
    {
        const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'ncdp-s256-list-'));
        try {
            fs.mkdirSync(path.join(fixture, 'sub-a'));
            fs.mkdirSync(path.join(fixture, 'sub-b'));
            fs.writeFileSync(path.join(fixture, 'arquivo.gguf'), 'x');

            const rootListing = listDirectory(fixture, fixture);
            assert(rootListing.subdirs.length === 2 && rootListing.subdirs.every(d => d.name.startsWith('sub-')), 'lista só as 2 subpastas, nunca o arquivo .gguf', rootListing);
            assert(rootListing.canGoUp === false && rootListing.parent === null, 'dir === ceiling → não pode subir, parent null', rootListing);

            const subListing = listDirectory(path.join(fixture, 'sub-a'), fixture);
            assert(subListing.canGoUp === true && subListing.parent === fixture, 'dir dentro do teto → pode subir, parent correto', subListing);

            const outsideListing = listDirectory(path.dirname(fixture), fixture);
            assert(!!outsideListing.error && outsideListing.subdirs.length === 0, 'dir fora do teto → recusado com erro, nunca lista conteúdo', outsideListing);
        } finally {
            fs.rmSync(fixture, { recursive: true, force: true });
        }
    }

    console.log('\n=== S256-6 — listDirectory() + symlink: resolvido ANTES de checar fronteira ===');
    {
        const inner = fs.mkdtempSync(path.join(os.tmpdir(), 'ncdp-s256-inner-'));
        const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'ncdp-s256-outer-'));
        try {
            fs.mkdirSync(path.join(inner, 'legit-sub'));
            const escapeLink = path.join(inner, 'escape-link');
            let symlinkOk = true;
            try {
                fs.symlinkSync(outer, escapeLink, 'junction');
            } catch (err) {
                symlinkOk = false;
                console.log(`  ⚠️  SKIP (ambiente sem permissão de symlink): ${(err as Error).message}`);
            }
            if (symlinkOk) {
                const listing = listDirectory(inner, inner);
                assert(listing.subdirs.some(d => d.name === 'legit-sub'), 'subpasta legítima dentro do teto aparece normalmente', listing);
                assert(!listing.subdirs.some(d => d.name === 'escape-link'), 'symlink resolvido para FORA do teto nunca aparece na listagem (TOCTOU-safe: resolve antes de checar fronteira)', listing);
            }
        } finally {
            fs.rmSync(inner, { recursive: true, force: true });
            fs.rmSync(outer, { recursive: true, force: true });
        }
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S256 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    if (failed > 0) process.exit(1);
}

main();
