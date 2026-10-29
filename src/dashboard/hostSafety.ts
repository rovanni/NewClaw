/**
 * hostSafety — autoridade única de "isto expõe o Dashboard sem autenticação?", reutilizada em dois
 * momentos: no boot (`DashboardServer.start()`) e na desativação de `dashboardAuth` em runtime
 * (`routes/auth.ts`, Campanha de Segurança — alerta CodeQL #104, achado T09).
 *
 * Extraído de `DashboardServer.ts` para que `routes/auth.ts` possa revalidar a mesma condição sem
 * um import circular (`DashboardServer` já importa de `routes/auth`) e sem duplicar o Set de
 * hostnames — Single Authoritative Knowledge para as duas checagens, que são a mesma pergunta em
 * dois instantes diferentes do ciclo de vida.
 *
 * Nota: `ProviderFactory.rodaNaMaquinaDoUsuario()` tem uma checagem de loopback equivalente,
 * porém sobre outro dado (hostname de `baseUrl` de um provider, não `DASHBOARD_HOST`) e para outro
 * propósito (detectar fallback entre providers locais). Duplicação pré-existente, fora do escopo
 * desta correção — não unificada aqui para não alterar comportamento não relacionado à campanha.
 */
export const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1']);

/**
 * Este bind expõe o Dashboard sem autenticação nenhuma? Extraída de `start()` para ser testável
 * sem precisar derrubar o processo de teste com `process.exit()` — campanha de Security, item C.
 *
 * `.env.example` já documenta esta combinação como exigindo senha "OBRIGATORIAMENTE" — isto
 * aplica o contrato já declarado, não uma política nova. Só bloqueia bind NÃO-loopback sem senha;
 * qualquer forma de loopback (com ou sem senha configurada) nunca é afetada.
 */
export function isUnsafeExposedBoot(host: string, authEnabled: boolean): boolean {
    return !LOOPBACK_HOSTNAMES.has(host) && !authEnabled;
}

// ── HTTPS opcional (29/10/2026) ───────────────────────────────────────────────────────────────
//
// O navegador só libera o microfone (e outras APIs) em página segura: HTTPS ou localhost. O painel
// aberto pela rede em http://<ip>:3090 recebia `not-allowed` no ditado. Com DASHBOARD_TLS_CERT e
// DASHBOARD_TLS_KEY, o painel atende a rede em HTTPS (DASHBOARD_HTTPS_PORT) e o HTTP fica preso a
// 127.0.0.1 — as ferramentas locais (`newclaw update`, `doctor`, troca de senha), que chamam
// http://127.0.0.1:<DASHBOARD_PORT>, continuam funcionando, e pela rede só existe HTTPS.

/** Porta HTTPS quando DASHBOARD_HTTPS_PORT não é informada. É endereço local, não escolha de recurso. */
export const DASHBOARD_HTTPS_PORT_PADRAO = 3443;

export interface Escuta { host: string; port: number }
export interface PlanoDeEscuta {
    http: Escuta;
    https?: Escuta & { certFile: string; keyFile: string };
    /** Configuração inconsistente: o boot para com esta mensagem (falha alta, como a de senha). */
    erro?: string;
}

export function planejarEscuta(
    env: { DASHBOARD_HOST?: string; DASHBOARD_HTTPS_PORT?: string; DASHBOARD_TLS_CERT?: string; DASHBOARD_TLS_KEY?: string },
    port: number,
): PlanoDeEscuta {
    const host = env.DASHBOARD_HOST || '127.0.0.1';
    const cert = env.DASHBOARD_TLS_CERT?.trim();
    const key = env.DASHBOARD_TLS_KEY?.trim();
    if (!cert && !key) return { http: { host, port } };
    if (!cert || !key) {
        return { http: { host, port }, erro: 'HTTPS precisa dos dois: DASHBOARD_TLS_CERT e DASHBOARD_TLS_KEY.' };
    }
    const bruta = env.DASHBOARD_HTTPS_PORT?.trim();
    const httpsPort = bruta ? Number(bruta) : DASHBOARD_HTTPS_PORT_PADRAO;
    if (!Number.isInteger(httpsPort) || httpsPort < 1 || httpsPort > 65535) {
        return { http: { host, port }, erro: `DASHBOARD_HTTPS_PORT inválida: '${bruta}'.` };
    }
    if (httpsPort === port) {
        return { http: { host, port }, erro: `DASHBOARD_HTTPS_PORT (${httpsPort}) precisa ser diferente de DASHBOARD_PORT.` };
    }
    return {
        http: { host: '127.0.0.1', port },
        https: { host, port: httpsPort, certFile: cert, keyFile: key },
    };
}

// ── Gate de Host por requisição (issue 026, achado nº1) ───────────────────────────────────────
//
// `isUnsafeExposedBoot()` responde "este BIND expõe o Dashboard sem senha?" no boot. A mesma
// pergunta existe também por requisição: com a autenticação desligada, o que autoriza o processo
// a atender uma requisição? Antes, nada além de o TCP ter chegado — o header `Host` era confiado
// como veio, então uma página externa com DNS rebinding (ou um proxy em 127.0.0.1) fazia o
// servidor atender como se fosse local, inclusive `POST /api/auth/config` (definir a primeira
// senha e trancar o operador para fora). Testado em instância real em 21/09/2026.
//
// Regra: enquanto a autenticação estiver DESLIGADA, só se atende `Host` loopback. Ausente ou
// ilegível → nega (fail-closed: sem evidência de que o destino é local, não é local). Com a
// autenticação ligada o gate não age — sem cookie/token o rebinding não obtém nada.

/**
 * O header `Host` (com ou sem porta) nomeia um destino loopback? Reusa `LOOPBACK_HOSTNAMES` — o
 * mesmo Set do boot, não uma segunda lista. Parse estrito: qualquer coisa fora de
 * `host[:porta]` / `[ipv6][:porta]` (userinfo, barra, espaço, porta não numérica) é rejeitada.
 */
export function isLoopbackHostHeader(hostHeader: string | undefined): boolean {
    if (!hostHeader) return false;
    const m = /^(\[[^\]\s/@]+\]|[^:\s/@\[\]]+)(?::(\d{1,5}))?$/.exec(hostHeader.trim());
    if (!m) return false;
    const name = m[1].replace(/^\[|\]$/g, '').toLowerCase();
    return LOOPBACK_HOSTNAMES.has(name);
}

interface HostGateReq { headers: { host?: string } }
interface HostGateRes {
    status(code: number): HostGateRes;
    json(payload: unknown): unknown;
}

/**
 * Middleware do gate. `isAuthEnabled` é lido A CADA requisição (a autenticação pode ser ligada ou
 * desligada em runtime) e vem injetado — importar `dashboardAuth` aqui criaria o ciclo
 * `auth.ts` ↔ `hostSafety.ts` que a extração deste módulo existe para evitar.
 */
export function createHostGate(isAuthEnabled: () => boolean) {
    return (req: HostGateReq, res: HostGateRes, next: () => void): void => {
        if (isAuthEnabled() || isLoopbackHostHeader(req.headers.host)) { next(); return; }
        res.status(403).json({
            success: false,
            error:
                'Acesso bloqueado: a autenticação do Dashboard está desativada e esta requisição ' +
                'não chegou por um endereço local (127.0.0.1, localhost ou [::1]). Sem senha, o ' +
                'Dashboard só atende acesso local. Para acessar por outro endereço ou por proxy ' +
                'reverso, defina DASHBOARD_PASSWORD e reinicie.',
        });
    };
}
