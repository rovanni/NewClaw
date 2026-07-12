/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — CrossPlatform: resolvePath()
 *
 * Valida o comportamento de resolvePath() em três cenários críticos:
 *
 * 1. Não-regressão Ubuntu/Linux:
 *    Um path que já pertence ao WORKSPACE_DIR atual NÃO deve ser transformado.
 *    (guarda alreadyLocal — garante que o Ubuntu não sofra alteração silenciosa)
 *
 * 2. Compatibilidade legada — paths de outra instalação:
 *    Paths com /home/X/Y/workspace/Z e /Users/X/Y/workspace/Z devem ser
 *    normalizados para workspaceDir/Z independentemente do SO atual.
 *
 * 3. Caminhos relativos:
 *    slides.md e subdir/slides.md devem resolver para workspaceDir/arquivo.
 *
 * 4. Segurança — path traversal fora do workspace:
 *    Qualquer path que escape do sandbox deve retornar { error } ou ser
 *    mapeado para dentro do workspace (sem acesso ao sistema de arquivos real).
 *
 * Execução: npx ts-node src/__tests__/regression/CrossPlatform_ResolvePath_NoRegression.test.ts
 */

import * as path from 'path';
import * as os from 'os';
import { resolvePath } from '../../utils/crossPlatform';

// ── Utilitário de assertion ───────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
    if (condition) {
        console.log(`  ✅ ${label}`);
        passed++;
    } else {
        console.error(`  ❌ FALHOU: ${label}`);
        failed++;
    }
}

// ── Workspace de referência para os testes ────────────────────────────────────

const workspaceDir = path.resolve(process.env.WORKSPACE_DIR ?? path.join(process.cwd(), 'workspace'));

console.log(`\nWorkspace de referência: ${workspaceDir}`);
console.log(`Plataforma: ${process.platform}\n`);

// ─────────────────────────────────────────────────────────────────────────────
// Bloco 1 — NÃO-REGRESSÃO UBUNTU/LINUX
//
// Se um path absoluto JÁ está dentro do workspaceDir atual, resolvePath()
// deve retorná-lo sem qualquer transformação.
// Garante que a instalação Ubuntu não sofra alteração silenciosa nos paths.
// ─────────────────────────────────────────────────────────────────────────────

console.log('=== Bloco 1 — Não-regressão: path já dentro do workspaceDir ===');

{
    const inputInWs = path.join(workspaceDir, 'slides.md');
    const { resolved, error } = resolvePath(inputInWs);
    assert(
        !error && path.normalize(resolved) === path.normalize(inputInWs),
        `Path dentro do workspace (${inputInWs}) → sem transformação → ${resolved}`,
    );
}

{
    const inputSubdir = path.join(workspaceDir, 'subdir', 'relatorio.md');
    const { resolved, error } = resolvePath(inputSubdir);
    assert(
        !error && path.normalize(resolved) === path.normalize(inputSubdir),
        `Subdiretório dentro do workspace → sem transformação`,
    );
}

