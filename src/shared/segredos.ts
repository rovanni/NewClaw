/**
 * Segredos — o valor de uma senha/chave nunca chega a logs, banco, transcrições nem modelos (ADR-019).
 *
 * Um só lugar para três coisas que antes não existiam ou viviam espalhadas:
 *   1. RECONHECER: formatos de credencial e o par "rótulo + valor" (senha: …, password = …). Exceção de SEGURANÇA ao
 *      Princípio da Preservação do Raciocínio (como `isDestructive()`): um valor reconhecido aqui é guardado ANTES de o
 *      LLM ver a mensagem — mandar ao modelo para perguntar "isto é uma senha?" já seria o vazamento.
 *   2. GUARDAR: o cofre é o próprio .env (SEGREDO_<NOME>), onde as chaves de API já vivem.
 *   3. TROCAR: o texto que circula leva o marcador <SEGREDO:nome>; só a execução de ferramenta recebe o valor
 *      (resolverMarcadores), e o que a ferramenta devolve volta mascarado (mascararSegredos).
 *
 * Origem: 11/10/2026, uma senha de app digitada no chat foi parar no log de auditoria, em 7 arquivos de avaliadores, numa
 * transcrição, em 5 tabelas do banco e nos prompts enviados aos modelos de nuvem.
 */
import fs from 'fs';
import path from 'path';
import { applyEnvUpdates } from './envSerializer';

/** Nome de campo/variável que carrega credencial. */
export const NOME_SENSIVEL = /(pass(word|wd)?|senha|secret|segredo|token|api[_-]?key|apikey|auth|credential|credencial|private[_-]?key|contrase(ñ|n)a)/i;

/** Formatos inconfundíveis de credencial. */
export const FORMATOS_DE_CREDENCIAL: RegExp[] = [
    /\bsk-[A-Za-z0-9_-]{16,}/, /\bghp_[A-Za-z0-9]{20,}/, /\bgithub_pat_[A-Za-z0-9_]{20,}/, /\bAKIA[0-9A-Z]{16}\b/,
    /\bxox[abprs]-[A-Za-z0-9-]{10,}/, /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/,
];

/** Senha de app do Google (4 grupos de 4 letras). Ambíguo em prosa comum: só conta perto de uma palavra de credencial. */
export const SENHA_DE_APP = /\b(?:[a-z]{4} ){3}[a-z]{4}\b/g;

/** Palavra de credencial em pt-BR/en/es — o contexto que torna a senha de app (ou um valor rotulado) inequívoca. */
const PALAVRA_DE_CREDENCIAL = /\b(senhas?|password|passwd|pwd|contrase(ñ|n)as?|claves?|chaves?|tokens?|api[ _-]?keys?|secret|segredo)\b/i;

/**
 * "senha: X", "password = X", "a senha é X", "a senha do servidor de teste é X", "my password is X", "la contraseña es X".
 * Até 6 palavras entre o rótulo e o verbo/sinal. O verbo é procurado depois de ESPAÇO, não de `\b`: sem o modo unicode,
 * `\b` não vê fronteira antes de "é" — achado na validação real de 14/10/2026 (a frase acima passou em claro).
 */
const VALOR_ROTULADO = /\b(?:senhas?|password|passwd|pwd|contrase(?:ñ|n)as?|claves?|chaves?|token|api[ _-]?key|secret)\b(?:\s+[^\s:=]+){0,6}?(?:\s*[:=]|\s+(?:é|e|is|es|será|são|son))\s*["'`]?([^\s"'`]{6,})/gi;

/** Variável com nome sensível cujo VALOR não é segredo (ex.: WHATSAPP_AUTH_DIR é uma pasta) — não é mascarada. */
const NAO_E_VALOR_SECRETO = /_(DIR|PATH|FILE|URL|MODE|ENABLED|TIMEOUT|PORT)$/i;

const PREFIXO = 'SEGREDO_';
const MARCADOR = /<SEGREDO:([A-Za-z0-9_]+)>/g;

/** Um valor rotulado só conta se tiver cara de senha — "a senha é complicada" não guarda "complicada". */
function temCaraDeSenha(v: string): boolean {
    if (v.length < 8) return false;
    const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(v)).length;
    return classes >= 2;
}

