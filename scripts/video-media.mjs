#!/usr/bin/env node
/**
 * video-media.mjs — Download validado de vídeos (yt-dlp + ffprobe/ffmpeg) e transcrição
 * local/homelab (API Whisper configurada no .env, faster-whisper com .srt ou whisper CLI).
 *
 * Multiplataforma (Windows, Linux, macOS): mede os binários disponíveis em tempo de execução
 * sem receitas fixas de sistema operacional nem endereços de rede embutidos.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const INSTALL_ROOT_PADRAO = path.resolve(__dirname, '..');

const ENV_PERMITIDAS = new Set(['WHISPER_API_URL', 'WHISPER_API_FALLBACK', 'WHISPER_PATH', 'WORKSPACE_DIR']);
const HEARTBEAT_MS = 15_000;
// 48 MB em bytes decimais fica com folga abaixo do teto de 50 MiB da Bot API do Telegram e do WhatsApp.
const LIMITE_ENVIO_PADRAO_BYTES = 48_000_000;
const LIMITE_DURACAO_LEVE_S = 900;

const SCRIPT_FASTER_WHISPER = String.raw`
import inspect
import json
import sys

wav_path, txt_path, srt_path, model_name, lang = sys.argv[1:6]

def patch_av():
    try:
        import av
        sig = inspect.signature(av.open)
        if "metadata_errors" not in sig.parameters:
            orig_open = av.open
            def wrapped_open(*args, **kwargs):
                kwargs.pop("metadata_errors", None)
                return orig_open(*args, **kwargs)
            av.open = wrapped_open
    except Exception:
        pass

def fmt_txt(seg_s):
    total = max(0, int(seg_s))
    h, rem = divmod(total, 3600)
    m, s = divmod(rem, 60)
    return f"{h:02d}:{m:02d}:{s:02d}"

def fmt_srt(seg_s):
    ms_total = max(0, round(float(seg_s) * 1000))
    total_s, ms = divmod(ms_total, 1000)
    h, rem = divmod(total_s, 3600)
    m, s = divmod(rem, 60)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"

patch_av()
from faster_whisper import WhisperModel

device = "cpu"
compute_type = "int8"
try:
    import torch
    if torch.cuda.is_available():
        device = "cuda"
        compute_type = "float16"
except Exception:
    pass

try:
    model = WhisperModel(model_name, device=device, compute_type=compute_type)
except Exception:
    if device != "cpu":
        device = "cpu"
        compute_type = "int8"
        model = WhisperModel(model_name, device="cpu", compute_type="int8")
    else:
        raise

language_arg = None if not lang or lang == "auto" else lang
segs_iter, info = model.transcribe(wav_path, language=language_arg, beam_size=5)

txt_lines = []
srt_blocks = []
for idx, seg in enumerate(segs_iter, start=1):
    texto = (seg.text or "").strip()
    if not texto:
        continue
    txt_lines.append(f"[{fmt_txt(seg.start)}] {texto}")
    srt_blocks.append(f"{idx}\n{fmt_srt(seg.start)} --> {fmt_srt(seg.end)}\n{texto}\n")

txt_out = "\n".join(txt_lines) + ("\n" if txt_lines else "")
srt_out = "\n".join(srt_blocks)

with open(txt_path, "w", encoding="utf-8") as f:
    f.write(txt_out)
with open(srt_path, "w", encoding="utf-8") as f:
    f.write(srt_out)

print(json.dumps({
    "segmentos": len(txt_lines),
    "idioma": getattr(info, "language", None) or (language_arg or "desconhecido"),
    "caracteres": len(txt_out.strip()),
    "device": device,
}, ensure_ascii=False))
`.trim();

/** Carrega variáveis de mídia do `.env` da instalação apenas quando ausentes em `env`. */
export function carregarEnvSeFaltar(installRoot = INSTALL_ROOT_PADRAO, env = process.env) {
    const envPath = path.join(installRoot, '.env');
    if (!fs.existsSync(envPath)) return env;
    const raw = fs.readFileSync(envPath, 'utf-8').replace(/^\uFEFF/, '');
    for (const linha of raw.split(/\r?\n/)) {
        const limpa = linha.trim();
        if (!limpa || limpa.startsWith('#')) continue;
        const m = limpa.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
        if (!m) continue;
        const [, chave, bruto] = m;
        if (!ENV_PERMITIDAS.has(chave) || chave in env) continue;
        let valor = bruto.trim();
        if ((valor.startsWith('"') && valor.endsWith('"')) || (valor.startsWith("'") && valor.endsWith("'"))) {
            valor = valor.slice(1, -1);
        } else {
            const hash = valor.indexOf(' #');
            if (hash >= 0) valor = valor.slice(0, hash).trim();
        }
        env[chave] = valor;
    }
    return env;
}

