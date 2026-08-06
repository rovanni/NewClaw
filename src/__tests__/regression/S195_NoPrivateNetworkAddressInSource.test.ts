/// <reference types="node" />
/**
 * S195 — Nenhum endereço de rede privada embutido no código-fonte ou nos instaladores.
 *
 * BUG REAL (incidente de 04/08/2026, RFC-004 Correção 0): `transcribeAttachment` tinha
 * `process.env.WHISPER_API_URL || 'http://<rede-privada>:8177'` — o endereço da máquina de um
 * usuário específico embutido como valor padrão no código-fonte de um projeto público. Como
 * `.env.example`, `install.sh` e `install.ps1` gravam `WHISPER_API_URL=` **vazia**, e string vazia
 * é falsy em JavaScript, o operador `||` fazia com que TODA instalação nova do NewClaw saísse de
 * fábrica apontando para aquele endereço. Em rede doméstica típica, esse endereço é o roteador do
 * próprio usuário — ou seja, o áudio de voz de terceiros era enviado por POST a um host arbitrário
 * da LAN deles, sem que ninguém tivesse configurado nada.
 *
 * O achado já constava de auditoria anterior (`docs/ARCHITECTURE/architecture.json`) como
 * "an internal IP baked into public OSS source" e permaneceu como observação por meses, nunca
 * virando correção. Este teste existe para que a classe inteira não volte silenciosamente.
 *
 * O que é aceito e por quê:
 *   - `localhost`, `127.0.0.1`, `::1`, `0.0.0.0` — endereços de loopback/bind local não revelam
 *     topologia de rede de ninguém e são padrões legítimos (ex: Ollama em localhost:11434).
 *   - Blocos reservados pela RFC 5737 para documentação (192.0.2.0/24, 198.51.100.0/24,
 *     203.0.113.0/24) — é o que exemplos em comentário devem usar.
 *   - Endereços dentro de string de documentação/comentário também falham quando são de faixa
 *     privada: um `192.168.x` num comentário é indistinguível da configuração real de alguém.
 *     Foi o caso de `server_config.ts`, ajustado para RFC 5737 nesta mesma sprint.
 *
 * Execução: npx ts-node src/__tests__/regression/S195_NoPrivateNetworkAddressInSource.test.ts
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.join(__dirname, '..', '..', '..');
const SRC_DIR = path.join(ROOT, 'src');

/** Arquivos fora de src/ que também geram configuração para o usuário final. */
const EXTRA_FILES = ['.env.example', 'install.sh', 'install.ps1'].map(f => path.join(ROOT, f));

/**
 * Faixas RFC1918 + link-local + CGNAT. Loopback (127.x) fica de fora de propósito.
 *   10.x.x.x | 172.16-31.x.x | 192.168.x.x | 169.254.x.x | 100.64-127.x.x
 */
const PRIVATE_IP = /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|169\.254\.\d{1,3}\.\d{1,3}|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3})\b/;

/** URL com IPv4 literal que não seja loopback/bind-all — pega também endereços públicos. */
const URL_WITH_LITERAL_IP = /https?:\/\/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/g;
/** Loopback, bind-all e os blocos de documentação da RFC 5737. */
const ALLOWED_LITERAL_IP = (ip: string): boolean =>
    ip === '127.0.0.1' ||
    ip === '0.0.0.0' ||
    ip.startsWith('192.0.2.') ||
    ip.startsWith('198.51.100.') ||
    ip.startsWith('203.0.113.');

let failures = 0;
function check(ok: boolean, label: string, detail = '') {
    if (ok) {
        console.log(`  OK   ${label}`);
    } else {
        failures++;
        console.error(`  FALHOU: ${label}${detail ? ' → ' + detail : ''}`);
    }
}

function collectFiles(dir: string, exts: string[]): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === 'node_modules' || entry.name === 'dist') continue;
            out.push(...collectFiles(full, exts));
        } else if (exts.some(e => entry.name.endsWith(e))) {
            out.push(full);
        }
    }
    return out;
}

console.log('S195 — Nenhum endereço de rede privada embutido no código-fonte\n');

const files = [
    ...collectFiles(SRC_DIR, ['.ts', '.js', '.html']),
    ...EXTRA_FILES.filter(f => fs.existsSync(f)),
];

check(files.length > 0, `varredura encontrou arquivos para inspecionar`, `${files.length} arquivo(s)`);

// ── 1. Nenhum endereço de faixa privada em lugar nenhum ─────────────────────
const privateHits: string[] = [];
for (const file of files) {
    if (path.basename(file) === path.basename(__filename)) continue; // este teste cita as faixas
    const lines = fs.readFileSync(file, 'utf-8').split('\n');
    lines.forEach((line, i) => {
        if (PRIVATE_IP.test(line)) {
            privateHits.push(`${path.relative(ROOT, file)}:${i + 1}`);
        }
    });
}
check(
    privateHits.length === 0,
    'nenhum endereço de rede privada (RFC1918/link-local/CGNAT) no repositório',
    privateHits.slice(0, 10).join(', '),
);

// ── 2. Nenhuma URL com IP literal além de loopback/bind-all ─────────────────
const literalHits: string[] = [];
for (const file of files) {
    if (path.basename(file) === path.basename(__filename)) continue;
    const lines = fs.readFileSync(file, 'utf-8').split('\n');
    lines.forEach((line, i) => {
        URL_WITH_LITERAL_IP.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = URL_WITH_LITERAL_IP.exec(line)) !== null) {
            if (!ALLOWED_LITERAL_IP(m[1])) {
                literalHits.push(`${path.relative(ROOT, file)}:${i + 1} (${m[1]})`);
            }
        }
    });
}
check(
    literalHits.length === 0,
    'nenhuma URL com IP literal fora de 127.0.0.1/0.0.0.0',
    literalHits.slice(0, 10).join(', '),
);

// ── 3. WHISPER_API_URL não tem valor padrão embutido ────────────────────────
// Guarda específica da regressão original: mesmo que o endereço mude, o padrão não pode voltar.
const mediaHandlers = fs.readFileSync(path.join(SRC_DIR, 'core', 'agentMediaHandlers.ts'), 'utf-8');
check(
    !/process\.env\.WHISPER_API_URL\s*\|\|\s*['"`]\s*http/.test(mediaHandlers),
    'WHISPER_API_URL não tem endereço padrão embutido (ausente = transcrição local)',
);

console.log(failures === 0 ? '\n✅ S195 passou' : `\n❌ S195: ${failures} falha(s)`);
process.exit(failures === 0 ? 0 : 1);