export interface SegredoConhecido { nome: string; valor: string }

/**
 * Os valores que nunca podem aparecer: os do cofre (SEGREDO_*) e os das variáveis de ambiente sensíveis (chaves de API,
 * tokens de bot). Mais longos primeiro — um valor que contém outro é trocado inteiro.
 */
let cache: { em: number; lista: SegredoConhecido[] } | null = null;
const CACHE_MS = 5000;

/** Invalida o cache (o cofre mudou). */
function invalidar(): void { cache = null; }

export function segredosConhecidos(env: NodeJS.ProcessEnv = process.env): SegredoConhecido[] {
    // O logger chama isto a cada linha: com o ambiente do processo, reaproveita a lista por alguns segundos.
    if (env === process.env) {
        if (cache && Date.now() - cache.em < CACHE_MS) return cache.lista;
        cache = { em: Date.now(), lista: calcular(env) };
        return cache.lista;
    }
    return calcular(env);
}

function calcular(env: NodeJS.ProcessEnv): SegredoConhecido[] {
    const r: SegredoConhecido[] = [];
    for (const [k, v] of Object.entries(env)) {
        if (typeof v !== 'string' || v.trim().length < 6) continue;
        if (k.startsWith(PREFIXO)) r.push({ nome: k.slice(PREFIXO.length).toLowerCase(), valor: v.trim() });
        // Mesmo mínimo do cofre (6, acima). Antes era 8 para as variáveis de nome sensível: produção (Linux), 17/10/2026, a
        // senha do painel tinha 7 caracteres, o agente a leu no .env e ela foi em claro ao modelo, ao log e ao Telegram.
        // Medido em 21/10 nas duas instalações: nenhuma variável do ambiente com nome sensível tem valor de 6–7 caracteres
        // que não seja segredo.
        else if (NOME_SENSIVEL.test(k) && !NAO_E_VALOR_SECRETO.test(k)) r.push({ nome: k, valor: v.trim() });
    }
    return r.sort((a, b) => b.valor.length - a.valor.length);
}

/** Troca cada valor conhecido por <SEGREDO:nome>. */
export function mascararSegredos(texto: string, conhecidos: SegredoConhecido[] = segredosConhecidos()): string {
    if (!texto || conhecidos.length === 0) return texto;
    let r = texto;
    for (const s of conhecidos) if (r.includes(s.valor)) r = r.split(s.valor).join(`<SEGREDO:${s.nome}>`);
    return r;
}

/** Mascara em profundidade (objetos/arrays de saída de ferramenta, metadados de log). */
export function mascararProfundo<T>(x: T, conhecidos: SegredoConhecido[] = segredosConhecidos()): T {
    if (conhecidos.length === 0) return x;
    if (typeof x === 'string') return mascararSegredos(x, conhecidos) as unknown as T;
    if (Array.isArray(x)) return x.map((y) => mascararProfundo(y, conhecidos)) as unknown as T;
    if (x && typeof x === 'object' && Object.getPrototypeOf(x) === Object.prototype) {
        const o: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(x as Record<string, unknown>)) o[k] = mascararProfundo(v, conhecidos);
        return o as T;
    }
    return x;
}

/**
 * Troca <SEGREDO:nome> pelo valor guardado — SÓ para os argumentos de uma ferramenta, no instante da execução. Apenas o
 * cofre (SEGREDO_*): chaves de API do próprio NewClaw nunca são entregues a uma ferramenta por marcador. Nome desconhecido
 * fica como está (a ferramenta falha visivelmente em vez de receber um valor adivinhado).
 */
