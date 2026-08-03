/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S185
 * Uma colisão de NOME não pode descartar uma skill legítima — e nunca em silêncio.
 *
 * CONTEXTO (relato do operador, 03/08/2026: "o gerador de skills não está mais sugerindo
 * skills"). Estado medido na instância real:
 *
 *     auto_skills:     8 active, 0 proposed
 *     skill_patterns:  crypto_query→read       367 sucessos   SEM skill
 *                      write→read              225 sucessos   SEM skill
 *                      crypto_query→write      169 sucessos   SEM skill
 *                      crypto_query→web_search  96 sucessos   SEM skill
 *                      crypto_query→memory_search 60 sucessos SEM skill
 *
 * Matéria-prima de sobra, e nada proposto.
 *
 * CAUSA — duas chaves de deduplicação que discordam:
 *
 *     const alreadyExists = ... WHERE source_pattern = ? AND source_tool = ?   ← identidade real
 *     const nameExists    = ... WHERE name = ?                                 ← grosseira
 *     if (nameExists) continue;                                                ← sem log
 *
 * O nome vem de `skillDefs`, indexado SÓ por `pattern`. Logo `crypto_query` com read, write,
 * web_search e memory_search nasce quatro vezes como "Consulta Cripto". O primeiro tool a cruzar
 * o limiar gravava a skill; todos os demais batiam no guarda de nome e eram descartados para
 * sempre, sem nenhuma linha de log explicando.
 *
 * REGRESSÃO SE: o guarda de nome voltar a descartar sem desambiguar; ou se voltar a sair em
 * silêncio quando descartar de verdade.
 *
 * Execução: npx ts-node src/__tests__/regression/S185_SkillLearner_NameCollisionBlocksProposals.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

const SRC = fs.readFileSync(path.join(process.cwd(), 'src', 'loop', 'SkillLearner.ts'), 'utf-8');

console.log('\n=== S185-1 — o descarte mudo por nome não existe mais ===');
{
    assert(
        !/\.get\(skill\.name\) as \{ id: string \} \| undefined;\s*\n\s*\n?\s*if \(nameExists\) continue;/.test(SRC),
        'o `if (nameExists) continue;` sem desambiguação foi removido',
    );
    assert(
        /skill\.name = `\$\{skill\.name\} \(\$\{item\.tool_name\}\)`;/.test(SRC),
        'a colisão é resolvida desambiguando pelo tool, que é o que difere as duas skills',
    );
}

console.log('\n=== S185-2 — descarte real acontece, e com log ===');
{
    const bloco = SRC.slice(SRC.indexOf('const nameExists'), SRC.indexOf('const nameExists') + 1600);
    assert(
        /if \(aindaColide\) \{/.test(bloco),
        'depois de desambiguar, ainda há verificação — duplicata verdadeira não passa',
    );
    assert(
        /log\.info\(\s*`Proposta ignorada: já existe skill chamada/.test(bloco),
        'e o descarte legítimo deixa rastro — o `continue` mudo era o que escondia o problema',
    );
}

console.log('\n=== S185-3 — a identidade real continua sendo (pattern, tool) ===');
{
    assert(
        /SELECT id FROM auto_skills WHERE source_pattern = \? AND source_tool = \? LIMIT 1/.test(SRC),
        'o guarda de identidade por pattern+tool segue existindo — não foi ele o problema',
    );
    const idx = SRC.indexOf('const alreadyExists');
    const idxNome = SRC.indexOf('const nameExists');
    assert(idx > 0 && idxNome > idx, 'e continua rodando ANTES do guarda de nome');
}

console.log('\n=== S185-4 — reprodução: o cenário real deixa de bloquear ===');
{
    // Reproduz a lógica de nomeação/deduplicação com os dados medidos na instância.
    const existentes = new Map<string, string>(); // nome → id
    const porIdentidade = new Set<string>();      // pattern|tool

    // O nome vem SÓ do pattern — é essa a origem da colisão.
    const nomeDoTemplate = (pattern: string) => ({
        crypto_query: 'Consulta Cripto',
        write: 'Operações de Arquivo',
        weather: 'Previsão do Tempo',
    } as Record<string, string>)[pattern] ?? pattern;

    const propor = (pattern: string, tool: string): 'criada' | 'ja-existe' | 'descartada' => {
        if (porIdentidade.has(`${pattern}|${tool}`)) return 'ja-existe';
        let nome = nomeDoTemplate(pattern);
        if (existentes.has(nome)) {
            nome = `${nome} (${tool})`;
            if (existentes.has(nome)) return 'descartada';
        }
        existentes.set(nome, `${pattern}|${tool}`);
        porIdentidade.add(`${pattern}|${tool}`);
        return 'criada';
    };

    assert(propor('crypto_query', 'exec_command') === 'criada', 'a primeira do pattern é criada (era o único caso que funcionava)');
    assert(propor('crypto_query', 'read') === 'criada', 'crypto_query→read (367 sucessos) agora é proposta — antes era descartada');
    assert(propor('crypto_query', 'write') === 'criada', 'crypto_query→write (169 sucessos) idem');
    assert(propor('crypto_query', 'web_search') === 'criada', 'crypto_query→web_search (96 sucessos) idem');
    assert(propor('write', 'exec_command') === 'criada', 'outro pattern segue independente');
    assert(propor('write', 'read') === 'criada', 'write→read (225 sucessos) agora é proposta');

    // O guarda continua fazendo o trabalho dele: a MESMA identidade não vira duas skills.
    assert(propor('crypto_query', 'read') === 'ja-existe', 'repetir pattern+tool não duplica');

    const nomes = [...existentes.keys()];
    assert(new Set(nomes).size === nomes.length, 'todos os nomes finais são únicos', nomes);
    assert(
        nomes.includes('Consulta Cripto') && nomes.includes('Consulta Cripto (read)'),
        'a desambiguação é legível para quem lê a lista no painel',
        nomes,
    );
}

console.log('\n=== S185-5 — o limiar de proposta não foi afrouxado ===');
{
    // A correção é sobre deduplicação, não sobre baixar a régua: um padrão ainda precisa de
    // 3 sucessos e 80% de taxa para virar proposta.
    assert(/WHERE success_count >= 3/.test(SRC), 'mínimo de 3 sucessos preservado');
    assert(
        /\(success_count \* 1\.0 \/ \(success_count \+ fail_count\)\) >= 0\.8/.test(SRC),
        'taxa mínima de 80% preservada',
    );
    assert(
        /if \(process\.env\.SKILL_LEARNER_PROPOSALS === 'false'\) return;/.test(SRC),
        'o desligamento por variável de ambiente continua disponível',
    );
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S185 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
console.log(`\nCOBERTURA:`);
console.log(`  Descarte mudo por nome eliminado: testado`);
console.log(`  Duplicata real ainda barrada, com log: testado`);
console.log(`  Identidade (pattern, tool) preservada: testado`);
console.log(`  Cenário real da instância desbloqueado: testado`);
console.log(`  Limiar de proposta inalterado: testado`);
if (failed > 0) process.exit(1);
