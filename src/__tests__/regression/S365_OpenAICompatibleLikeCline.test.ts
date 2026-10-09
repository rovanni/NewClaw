/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S365 (issue 070)
 *
 * Servidor local OpenAI-compatível configurado "como no Cline": URL base, chave opcional, Model ID DIGITADO,
 * raciocínio e "lê imagens?" declarados pelo operador.
 *
 * Origem: modelos offline novos (um servidor de modelo próprio na porta 8090, outro com llama-server próprio) não
 * eram "reconhecidos" pelo NewClaw, enquanto o Cline funcionava com URL + Model ID. O NewClaw já falava com
 * qualquer servidor OpenAI-compatível; o que faltava estava no assistente:
 *   1. o Model ID só podia ser escolhido de uma lista — servidor que não lista (ou lista com outro nome) travava;
 *   2. /models respondendo erro era tratado como "servidor fora do ar", mesmo com ele no ar;
 *   3. visão era adivinhada pelo nome do modelo — sem como dizer "sim, lê imagens" / "não lê";
 *   4. o raciocínio (on/off) existia na aba clássica, não no assistente.
 *
 * Mede comportamento real onde dá (servidor HTTP de verdade na máquina, provedor de verdade), e estrutura onde o
 * código é de navegador (ConfigWizard.js depende do DOM desde o topo — mesma técnica de S251/S355).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import * as vm from 'vm';
import { AddressInfo } from 'net';
import { discoverOpenAICompatibleModels, OpenAIProvider } from '../../core/OpenAIProvider';
import { ModelRegistryService } from '../../core/ModelRegistryService';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

const raiz = process.cwd();
const ler = (...p: string[]) => fs.readFileSync(path.join(raiz, ...p), 'utf-8');
const CW = ler('src', 'dashboard', 'public', 'config', 'components', 'ConfigWizard.js');
const MV = ler('src', 'dashboard', 'public', 'config', 'views', 'ModelosView.js');
const ROTA = ler('src', 'dashboard', 'routes', 'providers.ts');
const SHARED = ler('src', 'dashboard', 'public', 'shared.js');

/** Servidor OpenAI-compatível falso: /models devolve `statusModels`; /chat/completions registra o corpo pedido. */
function servidorFalso(statusModels: number): Promise<{ url: string; corpos: any[]; fechar: () => void }> {
    const corpos: any[] = [];
    const srv = http.createServer((req, res) => {
        if (req.url?.endsWith('/models')) {
            res.writeHead(statusModels, { 'Content-Type': 'application/json' });
            res.end(statusModels === 200 ? JSON.stringify({ data: [{ id: 'modelo-unico' }] }) : '{"error":"not found"}');
            return;
        }
        let b = '';
        req.on('data', c => { b += c; });
        req.on('end', () => {
            const corpo = JSON.parse(b || '{}');
            corpos.push(corpo);
            const msg = { role: 'assistant', content: 'ok' };
            if (corpo.stream) {
                res.writeHead(200, { 'Content-Type': 'text/event-stream' });
                res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: null }] })}\n\n`);
                res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
                res.end('data: [DONE]\n\n');
            } else {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ choices: [{ message: msg, finish_reason: 'stop' }] }));
            }
        });
    });
    return new Promise(ok => srv.listen(0, '127.0.0.1', () => {
        ok({ url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}/v1`, corpos, fechar: () => srv.close() });
    }));
}

