/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S212
 * Sondagem que não conseguiu verificar não vira "não existe" nem resposta positiva errada
 * (`ADR-008`, Sprint 034).
 *
 * CONTEXTO: `which()` devolvia `null` para qualquer falha — timeout, spawn, permissão — e
 * `commandExists()` traduzia isso para "o comando não existe". Medido em 07/08/2026: com a máquina
 * ociosa, 400 sondagens sem falha; sob CPU saturada, 5 em 150 (3,3%), todas por timeout.
 *
 * O consumidor mais crítico era a detecção de gerenciador de pacotes: `else if` encadeados sobre
 * sondagens que podem falhar. Numa máquina Debian cuja sondagem de `apt-get` falhasse, a cadeia
 * continuava e podia responder `yum` — e esse valor não executa nada, ele entra no bloco
 * `[CAPACIDADES DO AMBIENTE]` entregue ao LLM. Um fato falso apresentado à camada de julgamento
 * como se tivesse sido verificado é o que `NUNCA_ADIVINHAR.md` §1 existe para impedir.
 *
 * REGRESSÃO SE: uma sondagem indeterminada voltar a ser classificada como ausente; a cadeia de
 * gerenciador voltar a seguir para o próximo candidato após uma indeterminação; ou a classificação
 * passar a depender de convenção de código de saída específica de um SO — a medição cobriu só
 * Windows, e `ADR-008` §9 proíbe estender isso a Linux/macOS por analogia.
 *
 * Execução: npx ts-node src/__tests__/regression/S212_ProbeIndeterminate_NoWrongPositive.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { probeCommand, which, commandExists } from '../../utils/crossPlatform';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

const EXISTENTE = process.platform === 'win32' ? 'where.exe' : 'sh';

console.log('\n=== S212-1 — os três estados existem e se distinguem ===');
{
    const achado = probeCommand(EXISTENTE);
    assert(achado.kind === 'found', `comando existente → found (${EXISTENTE})`, achado);
    assert(achado.kind === 'found' && achado.path.length > 0, 'e devolve o caminho', achado);

    const ausente = probeCommand('__nao_existe_s212__');
    assert(ausente.kind === 'absent',
        'comando inexistente → absent (o sondador rodou e respondeu)', ausente);
}

console.log('\n=== S212-2 — falha da sondagem é indeterminação, nunca ausência ===');
{
    // PATH vazio: o próprio sondador (where.exe/which) fica inalcançável. Reproduz ENOENT de forma
    // determinística, sem depender de saturação real — cenário identificado na medição.
    const pathOriginal = process.env.PATH;
    try {
        process.env.PATH = '';
        const r = probeCommand(EXISTENTE);
        assert(r.kind === 'indeterminate',
            'sondador inalcançável → indeterminate, NÃO absent — a diferença entre não achar e não poder olhar',
            r);
        assert(r.kind === 'indeterminate' && r.cause.length > 0, 'e a causa é preservada', r);
    } finally {
        process.env.PATH = pathOriginal;
    }
}

console.log('\n=== S212-3 — o colapso para booleano continua existindo, agora declarado ===');
{
    assert(which(EXISTENTE) !== null, 'which() segue devolvendo caminho para comando existente');
    assert(which('__nao_existe_s212__') === null, 'e null para inexistente — comportamento inalterado');
    assert(commandExists(EXISTENTE) === true, 'commandExists() inalterado para quem já o usava');

    const SRC = fs.readFileSync(path.join(process.cwd(), 'src', 'utils', 'crossPlatform.ts'), 'utf-8');
    const corpo = SRC.slice(SRC.indexOf('export function which'), SRC.indexOf('export function commandExists'));
    assert(!/catch\s*\{\s*return null;?\s*\}/.test(corpo),
        'which() não engole mais a causa num catch cego', corpo);
}

console.log('\n=== S212-4 — a classificação não depende de convenção de SO ===');
{
    const SRC = fs.readFileSync(path.join(process.cwd(), 'src', 'utils', 'crossPlatform.ts'), 'utf-8');
    const corpo = SRC.slice(SRC.indexOf('export function probeCommand'), SRC.indexOf('export function which'));
    assert(/typeof e\.status === 'number'/.test(corpo),
        'ausência é decidida por "o processo respondeu" (status numérico), não por um código específico',
        corpo);
    assert(!/status === 1\b/.test(corpo),
        'nenhum código de saída literal — seria assumir convenção de um SO (ADR-008 §9)');
}

console.log('\n=== S212-5 — a cadeia de gerenciador para na indeterminação ===');
{
    const SRC = fs.readFileSync(path.join(process.cwd(), 'src', 'core', 'CapabilityRegistry.ts'), 'utf-8');

    assert(!/else if \(which\(/.test(SRC),
        'os `else if` encadeados sobre which() não existem mais — eram eles que produziam o positivo errado',
        SRC.match(/else if \(which\([^)]*\)/g));
    assert(!/runSafe\('choco --version'[^)]*\) \? 'choco'/.test(SRC),
        'a mesma cadeia no ramo Windows também saiu — mesmo defeito, outra primitiva');

    const detector = SRC.slice(SRC.indexOf('function detectarGerenciador'), SRC.indexOf('function makeStatus'));
    assert(/kind === 'indeterminate'/.test(detector) && /return undefined/.test(detector),
        'indeterminação devolve undefined em vez de tentar o próximo candidato', detector);
    assert(/kind === 'found'/.test(detector) && /return gerenciador/.test(detector),
        'e uma detecção positiva continua respondendo normalmente', detector);

    const usos = (SRC.match(/detectarGerenciador\(/g) || []).length;
    assert(usos >= 3, 'os dois ramos (Windows e Linux) usam o mesmo detector — ponto único', usos);
}

console.log(`\nS212 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
console.log(`\nCOBERTURA:`);
console.log(`  Três estados distinguíveis: testado`);
console.log(`  Falha de sondagem → indeterminate, não absent: testado`);
console.log(`  Colapso booleano preservado para quem já o usava: testado`);
console.log(`  Classificação sem convenção de SO: testado`);
console.log(`  Cadeia de gerenciador para na indeterminação (Windows e Linux): testado`);
if (failed > 0) process.exit(1);
