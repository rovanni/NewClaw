/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S41 (regressão LOCAL do workspace, não versionada — ver política
 * reafirmada pelo mantenedor sobre src/__tests__/)
 *
 * Achado durante auditoria de reprodutibilidade (mesma classe de bug do S39/S40, mas na
 * BORDA FINAL desta vez, não na inicial): duas regexes independentes em
 * src/tools/memory_write.ts (isFamilyOrSocialContent e inferFamilyRelation) tinham "\b" final
 * logo depois de "irmã" — como "ã" não é \w em JS, a transição \w<->\W exigida pelo "\b" nunca
 * ocorre quando "irmã" é seguida de espaço/pontuação/fim de string (o caso comum). Reproduzido:
 *
 *   isFamilyOrSocialContent('', 'minha irmã mora em Londrina') → false (esperado: true)
 *   inferFamilyRelation('minha irmã mora em Londrina')         → 'has_relation' (esperado: 'has_family')
 *
 * Pior: o mesmo defeito fazia "irmã" casar (incorretamente) como PREFIXO de "irmãs"/
 * "irmãozinho", porque a letra seguinte (caractere de palavra) criava uma falsa transição
 * \W->\w que o "\b" também aceita como boundary válido — um falso-positivo estrutural
 * coincidente com o falso-negativo do caso comum.
 *
 * Impacto real (Nível 3, reconstruído do código): isFamilyOrSocialContent(name,content)==false
 * pula o bloco em memory_write.ts:230-237 inteiro, que existe especificamente para "garantir
 * conexão direta ao USER node (Degree > 0) independente da confiança do domínio" (comentário
 * original do código). Um fato como "minha irmã mora em Londrina" podia ficar sem essa conexão
 * garantida. Mesmo se isFamilyOrSocialContent fosse corrigida sozinha, inferFamilyRelation
 * (chamada em seguida, linha 234) tem o MESMO bug em sua própria regex (branch 3, has_family) —
 * corrigindo só uma function o edge seria criado, mas com relação genérica 'has_relation' em
 * vez de 'has_family'. Por isso as duas foram corrigidas na mesma rodada.
 *
 * Testada a hipótese de flag "u" — não resolve (mesma conclusão do S39/S40: \w continua
 * ASCII-only independente da flag).
 *
 * Correção: "\b" final trocado por "(?!\w)" nas duas regexes (apenas na alternativa/grupo que
 * continha "irmã" — as demais 20+ alternativas do léxico, todas terminadas em ASCII, não
 * precisavam de ajuste e não mudam de comportamento). "\b" inicial mantido (sem bug —
 * "irmã" começa com "i", ASCII).
 *
 * Achado fora de escopo, NÃO corrigido aqui: "família" (com acento em í) está no léxico de
 * inferFamilyRelation mas NÃO está no léxico de isFamilyOrSocialContent (que só tem "familia"
 * sem acento e "familiar") — uma lacuna de vocabulário, não um bug de boundary. Como
 * isFamilyOrSocialContent(false) impede que inferFamilyRelation seja chamada (memory_write.ts
 * linha 230), um fato contendo só "família" nunca aciona o bloco de conexão direta ao USER.
 * Não corrigido: expandir léxico está fora do escopo desta rodada (só \b+acento em "irmã").
 *
 * ATUALIZAÇÃO (auditoria lexical pós-patch): "irmãs"/"irmãos" — antes do fix acima, casavam
 * (corretamente em resultado, mas por MECANISMO ACIDENTAL) como prefixo de 4 caracteres de
 * "irmã"/"irmão" seguido de "s" (mesmo bug de boundary). Corrigir o boundary fechou esse
 * acidente e criou uma REGRESSÃO FUNCIONAL real: "minhas irmãs moram em Londrina" passou a
 * retornar false/has_relation, apesar de ser conteúdo familiar inequívoco. Confirmado por
 * comparação empírica pré-patch (worktree em 5571ddb^) vs. pós-patch (HEAD). Diferente de
 * "irmãozinho"/"irmãzinha" (diminutivos, sem precedente de suporte deliberado no léxico e
 * sem evidência de contrato implícito equivalente — não adicionados, permanecem false).
 * Evidência de contrato implícito para plural: o léxico já cobre "filho|filha|filhos|filhas"
 * (singular E plural deliberados) — "irmão/irmã" nunca teve o plural correspondente, uma
 * assimetria pré-existente exposta (não causada) pelo fix do "\b". Corrigido adicionando
 * "irmaos|irmas|irmãos|irmãs" como alternativas completas (não stems) nas duas regexes,
 * seguindo esse mesmo padrão já estabelecido — não é expansão de vocabulário nova, é
 * correção de regressão + de uma lacuna já revelada pela mesma auditoria.
 * "namorad"/"casad" (stems truncados que nunca casam formas naturais como "namorado"/"casada")
 * e a assimetria "casado" (no léxico) vs. "casada" (ausente) são achados INDEPENDENTES,
 * pré-existentes e NÃO alterados por este commit nem pelo anterior (confirmado idênticos
 * pré/pós-patch) — classe de bug diferente (stem incompleto, não \b+acento), documentados
 * mas não corrigidos nesta rodada.
 *
 * Execução: npx ts-node src/__tests__/regression/S41_MemoryWrite_AccentedFamilyRelation.test.ts
 */

