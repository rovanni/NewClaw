/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S442
 * Modelo escolhido sem velocidade medida recebe UMA chamada mínima de medição (na partida e quando a escolha de modelos muda),
 * para que o primeiro pedido já tenha o prazo pelo trabalho (ADR-024). Modelo já medido não é chamado de novo.
 *
 * INCIDENTE REAL (21/10/2026, modelo local numa instância nova): mesmo com a S440, a primeira chamada do turno — o
 * classificador de objetivos — ainda não tinha velocidade medida, usou os 15 s de sempre, estourou, e o pedido não virou
 * objetivo. A velocidade só passou a existir a partir da chamada seguinte.
 *
 * Execução: npx ts-node src/__tests__/regression/S442_SondaDeVelocidadeDoModeloNovo.test.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { ProviderFactory } from '../../core/ProviderFactory';
import { medidorDoProcesso } from '../../core/medidorDeTrabalho';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}

async function main(): Promise<void> {
    console.log('\n=== S442-1 — só o modelo sem medição é sondado, uma vez, com chamada mínima ===');
    // Já medido (como o glm na produção): não pode gastar chamada.
    medidorDoProcesso.registrar({ modelo: 's442-medido', modo: 'padrao', tipo: 'X:y', entradaTokens: 100, saidaTokens: 100, raciocinioTokens: 0, respostaTokens: 100, msLeitura: 100, msGeracao: 1000, tempos: 'servidor', msTotal: 1200, desfecho: 'concluiu', fonte: 'servidor' } as any);
    const chamadas: Array<{ modelo?: string; opts: any }> = [];
    const falso = {
        // A sonda passa pelo caminho normal: a medição de verdade é registrada lá (aqui, simulada).
        async chatWithFallback(_m: unknown, _t: unknown, _p: unknown, _to: unknown, _s: unknown, modelo?: string, opts?: any) {
            chamadas.push({ modelo, opts });
            medidorDoProcesso.registrar({ modelo: modelo!, modo: 'padrao', tipo: 'MedicaoDeVelocidade:sonda', entradaTokens: 20, saidaTokens: 10, raciocinioTokens: 0, respostaTokens: 10, msLeitura: 200, msGeracao: 500, tempos: 'servidor', msTotal: 800, desfecho: 'concluiu', fonte: 'servidor' } as any);
            return { status: 'success', content: 'ok', attempts: [] };
        },
    };
    await (ProviderFactory.prototype.medirVelocidadeDosModelos as Function).call(falso, ['s442-novo', 's442-medido', 's442-novo', '']);
    assert(chamadas.length === 1 && chamadas[0].modelo === 's442-novo', 'uma chamada, só para o modelo sem medição (sem repetir, sem vazio)', chamadas.map(c => c.modelo));
    assert(chamadas[0]?.opts?.limiteDeSaidaTokens === 128 && chamadas[0]?.opts?.diag?.component === 'MedicaoDeVelocidade', 'chamada mínima e rotulada', chamadas[0]?.opts);
    assert(!!medidorDoProcesso.velocidade('s442-novo', 'padrao').geracao, 'depois dela, o modelo tem velocidade');
    await (ProviderFactory.prototype.medirVelocidadeDosModelos as Function).call(falso, ['s442-novo']);
    assert(chamadas.length === 1, 'segunda vez: nenhuma chamada (já medido)');

    console.log('\n=== S442-2 — a sonda nunca derruba quem chamou ===');
    const quebrado = { async chatWithFallback() { throw new Error('servidor fora do ar'); } };
    let lancou = false;
    try { await (ProviderFactory.prototype.medirVelocidadeDosModelos as Function).call(quebrado, ['s442-fora']); } catch { lancou = true; }
    assert(!lancou, 'falha do provedor vira log, não exceção');

    console.log('\n=== S442-3 — quando ela roda ===');
    const src = (f: string) => fs.readFileSync(path.join(process.cwd(), 'src', ...f.split('/')), 'utf-8');
    assert(/this\.agentLoop\.medirModelosSemVelocidade\(\[mr\?\.observerModel, mr\?\.plannerModel, mr\?\.riskModel, mr\?\.classifierModel\]\)/.test(src('core/AgentController.ts')), 'na partida, com os modelos internos também');
    assert(/this\.medirModelosSemVelocidade\(\[observerModel, plannerModel, riskModel, classifierModel\]\)/.test(src('loop/AgentLoop.ts')), 'quando a escolha de modelos muda no painel');

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S442 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
