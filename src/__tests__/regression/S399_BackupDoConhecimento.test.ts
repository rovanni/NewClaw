/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S399 (ADR-020, Sprint A)
 * Backup do conhecimento: um pacote único que qualquer usuário salva e restaura — em qualquer sistema — sem perder o que
 * o NewClaw aprendeu, sem vazar senhas por padrão e sem aceitar arquivo malicioso.
 *
 * ORIGEM: "tem um jeito de toda essa inteligência, toda essa experiência salvar? … não é só para mim, é para qualquer
 * usuário" (mantenedora, 14/10/2026). O backup antigo salvava só o banco e o .env: uma instalação do zero perdia as skills
 * em arquivo (várias nem estão no git), o perfil dos juízes e o histórico.
 *
 * REGRESSÃO SE: o pacote deixar de levar banco, skills ou perfil dos juízes; senhas/chaves ou pastas ocultas do workspace
 * entrarem sem escolha explícita; um zip com "../", sem manifesto, de versão mais nova ou com banco corrompido for aceito;
 * a restauração não guardar antes o estado atual; ou uma skill com caminho de outro sistema entrar ativa.
 *
 * Execução: npx ts-node src/__tests__/regression/S399_BackupDoConhecimento.test.ts
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import JSZip from 'jszip';
import Database from 'better-sqlite3';
import * as bk from '../../core/backupDoConhecimento';
import { VERSAO_DO_ESQUEMA } from '../../memory/memorySchema';
import { SkillLearner } from '../../loop/SkillLearner';
import { SkillLoader } from '../../skills/SkillLoader';
import { montarTrajetoria } from '../../loop/aprendizadoDeSkills';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}

