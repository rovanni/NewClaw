/**
 * DirectoryPickerService — capability de seleção de diretório do ConfigWizard.
 *
 * Origem: campanha de investigação FP → FP.6.3 (docs da conversa, sem RFC formal escrito —
 * mesmo padrão do ConfigWizard.js). Decisões fechadas na campanha, implementadas aqui:
 *
 * 1. Política × preferência (FP.6.3): a variável de ambiente `NEWCLAW_NATIVE_DIRECTORY_PICKER`
 *    é a POLÍTICA — um teto que só quem controla o deploy pode conceder, nunca contornável pela
 *    UI. Dentro do que a política permite, `ctx.config.directoryPickerPreference` ('native'|'web')
 *    é a PREFERÊNCIA — editável pelo Dashboard a qualquer momento, sem restart. ENV ausente
 *    equivale a ENV=false (Native nunca oferecido) — mesmo padrão já usado no projeto para toda
 *    outra feature opcional (`CognitiveKernelGate`, `send_audio`: padrão desligado, opt-in
 *    explícito). A preferência persiste mesmo com política=false (nunca apagada automaticamente),
 *    só fica sem efeito enquanto a política negar — evita forçar reconfiguração se o operador
 *    ligar a política depois.
 * 2. Probe real, nunca heurística (FP.6/FP.6.1): disponibilidade de Native nunca é inferida por
 *    IP/hostname/user-agent — só por (a) política declarada e (b) tentativa real observada. Não
 *    existe probe "prévio" separado da tentativa: a própria abertura do diálogo, com timeout
 *    curto de sondagem antes de qualquer coisa bloquear esperando um clique humano, cobre os dois.
 * 3. `resolveEffectiveRoot` (FP.6.2, revisado por objeção explícita na FP.6 §3-4): o Web Picker
 *    NUNCA oferece uma lista de raízes implícitas (homedir + drives) — isso seria "navegue o
 *    computador inteiro" disfarçado. A única raiz é o que já está digitado no campo (`hint`); se
 *    vazio, cai em `os.homedir()`. Caminho inexistente ou parcial sobe até o ancestral mais
 *    próximo que existir — mesma regra determinística cobre os 6 casos-exemplo da FP.6.2 sem
 *    tratamento especial por caso. Caminhos UNC nunca entram na árvore assistida.
 * 4. Fronteira de navegação (FP.6.2 §5): o teto é `homedir()` se a raiz efetiva estiver dentro
 *    dele, ou a raiz da própria unidade/volume caso contrário — nunca `/` nem lista de drives.
 *    Symlinks são resolvidos (`fs.realpathSync`) ANTES de checar se o alvo está dentro do teto —
 *    nunca depois (ordem que evita a classe de bug TOCTOU/symlink-bypass, identificada na FP.6).
 * 5. Segurança da execução nativa (FP.6/FP.6.1): comando fixo por plataforma, nunca lido do
 *    request; hint repassado via variável de ambiente do processo filho, nunca interpolado numa
 *    string de comando — elimina a classe inteira de injeção por escaping incorreto.
 *    `[Console]::OutputEncoding = UTF8` no Windows é OBRIGATÓRIO, não cosmético — confirmado
 *    empiricamente na FP.6.1 (sem isto, "ç"/"日本語" viram bytes corrompidos/literalmente "???",
 *    perda de dado real, não só visual).
 * 6. macOS usa `choose folder` SEM bloco `tell application` — mecanismo documentado (Scripting OS
 *    X, "Avoiding AppleScript Security and Privacy Requests") para evitar o prompt de permissão
 *    de Automação do macOS, que só dispara em eventos ENTRE processos; `choose folder` roda no
 *    mesmo processo do `osascript`. Não testado em hardware real nesta campanha (sem macOS
 *    disponível) — ver PENDÊNCIA no relatório da FP.6.1/FP.6.2.
 * 7. Linux (zenity/kdialog): nenhum dos dois é instalado automaticamente — ausência de binário é
 *    tratada como estado normal (`unavailable`/`no-binary`), nunca sugestão de instalação (decisão
 *    fechada na FP.6.1 §6 — isto não é dependência de execução de goal, não passa pelo pipeline de
 *    curadoria de dependências do agente).
 * 8. `isUncPath` é restrita a `process.platform === 'win32'` (achado de auditoria pós-QA,
 *    2026-08-24, item 3 acima): sem o guard, um hint POSIX começando por `//` (prefixo comum e
 *    válido em Linux/macOS, ex. `//mnt/models`) seria descartado pra `homedir()` por engano — o
 *    mesmo tipo de erro do achado UX-02 original, introduzido pela própria correção, no SO
 *    errado. PENDÊNCIA: não verificável em hardware real neste ambiente (só Windows disponível —
 *    mesma limitação do item 6). Simular via mock de `process.platform` num processo Node rodando
 *    em Windows não é confiável aqui: o módulo `path` nativo do Node é fixado em `path.win32` na
 *    carga do processo, não reagindo ao mock em runtime — então `path.resolve`/`path.isAbsolute`
 *    chamados depois do guard continuariam com semântica Windows mesmo com a plataforma mockada, e
 *    forçar `fs.statSync` num hint `//servidor/...` neste ambiente arrisca o Node tentar resolução
 *    de rede SMB real (lento/pode travar o processo de teste) em vez de simplesmente falhar como
 *    faria um path POSIX inexistente. Requer validação em etapa 4 (Validação Progressiva) contra
 *    Linux/macOS real antes de considerar este item fechado.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';
import { createLogger } from '../shared/AppLogger';

const log = createLogger('DirectoryPickerService');

export type DirectoryPickerOutcome =
    | { kind: 'selected'; path: string; source: 'native' | 'web' }
    | { kind: 'cancelled' }
    | { kind: 'unavailable'; source: 'native' | 'web'; reason: 'no-binary' | 'no-session' | 'permission-denied' | 'timeout' | 'not-permitted' | 'error' };

/** Duração da sondagem+diálogo nativo. Um único timeout (FP.6.2 §5 propôs dois — sondagem curta e
 *  diálogo longo — mas a implementação real não tem como separá-los: a MESMA chamada que abre o
 *  diálogo é a que revela se ele nem chegou a abrir; um timeout curto cobriria os dois casos só se
 *  o SO reportasse "sem sessão" instantaneamente, o que já é checado por `[Environment]::
 *  UserInteractive` ANTES de sequer instanciar o diálogo). Valor exato é decisão de produto ainda
 *  pendente (FP.6.1/FP.6.2) — 3 minutos aqui é só um ponto de partida razoável documentado, não a
 *  palavra final. */
