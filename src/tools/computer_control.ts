/**
 * computer_control — Controle do próprio computador (tela, mouse, teclado e navegador)
 *
 * Roda EM PROCESSO na máquina onde o NewClaw está instalado (o PC do Luciano, Windows).
 * Não depende de VPS, de agente HTTP remoto nem de porta aberta: é o NewClaw controlando
 * a sessão gráfica onde ele mesmo está rodando.
 *
 * Duas famílias de ações:
 *  - desktop: screenshot, screen_size, click, move, type, key
 *      → no Windows usa PowerShell (user32/user32.dll via Add-Type) — zero dependência nativa,
 *        sem node-gyp. Em Linux/macOS devolve erro explícito (não finge sucesso).
 *  - browser: browser_open, browser_click, browser_type, browser_text, browser_screenshot, browser_close
 *      → Playwright, carregado por import dinâmico. Chromium próprio, isolado do navegador
 *        do usuário (não mexe no perfil, nas abas nem nos cookies dele).
 *
 * Segurança:
 *  - Registrada como `dangerous: true` (exige aprovação em modo SAFE) — mesma política de
 *    exec_command/ssh_exec: controlar mouse e teclado pode apagar arquivo, comprar, enviar.
 *  - Texto digitado NUNCA volta no resultado (só o tamanho), e `secret: true` mascara também
 *    o tamanho. Evita senha em log/transcript.
 *  - Conteúdo de página é DADO, não instrução: browser_text devolve texto cru delimitado,
 *    para o modelo tratar como untrusted.
 */

import { ToolExecutor, ToolResult } from '../loop/agentLoopTypes';
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createLogger } from '../shared/AppLogger';
import { errorMessage } from '../shared/errors';

const log = createLogger('ComputerControlTool');

const IS_WINDOWS = process.platform === 'win32';
const ARTIFACT_DIR = path.join(process.cwd(), 'workspace', 'artifacts', 'computer');
const MAX_TEXT = 20000;

/* ------------------------------------------------------------------ */
/* PowerShell: primitivas de tela / mouse / teclado (Windows)          */
/* ------------------------------------------------------------------ */

const PS_INPUT = String.raw`
param([string]$Action, [int]$X = 0, [int]$Y = 0, [string]$Button = 'left', [string]$Text = '', [string]$Key = '', [string]$Out = '')
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class NCInput {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
}
"@
$LEFTDOWN=0x0002; $LEFTUP=0x0004; $RIGHTDOWN=0x0008; $RIGHTUP=0x0010; $MIDDLEDOWN=0x0020; $MIDDLEUP=0x0040

switch ($Action) {
  'size' {
    $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    Write-Output ("{0}x{1}" -f $b.Width, $b.Height)
  }
  'pos' {
    $p = New-Object NCInput+POINT
    [void][NCInput]::GetCursorPos([ref]$p)
    Write-Output ("{0},{1}" -f $p.X, $p.Y)
  }
  'move' {
    [void][NCInput]::SetCursorPos($X, $Y)
    Write-Output 'ok'
  }
  'click' {
    [void][NCInput]::SetCursorPos($X, $Y)
    Start-Sleep -Milliseconds 40
    switch ($Button) {
      'right'  { [NCInput]::mouse_event($RIGHTDOWN,0,0,0,[IntPtr]::Zero); [NCInput]::mouse_event($RIGHTUP,0,0,0,[IntPtr]::Zero) }
      'middle' { [NCInput]::mouse_event($MIDDLEDOWN,0,0,0,[IntPtr]::Zero); [NCInput]::mouse_event($MIDDLEUP,0,0,0,[IntPtr]::Zero) }
      default  { [NCInput]::mouse_event($LEFTDOWN,0,0,0,[IntPtr]::Zero); [NCInput]::mouse_event($LEFTUP,0,0,0,[IntPtr]::Zero) }
    }
    Write-Output 'ok'
  }
  'type' {
    [System.Windows.Forms.SendKeys]::SendWait($Text)
    Write-Output 'ok'
  }
  'key' {
    $seq = $Key
    $parts = $seq -split '\+'
    $mods = @()
    foreach ($p in $parts[0..($parts.Length-2)]) {
      switch ($p.ToLower()) {
        'ctrl'    { $mods += '^' }
        'alt'     { $mods += '%' }
        'shift'   { $mods += '+' }
        default   { }
      }
    }
    $last = $parts[-1]
    $map = @{ 'enter'='{ENTER}'; 'tab'='{TAB}'; 'esc'='{ESC}'; 'escape'='{ESC}'; 'space'=' ';
              'backspace'='{BACKSPACE}'; 'delete'='{DELETE}'; 'up'='{UP}'; 'down'='{DOWN}';
              'left'='{LEFT}'; 'right'='{RIGHT}'; 'home'='{HOME}'; 'end'='{END}';
              'pageup'='{PGUP}'; 'pagedown'='{PGDN}'; 'f1'='{F1}'; 'f2'='{F2}'; 'f3'='{F3}';
              'f4'='{F4}'; 'f5'='{F5}'; 'f6'='{F6}'; 'f7'='{F7}'; 'f8'='{F8}'; 'f9'='{F9}';
              'f10'='{F10}'; 'f11'='{F11}'; 'f12'='{F12}' }
    $k = $last.ToLower()
    if ($map.ContainsKey($k)) { $last = $map[$k] }
    $combo = ($mods -join '') + $last
    [System.Windows.Forms.SendKeys]::SendWait($combo)
    Write-Output 'ok'
  }
  'screenshot' {
    $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
    $bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
    Write-Output 'ok'
  }
  default { Write-Output "acao desconhecida: $Action" }
}
`;

