/**
 * As dependências reais do instalador genérico: rede, processos e PM2.
 */
import { execSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Dependencias, Resultado } from './gerenciador';

/**
 * Variáveis de ambiente que os comandos de uma integração podem ver. As do NewClaw (senha do painel, tokens, chaves de
 * provedor) NÃO passam: a integração é código de terceiros e recebe só o que um programa comum precisa para rodar.
 */
const AMBIENTE_PERMITIDO = [
    'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'windir', 'COMSPEC', 'ComSpec', 'TEMP', 'TMP', 'TMPDIR',
    'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'ProgramData',
    'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'CommonProgramFiles', 'USERNAME', 'USER', 'LOGNAME',
    'LANG', 'LC_ALL', 'SHELL', 'XDG_RUNTIME_DIR', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS',
    'PM2_HOME', 'CUDA_PATH',
];

export function ambienteDaIntegracao(origem: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' };
    for (const k of AMBIENTE_PERMITIDO) if (origem[k] !== undefined) env[k] = origem[k];
    return env;
}

/**
 * Onde está o PM2, com a mesma busca do `bin/newclaw` (findPM2): o script JS do PM2, rodado com o próprio Node — no
 * Windows o `pm2` do PATH é um .cmd, que não roda sem shell. Duplicação conhecida: o `bin/newclaw` é um script fora de
 * `src/` e não importa módulos do núcleo.
 */
export function localizarPm2(): string[] | null {
    const candidatos: string[] = [];
    try {
        const prefixo = execSync('npm prefix -g', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }).trim();
        candidatos.push(path.join(prefixo, 'node_modules', 'pm2', 'bin', 'pm2'), path.join(prefixo, 'lib', 'node_modules', 'pm2', 'bin', 'pm2'));
    } catch { /* npm fora do PATH */ }
    if (process.platform === 'win32') {
        candidatos.push(path.join(process.env.APPDATA || '', 'npm', 'node_modules', 'pm2', 'bin', 'pm2'));
    } else {
        candidatos.push('/usr/local/lib/node_modules/pm2/bin/pm2', '/usr/lib/node_modules/pm2/bin/pm2',
            path.join(os.homedir(), '.npm-global', 'lib', 'node_modules', 'pm2', 'bin', 'pm2'));
    }
    const achado = candidatos.find((c) => { try { return fs.statSync(c).isFile(); } catch { return false; } });
    return achado ? [process.execPath, achado] : null;
}

/**
 * O `tar` que extrai o pacote. No Windows, sempre o do próprio sistema (`System32\tar.exe`, bsdtar, desde o Windows 10):
 * o primeiro `tar` do PATH pode ser o GNU tar do Git, que lê `C:\...` como "máquina C, caminho \..." e falha ("Cannot
 * connect to C: resolve failed") — achado no teste S465, 30/10/2026.
 */
export function localizarTar(plataforma: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string {
    if (plataforma !== 'win32') return 'tar';
    const doSistema = path.join(env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows', 'System32', 'tar.exe');
    return fs.existsSync(doSistema) ? doSistema : 'tar';
}

function rodar(programa: string, args: string[], pasta: string | undefined, aoLer?: (linha: string) => void): Promise<Resultado> {
    return new Promise((resolve) => {
        let saida = '';
        let erro = '';
        let resto = '';
        const filho = spawn(programa, args, { cwd: pasta, env: ambienteDaIntegracao(), windowsHide: true });
        const linhas = (pedaco: Buffer, ehErro: boolean) => {
            const texto = pedaco.toString('utf-8');
            if (ehErro) erro += texto; else saida += texto;
            if (!aoLer) return;
            const partes = (resto + texto).split(/\r?\n/);
            resto = partes.pop() ?? '';
            partes.forEach(aoLer);
        };
        filho.stdout.on('data', (p: Buffer) => linhas(p, false));
        filho.stderr.on('data', (p: Buffer) => linhas(p, true));
        filho.on('error', (e) => resolve({ codigo: 127, saida, erro: `${erro}${e.message}` }));
        filho.on('close', (codigo) => {
            if (aoLer && resto) aoLer(resto);
            resolve({ codigo: codigo ?? 1, saida, erro });
        });
    });
}

export function dependenciasReais(newclawUrl: string): Dependencias {
    let pm2: string[] | null | undefined;  // procurado no primeiro uso, não quando o painel sobe
    return {
        get pm2() {
            if (pm2 === undefined) pm2 = localizarPm2();
            return pm2;
        },
        async baixar(url) {
            const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(120_000) });
            return { urlFinal: r.url || url, status: r.status, corpo: Buffer.from(await r.arrayBuffer()) };
        },
        executar: (programa, args, pasta) => rodar(programa, args, pasta),
        acompanhar: async (programa, args, pasta, aoLer) => (await rodar(programa, args, pasta, aoLer)).codigo,
        tar: localizarTar(),
        home: os.homedir(),
        plataforma: process.platform,
        newclawUrl,
        registro: path.join(process.cwd(), 'data', 'integracoes-opcionais.json'),
    };
}
