/**
 * ssrfGuard — autoridade única de proteção SSRF (CWE-918) para providers de LLM cujo `baseUrl`
 * vem de configuração do operador (`OpenAIProvider` — endpoints OpenAI-Compatible custom — e
 * `OllamaProvider`).
 *
 * Extraído de `OpenAIProvider.ts` (Campanha de Segurança, alerta CodeQL #104) para ser reutilizado
 * por `OllamaProvider` sem criar uma segunda cópia do blocklist nem fazer um provider importar do
 * outro — os dois são implementações irmãs de `ILLMProvider`, nenhum é uma extensão do outro.
 *
 * Hosts sem nenhum uso legítimo como servidor de modelo — só existem para expor metadado de
 * instância de nuvem (credenciais temporárias da AWS/GCP/Azure). `baseUrl` é 100% controlado por
 * quem configura um provider (dashboard: `/api/providers/test`, `/api/config` ollamaUrl), e o
 * recurso em si EXIGE aceitar host arbitrário: é assim que um servidor local (llamafile, LM
 * Studio, vLLM, Ollama) ou de outra máquina na rede do usuário é configurado. Por isso a defesa
 * aqui não é allowlist de host, nem bloqueio de rede privada/loopback (quebraria o uso legítimo de
 * providers locais/self-hosted, decisão explícita da Campanha de Segurança) — é este bloqueio
 * pontual, o único caso em que "endpoint arbitrário" nunca é uma configuração legítima
 * (CWE-918 / CodeQL js/request-forgery).
 *
 * Checagem por string do hostname, não por resolução de DNS: cobre o caso real (alguém cola o
 * endereço de metadado direto no campo, o mesmo padrão dos exploits SSRF→metadado documentados) —
 * não cobre DNS rebinding (um hostname próprio que resolve para 169.254.169.254 só depois desta
 * checagem). Aceito conscientemente: mitigar rebinding exigiria resolver e fixar o IP antes de
 * cada fetch, mudança maior e fora do escopo desta correção pontual.
 */
export const SSRF_BLOCKED_HOSTS = new Set([
    '169.254.169.254',          // AWS/GCP/Azure/OpenStack — endpoint de metadado padrão
    'metadata.google.internal', // GCP — alias DNS do mesmo endpoint
    'fd00:ec2::254',             // AWS — endpoint de metadado IMDSv2 em IPv6
]);

/** CWE-918 — ver `SSRF_BLOCKED_HOSTS`. Lança se `baseUrl` aponta para um host de metadado de
 *  nuvem; chamado no início de todo método que faz `fetch(baseUrl + ...)` em `OpenAIProvider` e
 *  `OllamaProvider`. */
export function assertNotSsrfTarget(baseUrl: string): void {
    let hostname: string;
    try {
        hostname = new URL(baseUrl).hostname.toLowerCase().replace(/^\[|\]$/g, '');
    } catch {
        return; // URL inválida — quem chama já trata o fetch subsequente falhando
    }
    if (SSRF_BLOCKED_HOSTS.has(hostname)) {
        throw new Error(`Endpoint bloqueado: "${hostname}" é um endereço de metadado de nuvem, nunca um servidor de modelo legítimo.`);
    }
}