/** Escreve o script .ps1 uma vez e chama com -File (evita inferno de quoting em -Command). */
function psScriptPath(): string {
    const dir = path.join(os.tmpdir(), 'newclaw-cc');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'input.ps1');
    if (!fs.existsSync(file)) fs.writeFileSync(file, PS_INPUT, 'utf8');
    return file;
}

function runPowerShell(args: string[], timeoutMs = 20000): Promise<{ out: string; err: string; code: number }> {
    return new Promise((resolve) => {
        execFile(
            'powershell.exe',
            ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', psScriptPath(), ...args],
            { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 * 8 },
            (err, stdout, stderr) => {
                resolve({
                    out: (stdout || '').toString().trim(),
                    err: (stderr || '').toString().trim(),
                    code: err ? (typeof (err as NodeJS.ErrnoException).code === 'number' ? Number((err as NodeJS.ErrnoException).code) : 1) : 0,
                });
            }
        );
    });
}

/* ------------------------------------------------------------------ */
/* Playwright: sessão de navegador persistente entre chamadas          */
/* ------------------------------------------------------------------ */

type AnyBrowser = { close(): Promise<void> } & Record<string, any>;
let browserInstance: AnyBrowser | null = null;
let pageInstance: any = null;

async function loadPlaywright(): Promise<any> {
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        return require('playwright');
    } catch {
        throw new Error(
            'Playwright não está instalado. No PC, rode: npm install playwright && npx playwright install chromium'
        );
    }
}

async function ensurePage(playwright: any, headless: boolean): Promise<any> {
    if (!browserInstance) {
        browserInstance = await playwright.chromium.launch({ headless });
        pageInstance = await browserInstance!.newPage();
        pageInstance.setDefaultTimeout(15000);
    }
    if (!pageInstance || pageInstance.isClosed()) {
        pageInstance = await browserInstance!.newPage();
        pageInstance.setDefaultTimeout(15000);
    }
    return pageInstance;
}

async function closeBrowser(): Promise<void> {
    try { if (browserInstance) await browserInstance.close(); } catch { /* ignore */ }
    browserInstance = null;
    pageInstance = null;
}

/* ------------------------------------------------------------------ */
/* Tool                                                                 */
/* ------------------------------------------------------------------ */

export class ComputerControlTool implements ToolExecutor {
    name = 'computer_control';
    description =
        'Controla ESTE computador (a máquina onde o NewClaw está rodando): tira screenshot, move/clica o ' +
        'mouse, digita texto e teclas, e opera um navegador Playwright isolado (abrir, clicar, digitar, ' +
        'extrair texto, screenshot, fechar). Use quando a tarefa exige ver a tela ou operar algo sem API ' +
        '(sistema legado, portal, app desktop, teste de UI). Toda ação de navegador é verificada por ' +
        'screenshot/URL antes de reportar sucesso.';