export const NATIVE_PICKER_TIMEOUT_MS = 3 * 60_000;

// ── Política × preferência ─────────────────────────────────────────────────────────────────────

/** Lê a política do ambiente. ENV ausente ou qualquer valor diferente de "true" equivale a
 *  negado — mesmo padrão já em uso no projeto para toda outra feature opcional. */
export function isNativePickerPolicyAllowed(): boolean {
    return process.env.NEWCLAW_NATIVE_DIRECTORY_PICKER === 'true';
}

/** A preferência nunca ultrapassa a política — este é o único ponto do sistema que decide se uma
 *  tentativa nativa deve sequer começar. `preference` pode valer 'native' mesmo com política
 *  negada (persistida, sem efeito) — só aqui a combinação é resolvida. */
export function shouldAttemptNative(preference: 'native' | 'web' | undefined): boolean {
    return isNativePickerPolicyAllowed() && preference !== 'web';
}

// ── WebDirectoryPicker: raiz efetiva, fronteira, listagem ──────────────────────────────────────

/** Detecta caminho UNC (`\\servidor\share\...`). Checa o PREFIXO da string bruta (dois
 *  separadores seguidos), não `path.win32.parse(...).root` — achado em investigação (QA da
 *  campanha FP, achado UX-02, 2026-08-24): para um UNC malformado tipo `\\servidorsharemodels`
 *  (sem separador entre servidor/share), `.root` devolve só `"\"` (um separador), não `"\\"`
 *  (dois) — o parser do Node só monta a raiz UNC completa quando reconhece server+share
 *  bem-formados. Checar o prefixo da string bruta cobre o UNC malformado também, sem depender de
 *  o resto do caminho estar bem-formado. Ainda é classificação sintática determinística (mesma
 *  categoria de `path.isAbsolute`), nunca interpretação semântica do conteúdo.
 *
 *  Restrito a `process.platform === 'win32'` (achado da auditoria pós-QA, 2026-08-24): UNC é um
 *  conceito exclusivo do Windows — em POSIX, um prefixo `//` é só um caminho absoluto comum
 *  (`path.posix.isAbsolute('//mnt/data') === true`, `path.posix.resolve('//mnt/data') ===
 *  '/mnt/data'`, confirmado via teste direto). Sem este guard, um hint real digitado em
 *  Linux/macOS começando por `//` (ex.: `//mnt/models`) seria descartado pra `homedir()` mesmo
 *  apontando pra um diretório existente e válido — mesma classe de bug do achado UX-02 original
 *  (inferir demais sobre um caminho), só que introduzida pela própria correção, no SO errado. O
 *  guard usa `process.platform`, mesmo sinal que `runNativeDirectoryPicker` já usa pra escolher o
 *  adapter por SO — não é heurística nova. */