async function main() {
    console.log('\n=== S365-1 — /models com erro: o servidor está no ar (status anexado), não "fora do ar" ===');
    {
        const s = await servidorFalso(404);
        let erro: any;
        try { await discoverOpenAICompatibleModels(s.url, undefined, 'teste'); } catch (e) { erro = e; }
        assert(erro?.status === 404, `o erro carrega o status HTTP (obtido ${erro?.status})`);
        s.fechar();
        let recusado: any;
        try { await discoverOpenAICompatibleModels('http://127.0.0.1:1/v1', undefined, 'teste'); } catch (e) { recusado = e; }
        assert(recusado && recusado.status === undefined, 'conexão recusada não tem status — esta sim é "fora do ar"');

        const rota = ROTA.slice(ROTA.indexOf("router.post('/providers/test'"), ROTA.indexOf("router.post('/providers/custom'"));
        assert(/typeof status === 'number'[\s\S]*online: true, models: \[\], modelsStatus: status/.test(rota),
            'a rota de teste responde online:true + modelsStatus quando o servidor respondeu sem lista');
        assert(rota.indexOf('modelsStatus') < rota.indexOf('online: false'), 'o caso "respondeu" é decidido antes do "fora do ar"');
    }

    console.log('\n=== S365-2 — Model ID digitado e raciocínio chegam ao servidor de verdade ===');
    {
        const s = await servidorFalso(404);
        const p = new OpenAIProvider('', 'swift-1.5-iq3_xxs', s.url, 'Servidor local', { thinking: 'off' });
        await p.chat([{ role: 'user', content: 'oi' }]);
        const c = s.corpos[0] || {};
        assert(c.model === 'swift-1.5-iq3_xxs', `o pedido leva o Model ID digitado (obtido ${c.model})`);
        assert(c.chat_template_kwargs?.enable_thinking === false, 'raciocínio desligado vai como chat_template_kwargs.enable_thinking=false');
        s.fechar();
    }

    console.log('\n=== S365-2b — painel: servidor sem lista conta como no ar, com o modelo declarado no catálogo ===');
    {
        // Achado na navegação: o assistente salvava, mas a barra de status dizia "/models error: 404" e "Sistema pronto: Não".
        const s = await servidorFalso(404);
        const fabrica = { getOllamaProvider: () => null, getNativeProvider: () => null } as any;
        const reg = new ModelRegistryService(fabrica, () => [{ label: 'Servidor local', baseUrl: s.url, model: 'swift-1.5-iq3_xxs' }]);
        const catalogo = await reg.getCatalog(true);
        const saude = reg.getLastHealth().find(h => h.provider === 'Servidor local');
        assert(saude?.online === true && !saude?.error, `no ar, sem erro (obtido ${JSON.stringify(saude)})`);
        assert(catalogo.some(m => m.id === 'swift-1.5-iq3_xxs' && m.provider === 'Servidor local'), 'o Model ID declarado entra no catálogo');
        s.fechar();

        const negado = await servidorFalso(401);
        const reg2 = new ModelRegistryService(fabrica, () => [{ label: 'Com chave', baseUrl: negado.url, model: 'x' }]);
        await reg2.getCatalog(true);
        const saude2 = reg2.getLastHealth().find(h => h.provider === 'Com chave');
        assert(saude2?.online === false && /401/.test(saude2?.error || ''), 'chave recusada (401) continua aparecendo como problema');
        negado.fechar();
        const quebrado = await servidorFalso(500);
        const reg3 = new ModelRegistryService(fabrica, () => [{ label: 'Quebrado', baseUrl: quebrado.url, model: 'x' }]);
        await reg3.getCatalog(true);
        const saude3 = reg3.getLastHealth().find(h => h.provider === 'Quebrado');
        assert(saude3?.online === false && /500/.test(saude3?.error || ''), 'erro do servidor (500) continua aparecendo como problema');
        quebrado.fechar();
        assert(/ROTA_DE_MODELOS_AUSENTE\.has\(status\) \|\| status === 503/.test(ROTA),
            'a rota de teste usa a mesma regra: só "rota ausente" e "carregando" contam como no ar');
    }

    console.log('\n=== S365-3 — assistente: campo de Model ID, raciocínio e imagens ===');
    {
        const etapa = CW.slice(CW.indexOf('function renderCustomModelSelect'), CW.indexOf('async function confirmCustomEntry'));
        assert(/id="ml-cw-customModelId"/.test(etapa) && /bindDraft\('ml-cw-customModelId', 'customModelId'\)/.test(etapa),
            'há um campo de texto para o Model ID, ligado ao rascunho');
        assert(/models\.length === 1 \? models\[0\]/.test(etapa), 'servidor de modelo único: o campo já vem preenchido');
        assert(/session\.draft\.customModelId = id/.test(etapa), 'clicar na lista preenche o campo (a lista é atalho, não obrigação)');
        assert(/id="ml-cw-customThinking"/.test(etapa) && /id="ml-cw-customImages"/.test(etapa), 'seletores de raciocínio e de imagens');
        assert(/ml_cw_custom_models_unlisted/.test(etapa), 'servidor sem lista: aviso próprio pedindo para digitar o ID');

        const conf = CW.slice(CW.indexOf('async function confirmCustomEntry'), CW.indexOf('function renderLocalFolder'));
        assert(/const modelo = \(session\.draft\.customModelId \?\? ''\)\.trim\(\)/.test(conf), 'a confirmação usa o Model ID do campo');
        assert(/thinking: session\.draft\.customThinking \|\| ''/.test(conf), 'o raciocínio escolhido é gravado no provedor');
        assert(/\{ sim: 'mesmo_modelo', nao: 'nao' \}\[session\.draft\.customImages\] \|\| 'se_o_catalogo_disser'/.test(conf)
            && /aplicarModeloATudo\(modelo, \{ visao \}\)/.test(conf), 'a resposta de "lê imagens?" vai para aplicarModeloATudo');

        const teste = CW.slice(CW.indexOf('async function testCustomEndpoint'), CW.indexOf('function renderCustomModelSelect'));
        assert(/session\.draft\.customModelId = undefined/.test(teste) && /modelsStatus: result\.modelsStatus/.test(teste),
            'testar outro endereço zera o Model ID antigo e guarda o "respondeu sem lista"');
    }

    console.log('\n=== S365-4 — aplicarModeloATudo respeita "sim" e "não" para imagens ===');
    {
        const ini = MV.indexOf('export function aplicarModeloATudo');
        const fim = MV.slice(ini).search(/\r?\n\}\r?\n/);
        const corpo = MV.slice(ini, ini + fim).replace('export function', 'function') + '\n}';
        const rodar = (catalogo: any[], visao?: string) => {
            const estado: Record<string, any> = { modelRouter: {} };
            const cs = { get: (k: string) => estado[k], set: (k: string, v: any) => { estado[k] = v; } };
            const ps = { get: () => catalogo };
            const fn = new Function('configStore', 'providersStore', 'document', `${corpo}; return aplicarModeloATudo;`)(cs, ps, { getElementById: () => null });
            fn('swift-1.5-iq3_xxs', visao ? { visao } : undefined);
            return estado.modelRouter;
        };
        const semCatalogo: any[] = [];
        const comVisao = [{ id: 'swift-1.5-iq3_xxs', capabilities: ['chat', 'vision'] }];
        assert(rodar(semCatalogo, 'mesmo_modelo').vision === 'swift-1.5-iq3_xxs', '"sim": visão aponta para o modelo, mesmo sem catálogo');
        assert(rodar(comVisao, 'nao').vision === '', '"não": visão fica vazia, mesmo que o catálogo diga que lê imagens');
        assert(rodar(comVisao).vision === 'swift-1.5-iq3_xxs' && rodar(semCatalogo).vision === '', '"automático": segue o catálogo');
        const mr = rodar(semCatalogo, 'nao');
        assert(['chat', 'code', 'light', 'analysis', 'execution', 'classifierModel', 'plannerModel', 'riskModel', 'observerModel'].every(k => mr[k] === 'swift-1.5-iq3_xxs'),
            'o Model ID vale para tudo (issue 071 continua valendo)');
    }

    console.log('\n=== S365-5 — textos nos 3 idiomas ===');
    {
        for (const k of ['ml_cw_custom_models_unlisted', 'ml_cw_custom_model_id_label', 'ml_cw_custom_model_id_placeholder',
            'ml_cw_custom_images_label', 'ml_cw_custom_images_auto', 'ml_cw_custom_images_yes', 'ml_cw_custom_images_no']) {
            assert((SHARED.match(new RegExp(`\\b${k}:`, 'g')) || []).length === 3, `${k} em pt/en/es`);
        }
        assert((SHARED.match(/llama-server/g) || []).length >= 6, 'o servidor llama-server é citado no rótulo e na dica, nos 3 idiomas');
        // Achado na navegação: aspas retas dentro de um texto entre aspas quebraram o shared.js e o painel ficou em branco.
        let sintaxe = 'ok';
        try { new vm.Script(SHARED); } catch (e) { sintaxe = (e as Error).message; }
        assert(sintaxe === 'ok', `shared.js continua sendo JavaScript válido (${sintaxe})`);
    }

    console.log(`\nS365 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    if (failed > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
