/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S498 (22/11/2026)
 *
 * Skill nativa `video-media` + script unificado `scripts/video-media.mjs` (download validado com
 * ffprobe + transcrição local/homelab sem receitas fixas de SO nem IPs privados embutidos).
 *
 * REGRESSÃO SE: a skill não carregar/expandir `{NEWCLAW}`; gatilhos de frase da ADR-040 falharem
 * ou casarem conversa comum; `baixarVideo` aceitar stream sem faixa de vídeo (`video:0kB`) ou
 * omitir `--` antes da URL; `transcreverMidia` ignorar `WHISPER_API_URL`/`WHISPER_API_FALLBACK`
 * ou não usar `faster-whisper` quando `--legendas` for pedido; `carregarEnvSeFaltar` sobrescrever
 * `WHISPER_API_URL=""` já definido; ou o script usar `shell: true` / `exec(` / IP privado.
 *
 * Execução: npx ts-node src/__tests__/regression/S498_Skill_VideoMedia.test.ts
 */
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { pathToFileURL } from 'url';
import { SkillLoader } from '../../skills/SkillLoader';
import { matchSkillByTrigger } from '../../skills/SkillDiscovery';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}

const ROOT = path.join(__dirname, '..', '..', '..');
const SCRIPT_PATH = path.join(ROOT, 'scripts', 'video-media.mjs');
const SKILLS_DIR = path.join(ROOT, 'skills');