export function resolverMarcadores<T>(x: T, env: NodeJS.ProcessEnv = process.env): T {
    if (typeof x === 'string') {
        return x.replace(MARCADOR, (m, nome: string) => env[PREFIXO + nome.toUpperCase()] ?? m) as unknown as T;
    }
    if (Array.isArray(x)) return x.map((y) => resolverMarcadores(y, env)) as unknown as T;
    if (x && typeof x === 'object' && Object.getPrototypeOf(x) === Object.prototype) {
        const o: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(x as Record<string, unknown>)) o[k] = resolverMarcadores(v, env);
        return o as T;
    }
    return x;
}

/**
 * O valor sem a pontuação que fecha a frase ("senha: abc123!." → "abc123"). Laço do fim para o começo, linear no tamanho.
 * Era `replace(/[.,;:!?)\]]+$/, '')`, que é quadrático quando a pontuação NÃO está no fim (o motor tenta cada posição da
 * sequência e falha no `$`) — alerta CodeQL js/polynomial-redos #112; medido em 21/10/2026: 40 mil "!" seguidos de uma letra
 * levavam 1,6 s, travando o processo, e isto roda em TODA mensagem recebida (MessageBus, antes de qualquer outra coisa).
 */
const PONTUACAO_DE_FIM = new Set(['.', ',', ';', ':', '!', '?', ')', ']']);
function semPontuacaoNoFim(v: string): string {
    let fim = v.length;
    while (fim > 0 && PONTUACAO_DE_FIM.has(v[fim - 1])) fim--;
    return v.slice(0, fim);
}

/** Valores com cara de credencial num texto de entrada (sem decidir nada além disso). */
export function detectarSegredos(texto: string): string[] {
    const achados = new Set<string>();
    for (const f of FORMATOS_DE_CREDENCIAL) {
        const g = new RegExp(f.source, f.flags.includes('g') ? f.flags : f.flags + 'g');
        for (const m of texto.match(g) ?? []) achados.add(m);
    }
    if (PALAVRA_DE_CREDENCIAL.test(texto)) {
        for (const m of texto.match(SENHA_DE_APP) ?? []) achados.add(m);
        for (const m of texto.matchAll(VALOR_ROTULADO)) {
            const v = semPontuacaoNoFim(m[1]);
            if (temCaraDeSenha(v)) achados.add(v);
        }
    }
    return [...achados].sort((a, b) => b.length - a.length);
}

/** Nome válido de segredo: letras, dígitos e _ (vira SEGREDO_<NOME> no .env). */
export function nomeValido(nome: string): boolean {
    return /^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(nome);
}

function caminhoDoEnv(): string {
    return path.join(process.cwd(), '.env');
}

/** Grava no cofre (.env + process.env). Devolve o nome usado. */
export function guardarSegredo(nome: string, valor: string, envPath: string = caminhoDoEnv()): string {
    if (!nomeValido(nome)) throw new Error(`nome de segredo inválido: "${nome}" (use letras, dígitos e _)`);
    const chave = PREFIXO + nome.toUpperCase();
    const atual = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8') : '';
    const { content, rejected } = applyEnvUpdates(atual, { [chave]: valor });
    if (rejected.length > 0) throw new Error('o valor não pode ser gravado no .env com segurança (formato incompatível)');
    fs.writeFileSync(envPath, content);
    process.env[chave] = valor;
    invalidar();
    return nome.toLowerCase();
}

/** Apaga do cofre. Devolve se existia. */
export function apagarSegredo(nome: string, envPath: string = caminhoDoEnv()): boolean {
    if (!nomeValido(nome)) return false;
    const chave = PREFIXO + nome.toUpperCase();
    const existia = process.env[chave] !== undefined;
    if (fs.existsSync(envPath)) {
        const linhas = fs.readFileSync(envPath, 'utf-8').split(/\r?\n/).filter((l) => !l.startsWith(chave + '='));
        fs.writeFileSync(envPath, linhas.join('\n'));
    }
    delete process.env[chave];
    invalidar();
    return existia;
}

/** Nomes guardados no cofre (nunca os valores). */
export function nomesNoCofre(env: NodeJS.ProcessEnv = process.env): string[] {
    return Object.keys(env).filter((k) => k.startsWith(PREFIXO) && env[k]).map((k) => k.slice(PREFIXO.length).toLowerCase()).sort();
}