export function ehUrlHttpValida(entrada) {
    if (typeof entrada !== 'string') return false;
    const limpa = entrada.trim();
    if (!limpa || limpa.startsWith('-') || !/^https?:\/\/\S+$/i.test(limpa)) return false;
    try {
        const u = new URL(limpa);
        return (u.protocol === 'http:' || u.protocol === 'https:') && Boolean(u.hostname);
    } catch {
        return false;
    }
}

export function sanitizarNome(nome, fallback = 'video') {
    const limpo = String(nome || '')
        .replace(/[^A-Za-z0-9_-]+/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 80);
    return limpo || fallback;
}

export function formatarTempoTxt(segundos) {
    const total = Math.max(0, Math.floor(Number(segundos) || 0));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return [h, m, s].map(n => String(n).padStart(2, '0')).join(':');
}

export function formatarTempoSrt(segundos) {
    const msTotal = Math.max(0, Math.round((Number(segundos) || 0) * 1000));
    const ms = msTotal % 1000;
    const totalS = Math.floor(msTotal / 1000);
    const h = Math.floor(totalS / 3600);
    const m = Math.floor((totalS % 3600) / 60);
    const s = totalS % 60;
    const hhmmss = [h, m, s].map(n => String(n).padStart(2, '0')).join(':');
    return `${hhmmss},${String(ms).padStart(3, '0')}`;
}

export function gerarSrt(segmentos) {
    return segmentos
        .map((seg, i) => ({ ...seg, texto: String(seg.texto ?? seg.text ?? '').trim(), idx: i + 1 }))
        .filter(seg => seg.texto.length > 0)
        .map((seg, i) => `${i + 1}\n${formatarTempoSrt(seg.start)} --> ${formatarTempoSrt(seg.end)}\n${seg.texto}\n`)
        .join('\n');
}

export function parseArgs(argv) {
    const [comando, ...rest] = argv;
    if (!comando || comando === '--help' || comando === '-h') return { comando: 'ajuda' };
    if (!['sondar', 'baixar', 'transcrever'].includes(comando)) {
        throw new Error(`Comando desconhecido: "${comando}". Use: sondar, baixar ou transcrever.`);
    }
    const opcoes = {
        comando,
        entrada: null,
        whatsapp: false,
        legendas: false,
        saida: null,
        nome: null,
        altura: 720,
        maxMb: null,
        lang: 'pt',
        model: 'base',
    };
    const precisaValor = (flag, i) => {
        if (i + 1 >= rest.length) throw new Error(`Falta o valor para ${flag}.`);
        return rest[i + 1];
    };
    for (let i = 0; i < rest.length; i++) {
        const a = rest[i];
        if (a === '--whatsapp' || a === '--telegram') opcoes.whatsapp = true;
        else if (a === '--legendas') opcoes.legendas = true;
        else if (a === '--saida') opcoes.saida = precisaValor(a, i++);
        else if (a === '--nome') opcoes.nome = precisaValor(a, i++);
        else if (a === '--lang') opcoes.lang = precisaValor(a, i++);
        else if (a === '--model') opcoes.model = precisaValor(a, i++);
        else if (a === '--max-mb') {
            const bruto = precisaValor(a, i++);
            const n = Number(bruto);
            if (!Number.isFinite(n) || n <= 0) throw new Error(`Valor inválido para --max-mb: ${bruto}`);
            opcoes.maxMb = n;
        } else if (a === '--altura') {
            const bruto = precisaValor(a, i++);
            const n = Number(bruto);
            if (!Number.isFinite(n) || n <= 0) throw new Error(`Valor inválido para --altura: ${bruto}`);
            opcoes.altura = Math.round(n);
        } else if (a.startsWith('-')) {
            throw new Error(`Opção desconhecida: ${a}`);
        } else if (opcoes.entrada === null) {
            opcoes.entrada = a;
        } else {
            throw new Error(`Argumento inesperado: ${a}`);
        }
    }
    if ((comando === 'baixar' || comando === 'transcrever') && !opcoes.entrada) {
        throw new Error(`Informe a URL${comando === 'transcrever' ? ' ou o arquivo' : ''} para o comando "${comando}".`);
    }
    return opcoes;
}