function isUncPath(raw: string): boolean {
    if (process.platform !== 'win32') return false;
    return /^[\\/]{2}/.test(raw);
}

/** Sobe do caminho completo até achar o ancestral mais próximo que existe de fato e é diretório.
 *  Cobre uniformemente os 6 casos-exemplo da FP.6.2 (válido, inexistente, parcial, raiz de unidade,
 *  caminho de usuário, UNC) sem nenhum tratamento especial por caso — ver docstring do módulo.
 *
 * Exige `path.isAbsolute(hint)` antes de resolver (achado UX-02, QA 2026-08-24): sem isto, um
 * hint que o Node NÃO reconhece como absoluto — caminho relativo, "drive-relative" do Windows
 * (`D:foo`, sem separador depois dos dois-pontos — sintaxe legada real do SO, confirmada via
 * teste direto nesta máquina: `path.isAbsolute('D:foo') === false`), ou texto qualquer — era
 * silenciosamente enxertado em cima de `process.cwd()` por `path.resolve()`, abrindo o painel
 * numa pasta sem nenhuma relação com o que a pessoa digitou (reproduzido ao vivo: um hint com a
 * barra invertida faltando abriu o painel na pasta de instalação do próprio NewClaw).
 * `path.isAbsolute()` é a checagem que o próprio Node/SO usa pra "isto é um caminho completo e
 * inequívoco" — não é um padrão de string inventado (tipo "contém barra?"), é a mesma regra que
 * a plataforma já aplica, cross-platform (win32 e posix têm suas próprias regras corretas). */
export function resolveEffectiveRoot(hint: string | undefined): string {
    const home = os.homedir();
    const trimmed = (hint ?? '').trim();
    if (!trimmed) return home;
    if (isUncPath(trimmed)) return home;
    if (!path.isAbsolute(trimmed)) return home;

    let current = path.resolve(trimmed);
    while (true) {
        try {
            if (fs.statSync(current).isDirectory()) return current;
        } catch { /* não existe neste nível — sobe */ }
        const parent = path.dirname(current);
        if (parent === current) return home; // chegou na raiz do filesystem sem achar nada
        current = parent;
    }
}

/** Teto de navegação para uma raiz efetiva: `homedir()` se ela estiver dentro dele, senão a raiz
 *  da própria unidade/volume — nunca `/` nem uma lista de unidades (FP.6 §3-4, revisado). */
export function ceilingFor(effectiveRoot: string): string {
    const home = os.homedir();
    const rel = path.relative(home, effectiveRoot);
    const insideHome = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    return insideHome ? home : path.parse(effectiveRoot).root;
}