function proximoNome(env: NodeJS.ProcessEnv = process.env): string {
    let n = 1;
    while (env[`${PREFIXO}SENHA_${n}`] !== undefined) n++;
    return `senha_${n}`;
}

export interface EntradaProtegida { texto: string; guardados: string[] }

/**
 * A mensagem do usuário, antes de qualquer log ou processamento:
 *  - `/segredo <nome> <valor>` guarda com o nome dado e o texto passa a levar só o marcador;
 *  - um valor reconhecido (detectarSegredos) já guardado reaparece com o nome que tem; um novo vai para o cofre como
 *    senha_N. Em ambos os casos o texto segue com <SEGREDO:nome> no lugar do valor.
 */
export function protegerEntrada(texto: string, envPath: string = caminhoDoEnv()): EntradaProtegida {
    if (!texto) return { texto, guardados: [] };
    const guardados: string[] = [];
    const cmd = texto.match(/^\/segredo\s+([A-Za-z][A-Za-z0-9_]{0,40})\s+(\S[\s\S]*)$/);
    if (cmd) {
        const nome = guardarSegredo(cmd[1], cmd[2].trim(), envPath);
        return { texto: `/segredo ${nome} <SEGREDO:${nome}>`, guardados: [nome] };
    }
    let r = mascararSegredos(texto);
    for (const valor of detectarSegredos(r)) {
        if (/<SEGREDO:/.test(valor)) continue;
        const nome = guardarSegredo(proximoNome(), valor, envPath);
        r = r.split(valor).join(`<SEGREDO:${nome}>`);
        guardados.push(nome);
    }
    return { texto: r, guardados };
}

/** Aviso ao usuário quando algo foi guardado — nas 3 línguas (o Core não tem sistema de tradução; ver AVISO_SEM_VEREDITO). */
const AVISO: Record<string, (nomes: string) => string> = {
    'pt-BR': (n) => `🔐 Guardei ${n} no cofre do NewClaw. O valor não vai para logs, histórico nem para os modelos — eu uso só o marcador, e ele é trocado pelo valor na hora de executar.\nSe não era uma senha: /segredo_apagar <nome> e reenvie a mensagem. Ver os guardados: /segredos`,
    'en-US': (n) => `🔐 I stored ${n} in NewClaw's vault. The value never goes to logs, history or the models — I only use the marker, which is swapped for the value at execution time.\nIf it was not a password: /segredo_apagar <name> and resend the message. List stored ones: /segredos`,
    'es-ES': (n) => `🔐 Guardé ${n} en la bóveda de NewClaw. El valor no va a los registros, al historial ni a los modelos — solo uso el marcador, que se cambia por el valor al ejecutar.\nSi no era una contraseña: /segredo_apagar <nombre> y reenvía el mensaje. Ver los guardados: /segredos`,
};

const AVISO_FALHA: Record<string, (motivo: string) => string> = {
    'pt-BR': (m) => `🔐 Encontrei algo com cara de senha e tirei da mensagem, mas não consegui guardar no cofre (${m}). Tente /segredo <nome> <valor>.`,
    'en-US': (m) => `🔐 I found something that looks like a password and removed it from the message, but could not store it in the vault (${m}). Try /segredo <name> <value>.`,
    'es-ES': (m) => `🔐 Encontré algo que parece una contraseña y lo quité del mensaje, pero no pude guardarlo en la bóveda (${m}). Prueba /segredo <nombre> <valor>.`,
};

export function avisoDeFalhaNoCofre(motivo: string, idioma: string = process.env.APP_LANG || 'pt-BR'): string {
    return (AVISO_FALHA[idioma] ?? AVISO_FALHA['pt-BR'])(motivo);
}

export function avisoDeSegredoGuardado(nomes: string[], idioma: string = process.env.APP_LANG || 'pt-BR'): string {
    const lista = nomes.map((n) => `<SEGREDO:${n}>`).join(', ');
    return (AVISO[idioma] ?? AVISO['pt-BR'])(lista);
}