function defaultRunSync(bin, args, opts = {}) {
    const r = spawnSync(bin, args, {
        encoding: 'utf-8',
        windowsHide: true,
        timeout: opts.timeout ?? 10_000,
        env: opts.env,
        cwd: opts.cwd,
    });
    return {
        status: r.status ?? (r.error ? 1 : 0),
        stdout: r.stdout || '',
        stderr: r.stderr || '',
        error: r.error ? r.error.message : null,
    };
}

function defaultRunAsync(bin, args, opts = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(bin, args, {
            cwd: opts.cwd,
            env: opts.env,
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        const t0 = Date.now();
        let stdout = '';
        let stderr = '';
        const cap = (buf, chunk) => {
            const next = buf + chunk;
            return next.length > 2_000_000 ? next.slice(-2_000_000) : next;
        };
        const timer = setInterval(() => {
            const seg = Math.round((Date.now() - t0) / 1000);
            process.stderr.write(`[video-media] executando ${path.basename(bin)} (${seg}s)...\n`);
        }, HEARTBEAT_MS);

        child.stdout.on('data', d => { stdout = cap(stdout, d.toString('utf-8')); });
        child.stderr.on('data', d => { stderr = cap(stderr, d.toString('utf-8')); });
        child.on('error', err => {
            clearInterval(timer);
            reject(err);
        });
        child.on('close', code => {
            clearInterval(timer);
            resolve({ code: code ?? 1, stdout, stderr });
        });
        if (opts.stdinText != null) child.stdin.write(opts.stdinText, 'utf-8');
        child.stdin.end();
    });
}

function temSeparador(candidato) {
    return candidato.includes('/') || candidato.includes('\\');
}

function testarCandidatos(candidatos, args, runSync, env, validar = r => r.status === 0) {
    const sondados = [];
    const vistos = new Set();
    for (const c of candidatos) {
        if (!c || vistos.has(c)) continue;
        vistos.add(c);
        sondados.push(c);
        if (temSeparador(c) && !fs.existsSync(c)) continue;
        const r = runSync(c, args, { env });
        if (validar(r)) {
            const primeiraLinha = (r.stdout || r.stderr || '').trim().split(/\r?\n/)[0] || '';
            return { found: true, path: c, version: primeiraLinha, probed: sondados };
        }
    }
    return { found: false, path: null, version: null, probed: sondados };
}

/** Sonda dinamicamente binários, venvs e configuração Whisper no ambiente atual. */
export function sondarAmbiente({
    installRoot = INSTALL_ROOT_PADRAO,
    workspaceDir,
    env = process.env,
    runSync = defaultRunSync,
} = {}) {
    carregarEnvSeFaltar(installRoot, env);
    const ws = workspaceDir || path.resolve(installRoot, env.WORKSPACE_DIR || 'workspace');
    const home = env.HOME || env.USERPROFILE || os.homedir();

    const ytDlp = testarCandidatos(
        [
            path.join(ws, 'venv', 'Scripts', 'yt-dlp.exe'),
            path.join(ws, 'venv', 'bin', 'yt-dlp'),
            path.join(installRoot, 'venv', 'Scripts', 'yt-dlp.exe'),
            path.join(installRoot, 'venv', 'bin', 'yt-dlp'),
            path.join(home, '.local', 'bin', 'yt-dlp.exe'),
            path.join(home, '.local', 'bin', 'yt-dlp'),
            'yt-dlp',
        ],
        ['--version'],
        runSync,
        env,
        r => r.status === 0 && Boolean((r.stdout || '').trim()),
    );

    const ffmpeg = testarCandidatos(['ffmpeg'], ['-version'], runSync, env);
    const ffprobe = testarCandidatos(['ffprobe'], ['-version'], runSync, env);

    const fasterWhisperPython = testarCandidatos(
        [
            path.join(ws, 'venv', 'Scripts', 'python.exe'),
            path.join(ws, 'venv', 'bin', 'python'),
            path.join(installRoot, 'venv', 'Scripts', 'python.exe'),
            path.join(installRoot, 'venv', 'bin', 'python'),
            'python3',
            'python',
        ],
        ['-c', 'import faster_whisper; print(getattr(faster_whisper, "__version__", "ok"))'],
        runSync,
        env,
        r => r.status === 0,
    );

    const whisperCli = testarCandidatos(
        [env.WHISPER_PATH, 'whisper'].filter(Boolean),
        ['--help'],
        runSync,
        env,
        r => r.status === 0,
    );

    let ytDlpHasCurlCffi = false;
    if (fasterWhisperPython.found) {
        const cr = runSync(fasterWhisperPython.path, ['-c', 'import curl_cffi; print("ok")'], { env });
        ytDlpHasCurlCffi = cr.status === 0;
    }
    if (!ytDlpHasCurlCffi && ytDlp.found) {
        const ir = runSync(ytDlp.path, ['--list-impersonate-targets'], { env });
        ytDlpHasCurlCffi = ir.status === 0 && /\b(chrome|edge|safari|firefox)\b/i.test(ir.stdout);
    }

    const whisperUrls = [env.WHISPER_API_URL, env.WHISPER_API_FALLBACK]
        .map(u => (u || '').trim())
        .filter(Boolean);

    return {
        platform: process.platform,
        ytDlp,
        ffmpeg,
        ffprobe,
        fasterWhisperPython,
        whisperCli,
        ytDlpHasCurlCffi,
        whisperApiConfigured: whisperUrls.length > 0,
        whisperApiCount: whisperUrls.length,
        probed: { workspaceDir: ws, installRoot },
    };
}

