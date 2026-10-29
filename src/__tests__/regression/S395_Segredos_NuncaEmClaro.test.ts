/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S395 (ADR-019)
 * O valor de uma senha nunca chega a logs, histórico, banco nem modelos: vai para o cofre e circula como <SEGREDO:nome>.
 *
 * INCIDENTE (11/10/2026, instância Windows da mantenedora): uma senha de app do Gmail digitada no chat para configurar
 * o himalaya foi parar no log de auditoria (primeiro pelo TelegramAdapter, que gravava 50 caracteres do texto), em 7
 * arquivos de avaliadores, numa transcrição, em 5 tabelas do banco (reflection_annotations, agent_traces,
 * memory_classifications, messages, goals) e nos prompts enviados aos modelos de nuvem.
 *
 * REGRESSÃO SE: uma senha reconhecível passar pelo MessageBus em claro; o adaptador voltar a logar o texto; uma ferramenta
 * receber o marcador em vez do valor (ou devolver o valor ao modelo); o logger ou o envio a um modelo deixarem passar um
 * valor do cofre; um marcador de chave de API do próprio NewClaw ser resolvido para uma ferramenta; ou prosa comum
 * ("a senha é complicada", quatro palavras de quatro letras) virar segredo.
 *
 * Execução: npx ts-node src/__tests__/regression/S395_Segredos_NuncaEmClaro.test.ts
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}
const src = (...p: string[]) => fs.readFileSync(path.join(process.cwd(), 'src', ...p), 'utf-8');

// Valores sintéticos — nenhum é credencial real.
const SENHA_APP = 'qwer tyui opas dfgh';
const SENHA_ROTULADA = 'Xk9#mP2vL7';
const CHAVE_SK = 'sk-' + 'A'.repeat(10) + 'b'.repeat(12);

