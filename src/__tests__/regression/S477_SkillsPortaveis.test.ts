/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S477 (ADR-035, aceita em 04/11/2026: skills portáveis entre sistemas)
 *
 * Cobre o plano da ADR: o leitor com os campos novos e os marcadores (etapa 1), o aprendizado gravando marcadores e o
 * cabeçalho (2), os avisos no catálogo e no conteúdo com o `requer` em três estados (3), a importação lendo o cabeçalho
 * antes do detector (4), a migração com relatório, numa cópia, com pacote de segurança (5), e o "funcionou aqui" (6).
 *
 * Real: SkillLoader, SkillLearner (ensureTable/exportSkillFile), importarPacote, a migração e os arquivos em pastas
 * temporárias. Imitado: só a sonda de programas, onde o teste precisa de um programa que "falta" de forma determinística.
 *
 * Execução: npx ts-node src/__tests__/regression/S477_SkillsPortaveis.test.ts
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import * as sl from '../../skills/SkillLoader';
import * as mig from '../../skills/migracaoDePortabilidade';
import * as bk from '../../core/backupDoConhecimento';
import { SkillLearner } from '../../loop/SkillLearner';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}

const AQUI = process.platform;
const OUTRO = AQUI === 'win32' ? 'linux' : 'win32';
const skillMd = (cab: string, corpo: string) => `---\nname: x\ndescription: d\n${cab}---\n${corpo}\n`;

