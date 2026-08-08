/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S210
 * Fato sobre a entrega chega ao usuário: a terceira categoria do contrato (`ADR-007`, Sprint 028).
 *
 * CONTEXTO: `send_audio` cai do Piper (na máquina do usuário) para um serviço de terceiros na
 * Internet quando o Piper falha. Até aqui isso virava `log.error` e nunca chegava a quem falou —
 * era a última linha ❌ do quadro de estado de `SOBERANIA_DA_CONFIGURACAO.md` §9.
 *
 * O mecanismo da Sprint 022 (fato no prompt, LLM verbaliza) não se aplicava, porque uma ferramenta
 * terminal ENCERRA o turno: o `output` dela vira a resposta e não há LLM depois. A `ADR-007`
 * resolveu não desligando o caminho que já existe — uma ferramenta que devolve fato deixa de
 * encerrar o turno, e o resultado volta ao contexto do modelo como em qualquer outra tool.
 *
 * REGRESSÃO SE: o fato voltar a viajar dentro do `output` (ali mora só o conteúdo entregue —
 * `FERRAMENTAS_DE_ENTREGA.md` §4, `S201`); uma entrega COM fato voltar a encerrar o turno (aí não
 * há quem verbalize); uma entrega SEM fato deixar de encerrar (custo de inferência sem motivo); ou
 * o fato deixar de chegar ao modelo por não ser concatenado à mensagem da tool.
 *
 * Execução: npx ts-node src/__tests__/regression/S210_DeliveryFacts_TurnDoesNotEnd.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { ToolRegistry } from '../../core/ToolRegistry';
import { toolResultForModel, ToolResult } from '../../loop/agentLoopTypes';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

const CONTEUDO = 'A capital da Austrália é Canberra.';
const FATO = '[FATO DO SISTEMA] O áudio deveria ter sido gerado pelo Piper... avise em UMA frase curta.';

const semFato: ToolResult = { success: true, output: CONTEUDO };
const comFato: ToolResult = { success: true, output: CONTEUDO, deliveryFacts: [FATO] };
const falhou: ToolResult = { success: false, output: '', error: 'boom' };

console.log('\n=== S210-1 — quem devolve fato NÃO encerra o turno ===');
{
    assert(ToolRegistry.endsTurn('send_audio', semFato),
        'entrega sem fato encerra o turno — o caminho barato continua barato');
    assert(!ToolRegistry.endsTurn('send_audio', comFato),
        'entrega COM fato não encerra: é a ida a mais ao LLM que permite verbalizar');
    assert(!ToolRegistry.endsTurn('send_audio', falhou),
        'falha nunca encerra como sucesso');
    assert(!ToolRegistry.endsTurn('exec_command', semFato),
        'tool não terminal não encerra o turno por ter sucesso');
    assert(ToolRegistry.endsTurn('send_document', semFato),
        'vale para qualquer ferramenta de entrega, não só a de áudio');
}

console.log('\n=== S210-2 — o fato chega ao modelo, e fora do `output` ===');
{
    assert(toolResultForModel(semFato) === CONTEUDO,
        'sem fato, o modelo vê exatamente o conteúdo — nada acrescentado',
        toolResultForModel(semFato));

    const comFatoTexto = toolResultForModel(comFato);
    assert(comFatoTexto.includes(CONTEUDO), 'com fato, o conteúdo continua lá');
    assert(comFatoTexto.includes(FATO), 'e o fato viaja junto para o modelo verbalizar');

    assert(comFato.output === CONTEUDO,
        'o `output` da tool permanece só o conteúdo — ele pode virar resposta final sem passar por LLM',
        comFato.output);
    assert(!comFato.output.includes('[FATO DO SISTEMA]'),
        'o fato NUNCA é injetado no output (seria texto fixo em português na resposta ao usuário)');
}

console.log('\n=== S210-3 — send_audio só produz fato quando o local foi declarado e falhou ===');
{
    const SRC = fs.readFileSync(path.join(process.cwd(), 'src', 'tools', 'send_audio.ts'), 'utf-8');

    // Migrado na Sprint 035: `const piper = this.findPiperInstallation()` virou `const lookup = …`,
    // porque a procura deixou de devolver "achou ou null" e passou a devolver quatro estados.
    const inicio = SRC.indexOf('const lookup = this.findPiperInstallation();');
    const fim = SRC.indexOf('const mp3File =', inicio);
    const blocoPiper = SRC.slice(inicio, fim);
    assert(inicio > 0 && fim > inicio, 'bloco do Piper localizado', { inicio, fim });
    assert(
        /catch\s*\(piperErr\)[\s\S]*fatos\.push\(/.test(blocoPiper),
        'o fato nasce no catch do Piper — declarado e falhou, não em qualquer queda de engine',
        blocoPiper.slice(-300),
    );
    assert(
        !/'nao-declarado'[\s\S]{0,200}fatos\.push\(/.test(blocoPiper),
        'sem Piper instalado não há fato: o usuário não declarou TTS local (Soberania §1.1)',
    );
    assert(
        /deliveryFacts: fatosDaEntrega/.test(SRC),
        'os fatos saem pela terceira categoria do ToolResult, não pelo output',
    );
}

console.log('\n=== S210-4 — o contrato de conteúdo permanece (S201 continua válido) ===');
{
    const SRC = fs.readFileSync(path.join(process.cwd(), 'src', 'tools', 'send_audio.ts'), 'utf-8');
    const retornos = SRC.match(/return \{ success: true, output: [^}]+\}/g) || [];
    assert(retornos.length > 0, 'há retornos de sucesso a inspecionar', retornos.length);
    assert(
        retornos.every(r => /output: spokenText/.test(r)),
        'todo retorno de sucesso devolve o texto falado como conteúdo — nunca recibo',
        retornos,
    );
}

console.log(`\nS210 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
console.log(`\nCOBERTURA:`);
console.log(`  endsTurn: com fato não encerra, sem fato encerra: testado`);
console.log(`  Fato chega ao modelo e fica fora do output: testado`);
console.log(`  Fato só nasce com TTS local declarado que falhou: testado`);
console.log(`  Contrato de conteúdo do S201 preservado: testado`);
if (failed > 0) process.exit(1);