function inspecionarComFfprobe(ffprobeBin, arquivo, runSync, env) {
    const r = runSync(ffprobeBin, [
        '-v', 'error',
        '-show_entries', 'stream=codec_type,codec_name,width,height:format=duration,size',
        '-of', 'json',
        arquivo,
    ], { env, timeout: 30_000 });
    if (r.status !== 0) {
        throw new Error(`ffprobe falhou (${r.status}): ${(r.stderr || r.stdout || r.error || '').trim()}`);
    }
    const info = JSON.parse(r.stdout || '{}');
    const streams = Array.isArray(info.streams) ? info.streams : [];
    const video = streams.find(s => s.codec_type === 'video') || null;
    const audio = streams.find(s => s.codec_type === 'audio') || null;
    const duracaoS = Number(info.format?.duration || 0);
    const tamanhoBytes = Number(info.format?.size || (fs.existsSync(arquivo) ? fs.statSync(arquivo).size : 0));
    return { video, audio, duracaoS, tamanhoBytes };
}

function localizarArquivoPrefixo(dir, prefixo) {
    const itens = fs.readdirSync(dir)
        .filter(f => f.startsWith(prefixo) && !f.endsWith('.part') && !f.endsWith('.ytdl'))
        .map(f => ({ nome: f, full: path.join(dir, f), mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
    return itens[0]?.full || null;
}

function removerPrefixo(dir, prefixo) {
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir)) {
        if (f.startsWith(prefixo)) {
            try { fs.rmSync(path.join(dir, f), { force: true }); } catch { /* noop */ }
        }
    }
}

function moverArquivo(origem, destino) {
    if (path.resolve(origem) === path.resolve(destino)) return;
    try {
        fs.renameSync(origem, destino);
    } catch {
        fs.copyFileSync(origem, destino);
        fs.rmSync(origem, { force: true });
    }
}

/** Baixa um vídeo via yt-dlp e valida a faixa de vídeo via ffprobe (+ recodificação opcional). */
export async function baixarVideo(opcoes, deps = {}) {
    if (!ehUrlHttpValida(opcoes.url)) {
        throw new Error(`URL inválida para download: "${opcoes.url}". Informe um endereço http:// ou https://.`);
    }
    const env = deps.env || process.env;
    const installRoot = deps.installRoot || INSTALL_ROOT_PADRAO;
    const runSync = deps.runSync || defaultRunSync;
    const runAsync = deps.runAsync || defaultRunAsync;
    const sonda = deps.sonda || sondarAmbiente({ installRoot, workspaceDir: deps.workspaceDir, env, runSync });

    if (!sonda.ytDlp?.found) {
        throw new Error(`yt-dlp não encontrado. Locais sondados: ${(sonda.ytDlp?.probed || []).join(', ')}`);
    }
    if (!sonda.ffprobe?.found) {
        throw new Error(`ffprobe não encontrado. Locais sondados: ${(sonda.ffprobe?.probed || []).join(', ')}`);
    }

    const outDir = path.resolve(opcoes.saida || process.cwd());
    fs.mkdirSync(outDir, { recursive: true });
    const base = sanitizarNome(opcoes.nome, `video_${Date.now()}`);
    const rawPrefixo = `${base}_raw.`;
    const rawTemplate = path.join(outDir, `${base}_raw.%(ext)s`);
    const altura = Number.isFinite(opcoes.altura) && opcoes.altura > 0 ? Math.round(opcoes.altura) : 720;
    const fmt = `bv*[vcodec^=avc1][height<=${altura}]+ba[acodec^=mp4a]/bv*[vcodec^=avc1][width<=${altura}]+ba[acodec^=mp4a]/bv*[height<=${altura}]+ba/bv*[width<=${altura}]+ba/b[height<=${altura}]/b`;

    const dlRes = await runAsync(
        sonda.ytDlp.path,
        ['--no-playlist', '--no-warnings', '--newline', '-f', fmt, '--merge-output-format', 'mp4', '-o', rawTemplate, '--', opcoes.url],
        { cwd: outDir, env },
    );
    if (dlRes.code !== 0) {
        removerPrefixo(outDir, rawPrefixo);
        throw new Error(`yt-dlp falhou (código ${dlRes.code}): ${(dlRes.stderr || dlRes.stdout).trim().slice(-600)}`);
    }

    const rawFile = localizarArquivoPrefixo(outDir, rawPrefixo);
    if (!rawFile) {
        throw new Error('yt-dlp concluiu sem gerar arquivo de vídeo legível no diretório de saída.');
    }

    let infoRaw;
    try {
        infoRaw = inspecionarComFfprobe(sonda.ffprobe.path, rawFile, runSync, env);
        if (!infoRaw.video) {
            throw new Error('Arquivo baixado não possui faixa de vídeo válida (apenas áudio ou mídia corrompida).');
        }
    } catch (err) {
        try { fs.rmSync(rawFile, { force: true }); } catch { /* noop */ }
        throw err;
    }

    const vCodec = String(infoRaw.video.codec_name || '').toLowerCase();
    const aCodec = String(infoRaw.audio?.codec_name || '').toLowerCase();
    const rawWidth = Number(infoRaw.video.width || 0);
    const rawHeight = Number(infoRaw.video.height || 0);
    const retrato = rawWidth > 0 && rawHeight > rawWidth;
    const ladoMenor = (rawWidth > 0 && rawHeight > 0) ? Math.min(rawWidth, rawHeight) : rawHeight;
    const temMaxMb = opcoes.maxMb != null && Number.isFinite(Number(opcoes.maxMb)) && Number(opcoes.maxMb) > 0;
    const limiteBytes = temMaxMb ? Math.round(Number(opcoes.maxMb) * 1_000_000) : LIMITE_ENVIO_PADRAO_BYTES;
    const aplicarLimiteTamanho = Boolean(opcoes.whatsapp) || temMaxMb;
    const precisaRecodificar = aplicarLimiteTamanho && (
        vCodec !== 'h264'
        || (Boolean(infoRaw.audio) && aCodec !== 'aac')
        || (ladoMenor > altura)
        || infoRaw.tamanhoBytes > limiteBytes
    );

    let finalPath;
    if (precisaRecodificar) {
        if (!sonda.ffmpeg?.found) {
            try { fs.rmSync(rawFile, { force: true }); } catch { /* noop */ }
            throw new Error('ffmpeg não encontrado para converter o vídeo para H.264/AAC (--whatsapp/--telegram).');
        }
        finalPath = path.join(outDir, `${base}.mp4`);
        const modoLeve = infoRaw.tamanhoBytes > limiteBytes || infoRaw.duracaoS > LIMITE_DURACAO_LEVE_S;
        const targetH = modoLeve ? Math.min(altura, 480) : altura;
        const crf = modoLeve ? '28' : '26';
        const audioKbps = infoRaw.audio ? (modoLeve ? 64 : 128) : 0;
        const audioBitrate = `${audioKbps || 64}k`;
        let bitrateArgs = [];
        if (infoRaw.tamanhoBytes > limiteBytes && infoRaw.duracaoS > 0) {
            const totalAlvoKbps = Math.floor(((limiteBytes * 8 * 0.9) / infoRaw.duracaoS) / 1000);
            const videoMaxKbps = Math.max(150, totalAlvoKbps - audioKbps);
            if (videoMaxKbps < 2500) {
                bitrateArgs = ['-maxrate', `${videoMaxKbps}k`, '-bufsize', `${videoMaxKbps * 2}k`];
            }
        }
        const vf = (ladoMenor > targetH || ladoMenor === 0)
            ? (retrato ? `scale=${targetH}:-2` : `scale=-2:${targetH}`)
            : 'scale=trunc(iw/2)*2:trunc(ih/2)*2';
        const ffArgs = [
            '-y', '-i', rawFile,
            '-vf', vf,
            '-c:v', 'libx264', '-crf', crf, '-preset', 'veryfast', ...bitrateArgs, '-pix_fmt', 'yuv420p',
            ...(infoRaw.audio ? ['-c:a', 'aac', '-b:a', audioBitrate, '-ac', '2'] : ['-an']),
            '-movflags', '+faststart',
            finalPath,
        ];
        const ffRes = await runAsync(sonda.ffmpeg.path, ffArgs, { cwd: outDir, env });
        try { fs.rmSync(rawFile, { force: true }); } catch { /* noop */ }
        if (ffRes.code !== 0) {
            try { fs.rmSync(finalPath, { force: true }); } catch { /* noop */ }
            throw new Error(`ffmpeg falhou (código ${ffRes.code}): ${(ffRes.stderr || ffRes.stdout).trim().slice(-600)}`);
        }
    } else {
        const ext = aplicarLimiteTamanho ? '.mp4' : (path.extname(rawFile) || '.mp4');
        finalPath = path.join(outDir, `${base}${ext}`);
        moverArquivo(rawFile, finalPath);
    }

    const infoFinal = inspecionarComFfprobe(sonda.ffprobe.path, finalPath, runSync, env);
    if (!infoFinal.video || (precisaRecodificar && String(infoFinal.video.codec_name || '').toLowerCase() !== 'h264')) {
        throw new Error('Validação final com ffprobe falhou: arquivo resultante sem faixa de vídeo esperada.');
    }

    return {
        arquivo: finalPath,
        codecVideo: infoFinal.video.codec_name || 'desconhecido',
        codecAudio: infoFinal.audio?.codec_name || 'nenhum',
        largura: Number(infoFinal.video.width || 0),
        altura: Number(infoFinal.video.height || 0),
        duracaoS: Number(infoFinal.duracaoS.toFixed(1)),
        tamanhoBytes: infoFinal.tamanhoBytes,
        limiteBytes: aplicarLimiteTamanho ? limiteBytes : null,
        dentroDoLimite: !aplicarLimiteTamanho || infoFinal.tamanhoBytes <= limiteBytes,
        validadoVideo: true,
    };
}

/** Transcreve URL ou arquivo local para `.txt` (e `.srt` quando usa faster-whisper). */
export async function transcreverMidia(opcoes, deps = {}) {
    const env = deps.env || process.env;
    const installRoot = deps.installRoot || INSTALL_ROOT_PADRAO;
    const runSync = deps.runSync || defaultRunSync;
    const runAsync = deps.runAsync || defaultRunAsync;
    const fetchImpl = deps.fetch || globalThis.fetch;
    const sonda = deps.sonda || sondarAmbiente({ installRoot, workspaceDir: deps.workspaceDir, env, runSync });

    const isUrl = ehUrlHttpValida(opcoes.entrada);
    let entradaResolvida = opcoes.entrada;
    if (!isUrl) {
        entradaResolvida = path.resolve(opcoes.entrada);
        if (!fs.existsSync(entradaResolvida) || !fs.statSync(entradaResolvida).isFile()) {
            throw new Error(`Entrada inválida: "${opcoes.entrada}" não é uma URL http(s) válida nem um arquivo local existente.`);
        }
    }

    const outDir = path.resolve(opcoes.saida || process.cwd());
    fs.mkdirSync(outDir, { recursive: true });
    const base = sanitizarNome(
        opcoes.nome,
        isUrl ? `transcricao_${Date.now()}` : sanitizarNome(path.parse(entradaResolvida).name, `transcricao_${Date.now()}`),
    );
    const txtPath = path.join(outDir, `${base}.txt`);
    const srtPath = path.join(outDir, `${base}.srt`);
    const lang = opcoes.lang || 'pt';
    const model = opcoes.model || 'base';

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-video-media-'));
    try {
        let sourcePath = entradaResolvida;
        if (isUrl) {
            if (!sonda.ytDlp?.found) {
                throw new Error(`yt-dlp não encontrado para baixar o áudio da URL. Sondados: ${(sonda.ytDlp?.probed || []).join(', ')}`);
            }
            const audioTmpl = path.join(tmpDir, 'src.%(ext)s');
            const dlRes = await runAsync(
                sonda.ytDlp.path,
                ['--no-playlist', '--no-warnings', '--newline', '-f', 'bestaudio/best', '-o', audioTmpl, '--', opcoes.entrada],
                { cwd: tmpDir, env },
            );
            if (dlRes.code !== 0) {
                throw new Error(`yt-dlp falhou ao baixar áudio (código ${dlRes.code}): ${(dlRes.stderr || dlRes.stdout).trim().slice(-600)}`);
            }
            sourcePath = localizarArquivoPrefixo(tmpDir, 'src.');
            if (!sourcePath) throw new Error('yt-dlp não produziu arquivo de áudio para transcrição.');
        }

        let wavPath = path.join(tmpDir, 'audio.16k.wav');
        if (sonda.ffmpeg?.found) {
            const ffRes = await runAsync(
                sonda.ffmpeg.path,
                ['-y', '-i', sourcePath, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wavPath],
                { cwd: tmpDir, env },
            );
            if (ffRes.code !== 0) {
                throw new Error(`ffmpeg falhou ao converter áudio para WAV 16 kHz (código ${ffRes.code}): ${(ffRes.stderr || ffRes.stdout).trim().slice(-600)}`);
            }
        } else if (sourcePath.toLowerCase().endsWith('.wav')) {
            wavPath = sourcePath;
        } else {
            throw new Error('ffmpeg não encontrado para extrair e converter o áudio para WAV 16 kHz.');
        }

        const tentativas = [];
        const whisperUrls = [env.WHISPER_API_URL, env.WHISPER_API_FALLBACK]
            .map(u => (u || '').trim().replace(/\/+$/, ''))
            .filter(Boolean);

        if (!opcoes.legendas && whisperUrls.length > 0 && typeof fetchImpl === 'function') {
            for (const url of whisperUrls) {
                const ac = new AbortController();
                const reqTimeout = setTimeout(
                    () => ac.abort(new Error('Tempo limite da API Whisper atingido (600s).')),
                    600_000,
                );
                const heartbeat = setInterval(() => {
                    process.stderr.write('[video-media] aguardando transcrição da API Whisper...\n');
                }, HEARTBEAT_MS);
                try {
                    const form = new FormData();
                    const wavBytes = fs.readFileSync(wavPath);
                    form.append('file', new Blob([wavBytes], { type: 'audio/wav' }), 'audio.wav');
                    form.append('response_format', 'json');
                    if (lang && lang !== 'auto') form.append('language', lang);

                    const res = await fetchImpl(`${url}/inference`, {
                        method: 'POST',
                        body: form,
                        headers: { Connection: 'close' },
                        signal: ac.signal,
                    });
                    if (!res.ok) {
                        try { await res.body?.cancel(); } catch { /* noop */ }
                        tentativas.push(`whisper_api: HTTP ${res.status}`);
                        continue;
                    }
                    const json = await res.json();
                    const texto = String(json?.text || json?.transcription || '').trim();
                    if (!texto) {
                        tentativas.push('whisper_api: resposta vazia');
                        continue;
                    }
                    fs.writeFileSync(txtPath, `${texto}\n`, 'utf-8');
                    return {
                        txtPath,
                        srtPath: null,
                        motor: 'whisper_api',
                        caracteres: texto.length,
                        segmentos: null,
                        idioma: lang,
                    };
                } catch (err) {
                    tentativas.push(`whisper_api: ${err instanceof Error ? err.message : String(err)}`);
                } finally {
                    clearTimeout(reqTimeout);
                    clearInterval(heartbeat);
                }
            }
        }

        if (sonda.fasterWhisperPython?.found) {
            const pyRes = await runAsync(
                sonda.fasterWhisperPython.path,
                ['-', wavPath, txtPath, srtPath, model, lang],
                { cwd: outDir, env, stdinText: SCRIPT_FASTER_WHISPER },
            );
            if (pyRes.code === 0) {
                const linhas = pyRes.stdout.trim().split(/\r?\n/).filter(Boolean);
                const resumo = JSON.parse(linhas[linhas.length - 1] || '{}');
                if (fs.existsSync(txtPath) && fs.readFileSync(txtPath, 'utf-8').trim()) {
                    return {
                        txtPath,
                        srtPath: fs.existsSync(srtPath) ? srtPath : null,
                        motor: `faster-whisper (${model})`,
                        caracteres: Number(resumo.caracteres || 0),
                        segmentos: Number(resumo.segmentos || 0),
                        idioma: resumo.idioma || lang,
                    };
                }
                tentativas.push('faster-whisper: transcrição vazia (nenhum segmento detectado)');
            } else {
                tentativas.push(`faster-whisper (código ${pyRes.code}): ${(pyRes.stderr || pyRes.stdout).trim().slice(-400)}`);
            }
        } else {
            tentativas.push('faster-whisper: módulo Python faster_whisper não encontrado');
        }

        if (!opcoes.legendas && sonda.whisperCli?.found) {
            const cliArgs = [wavPath, '--output_dir', tmpDir, '--output_format', 'txt'];
            if (lang && lang !== 'auto') cliArgs.push('--language', lang);
            const cliRes = await runAsync(sonda.whisperCli.path, cliArgs, { cwd: tmpDir, env });
            const cliTxt = path.join(tmpDir, `${path.parse(wavPath).name}.txt`);
            const texto = fs.existsSync(cliTxt)
                ? fs.readFileSync(cliTxt, 'utf-8').trim()
                : cliRes.stdout.trim();
            if (cliRes.code === 0 && texto) {
                fs.writeFileSync(txtPath, `${texto}\n`, 'utf-8');
                return {
                    txtPath,
                    srtPath: null,
                    motor: 'whisper_cli',
                    caracteres: texto.length,
                    segmentos: null,
                    idioma: lang,
                };
            }
            tentativas.push(`whisper_cli (código ${cliRes.code}): ${(cliRes.stderr || cliRes.stdout).trim().slice(-400)}`);
        }

        throw new Error(`Nenhum motor de transcrição produziu resultado. Tentativas: ${tentativas.join(' | ')}`);
    } finally {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
    }
}

async function main() {
    const opcoes = parseArgs(process.argv.slice(2));
    if (opcoes.comando === 'ajuda') {
        console.log([
            'Uso:',
            '  node scripts/video-media.mjs sondar',
            '  node scripts/video-media.mjs baixar <url> [--whatsapp|--telegram] [--max-mb <mb>] [--saida <dir>] [--nome <base>] [--altura <px>]',
            '  node scripts/video-media.mjs transcrever <url_ou_arquivo> [--legendas] [--lang <cod>] [--model <nome>] [--saida <dir>] [--nome <base>]',
        ].join('\n'));
        return;
    }

    if (opcoes.comando === 'sondar') {
        console.log(JSON.stringify(sondarAmbiente(), null, 2));
        return;
    }

    if (opcoes.comando === 'baixar') {
        const r = await baixarVideo({
            url: opcoes.entrada,
            whatsapp: opcoes.whatsapp,
            maxMb: opcoes.maxMb,
            saida: opcoes.saida,
            nome: opcoes.nome,
            altura: opcoes.altura,
        });
        console.log([
            `ARQUIVO_GERADO: ${r.arquivo}`,
            `CODEC_VIDEO: ${r.codecVideo}`,
            `CODEC_AUDIO: ${r.codecAudio}`,
            `LARGURA_PX: ${r.largura}`,
            `ALTURA_PX: ${r.altura}`,
            `DURACAO_S: ${r.duracaoS}`,
            `TAMANHO_BYTES: ${r.tamanhoBytes}`,
            ...(r.dentroDoLimite === false && r.limiteBytes
                ? [`AVISO_TAMANHO: arquivo final (${(r.tamanhoBytes / 1_000_000).toFixed(1)} MB) excede o limite de ${(r.limiteBytes / 1_000_000).toFixed(1)} MB`]
                : []),
            `VALIDADO_VIDEO: ${r.validadoVideo}`,
        ].join('\n'));
        return;
    }

    if (opcoes.comando === 'transcrever') {
        const r = await transcreverMidia({
            entrada: opcoes.entrada,
            legendas: opcoes.legendas,
            lang: opcoes.lang,
            model: opcoes.model,
            saida: opcoes.saida,
            nome: opcoes.nome,
        });
        const linhas = [
            `TRANSCRICAO_TXT: ${r.txtPath}`,
            ...(r.srtPath ? [`LEGENDA_SRT: ${r.srtPath}`] : []),
            `MOTOR: ${r.motor}`,
            ...(r.segmentos != null ? [`SEGMENTOS: ${r.segmentos}`] : []),
            `IDIOMA_DETECTADO: ${r.idioma}`,
            `CARACTERES: ${r.caracteres}`,
        ];
        console.log(linhas.join('\n'));
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
    main().catch(err => {
        console.error(`ERRO: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
    });
}
