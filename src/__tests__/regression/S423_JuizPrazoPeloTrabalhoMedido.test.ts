/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S423
 * ADR-024, etapa 3: o prazo do juiz vem do TRABALHO medido (tokens que aquele tipo custa a ESTE modelo neste modo ÷ a
 * velocidade MEDIDA dele) e o limite de tokens vai ao próprio provedor. Só ESTENDE — nunca corta antes do que cortava.
 *
 * ORIGEM: 16/10/2026 — o juiz de risco que a nuvem "perdeu" (cortado aos 70 s) concluiu no modelo local com 8,6 mil tokens a
 * ~38 tokens/s (232 s). Histórico de produção: a maioria dos cortes do relógio caberia no orçamento por tokens.
 *
 * REGRESSÃO SE: sem histórico o comportamento mudar; com histórico, o prazo de um modelo lento continuar o de um rápido;
 * o limite de tokens não chegar ao provedor; o prazo passar do que resta ao objetivo; ou o prazo encurtar.
 *
 * Execução: npx ts-node src/__tests__/regression/S423_JuizPrazoPeloTrabalhoMedido.test.ts
 */
import { PerfilDoJuiz } from '../../validation/perfilDoJuiz';
import { ValidationEngine } from '../../validation/ValidationEngine';
import { criarRegistroPadrao } from '../../validation/motorPadrao';
import { medidorDoProcesso, AMOSTRA_MINIMA, FOLGA } from '../../core/medidorDeTrabalho';
import { executarComPrazo } from '../../shared/turnCancellation';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}
const VEREDITO = JSON.stringify({ estado: 'aprovado', itens: [{ item: 'x', confere: 'sim' }], tipo_de_falha: 'none' });