    parameters = {
        type: 'object',
        properties: {
            action: {
                type: 'string',
                enum: [
                    'screen_size', 'screenshot', 'cursor_pos', 'move', 'click', 'type', 'key',
                    'browser_open', 'browser_click', 'browser_type', 'browser_text',
                    'browser_screenshot', 'browser_close', 'browser_status',
                ],
                description: 'Ação a executar.',
            },
            x: { type: 'number', description: 'Coordenada X (move/click).' },
            y: { type: 'number', description: 'Coordenada Y (move/click).' },
            button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Botão do mouse (click).' },
            text: { type: 'string', description: 'Texto a digitar (type/browser_type).' },
            key: { type: 'string', description: 'Tecla ou combinação (key): enter, tab, esc, ctrl+s, alt+f4, f5…' },
            url: { type: 'string', description: 'URL (browser_open).' },
            selector: { type: 'string', description: 'Seletor CSS (browser_click/browser_type/browser_text).' },
            submit: { type: 'boolean', description: 'browser_type: pressionar Enter depois de digitar.' },
            headless: { type: 'boolean', description: 'browser_open: rodar sem janela visível (padrão true).' },
            secret: { type: 'boolean', description: 'type/browser_type: não registra nem o tamanho do texto.' },
        },
        required: ['action'],
    };

    requiredArgsHint =
        'action sempre obrigatório. move/click exigem x e y. type e browser_type exigem text. ' +
        'browser_open exige url. browser_click/browser_text exigem selector. key exige key.';

    async execute(args: Record<string, unknown>): Promise<ToolResult> {
        const action = String(args.action || '').trim();
        try {
            switch (action) {
                case 'screen_size': return await this.screenSize();
                case 'cursor_pos': return await this.cursorPos();
                case 'screenshot': return await this.screenshot();
                case 'move': return await this.psSimple('move', args);
                case 'click': return await this.psSimple('click', args);
                case 'type': return await this.psType(args);
                case 'key': return await this.psKey(args);
                case 'browser_open': return await this.browserOpen(args);
                case 'browser_click': return await this.browserClick(args);
                case 'browser_type': return await this.browserType(args);
                case 'browser_text': return await this.browserText(args);
                case 'browser_screenshot': return await this.browserScreenshot();
                case 'browser_close': await closeBrowser(); return { success: true, output: 'Navegador fechado.' };
                case 'browser_status':
                    return {
                        success: true,
                        output: browserInstance
                            ? `Navegador aberto. URL: ${pageInstance?.url?.() ?? '(desconhecida)'}`
                            : 'Nenhum navegador aberto nesta sessão.',
                    };
                default:
                    return { success: false, output: '', error: `Ação desconhecida: ${action}` };
            }
        } catch (e) {
            const msg = errorMessage(e);
            log.warn(`computer_control ${action} falhou: ${msg}`);
            return { success: false, output: '', error: msg };
        }
    }

    /* ---------------------------- desktop ---------------------------- */

    private ensureWindows(): void {
        if (!IS_WINDOWS) {
            throw new Error(
                `computer_control desktop é implementado para Windows; esta máquina é ${process.platform}.`
            );
        }
    }

    private async screenSize(): Promise<ToolResult> {
        this.ensureWindows();
        const r = await runPowerShell(['-Action', 'size']);
        if (r.code !== 0 || !r.out) throw new Error(r.err || 'falha ao ler tamanho da tela');
        return { success: true, output: `Tela primária: ${r.out}` };
    }

    private async cursorPos(): Promise<ToolResult> {
        this.ensureWindows();
        const r = await runPowerShell(['-Action', 'pos']);
        return { success: true, output: `Cursor em: ${r.out}` };
    }

    private async screenshot(): Promise<ToolResult> {
        this.ensureWindows();
        fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
        const file = path.join(ARTIFACT_DIR, `screen-${Date.now()}.png`);
        const r = await runPowerShell(['-Action', 'screenshot', '-Out', file]);
        if (r.code !== 0 || !fs.existsSync(file)) throw new Error(r.err || 'falha ao capturar a tela');
        const size = fs.statSync(file).size;
        return {
            success: true,
            output: `Screenshot salvo: ${file} (${(size / 1024).toFixed(0)} KB)`,
            artifactPaths: [file],
        };
    }

    private async psSimple(action: 'move' | 'click', args: Record<string, unknown>): Promise<ToolResult> {
        this.ensureWindows();
        const x = Number(args.x);
        const y = Number(args.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`${action} exige x e y numéricos.`);
        const button = String(args.button || 'left');
        const r = await runPowerShell(['-Action', action, '-X', String(Math.round(x)), '-Y', String(Math.round(y)), '-Button', button]);
        if (r.code !== 0) throw new Error(r.err || `falha em ${action}`);
        return { success: true, output: `${action} em (${Math.round(x)}, ${Math.round(y)})${action === 'click' ? ` [${button}]` : ''} — ok` };
    }

