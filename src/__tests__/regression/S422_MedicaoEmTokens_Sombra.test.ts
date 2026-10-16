/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S422
 * ADR-024, etapa 1 (SOMBRA): toda chamada ao modelo é medida em TOKENS — por modelo e modo de raciocínio — e o orçamento por
 * tokens que TERIA valido é registrado ao lado do que o relógio fez. Nada de corte muda nesta etapa.
 *
 * ORIGEM: 16/10/2026 — prazos em segundos calibrados na nuvem (~370 tokens/s) cortariam um modelo local (Bonsai 27B, ~38
 * tokens/s); e a latência era medida por PROVEDOR, misturando modelos da nuvem e locais. Um juiz cortado aos 70 s na nuvem
 * concluiu no modelo local com 8,6 mil tokens — era corte de relógio, não espiral.
 *
 * REGRESSÃO SE: velocidades ou orçamentos se misturarem entre modelos ou modos; entrada/raciocínio/resposta forem mal
 * contados; chamada cortada não for registrada (com fonte 'estimado'); orçamento aparecer sem amostra mínima; a medição
 * alterar o resultado da chamada ou derrubá-la.
 *
 * Execução: npx ts-node src/__tests__/regression/S422_MedicaoEmTokens_Sombra.test.ts
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MedidorDeTrabalho, observacaoDaChamada, medidorDoProcesso, AMOSTRA_MINIMA, FOLGA } from '../../core/medidorDeTrabalho';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}