interface VideoMediaModule {
    carregarEnvSeFaltar: (installRoot?: string, env?: Record<string, string | undefined>) => Record<string, string | undefined>;
    parseArgs: (argv: string[]) => Record<string, unknown>;
    baixarVideo: (opcoes: Record<string, unknown>, deps?: Record<string, unknown>) => Promise<Record<string, unknown>>;
    transcreverMidia: (opcoes: Record<string, unknown>, deps?: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

async function importarModulo(): Promise<VideoMediaModule> {
    const href = pathToFileURL(SCRIPT_PATH).href;
    return await (Function('u', 'return import(u)')(href) as Promise<VideoMediaModule>);
}

async function main(): Promise<void> {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-s498-'));
    try {
        console.log('\n=== S498-1 — SkillLoader carrega e expande video-media (ADR-035) ===');
        const loader = new SkillLoader(SKILLS_DIR);
        const skills = loader.loadAll();
        const skill = skills.find(s => s.name === 'video-media');
        assert(Boolean(skill), 'skill video-media carregada pelo SkillLoader');
        if (skill) {
            const esperado = path.join(process.cwd(), 'scripts', 'video-media.mjs');
            assert(skill.content.includes(esperado) && fs.existsSync(esperado),
                '{NEWCLAW}/scripts/video-media.mjs expandido para caminho real existente', { esperado });
            assert((skill.plataformas ?? []).includes('todas'), 'plataformas inclui "todas"', skill.plataformas);
            assert(!skill.avisos?.curtos.length, 'sem avisos de portabilidade', skill.avisos);
        }

        console.log('\n=== S498-2 — Gatilhos ADR-040: frases de vídeo casam, conversa comum não ===');
        if (skill) {
            const positivas = [
                'Baixe o vídeo vou enviar para meu pai',
                'Estou tentando baixar vídeos ou transcrição de vídeos',
                'transcreve esse vídeo por favor',
                'quero gerar legenda srt sincronizada',
                'download video from this link',
                'descargar video en mp4',
                'https://vt.tiktok.com/ExEmPlO12/',
                'https://youtu.be/AbCdEfGhIjK',
                'https://www.instagram.com/reel/AbCd1234/',
            ];
            for (const msg of positivas) {
                assert(matchSkillByTrigger(skill, msg), `casa: "${msg}"`);
            }
            const negativas = [
                'oi',
                'como está a cotação hoje?',
                'baixa o arquivo PDF',
                'estou falando sobre o youtube',
                'envia esse link da aula',
            ];
            for (const msg of negativas) {
                assert(!matchSkillByTrigger(skill, msg), `não casa: "${msg}"`);
            }
        }

        console.log('\n=== S498-3 — CLI real: sondar e validação de argumentos ===');
        {
            const sondar = spawnSync(process.execPath, [SCRIPT_PATH, 'sondar'], { encoding: 'utf-8', cwd: ROOT, windowsHide: true });
            let parsed: Record<string, unknown> | null = null;
            try { parsed = JSON.parse(sondar.stdout); } catch { parsed = null; }
            assert(sondar.status === 0 && parsed !== null
                && 'platform' in parsed && 'whisperApiConfigured' in parsed
                && 'ytDlp' in parsed && 'ffmpeg' in parsed && 'ffprobe' in parsed,
                'sondar sai com 0 e imprime JSON estruturado', { status: sondar.status, stderr: sondar.stderr });

            const badScheme = spawnSync(process.execPath, [SCRIPT_PATH, 'baixar', 'ftp://invalido.example/a.mp4'], { encoding: 'utf-8', cwd: ROOT, windowsHide: true });
            assert(badScheme.status === 1, 'baixar ftp://... sai com código 1', badScheme.status);

            const flagInj = spawnSync(process.execPath, [SCRIPT_PATH, 'baixar', '--exec=malicioso'], { encoding: 'utf-8', cwd: ROOT, windowsHide: true });
            assert(flagInj.status === 1, 'baixar --exec=... (flag injection) sai com código 1', flagInj.status);

            const missingFile = spawnSync(process.execPath, [SCRIPT_PATH, 'transcrever', path.join(tmp, 'inexistente_s498.mp4')], { encoding: 'utf-8', cwd: ROOT, windowsHide: true });
            assert(missingFile.status === 1, 'transcrever arquivo inexistente sai com código 1', missingFile.status);

            const badMaxMbZero = spawnSync(process.execPath, [SCRIPT_PATH, 'baixar', 'https://video.example/v', '--max-mb', '0'], { encoding: 'utf-8', cwd: ROOT, windowsHide: true });
            assert(badMaxMbZero.status === 1, 'baixar --max-mb 0 sai com código 1', badMaxMbZero.status);

            const badMaxMbAlpha = spawnSync(process.execPath, [SCRIPT_PATH, 'baixar', 'https://video.example/v', '--max-mb', 'abc'], { encoding: 'utf-8', cwd: ROOT, windowsHide: true });
            assert(badMaxMbAlpha.status === 1, 'baixar --max-mb abc sai com código 1', badMaxMbAlpha.status);
        }

        const mod = await importarModulo();
        {
            const parsedTg = mod.parseArgs(['baixar', 'https://video.example/v', '--telegram', '--max-mb', '18']);
            assert(parsedTg.whatsapp === true && parsedTg.maxMb === 18, 'parseArgs aceita --telegram e --max-mb', parsedTg);
        }

        console.log('\n=== S498-4 — baixarVideo: -- antes da URL, rejeita só-áudio, recodifica --whatsapp ===');
        {
            const sondaFake = {
                ytDlp: { found: true, path: 'yt-dlp', probed: ['yt-dlp'] },
                ffmpeg: { found: true, path: 'ffmpeg', probed: ['ffmpeg'] },
                ffprobe: { found: true, path: 'ffprobe', probed: ['ffprobe'] },
            };

            // 4a) Rejeita arquivo sem stream de vídeo (regressão de video:0kB)
            const dirAudio = path.join(tmp, 'so-audio');
            let rejeitouSoAudio = false;
            try {
                await mod.baixarVideo(
                    { url: 'https://video.example/watch?v=123', saida: dirAudio, nome: 'teste' },
                    {
                        sonda: sondaFake,
                        runAsync: async (bin: string, args: string[]) => {
                            assert(bin === 'yt-dlp' && args[args.length - 2] === '--' && args[args.length - 1] === 'https://video.example/watch?v=123',
                                'yt-dlp recebe "--" imediatamente antes da URL');
                            fs.writeFileSync(path.join(dirAudio, 'teste_raw.webm'), 'audio-only');
                            return { code: 0, stdout: '', stderr: '' };
                        },
                        runSync: () => ({
                            status: 0,
                            stdout: JSON.stringify({ streams: [{ codec_type: 'audio', codec_name: 'opus' }], format: { duration: '120', size: '1000' } }),
                            stderr: '',
                        }),
                    },
                );
            } catch (e) {
                rejeitouSoAudio = /sem faixa de vídeo|não possui faixa de vídeo/i.test(String(e));
            }
            assert(rejeitouSoAudio, 'rejeita arquivo sem faixa de vídeo e apaga o arquivo inválido');
            assert(!fs.existsSync(path.join(dirAudio, 'teste_raw.webm')), 'arquivo inválido removido do disco');

            // 4b) Aceita H.264 + AAC válido sem recodificar
            const dirOk = path.join(tmp, 'h264-ok');
            const rOk = await mod.baixarVideo(
                { url: 'https://vt.tiktok.example/AbCd123/', whatsapp: true, saida: dirOk, nome: 'clip' },
                {
                    sonda: sondaFake,
                    runAsync: async (bin: string) => {
                        if (bin === 'ffmpeg') throw new Error('não deveria recodificar H.264+AAC <=720p');
                        fs.writeFileSync(path.join(dirOk, 'clip_raw.mp4'), 'mp4-bytes');
                        return { code: 0, stdout: '', stderr: '' };
                    },
                    runSync: () => ({
                        status: 0,
                        stdout: JSON.stringify({
                            streams: [
                                { codec_type: 'video', codec_name: 'h264', width: 720, height: 1280 },
                                { codec_type: 'audio', codec_name: 'aac' },
                            ],
                            format: { duration: '60', size: '4500000' },
                        }),
                        stderr: '',
                    }),
                },
            );
            assert(rOk.validadoVideo === true && fs.existsSync(String(rOk.arquivo)) && String(rOk.arquivo).endsWith('clip.mp4'),
                'H.264+AAC válido vai direto para clip.mp4 validado', rOk);

            // 4c) --whatsapp com vp9 aciona ffmpeg com libx264/yuv420p/+faststart e limpa _raw
            const dirVp9 = path.join(tmp, 'vp9-recod');
            let ffArgsUsados: string[] = [];
            let probeCount = 0;
            const rVp9 = await mod.baixarVideo(
                { url: 'https://www.youtube.example/watch?v=xyz', whatsapp: true, saida: dirVp9, nome: 'aula' },
                {
                    sonda: sondaFake,
                    runAsync: async (bin: string, args: string[]) => {
                        if (bin === 'yt-dlp') {
                            fs.writeFileSync(path.join(dirVp9, 'aula_raw.webm'), 'vp9-bytes');
                        } else if (bin === 'ffmpeg') {
                            ffArgsUsados = args;
                            fs.writeFileSync(String(args[args.length - 1]), 'h264-bytes');
                        }
                        return { code: 0, stdout: '', stderr: '' };
                    },
                    runSync: () => {
                        probeCount++;
                        return {
                            status: 0,
                            stdout: JSON.stringify({
                                streams: [
                                    { codec_type: 'video', codec_name: probeCount === 1 ? 'vp9' : 'h264', width: 1920, height: 1080 },
                                    { codec_type: 'audio', codec_name: probeCount === 1 ? 'opus' : 'aac' },
                                ],
                                format: { duration: '120', size: '5000000' },
                            }),
                            stderr: '',
                        };
                    },
                },
            );
            assert(ffArgsUsados.includes('libx264') && ffArgsUsados.includes('yuv420p') && ffArgsUsados.includes('+faststart'),
                'vp9 com --whatsapp aciona ffmpeg com libx264, yuv420p e +faststart', ffArgsUsados);
            assert(rVp9.codecVideo === 'h264' && !fs.existsSync(path.join(dirVp9, 'aula_raw.webm')),
                'revalida saída como h264 e remove _raw intermediário', rVp9);

            // 4d) Vídeo de 52 MB em 1800s com --whatsapp/--telegram excede teto padrão de 48 MB e limita bitrate
            const dirLimiteTg = path.join(tmp, 'limite-tg-48mb');
            let ffArgsLimiteTg: string[] = [];
            let size52Count = 0;
            const rTg = await mod.baixarVideo(
                { url: 'https://www.youtube.example/watch?v=longo', whatsapp: true, saida: dirLimiteTg, nome: 'longo' },
                {
                    sonda: sondaFake,
                    runAsync: async (bin: string, args: string[]) => {
                        if (bin === 'yt-dlp') {
                            fs.writeFileSync(path.join(dirLimiteTg, 'longo_raw.mp4'), 'h264-52mb');
                        } else if (bin === 'ffmpeg') {
                            ffArgsLimiteTg = args;
                            fs.writeFileSync(String(args[args.length - 1]), 'h264-compactado');
                        }
                        return { code: 0, stdout: '', stderr: '' };
                    },
                    runSync: () => {
                        size52Count++;
                        return {
                            status: 0,
                            stdout: JSON.stringify({
                                streams: [
                                    { codec_type: 'video', codec_name: 'h264', width: 1280, height: 720 },
                                    { codec_type: 'audio', codec_name: 'aac' },
                                ],
                                format: { duration: '1800', size: size52Count === 1 ? '52000000' : '42000000' },
                            }),
                            stderr: '',
                        };
                    },
                },
            );
            assert(ffArgsLimiteTg.includes('-maxrate') && ffArgsLimiteTg.includes('-bufsize'),
                '52 MB em 1800s excede 48 MB e aciona ffmpeg com -maxrate e -bufsize', ffArgsLimiteTg);
            assert(rTg.limiteBytes === 48_000_000 && rTg.dentroDoLimite === true,
                'baixarVideo retorna limiteBytes=48000000 e dentroDoLimite=true após compactar', rTg);

            // 4e) --max-mb 18 em vídeo de 25 MB H.264+AAC também aciona recodificação
            const dirMaxMb = path.join(tmp, 'limite-18mb');
            let ffArgsMaxMb: string[] = [];
            let maxMbCount = 0;
            const rMaxMb = await mod.baixarVideo(
                { url: 'https://www.youtube.example/watch?v=web18', maxMb: 18, saida: dirMaxMb, nome: 'webclip' },
                {
                    sonda: sondaFake,
                    runAsync: async (bin: string, args: string[]) => {
                        if (bin === 'yt-dlp') {
                            fs.writeFileSync(path.join(dirMaxMb, 'webclip_raw.mp4'), 'h264-25mb');
                        } else if (bin === 'ffmpeg') {
                            ffArgsMaxMb = args;
                            fs.writeFileSync(String(args[args.length - 1]), 'h264-15mb');
                        }
                        return { code: 0, stdout: '', stderr: '' };
                    },
                    runSync: () => {
                        maxMbCount++;
                        return {
                            status: 0,
                            stdout: JSON.stringify({
                                streams: [
                                    { codec_type: 'video', codec_name: 'h264', width: 1280, height: 720 },
                                    { codec_type: 'audio', codec_name: 'aac' },
                                ],
                                format: { duration: '120', size: maxMbCount === 1 ? '25000000' : '15000000' },
                            }),
                            stderr: '',
                        };
                    },
                },
            );
            assert(ffArgsMaxMb.length > 0 && ffArgsMaxMb.includes('libx264') && ffArgsMaxMb.includes('-maxrate'),
                'maxMb=18 em H.264 de 25 MB aciona recodificação com -maxrate', ffArgsMaxMb);
            assert(rMaxMb.limiteBytes === 18_000_000 && rMaxMb.dentroDoLimite === true,
                'baixarVideo respeita limiteBytes=18000000 e marca dentroDoLimite=true', rMaxMb);
        }

        console.log('\n=== S498-5 — transcreverMidia: Whisper API local, fallback e faster-whisper --legendas ===');
        {
            const wavInput = path.join(tmp, 'amostra.wav');
            fs.writeFileSync(wavInput, Buffer.from('RIFF0000WAVEfmt '));

            let statusPrincipal = 200;
            let chamadaPrincipal = 0;
            let chamadaFallback = 0;
            const srv1 = http.createServer((req, res) => {
                if (req.url === '/inference' && req.method === 'POST') {
                    chamadaPrincipal++;
                    req.resume();
                    req.on('end', () => {
                        res.writeHead(statusPrincipal, { 'Content-Type': 'application/json', Connection: 'close' });
                        res.end(JSON.stringify(statusPrincipal === 200 ? { text: 'Transcrição vinda da API principal.' } : { error: 'fail' }));
                    });
                    return;
                }
                res.writeHead(404, { Connection: 'close' }).end();
            });
            const srv2 = http.createServer((req, res) => {
                if (req.url === '/inference' && req.method === 'POST') {
                    chamadaFallback++;
                    req.resume();
                    req.on('end', () => {
                        res.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' });
                        res.end(JSON.stringify({ text: 'Transcrição via fallback.' }));
                    });
                    return;
                }
                res.writeHead(404, { Connection: 'close' }).end();
            });
            await new Promise<void>(r => srv1.listen(0, '127.0.0.1', r));
            await new Promise<void>(r => srv2.listen(0, '127.0.0.1', r));
            try {
                const port1 = (srv1.address() as { port: number }).port;
                const port2 = (srv2.address() as { port: number }).port;
                const url1 = `http://127.0.0.1:${port1}`;
                const url2 = `http://127.0.0.1:${port2}`;
                const sondaTransc = {
                    ytDlp: { found: false, probed: [] },
                    ffmpeg: { found: false, probed: [] },
                    fasterWhisperPython: { found: true, path: 'python3', probed: ['python3'] },
                    whisperCli: { found: false, probed: [] },
                };

                // 5a) API principal sem --legendas
                const dirApi = path.join(tmp, 'tx-api');
                const t1 = await mod.transcreverMidia(
                    { entrada: wavInput, saida: dirApi, nome: 'principal', lang: 'pt' },
                    { sonda: sondaTransc, env: { WHISPER_API_URL: url1, WHISPER_API_FALLBACK: url2 } },
                );
                assert(t1.motor === 'whisper_api' && chamadaPrincipal === 1 && chamadaFallback === 0
                    && fs.readFileSync(String(t1.txtPath), 'utf-8').includes('API principal'),
                    'usa WHISPER_API_URL e grava .txt UTF-8', t1);

                // 5b) API principal retorna 500 -> cai para WHISPER_API_FALLBACK
                statusPrincipal = 500;
                const t2 = await mod.transcreverMidia(
                    { entrada: wavInput, saida: dirApi, nome: 'fb', lang: 'pt' },
                    { sonda: sondaTransc, env: { WHISPER_API_URL: url1, WHISPER_API_FALLBACK: url2 } },
                );
                assert(t2.motor === 'whisper_api' && chamadaFallback === 1
                    && fs.readFileSync(String(t2.txtPath), 'utf-8').includes('via fallback'),
                    'quando WHISPER_API_URL falha, tenta WHISPER_API_FALLBACK', t2);

                // 5c) --legendas ignora API e usa faster-whisper gerando .txt + .srt
                const antesApi = chamadaPrincipal + chamadaFallback;
                const t3 = await mod.transcreverMidia(
                    { entrada: wavInput, legendas: true, saida: dirApi, nome: 'leg', model: 'tiny', lang: 'pt' },
                    {
                        sonda: sondaTransc,
                        env: { WHISPER_API_URL: url1, WHISPER_API_FALLBACK: url2 },
                        runAsync: async (bin: string, args: string[], opts: { stdinText?: string }) => {
                            assert(bin === 'python3' && args[0] === '-' && typeof opts.stdinText === 'string' && opts.stdinText.includes('WhisperModel'),
                                'chama python via stdin com script faster-whisper');
                            const outTxt = args[2];
                            const outSrt = args[3];
                            fs.writeFileSync(outTxt, '[00:00:01] Olá mundo\n', 'utf-8');
                            fs.writeFileSync(outSrt, '1\n00:00:01,000 --> 00:00:04,500\nOlá mundo\n\n', 'utf-8');
                            return { code: 0, stdout: JSON.stringify({ segmentos: 1, idioma: 'pt', caracteres: 20 }), stderr: '' };
                        },
                    },
                );
                assert(chamadaPrincipal + chamadaFallback === antesApi
                    && String(t3.motor).startsWith('faster-whisper')
                    && fs.readFileSync(String(t3.srtPath), 'utf-8').includes('00:00:01,000 --> 00:00:04,500'),
                    '--legendas ignora Whisper API e gera .txt + .srt via faster-whisper', t3);
            } finally {
                const fecharServidor = (srv: http.Server): Promise<void> => new Promise<void>(resolve => {
                    (srv as http.Server & { closeAllConnections?: () => void }).closeAllConnections?.();
                    srv.close(() => resolve());
                });
                await Promise.all([fecharServidor(srv1), fecharServidor(srv2)]);
            }
        }

        console.log('\n=== S498-6 — Invariantes de segurança, .env vazio e portabilidade ===');
        {
            const scriptSrc = fs.readFileSync(SCRIPT_PATH, 'utf-8');
            assert(!/shell\s*:\s*true/.test(scriptSrc), 'script não usa shell: true');
            assert(!/\bexec(Sync)?\s*\(/.test(scriptSrc), 'script não usa exec/execSync');
            const privateIp = /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})\b/;
            assert(!privateIp.test(scriptSrc), 'script não contém IP privado embutido (S195)');

            const fakeRoot = path.join(tmp, 'env-root');
            fs.mkdirSync(fakeRoot, { recursive: true });
            fs.writeFileSync(path.join(fakeRoot, '.env'), 'WHISPER_API_URL=http://127.0.0.1:8177\nWHISPER_PATH=/bin/w\n', 'utf-8');
            const envComVazio: Record<string, string | undefined> = { WHISPER_API_URL: '' };
            mod.carregarEnvSeFaltar(fakeRoot, envComVazio);
            assert(envComVazio.WHISPER_API_URL === '' && envComVazio.WHISPER_PATH === '/bin/w',
                'carregarEnvSeFaltar respeita WHISPER_API_URL="" já definido em env', envComVazio);
        }
    } finally {
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S498 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(e => { console.error(e); process.exitCode = 1; });