    private async psType(args: Record<string, unknown>): Promise<ToolResult> {
        this.ensureWindows();
        const text = String(args.text ?? '');
        if (!text) throw new Error('type exige text.');
        const secret = args.secret === true;
        // SendKeys: escapa caracteres reservados
        const escaped = text.replace(/([+^%~(){}[\]])/g, '{$1}');
        const r = await runPowerShell(['-Action', 'type', '-Text', escaped]);
        if (r.code !== 0) throw new Error(r.err || 'falha ao digitar');
        return {
            success: true,
            output: secret ? 'Texto digitado (oculto).' : `Texto digitado (${text.length} caracteres).`,
        };
    }

    private async psKey(args: Record<string, unknown>): Promise<ToolResult> {
        this.ensureWindows();
        const key = String(args.key || '').trim();
        if (!key) throw new Error('key exige key (ex.: enter, ctrl+s).');
        const r = await runPowerShell(['-Action', 'key', '-Key', key]);
        if (r.code !== 0) throw new Error(r.err || 'falha ao enviar tecla');
        return { success: true, output: `Tecla enviada: ${key}` };
    }

    /* ---------------------------- browser ---------------------------- */

    private async browserOpen(args: Record<string, unknown>): Promise<ToolResult> {
        const url = String(args.url || '').trim();
        if (!/^https?:\/\//i.test(url)) throw new Error('browser_open exige url http(s) válida.');
        const headless = args.headless !== false;
        const pw = await loadPlaywright();
        const page = await ensurePage(pw, headless);
        const resp = await page.goto(url, { waitUntil: 'domcontentloaded' });
        const status = resp ? resp.status() : 0;
        const title = await page.title();
        return {
            success: true,
            output: `Aberto: ${page.url()}\nHTTP ${status} | título: ${title || '(sem título)'}`,
        };
    }

    private async browserClick(args: Record<string, unknown>): Promise<ToolResult> {
        const selector = String(args.selector || '').trim();
        if (!selector) throw new Error('browser_click exige selector.');
        const pw = await loadPlaywright();
        const page = await ensurePage(pw, true);
        await page.click(selector);
        await page.waitForLoadState('domcontentloaded').catch(() => undefined);
        return { success: true, output: `Clique em "${selector}". URL agora: ${page.url()}` };
    }

    private async browserType(args: Record<string, unknown>): Promise<ToolResult> {
        const selector = String(args.selector || '').trim();
        const text = String(args.text ?? '');
        if (!selector) throw new Error('browser_type exige selector.');
        if (!text) throw new Error('browser_type exige text.');
        const secret = args.secret === true;
        const pw = await loadPlaywright();
        const page = await ensurePage(pw, true);
        await page.fill(selector, text);
        if (args.submit === true) {
            await page.press(selector, 'Enter');
            await page.waitForLoadState('domcontentloaded').catch(() => undefined);
        }
        return {
            success: true,
            output: secret
                ? `Preenchido "${selector}" (oculto)${args.submit ? ' + Enter' : ''}.`
                : `Preenchido "${selector}" com ${text.length} caracteres${args.submit ? ' + Enter' : ''}.`,
        };
    }

    private async browserText(args: Record<string, unknown>): Promise<ToolResult> {
        const selector = String(args.selector || 'body').trim();
        const pw = await loadPlaywright();
        const page = await ensurePage(pw, true);
        const raw = await page.textContent(selector).catch(() => null);
        if (raw === null) throw new Error(`Seletor não encontrado: ${selector}`);
        const text = String(raw).replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
        return {
            success: true,
            // Delimitado de propósito: conteúdo de página é dado não confiável.
            output: `URL: ${page.url()}\n<conteudo_nao_confiavel selector="${selector}">\n${text}\n</conteudo_nao_confiavel>`,
        };
    }

    private async browserScreenshot(): Promise<ToolResult> {
        const pw = await loadPlaywright();
        const page = await ensurePage(pw, true);
        fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
        const file = path.join(ARTIFACT_DIR, `browser-${Date.now()}.png`);
        await page.screenshot({ path: file, fullPage: false });
        const size = fs.statSync(file).size;
        return {
            success: true,
            output: `Screenshot do navegador: ${file} (${(size / 1024).toFixed(0)} KB) | URL: ${page.url()}`,
            artifactPaths: [file],
        };
    }
}