function isWithin(target: string, ceiling: string): boolean {
    if (target === ceiling) return true;
    const rel = path.relative(ceiling, target);
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export interface DirectoryListing {
    dir: string;
    ceiling: string;
    canGoUp: boolean;
    parent: string | null;
    subdirs: Array<{ name: string; path: string }>;
    error?: string;
}

/** Lista as subpastas de `dir`, resolvendo symlinks ANTES de checar a fronteira (nunca depois —
 *  ordem que evita bypass via link simbólico apontando pra fora do teto permitido). Nunca lista
 *  arquivos — só diretórios, porque o propósito é escolher uma PASTA, não navegar arquivos. */
export function listDirectory(dir: string, ceiling: string): DirectoryListing {
    const resolvedDir = path.resolve(dir);
    if (!isWithin(resolvedDir, ceiling)) {
        return { dir: ceiling, ceiling, canGoUp: false, parent: null, subdirs: [], error: 'fora da fronteira permitida' };
    }
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(resolvedDir, { withFileTypes: true });
    } catch (err) {
        return { dir: resolvedDir, ceiling, canGoUp: resolvedDir !== ceiling, parent: resolvedDir !== ceiling ? path.dirname(resolvedDir) : null, subdirs: [], error: (err as Error).message };
    }
    const subdirs: Array<{ name: string; path: string }> = [];
    for (const e of entries) {
        if (!e.isDirectory() && !e.isSymbolicLink()) continue;
        const full = path.join(resolvedDir, e.name);
        let real: string;
        try { real = fs.realpathSync(full); } catch { continue; } // link quebrado — ignora
        let stat: fs.Stats;
        try { stat = fs.statSync(real); } catch { continue; }
        if (!stat.isDirectory()) continue;
        if (!isWithin(real, ceiling)) continue; // link escapando do teto — nunca segue
        subdirs.push({ name: e.name, path: full });
    }
    subdirs.sort((a, b) => a.name.localeCompare(b.name));
    return {
        dir: resolvedDir,
        ceiling,
        canGoUp: resolvedDir !== ceiling,
        parent: resolvedDir !== ceiling ? path.dirname(resolvedDir) : null,
        subdirs,
    };
}

// ── NativeDirectoryPicker: adapters por plataforma ──────────────────────────────────────────────

/** Roda um comando fixo (nunca vindo do request) com o hint repassado via variável de ambiente do
 *  processo filho — nunca interpolado numa string de comando, elimina a classe de risco de
 *  escaping incorreto por completo. Compartilhado pelos três adapters. */
function runPickerProcess(
    command: string,
    args: string[],
    hint: string | undefined,
    parseOutput: (stdout: string, exitCode: number | null) => DirectoryPickerOutcome,
): Promise<DirectoryPickerOutcome> {
    return new Promise(resolve => {
        let out = '';
        let settled = false;
        const settle = (outcome: DirectoryPickerOutcome) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(outcome);
        };

        let child;
        try {
            child = spawn(command, args, {
                env: { ...process.env, NEWCLAW_PICKER_HINT: hint || '' },
                windowsHide: false,
            });
        } catch {
            settle({ kind: 'unavailable', source: 'native', reason: 'no-binary' });
            return;
        }

        const timer = setTimeout(() => {
            try { child.kill(); } catch { /* já pode ter saído */ }
            settle({ kind: 'unavailable', source: 'native', reason: 'timeout' });
        }, NATIVE_PICKER_TIMEOUT_MS);

        child.stdout?.on('data', d => {
            // Teto defensivo — um path de diretório nunca deveria se aproximar disto; protege contra
            // saída inesperada de um adapter com bug ou binário substituído.
            if (out.length < 65536) out += d.toString('utf8');
        });
        child.on('error', () => settle({ kind: 'unavailable', source: 'native', reason: 'no-binary' }));
        child.on('exit', code => settle(parseOutput(out, code)));
    });
}

const WINDOWS_PICKER_SCRIPT = [
    '$ErrorActionPreference = "Stop"',
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8', // obrigatório — ver docstring do módulo, item 5
    'Add-Type -AssemblyName System.Windows.Forms',
    // Sonda ANTES de instanciar o diálogo — API .NET real (Environment.UserInteractive), nunca
    // heurística de variável de ambiente isolada (confirmado disponível na FP.6.1, testado ao vivo).
    'if (-not [Environment]::UserInteractive) { Write-Output "NEWCLAW_NO_SESSION"; exit 0 }',
    '$dlg = New-Object System.Windows.Forms.FolderBrowserDialog',
    'if ($env:NEWCLAW_PICKER_HINT) { $dlg.SelectedPath = $env:NEWCLAW_PICKER_HINT }',
    '$result = $dlg.ShowDialog()',
    'if ($result -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dlg.SelectedPath } else { Write-Output "NEWCLAW_CANCELLED" }',
].join('; ');