process.env.WORKSPACE_DIR = process.env.WORKSPACE_DIR || 'D:/IA/newclaw/workspace';

import { MemoryWriteTool } from '../../tools/memory_write';
import type { MemoryManager } from '../../memory/MemoryManager';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

// Mock mínimo: isFamilyOrSocialContent/inferFamilyRelation não tocam memoryManager/facade
// em nenhum ponto — só o necessário para o construtor de MemoryWriteTool não lançar erro.
const fakeMemoryManager = { getFacade: () => ({}) } as unknown as MemoryManager;
const tool = new MemoryWriteTool(fakeMemoryManager) as unknown as {
    isFamilyOrSocialContent(name: string, content: string): boolean;
    inferFamilyRelation(content: string): string;
};

async function main(): Promise<void> {

// ── 1: texto exato do achado — "irmã" (acentuada) agora é reconhecida ──

console.log('\n=== S41-1 — "irmã" acentuada agora ativa isFamilyOrSocialContent e inferFamilyRelation ===');
{
    assert(tool.isFamilyOrSocialContent('', 'minha irmã mora em Londrina'), 'isFamilyOrSocialContent reconhece "minha irmã mora em Londrina"');
    assert(tool.inferFamilyRelation('minha irmã mora em Londrina') === 'has_family', 'inferFamilyRelation retorna has_family para "minha irmã mora em Londrina"', tool.inferFamilyRelation('minha irmã mora em Londrina'));
}

// ── 2: demais termos do léxico, acentuados e não-acentuados — sem regressão ──

console.log('\n=== S41-2 — outros termos do léxico continuam OK (sem regressão) ===');
{
    const positives = ['irma', 'irmão', 'mãe', 'mae', 'pai', 'familia', 'filhas', 'esposa', 'cônjuge'];
    for (const t of positives) {
        assert(tool.isFamilyOrSocialContent('', t), `isFamilyOrSocialContent reconhece "${t}"`);
    }
}

// ── 3: pontuação e posição ──

console.log('\n=== S41-3 — "irmã" em diferentes posições/pontuações/capitalização ===');
{
    const variants = ['irmã', 'irmã.', 'irmã,', '(irmã)', '"irmã"', 'minha irmã'];
    for (const v of variants) {
        assert(tool.isFamilyOrSocialContent('', v), `isFamilyOrSocialContent reconhece "${v}"`);
        assert(tool.inferFamilyRelation(v) === 'has_family', `inferFamilyRelation retorna has_family para "${v}"`, tool.inferFamilyRelation(v));
    }
}

// ── 4: negativos — nenhuma substring acidental (correção não pode virar match arbitrário) ──

console.log('\n=== S41-4 — negativos: substrings parecidas NÃO devem casar (sem falso positivo) ===');
{
    const negatives = ['irmandade', 'firma', 'afirma'];
    for (const n of negatives) {
        assert(!tool.isFamilyOrSocialContent('', n), `isFamilyOrSocialContent NÃO reconhece "${n}" (substring, não é o termo)`);
    }
}

// ── 5: plural de "irmão"/"irmã" — regressão encontrada e corrigida (agora como alternativa
//      completa no léxico, não como prefixo acidental) ──

console.log('\n=== S41-5 — "irmãs"/"irmãos" reconhecidos como forma própria do léxico (regressão corrigida) ===');
{
    for (const t of ['irmãs', 'irmãos', 'irmas', 'irmaos']) {
        assert(tool.isFamilyOrSocialContent('', t), `isFamilyOrSocialContent reconhece "${t}" (plural, agora no léxico)`);
        assert(tool.inferFamilyRelation(t) === 'has_family', `inferFamilyRelation retorna has_family para "${t}"`, tool.inferFamilyRelation(t));
    }
    assert(tool.isFamilyOrSocialContent('', 'minhas irmãs moram em Londrina'), 'isFamilyOrSocialContent reconhece "minhas irmãs moram em Londrina"');
    assert(tool.isFamilyOrSocialContent('', 'meus irmãos moram em Londrina'), 'isFamilyOrSocialContent reconhece "meus irmãos moram em Londrina"');
}

// ── 6: diminutivos ("irmãozinho"/"irmãzinha") permanecem NÃO reconhecidos — categoria
//      morfológica diferente de plural simples, sem precedente de suporte deliberado no
//      léxico; não adicionados nesta rodada (decisão de política, não bug) ──

console.log('\n=== S41-6 — diminutivos NÃO reconhecidos (não é regressão — nunca houve contrato para isso) ===');
{
    assert(!tool.isFamilyOrSocialContent('', 'irmãozinho'), '"irmãozinho" (diminutivo) não é reconhecido — sem precedente no léxico');
    assert(!tool.isFamilyOrSocialContent('', 'irmãzinha'), '"irmãzinha" (diminutivo) não é reconhecido — sem precedente no léxico');
}

// ── 7: negativos continuam protegidos após adicionar os plurais (sem nova brecha de substring) ──

console.log('\n=== S41-7 — negativos continuam protegidos após adicionar plurais ===');
{
    const negatives = ['irmandade', 'firma', 'afirma'];
    for (const n of negatives) {
        assert(!tool.isFamilyOrSocialContent('', n), `isFamilyOrSocialContent NÃO reconhece "${n}" (substring, não é o termo)`);
    }
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S41 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;

}

main().catch((err) => {
    console.error('S41 erro inesperado:', err);
    process.exitCode = 1;
});