function instalacao(raiz: string, comConteudo: boolean): bk.Caminhos {
    const c: bk.Caminhos = { raiz, dados: path.join(raiz, 'data'), skills: path.join(raiz, 'skills'), workspace: path.join(raiz, 'workspace'), env: path.join(raiz, '.env') };
    fs.mkdirSync(c.dados, { recursive: true });
    if (!comConteudo) return c;
    const db = new Database(path.join(c.dados, 'newclaw.db'));
    db.exec('CREATE TABLE memory_nodes (id TEXT PRIMARY KEY, name TEXT, content TEXT)');
    db.prepare('INSERT INTO memory_nodes VALUES (?, ?, ?)').run('m1', 'clima', 'Cidade padrão');
    db.prepare('INSERT INTO memory_nodes VALUES (?, ?, ?)').run('m2', 'gmail', 'Acesso via himalaya');
    db.pragma(`user_version = ${VERSAO_DO_ESQUEMA}`);
    db.close();
    fs.writeFileSync(path.join(c.dados, 'validation-judge-profile.json'), '{"modelo":{"medidas":3}}');
    fs.mkdirSync(path.join(c.dados, 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(c.dados, 'sessions', 'conversa.jsonl'), '{"role":"user","content":"oi"}\n');
    fs.mkdirSync(path.join(c.skills, 'resumo-de-texto'), { recursive: true });
    fs.writeFileSync(path.join(c.skills, 'resumo-de-texto', 'SKILL.md'), '---\nname: resumo-de-texto\n---\nResuma em 3 tópicos.');
    fs.mkdirSync(path.join(c.skills, 'ler-email'), { recursive: true });
    fs.writeFileSync(path.join(c.skills, 'ler-email', 'SKILL.md'), '---\nname: ler-email\n---\nA senha fica em C:/Users/alguem/.hermes/pass e o binário em C:\\Tools\\himalaya.exe');
    fs.mkdirSync(path.join(c.workspace, '.hermes'), { recursive: true });
    fs.writeFileSync(path.join(c.workspace, '.hermes', 'gmail-app-pass'), 'segredo-sintetico');
    fs.writeFileSync(path.join(c.workspace, 'notas.txt'), 'minhas notas');
    fs.writeFileSync(c.env, 'OPENROUTER_API_KEY=chave-sintetica-123456\n');
    return c;
}

async function nomesNoZip(arquivo: string): Promise<string[]> {
    return Object.keys((await JSZip.loadAsync(fs.readFileSync(arquivo))).files).filter(n => !n.endsWith('/'));
}

async function zipCom(arquivo: string, entradas: Record<string, string | Buffer>): Promise<void> {
    const z = new JSZip();
    for (const [n, v] of Object.entries(entradas)) z.file(n, v);
    fs.writeFileSync(arquivo, await z.generateAsync({ type: 'nodebuffer' }));
}

async function main(): Promise<void> {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-s399-'));
    try {
        const origem = instalacao(path.join(base, 'origem'), true);
        const saida = path.join(base, 'pacotes');

        console.log('\n=== S399-1 — por padrão: banco, skills e perfil dos juízes; segredos, histórico e workspace FORA ===');
        const { arquivo, manifesto } = await bk.criarPacote(saida, {}, origem);
        const nomes = await nomesNoZip(arquivo);
        assert(nomes.includes('data/newclaw.db') && nomes.includes('data/validation-judge-profile.json') && nomes.includes('skills/resumo-de-texto/SKILL.md'), 'banco, perfil dos juízes e skills em arquivo entram', nomes);
        assert(!nomes.includes('.env') && !nomes.some(n => n.includes('.hermes')), 'nenhuma senha ou chave entra sem escolha explícita', nomes);
        assert(!nomes.some(n => n.startsWith('data/sessions/') || n.startsWith('workspace/')), 'histórico e workspace só se a pessoa escolher', nomes);
        assert(manifesto.contagens.memorias === 2 && manifesto.contagens.skills === 2 && manifesto.sistema === process.platform && manifesto.esquema === VERSAO_DO_ESQUEMA, 'o manifesto descreve o conteúdo (memórias, skills, sistema, esquema)', manifesto);
        const textoDoManifesto = JSON.stringify(manifesto);
        assert(!textoDoManifesto.includes(os.hostname()) && !textoDoManifesto.includes(os.userInfo().username), 'o manifesto não leva nome de máquina nem de usuário');

        console.log('\n=== S399-2 — opções: histórico, workspace (sem pastas ocultas) e segredos ===');
        const com = await nomesNoZip((await bk.criarPacote(saida, { historico: true, workspace: true }, origem)).arquivo);
        assert(com.includes('data/sessions/conversa.jsonl') && com.includes('workspace/notas.txt'), 'histórico e workspace entram quando escolhidos', com);
        assert(!com.some(n => n.includes('.hermes')) && !com.includes('.env'), 'workspace sem "segredos": pastas ocultas (credenciais) ficam fora', com);
        const tudo = await nomesNoZip((await bk.criarPacote(saida, { workspace: true, segredos: true }, origem)).arquivo);
        assert(tudo.includes('.env') && tudo.includes('workspace/.hermes/gmail-app-pass'), 'com "segredos" marcado, .env e pastas ocultas entram', tudo);

        console.log('\n=== S399-3 — arquivos que NÃO podem ser aceitos ===');
        const ruim = path.join(base, 'ruim.zip');
        const manifestoOk = JSON.stringify({ ...manifesto });
        const recusa = async (entradas: Record<string, string | Buffer>, padrao: RegExp, msg: string) => {
            await zipCom(ruim, entradas);
            let erro = '';
            try { await bk.lerPacote(ruim); } catch (e) { erro = (e as Error).message; }
            assert(padrao.test(erro), msg, erro);
        };
        await recusa({ 'manifesto.json': manifestoOk, '../../fora.txt': 'x' }, /fora do formato esperado/, 'travessia de caminho ("../") é recusada');
        await recusa({ 'manifesto.json': manifestoOk, 'skills/../../x': 'x' }, /fora do formato esperado/, '"../" no meio do caminho também');
        await recusa({ 'skills/a/SKILL.md': 'x' }, /falta o manifesto/, 'zip sem manifesto não é backup do NewClaw');
        await recusa({ 'manifesto.json': JSON.stringify({ ...manifesto, formato: bk.VERSAO_DO_FORMATO + 1 }) }, /versão mais nova/, 'formato mais novo que o app é recusado com mensagem clara');
        await recusa({ 'manifesto.json': JSON.stringify({ ...manifesto, esquema: VERSAO_DO_ESQUEMA + 1 }) }, /versão mais nova/, 'banco de esquema mais novo que o app é recusado');
        assert(bk.nomeSeguro('skills/x/SKILL.md') && !bk.nomeSeguro('C:/x') && !bk.nomeSeguro('/etc/passwd') && !bk.nomeSeguro('outra/pasta.txt'), 'nomes aceitos só dentro das pastas conhecidas');
        const destinoCorrompido = instalacao(path.join(base, 'destino-corrompido'), false);
        await zipCom(ruim, { 'manifesto.json': manifestoOk, 'data/newclaw.db': Buffer.from('isto não é um banco sqlite') });
        let erroBanco = '';
        try { await bk.restaurarPacote(ruim, {}, destinoCorrompido, path.join(base, 'seg-corrompido')); } catch (e) { erroBanco = (e as Error).message; }
        assert(erroBanco.length > 0 && !fs.existsSync(path.join(destinoCorrompido.dados, '.restore-pending')), 'banco corrompido é recusado ANTES de qualquer escrita', erroBanco);

        console.log('\n=== S399-4 — restaurar numa instalação nova (o caso "instalei do zero") ===');
        const destino = instalacao(path.join(base, 'destino'), false);
        const pacoteCompleto = (await bk.criarPacote(saida, { historico: true }, origem)).arquivo;
        const rel = await bk.restaurarPacote(pacoteCompleto, {}, destino, path.join(base, 'seg'));
        assert(rel.banco && fs.existsSync(path.join(destino.dados, 'newclaw.db.restore')) && fs.existsSync(path.join(destino.dados, '.restore-pending')), 'o banco fica agendado para o próximo início (mesmo mecanismo do restore existente)');
        assert(fs.existsSync(path.join(destino.skills, 'resumo-de-texto', 'SKILL.md')) && rel.skills === 2, 'as skills voltam', rel);
        assert(fs.existsSync(path.join(destino.dados, 'validation-judge-profile.json')) && fs.existsSync(path.join(destino.dados, 'sessions', 'conversa.jsonl')), 'perfil dos juízes e histórico voltam');
        assert(fs.existsSync(rel.pacoteDeSeguranca) && /pre-restauracao-/.test(rel.pacoteDeSeguranca), 'antes de restaurar, o estado atual vira um pacote de segurança', rel.pacoteDeSeguranca);
        assert(!fs.existsSync(destino.env), 'sem pedir, o .env não é restaurado');
        assert(rel.skillsParaRevisar.length === 0, 'mesmo sistema: nada vai para revisão');

        console.log('\n=== S399-5 — backup de OUTRO sistema: skill com caminho de lá entra para revisão ===');
        // Simula "o outro sistema" a partir de onde o teste roda — vale no Windows, no Linux e no macOS.
        const outro = process.platform === 'win32' ? 'linux' : 'win32';
        const caminhoDoOutro = outro === 'win32' ? 'C:/Users/alguem/.hermes/pass' : '/home/alguem/.hermes/pass';
        const z = await JSZip.loadAsync(fs.readFileSync(pacoteCompleto));
        const m = JSON.parse(await z.file('manifesto.json')!.async('string'));
        z.file('manifesto.json', JSON.stringify({ ...m, sistema: outro }));
        z.file('skills/ler-email/SKILL.md', `---\nname: ler-email\n---\nA senha fica em ${caminhoDoOutro}`);
        const deOutroSistema = path.join(base, 'de-outro-sistema.zip');
        fs.writeFileSync(deOutroSistema, await z.generateAsync({ type: 'nodebuffer' }));
        {
            const destino2 = instalacao(path.join(base, 'destino2'), false);
            const lido = await bk.lerPacote(deOutroSistema);
            assert(lido.avisos.some(a => /outro sistema/.test(a)), 'a leitura avisa que o backup é de outro sistema', lido.avisos);
            const rel2 = await bk.restaurarPacote(deOutroSistema, {}, destino2, path.join(base, 'seg2'));
            assert(rel2.skillsParaRevisar.includes('ler-email') && fs.existsSync(path.join(destino2.skills, 'ler-email', 'SKILL.md.revisar')) && !fs.existsSync(path.join(destino2.skills, 'ler-email', 'SKILL.md')), 'a skill com caminho do outro sistema fica inativa, para revisão (não é reescrita por palpite)', rel2);
            assert(fs.existsSync(path.join(destino2.skills, 'resumo-de-texto', 'SKILL.md')), 'a skill sem caminho volta normalmente');
        }
        assert(bk.temCaminhoDeOutroSistema('use C:\\Tools\\x.exe', 'win32', 'linux') && bk.temCaminhoDeOutroSistema('em /home/fulano/x', 'linux', 'win32') && bk.temCaminhoDeOutroSistema('em /Users/fulano/x', 'darwin', 'linux'), 'caminhos típicos de cada sistema são reconhecidos');
        assert(!bk.temCaminhoDeOutroSistema('use C:\\Tools\\x.exe', 'win32', 'win32') && !bk.temCaminhoDeOutroSistema('Resuma em 3 tópicos', 'win32', 'linux'), 'mesmo sistema, ou texto sem caminho: nada a revisar');
        console.log('\n=== S399-7 — skill APRENDIDA: backup → restaurar numa instalação limpa, sem a pasta de origem (ADR-036) ===');
        {
            // A skill nasce pelo caminho real (SkillLearner), com cercas de código e acento no corpo.
            const A = instalacao(path.join(base, 'aprendiz'), false);
            const dbA = new Database(path.join(A.dados, 'newclaw.db'));
            dbA.exec('CREATE TABLE memory_nodes (id TEXT PRIMARY KEY, name TEXT, content TEXT)');
            dbA.pragma(`user_version = ${VERSAO_DO_ESQUEMA}`);
            const procedimento = '1. Liste os arquivos:\n```powershell\nGet-ChildItem -Recurse\n```\n2. Rode o script:\n```powershell\nnode <script>\n```';
            const resposta = JSON.stringify({
                aprender: true, motivo: 'procedimento reutilizável', nome: 'Executar script Node', titulo: 'Executar script Node no workspace',
                descricao: 'Quando o usuário pedir para rodar um script Node que está no workspace.', gatilhos: ['node', 'script'],
                ferramentas: ['exec_command'], procedimento, cuidados: 'Confira o caminho antes de rodar.', aviso: 'Aprendi a rodar scripts Node.',
            });
            const trajetoria = montarTrajetoria([
                { toolName: 'exec_command', args: { command: 'Get-ChildItem -Recurse' }, result: 'success' },
                { toolName: 'exec_command', args: { command: 'node script.js' }, result: 'success' },
            ], () => undefined);
            const aprendizA = new SkillLearner(dbA, A.skills);
            const aprendida = await aprendizA.aprenderComTrajetoria(
                { goalId: 'g-s399', pedido: 'rode o script que está na pasta de trabalho', objetivo: 'rodar script', plataforma: process.platform, trajetoria, segredos: [] },
                async () => resposta);
            assert(aprendida.aprendida, 'a skill foi aprendida pelo caminho real', aprendida);
            const linhaA = dbA.prepare('SELECT * FROM auto_skills').get() as Record<string, unknown>;
            const pastas = fs.readdirSync(A.skills);
            const pasta = pastas[0] ?? '';
            const bytesA = fs.readFileSync(path.join(A.skills, pasta, 'SKILL.md'));
            assert(pastas.length === 1 && /^aprendida_/.test(pasta) && linhaA.file_exported === 1, 'nasce numa pasta aprendida_<nome>, com a linha marcada como exportada', { pastas, file_exported: linhaA.file_exported });
            const pacoteA = (await bk.criarPacote(saida, {}, A)).arquivo;
            dbA.close();
            fs.rmSync(A.raiz, { recursive: true, force: true });
            assert(!fs.existsSync(A.skills) && !fs.existsSync(A.dados), 'a pasta de origem deixou de existir: a restauração só tem o pacote');

            const B = instalacao(path.join(base, 'restaurada'), false);
            const relB = await bk.restaurarPacote(pacoteA, {}, B, path.join(base, 'seg-aprendida'));
            const arquivoB = path.join(B.skills, pasta, 'SKILL.md');
            assert(relB.skills === 1 && fs.existsSync(arquivoB) && fs.readFileSync(arquivoB).equals(bytesA), 'o SKILL.md aprendido volta, byte a byte', relB);

            const carregador = new SkillLoader(B.skills); carregador.loadAll();
            const skB = carregador.getSkill(String(linhaA.name));
            assert(!!skB && skB.content.includes('```powershell\nGet-ChildItem -Recurse\n```') && skB.content.includes('que está na pasta'),
                'o SkillLoader da instalação restaurada carrega a skill, com as cercas de código e os acentos', skB?.content.slice(0, 160));

            const restaurado = path.join(B.dados, 'newclaw.db.restore');
            const dbB = new Database(restaurado, { readonly: true });
            const linhaB = dbB.prepare('SELECT * FROM auto_skills WHERE id = ?').get(String(linhaA.id)) as Record<string, unknown> | undefined;
            dbB.close();
            assert(!!linhaB && JSON.stringify(linhaB) === JSON.stringify(linhaA), 'a linha de auto_skills volta idêntica em todas as colunas (id, corpo, status, datas, origem, file_exported)', { linhaA, linhaB });

            // Fonte de verdade é o banco: sem o arquivo, ele se reconstrói do banco, byte a byte.
            const copiaDoBanco = path.join(base, 'copia-do-banco-restaurado.db');
            fs.copyFileSync(restaurado, copiaDoBanco);
            const dbC = new Database(copiaDoBanco);
            const pastaReconstruida = path.join(base, 'skills-reconstruidas');
            const aprendizC = new SkillLearner(dbC, pastaReconstruida);
            const reativou = aprendizC.deactivateSkill(String(linhaA.id)) && aprendizC.activateSkill(String(linhaA.id));
            dbC.close();
            const arquivoC = path.join(pastaReconstruida, pasta, 'SKILL.md');
            assert(reativou && fs.existsSync(arquivoC) && fs.readFileSync(arquivoC).equals(bytesA), 'sem o arquivo, ele é reconstruído só a partir do banco, idêntico ao original');
        }

        console.log('\n=== S399-6 — painel, linha de comando e textos usam o MESMO módulo ===');
        const ler = (...p: string[]) => fs.readFileSync(path.join(process.cwd(), ...p), 'utf-8');
        const rota = ler('src', 'dashboard', 'routes', 'maintenance.ts');
        assert(/router\.post\('\/backup\/conhecimento'/.test(rota) && /\/backup\/conhecimento\/inspecionar/.test(rota) && /\/backup\/conhecimento\/restaurar/.test(rota), 'rotas de criar, inspecionar e restaurar');
        assert(/await lerPacote\(tmp\)/.test(rota), 'o envio de .zip é validado antes de ser aceito');
        const tela = ler('src', 'dashboard', 'public', 'config', 'views', 'BackupView.js');
        assert(/inspectKnowledgeBackup\(name\)/.test(tela) && tela.indexOf('inspectKnowledgeBackup(name)') < tela.indexOf('restoreKnowledgeBackup('), 'a tela mostra o conteúdo ANTES de restaurar');
        const cli = ler('bin', 'newclaw');
        assert(/async backup\(args = \[\]\)/.test(cli) && /restaurarConhecimento\(pacote, args\)/.test(cli) && /dist', 'core', 'backupDoConhecimento\.js'/.test(cli), 'newclaw backup / restore <a.zip> usam o módulo compilado');
        const textos = ler('src', 'dashboard', 'public', 'shared.js');
        for (const k of ['bkp_conh_title', 'bkp_conh_desc', 'bkp_conh_opt_secrets_hint', 'bkp_conh_restore_summary', 'bkp_conh_restored_toast']) {
            assert((textos.match(new RegExp(`\\b${k}:`, 'g')) || []).length === 3, `texto "${k}" nas 3 línguas`);
        }
    } finally {
        try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* ok */ }
    }
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S399 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    process.exit(failed > 0 ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