async function main(): Promise<void> {
    console.log('\n=== S422-1 — contabilidade: números do servidor, raciocínio × resposta, chamada cortada ===');
    {
        const ok = observacaoDaChamada({ modelo: 'x', modo: 'livre', tipo: 'ValidationEngine:risco_do_plano', status: 'success',
            tentativa: { model: 'bonsai', promptTokens: 1653, evalTokens: 6036, promptEvalMs: 4130, evalMs: 158000, thinkingChars: 22429, contentChars: 2445, firstChunkMs: 4200, doneReason: 'stop' },
            charsDeEntrada: 6012, msTotal: 162000, canceladaPeloUsuario: false });
        assert(ok.fonte === 'servidor' && ok.modelo === 'bonsai' && ok.entradaTokens === 1653 && ok.saidaTokens === 6036, 'usa os números do servidor e o modelo REAL da tentativa', ok);
        assert(ok.raciocinioTokens + ok.respostaTokens === 6036 && ok.raciocinioTokens > 5000, 'divide a saída entre raciocínio e resposta pela proporção de caracteres', ok);
        assert(ok.desfecho === 'concluiu', 'desfecho: concluiu');

        const cortada = observacaoDaChamada({ modelo: 'glm-flash', modo: 'livre', tipo: 'ValidationEngine:risco_do_plano', status: 'cancelled',
            tentativa: { model: 'glm-flash', chunks: 3426, thinkingChars: 32229, contentChars: 0, firstChunkMs: 1360 },
            charsDeEntrada: 6839, msTotal: 51979, canceladaPeloUsuario: false });
        assert(cortada.fonte === 'estimado' && cortada.saidaTokens === 3426 && cortada.raciocinioTokens === 3426, 'chamada cortada: saída ESTIMADA pelos pedaços, toda em raciocínio', cortada);
        assert(cortada.entradaTokens === Math.round(6839 / 3.55), 'entrada estimada pelos caracteres (3,55/token, pt-BR medido)', cortada.entradaTokens);
        assert(cortada.desfecho === 'cortada_pelo_relogio', 'desfecho: cortada pelo relógio (a fatia do juiz aborta como "cancelled")');

        const usuario = observacaoDaChamada({ modelo: 'm', modo: 'padrao', tipo: 't', status: 'cancelled', charsDeEntrada: 10, msTotal: 5, canceladaPeloUsuario: true });
        assert(usuario.desfecho === 'cancelada', '"Parar" do usuário não é confundido com corte de relógio');
        const limite = observacaoDaChamada({ modelo: 'm', modo: 'livre', tipo: 't', status: 'success', tentativa: { evalTokens: 60, doneReason: 'length', thinkingChars: 243, contentChars: 0 }, charsDeEntrada: 10, msTotal: 5, canceladaPeloUsuario: false });
        assert(limite.desfecho === 'limite_de_tokens', 'parar no limite de tokens do provedor é um desfecho próprio (Ollama Cloud: done_reason=length)');
    }

    console.log('\n=== S422-2 — por MODELO e MODO: velocidades e orçamentos não se misturam ===');
    {
        const m = new MedidorDeTrabalho();
        const obs = (modelo: string, modo: 'livre' | 'desligado', saida: number, msGeracao: number, desfecho: 'concluiu' | 'cortada_pelo_relogio' = 'concluiu') =>
            m.registrar({ modelo, modo, tipo: 'ValidationEngine:risco_do_plano', entradaTokens: 1700, saidaTokens: saida, raciocinioTokens: saida, respostaTokens: 0, msLeitura: 2000, msGeracao, msTotal: msGeracao + 2000, desfecho, fonte: 'servidor' });
        for (let i = 0; i < AMOSTRA_MINIMA - 1; i++) obs('local', 'livre', 6000, 160000);
        const antes = obs('nuvem', 'livre', 6000, 16000);
        assert(/orcamento_tokens=sem_historico/.test(antes) && /teria_cortado_por_tokens=sem_historico/.test(antes), 'sem amostra mínima: "sem_historico", declarado — nunca um número inventado', antes);
        assert(m.orcamento('local', 'livre', 'ValidationEngine:risco_do_plano') === null, `com ${AMOSTRA_MINIMA - 1} amostras ainda não há orçamento`);
        obs('local', 'livre', 8000, 210000);
        const orc = m.orcamento('local', 'livre', 'ValidationEngine:risco_do_plano');
        assert(orc !== null && orc.tokens === Math.ceil(8000 * FOLGA) && orc.amostras === AMOSTRA_MINIMA, `orçamento = p95 × ${FOLGA} do que CONCLUIU`, orc);
        assert(m.orcamento('local', 'desligado', 'ValidationEngine:risco_do_plano') === null, 'outro MODO do mesmo modelo: orçamento próprio');
        assert(m.orcamento('nuvem', 'livre', 'ValidationEngine:risco_do_plano') === null, 'outro MODELO: orçamento próprio');
        const vl = m.velocidade('local', 'livre'), vn = m.velocidade('nuvem', 'livre');
        assert(vl.geracao !== undefined && vl.geracao < 45 && vn.geracao !== undefined && vn.geracao > 300, `velocidades separadas por modelo (local ${vl.geracao?.toFixed(1)}, nuvem ${vn.geracao?.toFixed(1)} tok/s)`);
        const sombra = obs('local', 'livre', 13000, 340000, 'cortada_pelo_relogio');
        assert(/teria_cortado_por_tokens=sim/.test(sombra) && /relogio_cortou=sim/.test(sombra), 'linha de sombra: o que o limite por tokens faria × o que o relógio fez', sombra);
        assert(m.orcamento('local', 'livre', 'ValidationEngine:risco_do_plano')!.amostras === AMOSTRA_MINIMA, 'chamada cortada não entra no histórico do que concluiu (é dado censurado)');
        assert(/tempo_que_o_orcamento_daria_s=\d+/.test(sombra), 'diz quanto tempo o orçamento em tokens daria a ESTE modelo (velocidade medida)', sombra);

        const arq = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nc-s422-')), 'medicao.json');
        const g = new MedidorDeTrabalho(); g.persistirEm(arq);
        g.registrar({ modelo: 'a', modo: 'livre', tipo: 't', entradaTokens: 10, saidaTokens: 100, raciocinioTokens: 0, respostaTokens: 100, msLeitura: 100, msGeracao: 1000, msTotal: 1100, desfecho: 'concluiu', fonte: 'servidor' });
        const relido = new MedidorDeTrabalho(); relido.persistirEm(arq);
        assert(relido.velocidade('a', 'livre').amostras === 1, 'a medição sobrevive ao reinício');
        try { fs.rmSync(path.dirname(arq), { recursive: true, force: true }); } catch { /* temporário */ }
    }

    console.log('\n=== S422-3 — no ProviderFactory real: toda chamada é medida e o resultado NÃO muda ===');
    {
        const { ProviderFactory } = require('../../core/ProviderFactory') as typeof import('../../core/ProviderFactory');
        const pf = new ProviderFactory({ defaultProvider: 'falso', ollamaUrl: 'http://127.0.0.1:1', customProviders: [{ label: 'falso', baseUrl: 'http://127.0.0.1:2/v1', model: 'modelo-falso' }] } as any);
        (pf as any).providers.set('falso', { name: 'falso', model: 'modelo-falso', setModel() {}, async chat(_m: unknown, _t: unknown, opts: any) {
            // Como o OllamaProvider: preenche a telemetria da tentativa com o que o servidor informou.
            if (opts?.telemetry) Object.assign(opts.telemetry, { promptTokens: 500, evalTokens: 250, promptEvalMs: 500, evalMs: 5000, thinkingChars: 0, contentChars: 900, doneReason: 'stop', chunks: 250 });
            return { content: 'resposta do modelo', usage: { prompt_tokens: 500, completion_tokens: 250 } };
        } });
        const antes = medidorDoProcesso.velocidade('modelo-falso', 'desligado').amostras;
        const r = await pf.chatWithFallback([{ role: 'user', content: 'oi' }], undefined, 'falso', 5000, undefined, undefined, { raciocinio: 'desligado', diag: { component: 'Teste', phase: 's422' } } as any);
        assert(r.status === 'success' && r.content === 'resposta do modelo', 'o resultado da chamada é o mesmo (a medição só observa)', r);
        assert(medidorDoProcesso.velocidade('modelo-falso', 'desligado').amostras === antes + 1, 'a chamada foi medida mesmo sem o chamador pedir telemetria (telemetria interna)');
        const v = medidorDoProcesso.velocidade('modelo-falso', 'desligado');
        assert(v.geracao === 50 && v.leitura === 1000, `velocidade = tokens ÷ tempo do servidor (geração ${v.geracao}, leitura ${v.leitura} tok/s)`, v);

        (pf as any).providers.set('quebrado', { name: 'quebrado', model: 'mq', setModel() {}, async chat(_m: unknown, _t: unknown, opts: any) {
            if (opts?.telemetry) Object.assign(opts.telemetry, { chunks: 40, thinkingChars: 300, contentChars: 0 });
            throw new Error('This operation was aborted');
        } });
        let lancou = false;
        try { await pf.chatWithFallback([{ role: 'user', content: 'oi' }], undefined, 'quebrado', 2000); } catch { lancou = true; }
        assert(!lancou, 'chamada que falha continua devolvendo o resultado de sempre (a medição nunca lança)');
    }

    console.log('\n=== S422-4 — fiação: o Ollama repassa os tempos do servidor e o boot persiste a medição ===');
    {
        const ler = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), 'utf-8');
        assert(/prompt_ms: nsParaMs\(chunk\.prompt_eval_duration\), eval_ms: nsParaMs\(chunk\.eval_duration\)/.test(ler('src/core/OllamaProvider.ts')), 'OllamaProvider repassa prompt_eval_duration e eval_duration (ns → ms)');
        assert(/medidorDoProcesso\.persistirEm\(path\.join\(process\.cwd\(\), 'data', 'medicao-de-tokens\.json'\)\)/.test(ler('src/core/AgentController.ts')), 'boot persiste em data/medicao-de-tokens.json');
        assert(/\[TOKENS-SOMBRA\]/.test(ler('src/core/ProviderFactory.ts')), 'o ProviderFactory registra a linha [TOKENS-SOMBRA]');
    }

    console.log(`\n=== S422: ${passed} passaram, ${failed} falharam ===`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
