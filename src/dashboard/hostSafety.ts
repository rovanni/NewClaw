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