async function main(): Promise<void> {
    const registro = criarRegistroPadrao();
    const tipo = 'risco_do_plano';
    const entradas = Object.fromEntries((registro.obter(tipo)?.entradas ?? []).filter(e => e.obrigatoria).map(e => [e.nome, 'conteúdo']));

    /** ProviderFactory falso: registra o prazo e o limite que cada chamada recebeu. */
    const fabrica = (medido: ((m: string) => any) | null, chamadas: Array<{ modo: string; fatia: number; limite?: number }>) => ({
        getBudgetAuxiliar: () => ({ timeoutMs: 1000, origem: 'padrao', latenciaTipicaMs: null }),
        ...(medido ? { orcamentoPeloTrabalho: (_mod: unknown, modo: string) => medido(modo) } : {}),
        chatWithFallback: async (_m: unknown, _t: unknown, _p: unknown, fatia: number, _s: unknown, _mod: unknown, opts: any) => {
            chamadas.push({ modo: opts.raciocinio, fatia: opts.prazoDaVezMs ?? fatia, limite: opts.limiteDeSaidaTokens });   // ADR-024: prazo da vez explícito
            return { status: 'success', content: VEREDITO, attempts: [] };
        },
    }) as any;

    console.log('\n=== S423-1 — sem histórico medido: exatamente como antes ===');
    {
        const chamadas: Array<{ modo: string; fatia: number; limite?: number }> = [];
        const r = await new ValidationEngine(fabrica(null, chamadas), registro, () => 'modelo-x', new PerfilDoJuiz()).validar(tipo, entradas);
        assert(r.semVeredito === false && chamadas.length === 1, 'deu veredito numa chamada', chamadas);
        assert(chamadas[0].fatia <= 1000 && chamadas[0].limite === undefined, 'prazo do orçamento de sempre e nenhum limite de tokens', chamadas[0]);
        assert(r.orcamentoMs === 1000, 'orçamento registrado = o de sempre', r.orcamentoMs);
    }

    console.log('\n=== S423-2 — modelo lento com custo medido: o prazo vem do trabalho e o limite vai ao provedor ===');
    {
        const chamadas: Array<{ modo: string; fatia: number; limite?: number }> = [];
        const medido = (modo: string) => modo === 'livre' ? { modelo: 'bonsai', tokens: 12900, prazoMs: 240_000, amostras: 8, geracao: 38 } : null;
        const r = await new ValidationEngine(fabrica(medido, chamadas), registro, () => 'bonsai', new PerfilDoJuiz()).validar(tipo, entradas);
        assert(chamadas[0].modo === 'livre' && chamadas[0].fatia >= 240_000 * 0.99, `o modo medido recebe o tempo que o trabalho dele precisa (${chamadas[0].fatia} ms ≥ 240 s), não 1 s`, chamadas[0]);
        assert(chamadas[0].limite === 12900, 'o limite de tokens medido vai ao provedor (o modelo para sozinho, sem relógio)', chamadas[0]);
        assert((r.orcamentoMs ?? 0) >= 240_000, 'o orçamento registrado reflete o trabalho medido', r.orcamentoMs);
    }

    console.log('\n=== S423-3 — nunca encurta: medição menor que o prazo de sempre não reduz nada ===');
    {
        const chamadas: Array<{ modo: string; fatia: number; limite?: number }> = [];
        const medido = () => ({ modelo: 'rapido', tokens: 500, prazoMs: 200, amostras: 9, geracao: 400 });
        const r = await new ValidationEngine(fabrica(medido, chamadas), registro, () => 'rapido', new PerfilDoJuiz()).validar(tipo, entradas);
        assert(r.orcamentoMs === 1000, 'orçamento continua o de sempre (1 s), não os 0,2 s medidos', r.orcamentoMs);
    }

    console.log('\n=== S423-4 — no ProviderFactory real: tokens ÷ velocidade MEDIDA, por modelo e modo, e teto do objetivo ===');
    {
        const { ProviderFactory } = require('../../core/ProviderFactory') as typeof import('../../core/ProviderFactory');
        const pf = new ProviderFactory({ defaultProvider: 'ollama', ollamaUrl: 'http://127.0.0.1:1' } as any);
        const tipoChave = 'ValidationEngine:risco_do_plano';
        assert(pf.orcamentoPeloTrabalho('modelo-lento-s423', 'livre', tipoChave, 7000) === null, 'sem histórico: null (quem chama segue com o prazo de sempre)');
        for (let i = 0; i < AMOSTRA_MINIMA; i++) {
            medidorDoProcesso.registrar({ modelo: 'modelo-lento-s423', modo: 'livre', tipo: tipoChave, entradaTokens: 2000, saidaTokens: 8000, raciocinioTokens: 7500, respostaTokens: 500, msLeitura: 4000, msGeracao: 200_000, msTotal: 205_000, desfecho: 'concluiu', fonte: 'servidor' });
        }
        const o = pf.orcamentoPeloTrabalho('modelo-lento-s423', 'livre', tipoChave, 7100)!;
        const esperado = ((8000 * FOLGA) / 40 + (7100 / 3.55) / 500) * 1000 * 1.25 + 5000;
        assert(o !== null && o.tokens === 8000 * FOLGA && Math.abs(o.prazoMs - esperado) < 50, `prazo = (tokens ÷ geração + entrada ÷ leitura) × folga — ${Math.round(o.prazoMs / 1000)} s para 40 tok/s`, o);
        assert(pf.orcamentoPeloTrabalho('modelo-lento-s423', 'desligado', tipoChave, 7100) === null, 'outro modo do mesmo modelo: sem histórico próprio, null');
        const dentro = await executarComPrazo(Date.now() + 60_000, async () => pf.orcamentoPeloTrabalho('modelo-lento-s423', 'livre', tipoChave, 7100));
        assert(dentro !== null && dentro.prazoMs <= 60_000, `dentro de um objetivo, nunca passa do que resta a ele (${dentro?.prazoMs} ms ≤ 60 s)`, dentro);
    }

    console.log('\n=== S423-5 — fiação: o limite chega aos provedores ===');
    {
        const fs = require('fs') as typeof import('fs');
        const path = require('path') as typeof import('path');
        const ler = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), 'utf-8');
        const ollama = ler('src/core/OllamaProvider.ts');
        assert((ollama.match(/num_predict: Math\.round\(limiteDeSaida\)/g) ?? []).length === 2, 'Ollama: num_predict no streaming e no caminho sem streaming');
        assert(/max_tokens: Math\.round\(options\.limiteDeSaidaTokens\)/.test(ler('src/core/OpenAIProvider.ts')), 'OpenAI-compatível (llama-server/Bonsai): max_tokens');
        assert(/limiteDeSaidaTokens: opts\?\.limiteDeSaidaTokens \}/.test(ler('src/core/ProviderFactory.ts')), 'ProviderFactory repassa o limite a cada tentativa');
    }

    console.log(`\n=== S423: ${passed} passaram, ${failed} falharam ===`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
