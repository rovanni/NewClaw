/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S213
 * Sondagem indeterminada não apaga a declaração do usuário (`ADR-008` §4.2, Sprint 035).
 *
 * CONTEXTO: a Sprint 028 fez a queda do Piper para um serviço de terceiros virar um fato
 * comunicado ao usuário. Mas o fato nascia no `catch` do Piper — e esse `catch` só é alcançado se
 * `findPiperInstallation()` tiver devolvido algo. Uma sondagem do binário que apenas FALHASSE
 * (timeout, PATH, permissão) devolvia `null` igual a "não instalado": o áudio ia para a Microsoft e
 * nenhum fato era produzido.
 *
 * Era a porta dos fundos que anulava a garantia da Sprint 028, por um caminho que nem log deixava.
 * Medida em 3,3% das sondagens sob CPU saturada — e saturação é o que inferência local provoca,
 * que é justamente o cenário de quem configura TTS local.
 *
 * A decisão da `ADR-008`: a declaração do usuário está na presença dos modelos em disco; uma
 * sondagem que falhou não a desfaz. O áudio continua sendo entregue pela engine remota — não se
 * recusa entrega por causa de uma sondagem — e o fato é produzido.
 *
 * REGRESSÃO SE: indeterminação voltar a ser indistinguível de ausência; a declaração passar a ser
 * derivada da sondagem em vez dos modelos em disco; ou um fato passar a ser produzido quando o
 * usuário não declarou TTS local nenhum.
 *
 * Execução: npx ts-node src/__tests__/regression/S213_PiperLookup_IndeterminateKeepsDeclaration.test.ts
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

const MODELO = 'pt-BR-razo-medium.onnx';

async function main(): Promise<void> {
    const envOriginal = { dir: process.env.PIPER_MODELS_DIR, bin: process.env.PIPER_BIN, path: process.env.PATH };
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'newclaw-s213-'));

    try {
        // `PIPER_MODELS_DIR` é lido no carregamento do módulo — precisa estar definido ANTES do import.
        process.env.PIPER_MODELS_DIR = tmp;
        delete process.env.PIPER_BIN;

        const { SendAudioTool } = await import('../../tools/send_audio');
        const fakeBus = {} as unknown as import('../../channels/MessageBus').MessageBus;
        const tool = new SendAudioTool(fakeBus) as unknown as {
            findPiperInstallation(): { kind: string; cause?: string; piperBin?: string };
        };

        console.log('\n=== S213-1 — sem modelos em disco: o usuário não declarou nada ===');
        {
            const r = tool.findPiperInstallation();
            assert(r.kind === 'nao-declarado',
                'sem os modelos, não há TTS local declarado — nada a proteger (Soberania §1.1)', r);
        }

        // A partir daqui os modelos existem: a declaração está feita.
        fs.writeFileSync(path.join(tmp, MODELO), 'modelo falso');
        fs.writeFileSync(path.join(tmp, `${MODELO}.json`), '{}');

        console.log('\n=== S213-2 — declarado + caminho explícito: a sondagem nem acontece ===');
        {
            process.env.PIPER_BIN = '/caminho/explicito/piper';
            const r = tool.findPiperInstallation();
            assert(r.kind === 'usable', 'PIPER_BIN vence a sondagem — quem apontou à mão já respondeu', r);
            assert(r.piperBin === '/caminho/explicito/piper', 'e o caminho informado é o usado', r);
            delete process.env.PIPER_BIN;
        }

        console.log('\n=== S213-3 — declarado + binário verificadamente ausente ===');
        {
            const r = tool.findPiperInstallation();
            assert(r.kind === 'binario-ausente',
                'sondagem respondeu que não há: ausência verificada, não indeterminação', r);
        }

        console.log('\n=== S213-4 — declarado + sondagem que NÃO conseguiu verificar ===');
        {
            // PATH vazio torna o próprio sondador inalcançável — reproduz o caso de forma
            // determinística, sem depender de saturação real de CPU.
            process.env.PATH = '';
            const r = tool.findPiperInstallation();
            process.env.PATH = envOriginal.path;

            assert(r.kind === 'binario-indeterminado',
                'sondagem falha NÃO vira "não instalado" — a declaração do usuário permanece', r);
            assert(typeof r.cause === 'string' && r.cause.length > 0,
                'e a causa é preservada para o log', r);
        }

        console.log('\n=== S213-5 — o fato é produzido só na indeterminação, não na ausência ===');
        {
            const SRC = fs.readFileSync(path.join(process.cwd(), 'src', 'tools', 'send_audio.ts'), 'utf-8');
            // Limite em `findPiperInstallation`, não em `generateViaPiper`: aquele método vem entre
            // os dois e menciona todos os estados, o que tornaria a asserção seguinte inútil.
            const gen = SRC.slice(SRC.indexOf('private async generateAudio'), SRC.indexOf('private findPiperInstallation'));

            assert(/binario-indeterminado[\s\S]{0,600}fatos\.push\(/.test(gen),
                'indeterminação empilha fato antes de seguir para a engine remota', gen.slice(0, 400));
            assert(!/binario-ausente/.test(gen),
                'ausência verificada NÃO produz fato neste caminho — segue silenciosa, como antes');
            assert(/catch\s*\(piperErr\)[\s\S]{0,400}fatos\.push\(/.test(gen),
                'e o caso original (Piper existe e falha) continua produzindo o seu', gen.slice(-500));
        }

        console.log(`\nS213 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
        console.log(`\nCOBERTURA:`);
        console.log(`  Sem modelos: não declarado, sem fato: testado`);
        console.log(`  PIPER_BIN explícito dispensa sondagem: testado`);
        console.log(`  Ausência verificada × indeterminação distinguidas: testado`);
        console.log(`  Indeterminação preserva a declaração e produz fato: testado`);
    } finally {
        if (envOriginal.dir === undefined) delete process.env.PIPER_MODELS_DIR; else process.env.PIPER_MODELS_DIR = envOriginal.dir;
        if (envOriginal.bin === undefined) delete process.env.PIPER_BIN; else process.env.PIPER_BIN = envOriginal.bin;
        process.env.PATH = envOriginal.path;
        fs.rmSync(tmp, { recursive: true, force: true });
    }

    if (failed > 0) process.exit(1);
}

main().catch(err => { console.error('Erro inesperado:', err); process.exit(1); });