function windowsNativePicker(hint: string | undefined): Promise<DirectoryPickerOutcome> {
    return runPickerProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_PICKER_SCRIPT], hint, (stdout, code) => {
        const trimmed = stdout.trim();
        if (trimmed === 'NEWCLAW_NO_SESSION') return { kind: 'unavailable', source: 'native', reason: 'no-session' };
        if (trimmed === 'NEWCLAW_CANCELLED') return { kind: 'cancelled' };
        if (code === 0 && trimmed) return { kind: 'selected', path: trimmed, source: 'native' };
        return { kind: 'unavailable', source: 'native', reason: 'error' };
    });
}

// AppleScript de terceiros (Scripting OS X — ver docstring, item 6): `choose folder` fora de um
// bloco `tell application` roda no mesmo processo do osascript, evitando o prompt de permissão de
// Automação do macOS. -128 é o código padrão de cancelamento do usuário no AppleScript.
const MACOS_PICKER_SCRIPT = `
try
  set hintPath to (system attribute "NEWCLAW_PICKER_HINT")
  if hintPath is not "" then
    set theFolder to choose folder with prompt "Selecione a pasta dos modelos" default location (POSIX file hintPath)
  else
    set theFolder to choose folder with prompt "Selecione a pasta dos modelos"
  end if
  POSIX path of theFolder
on error errText number errNum
  if errNum is -128 then
    "NEWCLAW_CANCELLED"
  else
    "NEWCLAW_ERROR:" & errNum
  end if
end try
`.trim();

function macosNativePicker(hint: string | undefined): Promise<DirectoryPickerOutcome> {
    return runPickerProcess('osascript', ['-e', MACOS_PICKER_SCRIPT], hint, (stdout, code) => {
        const trimmed = stdout.trim();
        if (trimmed === 'NEWCLAW_CANCELLED') return { kind: 'cancelled' };
        if (trimmed.startsWith('NEWCLAW_ERROR:')) {
            const num = trimmed.slice('NEWCLAW_ERROR:'.length).trim();
            return { kind: 'unavailable', source: 'native', reason: num === '-1743' ? 'permission-denied' : 'error' };
        }
        if (code === 0 && trimmed) return { kind: 'selected', path: trimmed, source: 'native' };
        return { kind: 'unavailable', source: 'native', reason: 'error' };
    });
}

/** zenity primeiro, kdialog como segunda tentativa — nenhum dos dois instalado automaticamente
 *  (FP.6.1 §6, fechado). Ausência de AMBOS não é erro, é o estado esperado em servidor headless. */
async function linuxNativePicker(hint: string | undefined): Promise<DirectoryPickerOutcome> {
    const zenityArgs = ['--file-selection', '--directory'];
    if (hint) zenityArgs.push(`--filename=${hint}`);
    const zenity = await runPickerProcess('zenity', zenityArgs, hint, (stdout, code) => {
        const trimmed = stdout.trim();
        if (code === 0 && trimmed) return { kind: 'selected', path: trimmed, source: 'native' };
        if (code === 1) return { kind: 'cancelled' };
        return { kind: 'unavailable', source: 'native', reason: 'error' };
    });
    if (zenity.kind !== 'unavailable' || zenity.reason !== 'no-binary') return zenity;

    const kdialogArgs = ['--getexistingdirectory', hint || os.homedir()];
    return runPickerProcess('kdialog', kdialogArgs, hint, (stdout, code) => {
        const trimmed = stdout.trim();
        if (code === 0 && trimmed) return { kind: 'selected', path: trimmed, source: 'native' };
        if (code === 1) return { kind: 'cancelled' };
        return { kind: 'unavailable', source: 'native', reason: 'error' };
    });
}

/** Ponto único de entrada do Native picker — escolhe o adapter pela plataforma real
 *  (`process.platform`), nunca por inferência de topologia de rede. Chamador (rota HTTP) já
 *  garantiu política+preferência antes de chegar aqui; esta função nunca decide "devo tentar?",
 *  só "como tentar, dado que devo". */
export function runNativeDirectoryPicker(hint: string | undefined): Promise<DirectoryPickerOutcome> {
    switch (process.platform) {
        case 'win32': return windowsNativePicker(hint);
        case 'darwin': return macosNativePicker(hint);
        case 'linux': return linuxNativePicker(hint);
        default:
            log.info(`Native directory picker: plataforma "${process.platform}" sem adapter — fallback pro Web picker.`);
            return Promise.resolve({ kind: 'unavailable', source: 'native', reason: 'no-binary' });
    }
}