async function main(): Promise<void> {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-s477-'));
    try {
        console.log('\n=== S477-1 — marcadores: expandir com o separador certo, nos três sistemas ===');
        const win: sl.PastasDaInstalacao = { newclaw: 'C:\\NC', workspace: 'C:\\NC\\workspace', skills: 'C:\\NC\\skills', pastas: { aulas: 'D:\\Aulas' } };
        const lin: sl.PastasDaInstalacao = { newclaw: '/opt/nc', workspace: '/opt/nc/workspace', skills: '/opt/nc/skills', pastas: { aulas: '/srv/aulas' } };
        const texto = 'Rode {WORKSPACE}/tmp/a.py e abra "{PASTA:aulas}\\2026/prova.docx"; veja {SKILLS}.';
        const ew = sl.expandirMarcadores(texto, win, '\\');
        const el = sl.expandirMarcadores(texto, lin, '/');
        assert(ew.texto === 'Rode C:\\NC\\workspace\\tmp\\a.py e abra "D:\\Aulas\\2026\\prova.docx"; veja C:\\NC\\skills.', 'Windows: marcador e o resto do caminho com \\', ew.texto);
        assert(el.texto === 'Rode /opt/nc/workspace/tmp/a.py e abra "/srv/aulas/2026/prova.docx"; veja /opt/nc/skills.', 'Linux (e macOS): com /', el.texto);
        const semPasta = sl.expandirMarcadores('cp {PASTA:fotos}/x.jpg {DESCONHECIDO}/y', lin, '/');
        assert(semPasta.texto === 'cp {PASTA:fotos}/x.jpg {DESCONHECIDO}/y' && JSON.stringify(semPasta.semPasta) === '["fotos"]', 'nome sem pasta e marcador desconhecido ficam intactos; o nome sem pasta é informado', semPasta);

        console.log('\n=== S477-2 — aprender: prefixos viram marcadores (o mais longo ganha; maiúsculas no Windows) ===');
        const marcadoW = sl.marcarCaminhos('Gravei em C:\\nc\\Workspace\\out\\r.pdf e li d:\\aulas\\p.docx; o app fica em C:\\NC.', win, 'win32');
        assert(marcadoW === 'Gravei em {WORKSPACE}\\out\\r.pdf e li {PASTA:aulas}\\p.docx; o app fica em {NEWCLAW}.', 'Windows: sem diferença de maiúsculas; o workspace ganha do NEWCLAW', marcadoW);
        assert(sl.marcarCaminhos('o arquivo C:\\NC.txt e (C:\\NC)', win, 'win32') === 'o arquivo C:\\NC.txt e ({NEWCLAW})', 'um arquivo que só começa igual (C:\\NC.txt) não é trocado; entre parênteses é', sl.marcarCaminhos('o arquivo C:\\NC.txt e (C:\\NC)', win, 'win32'));
        const marcadoL = sl.marcarCaminhos('ls /opt/nc/skills/a e /opt/ncx/b e /OPT/nc/workspace', lin, 'linux');
        assert(marcadoL === 'ls {SKILLS}/a e /opt/ncx/b e /OPT/nc/workspace', 'Linux: diferença de maiúsculas conta; prefixo parecido (/opt/ncx) não é trocado', marcadoL);

        console.log('\n=== S477-3 — leitor: campos novos, resumo independente de CRLF, compatibilidade ===');
        const dirSk = path.join(base, 'skills');
        const escrever = (pasta: string, t: string) => { fs.mkdirSync(path.join(dirSk, pasta), { recursive: true }); fs.writeFileSync(path.join(dirSk, pasta, 'SKILL.md'), t); };
        const corpo = 'Rode {WORKSPACE}/tmp/a.py';
        const resumo = sl.resumoDoCorpo(corpo);
        assert(sl.resumoDoCorpo('linha 1\r\nlinha 2') === sl.resumoDoCorpo('linha 1\nlinha 2'), 'o mesmo corpo com CRLF e com LF dá o mesmo resumo');
        escrever('antiga', skillMd('triggers: a,b\n', 'Corpo antigo sem campos.'));
        escrever('nova', skillMd(`triggers: a\nsistema_origem: ${AQUI}\nvalidada_em: ${AQUI}@${resumo}\nplataformas: todas\nformato_skill: 1\n`, corpo));
        escrever('outro-sistema', skillMd(`plataformas: ${OUTRO}\nformato_skill: 1\n`, 'Passos do outro sistema.'));
        escrever('nao-validada', skillMd(`validada_em: ${OUTRO}@${resumo}\nformato_skill: 1\n`, corpo));
        escrever('editada', skillMd(`validada_em: ${AQUI}@00000000\nformato_skill: 1\n`, corpo));
        escrever('requisitos', skillMd('requer: programa-que-falta-s477, node, nome com espaco\nformato_skill: 1\n', 'Use os programas.'));
        escrever('pasta-faltando', skillMd('formato_skill: 1\n', 'Abra {PASTA:fotos}/x.jpg'));
        for (const p of ['antiga', 'nova', 'outro-sistema', 'nao-validada', 'editada', 'requisitos', 'pasta-faltando']) {
            const arq = path.join(dirSk, p, 'SKILL.md');
            fs.writeFileSync(arq, fs.readFileSync(arq, 'utf8').replace(/^name: x$/m, `name: ${p}`));
        }
        const pastasLocais = { ...lin, skills: dirSk, newclaw: base, workspace: path.join(base, 'ws') };
        const loader = new sl.SkillLoader(dirSk, () => pastasLocais);
        const todas = loader.loadAll();
        const s = (n: string) => todas.find(x => x.name === n)!;
        assert(todas.length === 7, 'nenhuma skill some do catálogo (inclusive a feita para outro sistema)', todas.map(x => x.name));
        assert(!s('antiga').avisos?.curtos.length && s('antiga').content === 'Corpo antigo sem campos.', 'sem os campos novos: igual a antes (sem aviso, corpo intacto)');
        assert(s('nova').sistemaOrigem === AQUI && s('nova').validadaEm?.[0]?.resumo === resumo && !s('nova').avisos?.curtos.length
            && s('nova').content.includes(path.join(base, 'ws')), 'validada neste sistema com este corpo: carrega normal, marcador expandido', s('nova'));
        assert(s('outro-sistema').avisos!.curtos.includes(`feita para ${OUTRO}`) && /feita só para/.test(s('outro-sistema').content), 'feita para outro sistema: carrega, com o aviso no catálogo e no conteúdo (D3)');
        assert(s('nao-validada').avisos!.curtos.some(a => /ainda não validada/.test(a)), 'validada em outro sistema, não neste: aviso "ainda não neste sistema"', s('nao-validada').avisos);
        assert(s('editada').avisos!.curtos.includes('validada numa versão anterior'), 'corpo editado depois da validação: "versão anterior"', s('editada').avisos);
        const r = s('requisitos').avisos!.curtos.join(' | ');
        assert(/falta: programa-que-falta-s477/.test(r) && !/falta:.*node/.test(r) && /não verificado: nome com espaco/.test(r), 'requer: encontrado (node), falta e não verificado — três estados', r);
        assert(s('pasta-faltando').avisos!.curtos.includes('pasta não configurada: fotos') && s('pasta-faltando').content.includes('{PASTA:fotos}'), 'pasta não configurada: aviso e marcador intacto');
        assert(/\[feita para /.test(loader.getSkillSummaries()) && sl.linhaDoCatalogo(s('outro-sistema'), '  ').startsWith('  - outro-sistema: d ['), 'os avisos curtos entram no catálogo (roteador e planejador pela mesma função)');
        const avisoDeterminista = sl.avisosDaSkill({ name: 'r', description: '', requer: ['a', 'b', 'c'] }, 'x', [], AQUI, p => p === 'a' ? 'encontrado' : p === 'b' ? 'falta' : 'nao_verificado');
        assert(JSON.stringify(avisoDeterminista.curtos) === JSON.stringify(['falta: b', 'não verificado: c']), 'requisito: nunca "provavelmente tem"');

        console.log('\n=== S477-4 — aprender: o SKILL.md regerado do banco tem o cabeçalho e marcadores ===');
        const raizL = path.join(base, 'learner');
        fs.mkdirSync(path.join(raizL, 'skills'), { recursive: true });
        const dbL = new Database(':memory:');
        const learner = new SkillLearner(dbL, path.join(raizL, 'skills'));
        const cols = (dbL.prepare('PRAGMA table_info(auto_skills)').all() as Array<{ name: string }>).map(c => c.name);
        assert(['sistema_origem', 'validada_em', 'plataformas', 'requer', 'instalacao_origem', 'origem_instalacao'].every(c => cols.includes(c)), 'auto_skills ganhou as colunas da ADR-035 (e a origem da ADR-034)');
        const corpoL = 'Rode {WORKSPACE}/r.py';
        dbL.prepare(`INSERT INTO auto_skills (id, name, trigger, description, prompt, status, source_pattern, sistema_origem, validada_em) VALUES ('s1', 'relatorio', 'rel', 'd', ?, 'inactive', 'aprendida_relatorio', ?, ?)`)
            .run(corpoL, AQUI, `${AQUI}@${sl.resumoDoCorpo(corpoL)}`);
        learner.activateSkill('s1');
        const regerado = fs.readFileSync(path.join(raizL, 'skills', 'aprendida_relatorio', 'SKILL.md'), 'utf8');
        assert(new RegExp(`^sistema_origem: ${AQUI}$`, 'm').test(regerado) && /^validada_em: [a-z0-9]+@[0-9a-f]{8}$/m.test(regerado) && /^formato_skill: 1$/m.test(regerado) && regerado.includes('{WORKSPACE}/r.py'),
            'exportSkillFile escreve os campos; o corpo guarda o marcador', regerado);
        const carregadaL = new sl.SkillLoader(path.join(raizL, 'skills'), () => ({ ...pastasLocais, skills: path.join(raizL, 'skills') })).loadAll().find(x => x.name === 'relatorio');
        assert(!!carregadaL && !carregadaL.avisos?.curtos.length, 'a skill aprendida carrega validada neste sistema, sem aviso', carregadaL?.avisos);
        dbL.close();

        console.log('\n=== S477-5 — importação lê o cabeçalho: marcadores seguem a ADR-017; caminho literal fica proposto ===');
        const mk = (raiz: string): bk.Caminhos => {
            const c = { raiz, dados: path.join(raiz, 'data'), skills: path.join(raiz, 'skills'), workspace: path.join(raiz, 'workspace'), env: path.join(raiz, '.env') };
            fs.mkdirSync(c.dados, { recursive: true }); fs.mkdirSync(c.skills, { recursive: true });
            return c;
        };
        const origem = mk(path.join(base, 'origem'));
        const destino = mk(path.join(base, 'destino'));
        const literal = OUTRO === 'win32' ? 'C:\\Users\\alguem\\x.exe' : '/home/alguem/x';
        for (const [pasta, corpoX] of [['so-marcadores', 'Rode {WORKSPACE}/a.py'], ['com-literal', `Rode ${literal}`], ['sem-cabecalho', `Rode ${literal}`]] as const) {
            fs.mkdirSync(path.join(origem.skills, pasta), { recursive: true });
            const cab = pasta === 'sem-cabecalho' ? '' : `sistema_origem: ${OUTRO}\nplataformas: ${OUTRO}\nformato_skill: 1\n`;
            fs.writeFileSync(path.join(origem.skills, pasta, 'SKILL.md'), skillMd(cab, corpoX).replace('name: x', `name: ${pasta}`));
        }
        const { arquivo } = await bk.criarPacote(path.join(base, 'pkgs'), {}, origem, 'teste');
        // O pacote veio de OUTRO sistema: reescreve o manifesto interno.
        const JSZip = (await import('jszip')).default;
        const z = await JSZip.loadAsync(fs.readFileSync(arquivo));
        const man = JSON.parse(await z.file('manifesto.json')!.async('string')); man.sistema = OUTRO;
        z.file('manifesto.json', JSON.stringify(man));
        fs.writeFileSync(arquivo, await z.generateAsync({ type: 'nodebuffer' }));
        const rel = await bk.importarPacote(arquivo, destino, undefined, path.join(base, 'seg'), { origemInstalacao: 'outra', modo: 'automatico' });
        const ativo = (p: string) => fs.existsSync(path.join(destino.skills, p, 'SKILL.md'));
        const proposto = (p: string) => fs.existsSync(path.join(destino.skills, p, 'SKILL.md.revisar'));
        assert(ativo('so-marcadores') && !proposto('so-marcadores'), 'só marcadores, vinda de outro sistema: segue a ADR-017 (automático → ativa), mesmo feita para outro sistema', rel.skills);
        assert(proposto('com-literal') && !ativo('com-literal'), 'caminho literal de outro sistema: proposta');
        assert(proposto('sem-cabecalho'), 'sem cabeçalho: o detector decide, como antes');
        const importada = new sl.SkillLoader(destino.skills, () => ({ newclaw: destino.raiz, workspace: destino.workspace, skills: destino.skills, pastas: {} })).loadAll().find(x => x.name === 'so-marcadores');
        assert(!!importada && importada.content.includes(path.join(destino.workspace, 'a.py')) && importada.avisos!.curtos.includes(`feita para ${OUTRO}`),
            'a importada carrega com os caminhos DESTA instalação e com o aviso de outro sistema', importada?.content);

        console.log('\n=== S477-6 — migração: plano numa cópia, relatório, pastas só confirmadas, segurança antes de aplicar ===');
        const inst = mk(path.join(base, 'inst'));
        const db = new Database(path.join(inst.dados, 'newclaw.db'));
        db.exec(`CREATE TABLE auto_skills (id TEXT PRIMARY KEY, name TEXT, trigger TEXT, description TEXT, prompt TEXT, status TEXT, source_pattern TEXT, sistema_origem TEXT, validada_em TEXT, plataformas TEXT, requer TEXT)`);
        // Pasta pessoal literal que o detector reconhece no sistema: no Windows, a pasta temporária (C:\Users\…); no Unix, /home/…
        // (/tmp não é pasta pessoal para o detector da ADR-020 — o CI Ubuntu pegou em 05/11/2026).
        const PASTA_PESSOAL = AQUI === 'win32' ? path.join(base, 'Docs', 'Relatorios') : '/home/alguem/Docs/Relatorios';
        const corpoAprendida = `# Relatório\n\n> Aprendida automaticamente pelo NewClaw em 2026-10-20, ao concluir: "gera o relatório" (${AQUI}).\n\nRode ${inst.workspace}${path.sep}r.py e salve em ${PASTA_PESSOAL}${path.sep}a.pdf`;
        db.prepare(`INSERT INTO auto_skills (id, name, trigger, description, prompt, status, source_pattern) VALUES ('a1', 'relatorio', 'r', 'd', ?, 'active', 'aprendida_relatorio')`).run(corpoAprendida);
        db.close();
        const escreverEm = (c: bk.Caminhos, pasta: string, t: string) => { fs.mkdirSync(path.join(c.skills, pasta), { recursive: true }); fs.writeFileSync(path.join(c.skills, pasta, 'SKILL.md'), t); };
        escreverEm(inst, 'aprendida_relatorio', '---\r\nname: relatorio\r\ndescription: d\r\n---\r\n' + corpoAprendida.replace(/\n/g, '\r\n'));
        escreverEm(inst, 'manual', skillMd('', 'Skill escrita à mão.').replace('name: x', 'name: manual'));
        escreverEm(inst, 'ja-migrada', skillMd('formato_skill: 1\n', 'ok').replace('name: x', 'name: ja-migrada'));
        // Casos do plano REAL na cópia da produção (04/11/2026): "(windows)" no corpo, link https, pastas aninhadas, texto cortado.
        escreverEm(inst, 'aprendida_agenda', skillMd('', [
            '> Aprendida automaticamente pelo NewClaw em 2026-10-26, ao concluir: "veja D:\\…" (windows).',
            'Abra https://calendar.google.com e grave em D:\\Prof\\UENP\\a.docx e D:\\Prof\\UENP\\2026\\Disc\\b.docx.',
        ].join('\n')).replace('name: x', 'name: agenda'));
        const planoReal = mig.planejarMigracao(inst).itens.find(i => i.pasta === 'aprendida_agenda')!;
        assert(planoReal.sistemaOrigem === 'win32', '"(windows)" no corpo vira sistema_origem: win32 (nome do Node)', planoReal.sistemaOrigem);
        assert(!planoReal.caminhosLiterais.some(c => /calendar|^s:/i.test(c)) && !planoReal.caminhosLiterais.some(c => /^D:\\?$/.test(c)),
            'link https não é caminho; "D:\\…" cortado não é pasta', planoReal.caminhosLiterais);
        const propostasReais = mig.planejarMigracao(inst).pastasPropostas.filter(p => p.skills.includes('aprendida_agenda'));
        assert(propostasReais.length === 1 && propostasReais[0].caminho === 'D:\\Prof\\UENP' && propostasReais[0].nomeProposto === 'uenp',
            'pastas aninhadas viram uma proposta só, a de cima', propostasReais);
        fs.rmSync(path.join(inst.skills, 'aprendida_agenda'), { recursive: true, force: true });
        const antesDoPlano = fs.readFileSync(path.join(inst.skills, 'aprendida_relatorio', 'SKILL.md'), 'utf8');
        const plano = mig.planejarMigracao(inst);
        const it = (p: string) => plano.itens.find(i => i.pasta === p)!;
        assert(fs.readFileSync(path.join(inst.skills, 'aprendida_relatorio', 'SKILL.md'), 'utf8') === antesDoPlano, 'planejar não escreve nada');
        assert(it('aprendida_relatorio').sistemaOrigem === AQUI && it('aprendida_relatorio').camposNovos.some(c => c.startsWith(`validada_em: ${AQUI}@`)) && it('aprendida_relatorio').depois.includes('{WORKSPACE}'),
            'aprendida: sistema_origem tirado do corpo, validada_em com o resumo do corpo migrado, workspace vira marcador', it('aprendida_relatorio').camposNovos);
        assert(!/plataformas|requer/.test(it('aprendida_relatorio').camposNovos.join()), 'plataformas e requer ficam vazios (desconhecidos), sem chute');
        assert(it('aprendida_relatorio').depois.includes('\r\n---\r\n'), 'o final de linha do arquivo (CRLF) é mantido');
        assert(JSON.stringify(it('manual').camposNovos) === '["formato_skill: 1"]' && it('ja-migrada').jaMigrada, 'escrita à mão: só formato_skill: 1; já migrada: nada a fazer');
        const proposta = plano.pastasPropostas.find(p => p.caminho.endsWith('Relatorios'));
        assert(!!proposta && proposta.nomeProposto === 'relatorios' && it('aprendida_relatorio').caminhosLiterais.length === 1, 'pasta pessoal: listada com um nome PROPOSTO, e o caminho continua literal', plano.pastasPropostas);
        const md = mig.relatorioEmMarkdown(plano);
        assert(/só planejada, nada foi escrito/.test(md) && md.includes('{PASTA:relatorios}') && md.includes('aprendida_relatorio'), 'relatório em Markdown para revisar');
        const aplicada = await mig.aplicarMigracao(inst, { relatorios: PASTA_PESSOAL });
        const depois = fs.readFileSync(path.join(inst.skills, 'aprendida_relatorio', 'SKILL.md'), 'utf8');
        assert(aplicada.aplicado && !!aplicada.pacoteDeSeguranca && fs.existsSync(aplicada.pacoteDeSeguranca), 'aplicar: pacote de segurança antes');
        assert(depois.includes('{PASTA:relatorios}') && depois.includes(`sistema_origem: ${AQUI}`) && JSON.stringify(sl.lerTabelaDePastas(inst.dados)) === JSON.stringify({ relatorios: PASTA_PESSOAL }),
            'pasta confirmada vira {PASTA:nome} e entra na tabela local', depois);
        const linha = new Database(path.join(inst.dados, 'newclaw.db'), { readonly: true });
        const row = linha.prepare(`SELECT prompt, sistema_origem, validada_em FROM auto_skills WHERE id = 'a1'`).get() as { prompt: string; sistema_origem: string; validada_em: string };
        linha.close();
        assert(row.sistema_origem === AQUI && row.prompt.includes('{PASTA:relatorios}') && /@[0-9a-f]{8}$/.test(row.validada_em), 'a linha de auto_skills recebe o corpo migrado e os campos (regerar mantém o cabeçalho)', row);
        const carregadaM = new sl.SkillLoader(inst.skills, () => ({ newclaw: inst.raiz, workspace: inst.workspace, skills: inst.skills, pastas: sl.lerTabelaDePastas(inst.dados) })).loadAll().find(x => x.name === 'relatorio');
        assert(!!carregadaM && !carregadaM.avisos?.curtos.length && carregadaM.content.includes(PASTA_PESSOAL), 'depois da migração, a skill carrega validada aqui, com o caminho real da pasta', carregadaM?.avisos);

        console.log('\n=== S477-6b — decisão 17: skills soltas viram aprendidas ===');
        escreverEm(inst, 'gmail-himalaya', skillMd('triggers: email\n', 'Use o himalaya.').replace('name: x', 'name: gmail-himalaya'));
        escreverEm(inst, 'oficial', skillMd('', 'Versionada no git.').replace('name: x', 'name: oficial'));
        assert(mig.planejarAdocao(inst, undefined).length === 0, 'sem a lista do git (oficiais), nada é adotado');
        const soltas = mig.planejarAdocao(inst, new Set(['oficial', 'manual', 'ja-migrada']));
        assert(JSON.stringify(soltas.map(s => s.pasta)) === '["gmail-himalaya"]' && soltas[0].novaPasta === 'aprendida_gmail_himalaya',
            'solta = fora do git, sem prefixo e sem linha em auto_skills; a pasta nova é a que o SkillLearner daria', soltas);
        const ad = await mig.aplicarAdocao(inst, soltas);
        const dbAd = new Database(path.join(inst.dados, 'newclaw.db'), { readonly: true });
        const linhaAd = dbAd.prepare(`SELECT name, status, source_pattern, prompt FROM auto_skills WHERE source_pattern = 'aprendida_gmail_himalaya'`).get() as { name: string; status: string; prompt: string } | undefined;
        dbAd.close();
        assert(ad.adotadas.length === 1 && fs.existsSync(ad.pacoteDeSeguranca) && fs.existsSync(path.join(inst.skills, 'aprendida_gmail_himalaya', 'SKILL.md'))
            && !fs.existsSync(path.join(inst.skills, 'gmail-himalaya')) && linhaAd?.status === 'active' && linhaAd.prompt === 'Use o himalaya.',
            'adotada: pasta com prefixo, linha ativa em auto_skills com o corpo, pacote de segurança antes', linhaAd);
        assert(mig.planejarAdocao(inst, new Set(['oficial', 'manual', 'ja-migrada'])).length === 0, 'adotar de novo não faz nada');

        console.log('\n=== S477-7 — "funcionou aqui" ===');
        const t0 = skillMd(`validada_em: ${OUTRO}@${resumo}\n`, corpo);
        const t1 = sl.acrescentarValidacao(t0, AQUI, resumo)!;
        assert(new RegExp(`^validada_em: ${OUTRO}@${resumo}, ${AQUI}@${resumo}$`, 'm').test(t1) && /^formato_skill: 1$/m.test(t1) && t1.endsWith(`${corpo}\n`), 'acrescenta este sistema sem tocar no corpo', t1);
        assert(sl.acrescentarValidacao(t1, AQUI, resumo) === t1, 'repetir não duplica');
        const fonte = fs.readFileSync(path.join(__dirname, '../../dashboard/routes/skills.ts'), 'utf8');
        assert(fonte.includes("router.post('/portabilidade/:pasta/funcionou'") && fonte.includes("router.put('/pastas'"), 'painel: rotas do "funcionou aqui" e da tabela de pastas');
        const fonteBk = fs.readFileSync(path.join(__dirname, '../../core/backupDoConhecimento.ts'), 'utf8');
        assert(!/pastas-das-skills/.test(fonteBk), 'a tabela de pastas não entra no pacote da ADR-034 (é local)');
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S477 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    if (failed > 0) process.exitCode = 1;
}

main().catch((e) => { console.error('S477 erro inesperado:', e); process.exitCode = 1; });
