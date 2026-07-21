/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S136 (CodeQL #35-45, #65-74, #35 total 21 alertas + investigação real)
 *
 * A hipótese inicial do sprint (docs/issues/seguranca-codeql-2026-07-20/SPRINTS/S4.md) era que
 * os 21 alertas de `js/path-injection` em SessionTranscript.ts fossem majoritariamente falso-
 * positivo (CodeQL não reconhecendo `toFileSafeId()` como sanitizador). Investigação real
 * (2026-07-20) mostrou que a premissa estava ERRADA: `toFileSafeId()` só trocava ':' — '/' e '\'
 * passavam intactos — e `sessionId` chega, para o canal Web, DIRETO de
 * `req.body?.sessionId` (src/dashboard/routes/chat.ts) sem NENHUMA validação. Um
 * `sessionId` tipo `web:../../../../etc/evil` sobrevivia até `path.join(transcriptDir,
 * safeId + '.jsonl')`, que normaliza `..` como segmento de path — escapando de verdade de
 * `transcriptDir`. CodeQL estava CERTO; corrigido em SessionKeyFactory.toFileSafeId() (agora
 * neutraliza '/','\\',':') + checagem de contenção de path em SessionTranscript (cinto e
 * suspensório).
 *
 * Execução: npx ts-node src/__tests__/regression/S136_SessionTranscript_PathTraversal.test.ts
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { toFileSafeId } from '../../session/SessionKeyFactory';
import { SessionTranscript } from '../../session/SessionTranscript';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  OK ${message}`); passed++; }
    else { console.error(`  FALHOU: ${message}`, detail ?? ''); failed++; }
}

/** toFileSafeId ANTES desta correção — só tratava ':'. Usado só pra provar o traversal real. */
function oldToFileSafeId(composite: string): string {
    return composite.replace(/:/g, '~');
}

async function main() {
    console.log('\n=== S136.1 — prova do traversal real: toFileSafeId ANTIGO deixava path.join escapar de transcriptDir ===');
    {
        const transcriptDir = path.join(os.tmpdir(), 'newclaw-s136-fake-sessions');
        const maliciousSessionId = 'web:../../../../../../etc/evil';

        const oldSafeId = oldToFileSafeId(maliciousSessionId);
        const oldResolvedPath = path.resolve(path.join(transcriptDir, `${oldSafeId}.jsonl`));
        const rel = path.relative(path.resolve(transcriptDir), oldResolvedPath);
        const escaped = rel.startsWith('..') || path.isAbsolute(rel);
        assert(escaped, 'toFileSafeId antigo (só trocava ":") permitia path.join escapar de transcriptDir — vulnerabilidade real confirmada', { oldSafeId, oldResolvedPath, rel });
    }

    console.log('\n=== S136.2 — toFileSafeId novo neutraliza "/", "\\" e ":" — nenhum separador de path sobrevive ===');
    {
        const cases = [
            'web:../../../../etc/evil',
            'web:..\\..\\..\\windows\\evil',
            'telegram:123456789',
        ];
        for (const c of cases) {
            const safe = toFileSafeId(c);
            assert(!safe.includes('/') && !safe.includes('\\'), `toFileSafeId("${c}") não contém "/" nem "\\" no resultado`, safe);
        }
        assert(toFileSafeId('telegram:123456789') === 'telegram~123456789', 'caso normal (sem "/" nem "\\") continua produzindo o mesmo resultado de antes — regressão do caminho feliz', toFileSafeId('telegram:123456789'));
    }

    console.log('\n=== S136.3 — SessionTranscript com sessionId adversarial: path resultante fica DENTRO de transcriptDir, nunca escapa ===');
    {
        const transcriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'newclaw-s136-real-'));
        const maliciousSessionId = 'web:../../../../../../tmp/s136-escaped-marker';

        const transcript = new SessionTranscript(transcriptDir, maliciousSessionId);
        await transcript.init();

        const filePath = (transcript as any).filePath as string;
        const rel = path.relative(path.resolve(transcriptDir), path.resolve(filePath));
        const escaped = rel.startsWith('..') || path.isAbsolute(rel);
        assert(!escaped, 'filePath do SessionTranscript fica dentro de transcriptDir mesmo com sessionId adversarial', { filePath, rel });
        assert(fs.existsSync(filePath), 'o arquivo de sessão foi criado no local esperado (dentro de transcriptDir)', filePath);

        // Confirma que NADA foi criado no path que o ataque tentava atingir.
        const wouldBeEscapedPath = path.resolve(os.tmpdir(), 's136-escaped-marker.jsonl');
        assert(!fs.existsSync(wouldBeEscapedPath), 'nenhum arquivo foi criado no destino do ataque (fora de transcriptDir)', wouldBeEscapedPath);

        await transcript.close();
        fs.rmSync(transcriptDir, { recursive: true, force: true });
    }

    console.log('\n=== S136.4 — migrateLegacyColonPath com sessionId adversarial: não tenta ler/escrever fora de transcriptDir ===');
    {
        const transcriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'newclaw-s136-legacy-'));
        // Contém ':' (dispara a tentativa de migração) E '../' (tentativa de escapar).
        const maliciousSessionId = 'web:../../../../../../tmp/s136-legacy-marker';

        const transcript = new SessionTranscript(transcriptDir, maliciousSessionId);
        // init() não deve lançar (migração adversarial é ignorada, não fatal) nem criar nada
        // fora de transcriptDir.
        await transcript.init();

        const wouldBeEscapedLegacy = path.resolve(os.tmpdir(), 's136-legacy-marker.jsonl');
        assert(!fs.existsSync(wouldBeEscapedLegacy), 'migração legada não leu/escreveu nada fora de transcriptDir', wouldBeEscapedLegacy);

        await transcript.close();
        fs.rmSync(transcriptDir, { recursive: true, force: true });
    }

    console.log('\n=== S136.5 — sessionId normal (sem "/" nem "\\"): comportamento idêntico ao anterior ===');
    {
        const transcriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'newclaw-s136-normal-'));
        const transcript = new SessionTranscript(transcriptDir, 'telegram:123456789');
        await transcript.init();
        const filePath = (transcript as any).filePath as string;
        assert(path.basename(filePath) === 'telegram~123456789.jsonl', 'nome de arquivo pra sessionId normal continua exatamente igual ao formato anterior', path.basename(filePath));
        await transcript.close();
        fs.rmSync(transcriptDir, { recursive: true, force: true });
    }

    console.log(`\n=== RESULTADO: ${passed} passou, ${failed} falhou ===`);
    if (failed > 0) process.exit(1);
}

main().catch(err => { console.error(err); process.exit(1); });