async function main(): Promise<void> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-s395-'));
    const envPath = path.join(dir, '.env');
    fs.writeFileSync(envPath, 'APP_LANG=pt-BR\n');
    const envAntes = { ...process.env };
    const seg = require('../../shared/segredos') as typeof import('../../shared/segredos');
    try {
        console.log('\n=== S395-1 — reconhecer: formatos e rótulos, sem confundir prosa ===');
        assert(seg.detectarSegredos(`a senha de app é ${SENHA_APP}`).includes(SENHA_APP), 'senha de app com palavra de credencial (pt-BR)');
        assert(seg.detectarSegredos(`my app password is ${SENHA_APP}`).includes(SENHA_APP), 'senha de app (en)');
        assert(seg.detectarSegredos(`la contraseña es ${SENHA_ROTULADA}`).includes(SENHA_ROTULADA), 'valor rotulado (es)');
        assert(seg.detectarSegredos(`password: ${SENHA_ROTULADA}.`).includes(SENHA_ROTULADA), 'valor rotulado com dois-pontos, sem a pontuação final');
        assert(seg.detectarSegredos(`use ${CHAVE_SK}`).includes(CHAVE_SK), 'formato inconfundível (sk-…) mesmo sem palavra de credencial');
        // Validação real (14/10/2026): estas duas passavam em claro — várias palavras entre o rótulo e o verbo, e o "é".
        assert(seg.detectarSegredos(`A senha do servidor de teste é ${SENHA_ROTULADA}`).includes(SENHA_ROTULADA), 'rótulo, várias palavras e o verbo "é" (a frase da validação real)');
        assert(seg.detectarSegredos(`a senha é ${SENHA_ROTULADA}`).includes(SENHA_ROTULADA), '"a senha é X" (o "é" precisa casar sem \\b)');
        assert(seg.detectarSegredos('a senha do wifi da casa é muito difícil de lembrar').length === 0, 'prosa com rótulo e "é", sem valor com cara de senha, não é guardada');
        assert(seg.detectarSegredos('esta casa fica logo ali, pode ir').length === 0, 'quatro palavras de quatro letras sem contexto de credencial não são senha');
        assert(seg.detectarSegredos('a senha é complicada demais para lembrar').length === 0, '"a senha é complicada" não guarda "complicada" (sem cara de senha)');

        console.log('\n=== S395-2 — guardar no cofre e trocar pelo marcador ===');
        const p1 = seg.protegerEntrada(`configure o gmail, a senha de app é ${SENHA_APP}`, envPath);
        assert(!p1.texto.includes(SENHA_APP) && /<SEGREDO:senha_1>/.test(p1.texto), 'o texto segue só com o marcador', p1.texto);
        assert(p1.guardados.length === 1 && process.env.SEGREDO_SENHA_1 === SENHA_APP, 'o valor foi para o cofre (process.env)');
        assert(fs.readFileSync(envPath, 'utf-8').includes('SEGREDO_SENHA_1='), 'e para o .env (sobrevive ao reinício)');
        const p2 = seg.protegerEntrada(`de novo: ${SENHA_APP}`, envPath);
        assert(p2.guardados.length === 0 && p2.texto.includes('<SEGREDO:senha_1>'), 'valor já guardado reaparece com o mesmo nome, sem duplicar', p2);
        const p3 = seg.protegerEntrada(`/segredo gmail ${SENHA_ROTULADA}`, envPath);
        assert(p3.texto === '/segredo gmail <SEGREDO:gmail>' && process.env.SEGREDO_GMAIL === SENHA_ROTULADA, '/segredo <nome> <valor> guarda com o nome dado', p3);
        assert(seg.nomesNoCofre().includes('gmail') && seg.nomesNoCofre().includes('senha_1'), 'o cofre lista só os nomes');

        console.log('\n=== S395-3 — mascarar e resolver ===');
        process.env.OPENROUTER_API_KEY = 'or-' + 'z'.repeat(20);
        const conhecidos = seg.segredosConhecidos({ ...process.env });
        assert(seg.mascararSegredos(`senha ${SENHA_APP} e chave ${process.env.OPENROUTER_API_KEY}`, conhecidos) === 'senha <SEGREDO:senha_1> e chave <SEGREDO:OPENROUTER_API_KEY>', 'valores do cofre e de chaves de API viram marcador');
        const resolvido = seg.resolverMarcadores({ cmd: 'login --pass <SEGREDO:gmail>', lista: ['<SEGREDO:senha_1>'], chave: '<SEGREDO:OPENROUTER_API_KEY>', x: '<SEGREDO:inexistente>' });
        assert(resolvido.cmd === `login --pass ${SENHA_ROTULADA}` && resolvido.lista[0] === SENHA_APP, 'o marcador do cofre vira o valor (em profundidade)');
        assert(resolvido.chave === '<SEGREDO:OPENROUTER_API_KEY>', 'chave de API do NewClaw NUNCA é entregue a uma ferramenta por marcador');
        assert(resolvido.x === '<SEGREDO:inexistente>', 'nome desconhecido fica como está (falha visível, nada adivinhado)');
        const comPasta = seg.segredosConhecidos({ WHATSAPP_AUTH_DIR: './data/whatsapp-auth', DASHBOARD_PASSWORD: 'Painel#2026x' });
        assert(comPasta.length === 1 && comPasta[0].nome === 'DASHBOARD_PASSWORD', 'nome sensível com valor de caminho (WHATSAPP_AUTH_DIR) não é mascarado; a senha do painel é', comPasta);

        console.log('\n=== S395-4 — ferramenta: recebe o valor, devolve o marcador ===');
        const { comSegredos } = require('../../core/ToolRegistry') as typeof import('../../core/ToolRegistry');
        class FerramentaEco { name = 'eco'; description = 'x'; parameters = {}; recebido = ''; contexto = '';
            setContext(c: string) { this.contexto = c; }
            async execute(args: Record<string, unknown>) { this.recebido = String(args.texto); return { success: true, output: `config: pass=${args.texto}` }; } }
        const original = new FerramentaEco();
        const embrulhada = comSegredos(original as any);
        const r = await embrulhada.execute({ texto: '<SEGREDO:gmail>' });
        assert(original.recebido === SENHA_ROTULADA, 'a ferramenta recebe o valor real na execução');
        assert(r.output === 'config: pass=<SEGREDO:gmail>', 'a saída volta mascarada (modelo, trace e log não veem o valor)', r.output);
        assert(comSegredos(embrulhada) === embrulhada && comSegredos(original as any) === embrulhada, 'idempotente: embrulhar de novo não resolve duas vezes');
        assert(embrulhada instanceof FerramentaEco && embrulhada.name === 'eco', 'nome e classe passam intactos');
        (embrulhada as any).setContext('chat-1');
        assert(original.contexto === 'chat-1', 'métodos como setContext continuam funcionando');

        console.log('\n=== S395-5 — logger e envio a modelos mascaram ===');
        const logFile = path.join(dir, 'audit.log');
        process.env.LOG_FILE = logFile;
        const { createLogger } = require('../../shared/AppLogger') as typeof import('../../shared/AppLogger');
        const stdout = process.stdout.write.bind(process.stdout);
        (process.stdout.write as unknown) = (): boolean => true;
        try { createLogger('S395').info('evento', `comando com ${SENHA_APP}`, { meta: SENHA_ROTULADA }); } finally { process.stdout.write = stdout; }
        await new Promise(res => setTimeout(res, 200));
        const linha = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf-8') : '';
        assert(linha.includes('<SEGREDO:senha_1>') && !linha.includes(SENHA_APP) && !linha.includes(SENHA_ROTULADA), 'o log de auditoria só tem marcadores', linha);
        const { ProviderFactory } = require('../../core/ProviderFactory') as typeof import('../../core/ProviderFactory');
        const pf = new ProviderFactory({ defaultProvider: 'espiao', ollamaUrl: 'http://127.0.0.1:1', customProviders: [{ label: 'espiao', baseUrl: 'http://127.0.0.1:2/v1', model: 'm' }] } as any);
        const enviados: string[] = [];
        (pf as any).providers.set('espiao', { name: 'espiao', model: 'm', setModel() {}, async chat(msgs: Array<{ content: string }>) { enviados.push(JSON.stringify(msgs)); return { content: 'ok' }; } });
        const pedido = [{ role: 'user' as const, content: `lembre: ${SENHA_APP}` }];
        await pf.chatWithFallback(pedido, undefined, 'espiao', 3000);
        assert(enviados.length === 1 && !enviados[0].includes(SENHA_APP) && enviados[0].includes('<SEGREDO:senha_1>'), 'o modelo recebe só o marcador', enviados);
        assert(pedido[0].content.includes(SENHA_APP), 'o array de quem chamou não é alterado');

        console.log('\n=== S395-6 — a ordem no caminho real da mensagem ===');
        const bus = src('channels', 'MessageBus.ts');
        const proc = bus.slice(bus.indexOf('async processMessage('), bus.indexOf('private async processMessageCore('));
        const iProteger = proc.indexOf('protegerEntrada(msg.text'); // S460: agora com o contexto da conversa
        const iLog = proc.indexOf("log.info('message_received'");
        assert(iProteger > 0 && iLog > iProteger, 'MessageBus protege a entrada ANTES do primeiro log do texto');
        assert(/<SEGREDO:nao_guardado>/.test(proc), 'se o cofre falhar, o valor sai da mensagem mesmo assim');
        const tg = src('channels', 'TelegramAdapter.ts');
        assert(!/text_message_received[^\n]*text\.slice/.test(tg) && /text_message_received[^\n]*chars=/.test(tg), 'o TelegramAdapter loga só o tamanho, não o texto');
        assert(/registerTool\(tool: ToolExecutor\): void \{ this\.tools\.set\(tool\.name, comSegredos\(tool\)\); \}/.test(src('loop', 'AgentLoop.ts')), 'o AgentLoop embrulha toda ferramenta registrada');
        assert(/messages = mascararProfundo\(messages\);/.test(src('core', 'ProviderFactory.ts')), 'o ProviderFactory mascara antes de qualquer provedor');
        assert(/SENHAS E CHAVES \(<SEGREDO:nome>\)/.test(src('core', 'agentControllerSetup.ts')), 'o agente sabe usar o marcador nos argumentos');
        const aprendizado = src('loop', 'aprendizadoDeSkills.ts');
        assert(/from '\.\.\/shared\/segredos'/.test(aprendizado) && !/const FORMATOS_DE_CREDENCIAL/.test(aprendizado), 'os padrões de credencial vivem num lugar só');

        console.log('\n=== S395-6b — o planejador não trata o marcador como placeholder (validação real, 14/10/2026) ===');
        {
            const { PLACEHOLDER_ARG_PATTERN } = require('../../shared/placeholderPatterns') as typeof import('../../shared/placeholderPatterns');
            assert(!PLACEHOLDER_ARG_PATTERN.test('password=<SEGREDO:senha_1>'), 'o marcador do cofre é um valor legítimo num argumento de plano');
            assert(PLACEHOLDER_ARG_PATTERN.test('password=<a senha>') && PLACEHOLDER_ARG_PATTERN.test('user=<usuario> pass=<SEGREDO:x>'), 'um placeholder de verdade continua sendo pego, mesmo ao lado de um marcador');
        }

        console.log('\n=== S395-6c — gravações diretas em disco também mascaram (validação real, 14/10/2026) ===');
        // O validador de conclusão lê o arquivo gerado direto do disco; o modelo recebeu o marcador (ProviderFactory), mas o
        // gravador de voo dos avaliadores registrava o prompt cru — o valor apareceu em logs/avaliadores.
        assert(/JSON\.stringify\(capar\(mascararProfundo\(/.test(src('shared', 'evaluatorFlightRecorder.ts')), 'o gravador de voo dos avaliadores mascara antes de gravar');
        assert(/JSON\.stringify\(mascararProfundo\(entry\)\)/.test(src('session', 'SessionTranscript.ts')), 'a transcrição da sessão mascara antes de gravar');

        console.log('\n=== S395-7 — apagar ===');
        assert(seg.apagarSegredo('gmail', envPath) && process.env.SEGREDO_GMAIL === undefined && !fs.readFileSync(envPath, 'utf-8').includes('SEGREDO_GMAIL='), '/segredo_apagar remove do cofre e do .env');
        assert(seg.avisoDeSegredoGuardado(['senha_1'], 'en-US').includes('vault') && seg.avisoDeSegredoGuardado(['senha_1'], 'es-ES').includes('bóveda'), 'aviso nas 3 línguas');
    } finally {
        for (const k of Object.keys(process.env)) if (!(k in envAntes)) delete process.env[k];
        Object.assign(process.env, envAntes);
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* o stream do log pode segurar o arquivo no Windows */ }
    }
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S395 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    process.exit(failed > 0 ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
