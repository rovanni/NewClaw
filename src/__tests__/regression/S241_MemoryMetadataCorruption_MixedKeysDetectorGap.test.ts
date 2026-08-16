/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S241
 * Lacuna real no detector `isCharacterDecomposedMetadata()` (a mesma função que S238 corrigiu):
 * um objeto decomposto em caracteres que depois ganhou chaves literais (via spread em
 * `MemoryGovernor.archiveNode()`) escapava da detecção — a checagem exigia que TODAS as chaves
 * fossem sequenciais, e a presença de chaves não-numéricas ao final bastava para o objeto passar
 * como "válido".
 *
 * INCIDENTE REAL (16/08/2026, banco de produção local, descoberto ao verificar se o deploy do
 * S238 tinha resolvido a corrupção do banco): 23 nós com
 * `metadata` de exatamente 1030 chars, todos no formato
 * `{"0":"{","1":"\"",...,"103":"}","archived":"true","archived_at":"<timestamp fresco>","original_type":"context"}`.
 * O prefixo "0".."103" decodifica para uma metadata antiga já corrompida
 * (`{"archived":"true","archived_at":"...","original_type":"context","_truncated":true}`) —
 * evidência de que o nó já tinha sido arquivado uma vez, seu metadata virou string, e
 * `archiveNode()` fez `{...umaString}` (decompondo-a) — mas como código JS sempre enumera chaves
 * inteiras primeiro em ordem numérica, `Object.keys()` desse objeto MISTO ainda devolve
 * "0","1",...,"103" antes de "archived"/"archived_at"/"original_type", e a checagem antiga
 * (`keys.every((k,i) => k === String(i))`) falhava no primeiro k não-numérico — condenando a
 * detecção inteira. `repairCorruptedNodeMetadata()` (chamada em TODO boot via `ensureMemorySchema`)
 * rodou normalmente mas não pegou esses 23 nós porque usa o mesmo detector. Resultado: cada ciclo
 * de `MemoryGovernor.archiveNode()` (dispara a cada boot e por decaimento de confiança) só
 * reempilhava a mesma sujeira com timestamp novo — não cresce (não é uma segunda decomposição),
 * mas nunca se autocorrige.
 *
 * CORREÇÃO: `isCharacterDecomposedMetadata()` (memoryTypes.ts) agora também condena qualquer
 * objeto que tenha AMBAS as chaves "0" e "1" — independente de outras chaves legítimas
 * coexistirem. Metadata legítimo desta aplicação nunca usa chaves puramente numéricas, então essa
 * verificação continua sendo estrutural (forma das chaves), não interpretação semântica de
 * conteúdo — mesma natureza de checagem que S238 já usava, só que sem a exigência de que TODAS as
 * chaves fossem numéricas.
 *
 * Execução: npx ts-node src/__tests__/regression/S241_MemoryMetadataCorruption_MixedKeysDetectorGap.test.ts
 */

import { isCharacterDecomposedMetadata, parseNodeMetadata } from '../../memory/memoryTypes';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

console.log('\n=== S241-1 — reprodução exata do nó real (fact_1776994400316, 16/08/2026) ===');
{
    // Prefixo "0".."103" (a antiga metadata corrompida decomposta) + as 3 chaves literais que
    // MemoryGovernor.archiveNode() acrescenta a cada re-arquivamento.
    const numericPrefix: Record<string, string> = {};
    const oldCorruptedJson = '{"archived":"true","archived_at":"2026-08-15T15:05:51.173Z","original_type":"context","_truncated":true}';
    for (let i = 0; i < oldCorruptedJson.length; i++) numericPrefix[String(i)] = oldCorruptedJson[i];

    const mixed = {
        ...numericPrefix,
        archived: 'true',
        archived_at: '2026-08-16T00:04:33.064Z',
        original_type: 'context',
    };

    assert(isCharacterDecomposedMetadata(mixed), 'objeto misto (prefixo numérico + chaves literais anexadas depois) é detectado como corrompido', Object.keys(mixed).length);

    const asRaw = JSON.stringify(mixed);
    const result = parseNodeMetadata(asRaw, 'fact_1776994400316');
    assert(Object.keys(result).length === 0, 'parseNodeMetadata descarta o objeto misto para {} em vez de propagá-lo', result);
}

console.log('\n=== S241-2 — não regride: casos que S238 já cobria continuam cobertos ===');
{
    assert(isCharacterDecomposedMetadata({ '0': 'a', '1': 'b', '2': 'c' }), 'decomposição pura (sem chaves extras) continua detectada');
    assert(isCharacterDecomposedMetadata({ '0': 'a', '1': 'b', _truncated: true }), 'decomposição pura + _truncated continua detectada');
    assert(!isCharacterDecomposedMetadata({ archived: 'true', archived_at: 'x', original_type: 'context' }), 'metadata legítimo de arquivamento (sem chaves numéricas) NÃO é falso-positivo');
    assert(!isCharacterDecomposedMetadata({}), 'objeto vazio não é corrompido');
    assert(!isCharacterDecomposedMetadata({ invalid: 1, reason: 'unstructured_identity' }), 'metadata legítimo arbitrário (core_identity real) NÃO é falso-positivo');
}

console.log('\n=== S241-3 — comportamento pré-existente do S238 preservado: chave "0" isolada continua corrompida ===');
{
    // Não é um caso novo introduzido por este fix — `{'0': x}` já era pego pela checagem original
    // ("toda chave é sequencial", e um objeto de uma chave só passa trivialmente nesse teste).
    // Registrado aqui só para deixar explícito que o novo atalho (checar "0" e "1") não muda o
    // resultado para este caso — ele nunca chega a ser avaliado, o fallback original já resolve.
    assert(isCharacterDecomposedMetadata({ '0': 'x' }), 'chave "0" isolada continua tratada como corrompida (comportamento inalterado do S238)');
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S241 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exit(1);
process.exit(0);