{
    const { resolved } = resolvePath(workspaceDir);
    assert(
        path.normalize(resolved) === path.normalize(workspaceDir),
        `Próprio workspaceDir como input → retorna workspaceDir sem transformação`,
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// Bloco 2 — COMPATIBILIDADE LEGADA: paths de outra instalação
//
// Paths com /home/X/Y/workspace/Z (Linux VPS) ou /Users/X/Y/workspace/Z (macOS)
// NÃO pertencem ao workspaceDir atual mas devem ser normalizados para
// workspaceDir/Z (extrai o sufixo relativo ao workspace).
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n=== Bloco 2 — Compatibilidade legada: paths de outra instalação ===');

const expectedSlides = path.join(workspaceDir, 'slides.md');

{
    // Linux VPS — /home/X/Y/workspace/Z
    const legacyLinux = '/home/user-vps/newclaw/workspace/slides.md';
    const { resolved, error } = resolvePath(legacyLinux);
    assert(
        !error && path.normalize(resolved) === path.normalize(expectedSlides),
        `Linux VPS path → ${resolved} (esperado: ${expectedSlides})`,
    );
}

{
    // macOS VPS — /Users/X/Y/workspace/Z
    const legacyMac = '/Users/user-vps/NewClaw/workspace/slides.md';
    const { resolved, error } = resolvePath(legacyMac);
    assert(
        !error && path.normalize(resolved) === path.normalize(expectedSlides),
        `macOS VPS path → ${resolved} (esperado: ${expectedSlides})`,
    );
}

{
    // Canônico /workspace/Z (sem prefixo de instalação)
    const canonical = '/workspace/slides.md';
    const { resolved, error } = resolvePath(canonical);
    assert(
        !error && path.normalize(resolved) === path.normalize(expectedSlides),
        `Canônico /workspace/slides.md → ${resolved} (esperado: ${expectedSlides})`,
    );
}

{
    // Subdiretório em path VPS
    const legacySubdir = '/home/user-vps/newclaw/workspace/docs/relatorio.md';
    const expectedSubdir = path.join(workspaceDir, 'docs', 'relatorio.md');
    const { resolved, error } = resolvePath(legacySubdir);
    assert(
        !error && path.normalize(resolved) === path.normalize(expectedSubdir),
        `VPS path com subdiretório → ${resolved} (esperado: ${expectedSubdir})`,
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// Bloco 3 — CAMINHOS RELATIVOS
//
// Paths relativos devem sempre resolver para workspaceDir/arquivo.
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n=== Bloco 3 — Caminhos relativos ===');

{
    const { resolved, error } = resolvePath('slides.md');
    assert(
        !error && path.normalize(resolved) === path.normalize(path.join(workspaceDir, 'slides.md')),
        `Relativo "slides.md" → ${resolved}`,
    );
}

{
    const { resolved, error } = resolvePath('subdir/slides.md');
    assert(
        !error && path.normalize(resolved) === path.normalize(path.join(workspaceDir, 'subdir', 'slides.md')),
        `Relativo "subdir/slides.md" → ${resolved}`,
    );
}

{
    const { resolved, error } = resolvePath('workspace/slides.md');
    assert(
        !error && path.normalize(resolved) === path.normalize(path.join(workspaceDir, 'slides.md')),
        `"workspace/slides.md" (prefixo redundante) → ${resolved}`,
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// Bloco 4 — SEGURANÇA: sandbox
//
// Paths que apontam para fora do workspace não devem acessar o sistema de
// arquivos real. O sistema deve rejeitar (error) ou mapear para dentro do
// workspace (nunca retornar um path de sistema como /etc, C:\Windows etc.).
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n=== Bloco 4 — Segurança: sandbox ===');

{
    // /etc/passwd não tem /workspace/ → vai para candidate 2 (workspace/etc/passwd)
    // Comportamento esperado: resolvido DENTRO do workspace (sandbox seguro)
    const { resolved: etcResolved } = resolvePath('/etc/passwd');
    const isSystemFile = path.normalize(etcResolved) === '/etc/passwd' ||
        path.normalize(etcResolved).toLowerCase() === 'c:\\windows\\system32\\drivers\\etc\\hosts';
    assert(
        !isSystemFile,
        `/etc/passwd não deve resolver para arquivo de sistema real (resolveu para: ${etcResolved})`,
    );
}

{
    // C:\Windows\System32 sem /workspace/ — no Windows deve ser rejeitado fora do sandbox.
    //
    // Atualizado em 01/07/2026: `resolved` agora PODE ser literalmente "C:\Windows\System32"
    // (path.normalize do candidato 1) — o que importa é que `error` vem preenchido, e é ISSO
    // que os callers (read_tool, write_tool) checam antes de tocar o disco. Antes, um path
    // absoluto com drive letter também gerava um 2º candidato via `expanded.slice(1)` (pensado
    // pra paths Unix tipo /etc/passwd) que cortava a letra do drive, virando algo como
    // "workspace\:\Windows\System32" — um candidato ausurdo mas que por acidente caía DENTRO
    // do workspace e passava no checkAllowed, fazendo esse teste antigo passar por engano
    // mesmo com o bug de escape de sandbox presente (ver CorrectionsBugsJul2026B #5). O fix
    // parou de gerar esse candidato para paths com drive letter — então agora não sobra
    // nenhum candidato "seguro", e a função corretamente devolve error. A invariante real é
    // "resolved dentro de um root permitido OU error setado", igual ao bloco de baixo.
    const { resolved, error } = resolvePath('C:\\Windows\\System32');
    const isOutsideSandbox = !resolved.startsWith(workspaceDir) &&
        !resolved.startsWith(os.tmpdir()) &&
        !resolved.startsWith(os.homedir()) &&
        !error;
    assert(
        !isOutsideSandbox,
        `C:\\Windows\\System32 não deve escapar do sandbox sem error (resolveu para: ${resolved}, error: ${error ?? '(nenhum)'})`,
    );
}

{
    // Path sem /workspace/ que não existe → Phase 2 → candidate 2 (workspace-relativo)
    // Nunca deve apontar para fora do workspace sem error
    const { resolved, error } = resolvePath('/home/user-vps/.ssh/id_rsa');
    const isOutsideWorkspace = !resolved.startsWith(workspaceDir) &&
        !resolved.startsWith(os.tmpdir()) &&
        !resolved.startsWith(os.homedir()) &&
        !error;
    // Se está dentro do workspace (como nested path), é seguro (sandbox)
    // Se retornou error, também é correto
    assert(
        !isOutsideWorkspace,
        `/home/user-vps/.ssh/id_rsa não deve escapar do sandbox sem error (resolveu para: ${resolved})`,
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// Bloco 5 — INVARIANTE CENTRAL
//
// Todo path retornado sem error deve estar dentro de workspaceDir,
// tmpdir, homeDir, logs ou data. Nunca um path arbitrário do sistema.
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n=== Bloco 5 — Invariante: resultado sempre dentro de roots permitidos ===');

const allowedPrefixes = [
    workspaceDir,
    os.tmpdir(),
    os.homedir(),
    path.join(process.cwd(), 'logs'),
    path.join(process.cwd(), 'data'),
];

const probeInputs = [
    'slides.md',
    'subdir/arquivo.md',
    '/home/user-vps/newclaw/workspace/doc.pdf',
    '/Users/user-vps/NewClaw/workspace/doc.pdf',
    '/workspace/doc.pdf',
    path.join(workspaceDir, 'existente.md'),
];

for (const input of probeInputs) {
    const { resolved, error } = resolvePath(input);
    if (error) {
        assert(true, `"${input}" → rejeitado com error (dentro do esperado)`);
        continue;
    }
    const normalizedResolved = path.normalize(resolved);
    const withinAllowed = allowedPrefixes.some(prefix =>
        normalizedResolved === path.normalize(prefix) ||
        normalizedResolved.startsWith(path.normalize(prefix) + path.sep)
    );
    assert(
        withinAllowed,
        `"${input}" → resolvido para root permitido (${resolved})`,
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// Resultado
// ─────────────────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(60)}`);
console.log(`CrossPlatform_ResolvePath RESULTADO:`);
console.log(`  ✅ Passou: ${passed}`);
console.log(`  ❌ Falhou: ${failed}`);

if (failed > 0) {
    console.error('\n⛔ REGRESSÃO DETECTADA — revisar antes de fazer deploy.');
    process.exit(1);
} else {
    console.log('\n✅ Todos os testes passaram — sem regressão.');
    process.exit(0);
}
