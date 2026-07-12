/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S9
 * GoalExecutionLoop.checkDeliverables: scan nativo Node.js com caminhos absolutos
 *
 * PROBLEMA CORRIGIDO: checkDeliverables usava exec_command + find, que:
 *   (a) exec_command pode estar indisponível no ambiente
 *   (b) find retorna caminhos RELATIVOS ao CWD do shell (ex: ./workspace/slides.html)
 *   (c) Node.js tem CWD diferente do shell → fs.statSync('./workspace/slides.html') = ENOENT
 *   (d) todos os arquivos apareciam como "< 200B placeholders" mesmo tendo 8KB+
 *
 * FIX: fs.readdirSync recursivo a partir de WORKSPACE_DIR (caminho absoluto),
 *      retorna caminhos absolutos via path.join(dir, entry.name).
 *
 * REGRESSÃO SE: código voltar a usar exec_command/find ou retornar paths relativos.
 *
 * Execução: npx ts-node src/__tests__/regression/S9_CheckDeliverables_NativeScan.test.ts
 */

import * as fs   from 'fs';
import * as path from 'path';
import * as os   from 'os';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`); failed++; }
}

// ── Teste 1: Inspeção do source — sem exec_command em checkDeliverables ─────

console.log('\n=== S9 — Inspeção do source: checkDeliverables sem exec_command ===');

const loopPath = path.join(process.cwd(), 'src', 'loop', 'GoalExecutionLoop.ts');
const loopSource = fs.readFileSync(loopPath, 'utf-8');

// Extrai apenas a função checkDeliverables para análise isolada
const fnMatch = loopSource.match(/private async checkDeliverables[\s\S]*?(?=\n    private |\n    public )/);
assert(!!fnMatch, 'Função checkDeliverables encontrada no source');

if (fnMatch) {
    const fn = fnMatch[0];

    // Usa fs.readdirSync (não exec_command)
    assert(
        /fs\.readdirSync/.test(fn),
        'checkDeliverables usa fs.readdirSync (scan nativo Node.js)'
    );

    // NÃO usa exec_command como chamada de ferramenta (comentários são permitidos — explicam o porquê)
    // Remove linhas de comentário antes de verificar chamadas executáveis
    const fnNoComments = fn.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
    assert(
        !/toolName.*exec_command|spawnSync|execSync|child_process/.test(fnNoComments),
        'checkDeliverables NÃO invoca exec_command/spawnSync/execSync como tool (sem chamadas executáveis)'
    );

    // Usa path.join para construir caminhos absolutos
    assert(
        /path\.join\(dir,\s*entry\.name\)/.test(fn),
        'Caminhos construídos com path.join(dir, entry.name) — sempre absolutos'
    );

    // Usa WORKSPACE_DIR como base (absoluta)
    assert(
        /WORKSPACE_DIR/.test(fn),
        'Usa process.env.WORKSPACE_DIR como diretório base'
    );

    // Itera com withFileTypes para distinguir diretórios de arquivos
    assert(
        /withFileTypes:\s*true/.test(fn),
        'readdirSync usa { withFileTypes: true } para identificar diretórios'
    );

    // entry.isDirectory() para recursão
    assert(
        /entry\.isDirectory\(\)/.test(fn),
        'entry.isDirectory() para recursão controlada'
    );

    // Limita recursão (depth <= 4)
    assert(
        /depth\s*[><=]+\s*4/.test(fn),
        'Recursão limitada por profundidade máxima (depth > 4)'
    );

    // Limita quantidade de resultados
    assert(
        /found\.length\s*>=?\s*5/.test(fn),
        'Scan limitado a no máximo 5 arquivos (found.length >= 5)'
    );

    // fs.statSync para verificar mtime — usando o fullPath absoluto
    assert(
        /fs\.statSync\(fullPath\)\.mtimeMs/.test(fn),
        'fs.statSync(fullPath).mtimeMs para filtrar por data — fullPath é absoluto'
    );
}

// ── Teste 2: Comportamento da lógica de scan com arquivos reais ─────────────

console.log('\n=== S9 — Scan real em diretório temporário ===');

// Réplica da lógica de checkDeliverables para teste isolado
function checkDeliverablesScan(
    workspaceDir: string,
    extensions: string[],
    goalCreatedAt: number
): string[] {
    const cutoff = goalCreatedAt - 60_000;
    const found: string[] = [];

    const scan = (dir: string, depth: number) => {
        if (depth > 4 || found.length >= 5) return;
        try {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                if (found.length >= 5) break;
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    scan(fullPath, depth + 1);
                } else if (extensions.some(ext => entry.name.endsWith(ext))) {
                    try {
                        if (fs.statSync(fullPath).mtimeMs >= cutoff) {
                            found.push(fullPath);
                        }
                    } catch { /* arquivo desapareceu */ }
                }
            }
        } catch { /* diretório inacessível */ }
    };

    scan(workspaceDir, 0);
    return found;
}

// Cria diretório temporário com arquivos de teste
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'newclaw-s9-test-'));
const subDir = path.join(tmpDir, 'workspace', 'slides');

try {
    fs.mkdirSync(subDir, { recursive: true });

    const testFiles = [
        path.join(tmpDir, 'workspace', 'aula_scrum.html'),
        path.join(subDir,              'slides_parte1.html'),
        path.join(tmpDir, 'workspace', 'README.txt'),      // extensão .txt — não deve ser encontrado
        path.join(tmpDir, 'workspace', 'outro.html'),
    ];

    const now = Date.now();
    for (const f of testFiles) {
        fs.writeFileSync(f, `<html>conteúdo de ${path.basename(f)}</html>`);
    }

    // Testa o scan
    const found = checkDeliverablesScan(path.join(tmpDir, 'workspace'), ['.html'], now - 1000);

    console.log(`  → Arquivos encontrados: ${found.length}`);
    found.forEach(f => console.log(`    ${f}`));

    // Verifica que todos os caminhos são ABSOLUTOS
    assert(
        found.every(f => path.isAbsolute(f)),
        `Todos os ${found.length} caminhos retornados são absolutos`
    );

    // Verifica que arquivos .txt não aparecem
    assert(
        found.every(f => f.endsWith('.html')),
        'Apenas arquivos .html retornados (README.txt excluído)'
    );

    // Verifica que encontrou os arquivos HTML criados
    assert(
        found.length === 3,
        `3 arquivos .html encontrados — nos subdiretórios inclusive (obtido: ${found.length})`
    );

    // Verifica que path.basename dos resultados batem com os criados
    const basenames = found.map(f => path.basename(f)).sort();
    assert(
        basenames.includes('aula_scrum.html'),
        'aula_scrum.html encontrado'
    );
    assert(
        basenames.includes('outro.html'),
        'outro.html encontrado'
    );
    assert(
        basenames.includes('slides_parte1.html'),
        'slides_parte1.html encontrado (subdiretório workspace/slides)'
    );

    // ── Teste 3: Filtro por mtime exclui arquivos antigos ───────────────────

    console.log('\n=== S9 — Filtro de mtime exclui arquivos pré-existentes ===');

    // Arquivo criado "no futuro" do cutoff — deve aparecer
    const futureFile = path.join(tmpDir, 'workspace', 'novo_apos_goal.html');
    fs.writeFileSync(futureFile, '<html>novo</html>');

    // goalCreatedAt muito no futuro — todos os arquivos existentes ficam antes do cutoff
    const farFuture = Date.now() + 10_000_000; // 10s no futuro
    const foundFuture = checkDeliverablesScan(path.join(tmpDir, 'workspace'), ['.html'], farFuture);

    assert(
        foundFuture.length === 0,
        `Cutoff no futuro: 0 arquivos encontrados (todos pré-existentes) — obtido: ${foundFuture.length}`
    );

} finally {
    // Limpeza
    fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ── Resultado ────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(60)}`);
console.log(`S9 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
console.log(`\nCOBERTURA:`);
console.log(`  Sem exec_command no source: testado`);
console.log(`  fs.readdirSync com withFileTypes: testado`);
console.log(`  Caminhos absolutos (path.isAbsolute): testado`);
console.log(`  Scan recursivo em subdiretórios: testado`);
console.log(`  Filtro por extensão: testado`);
console.log(`  Filtro por mtime (cutoff): testado`);
if (failed > 0) process.exit(1);
