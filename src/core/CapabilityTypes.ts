/**
 * CapabilityTypes — Tipos centrais do sistema de Capability Discovery.
 *
 * Define a estrutura de dados para representar capacidades detectadas
 * automaticamente no ambiente de execução do NewClaw.
 */

export type CapabilitySource = 'probe' | 'inference' | 'cached' | 'manual';

/**
 * Status semântico de uma capability individual.
 * Inclui confiança, origem e timestamp para que o sistema possa
 * decidir se um valor cacheado ainda é confiável.
 */
export interface CapabilityStatus {
    available: boolean;
    /** Confiança da detecção: 0.0 – 1.0 */
    confidence: number;
    source: CapabilitySource;
    /** Date.now() no momento da detecção */
    checkedAt: number;
    /** Detalhes extras: versão, caminho do binário, mensagem de erro */
    details?: string;
}

/**
 * Capabilities do workspace local: onde o agente pode ler e escrever.
 */
export interface WorkspaceCapabilities {
    /** Caminho absoluto da raiz do workspace */
    root: string;
    canRead: boolean;
    canWrite: boolean;
    /** Número total de itens (arquivos + diretórios) na raiz */
    entryCount: number;
    /** Subdirectórios diretos da raiz (máx. 20) */
    knownSubdirs: string[];
    /** Caminhos que as ferramentas bloqueiam para escrita (sandbox) */
    restrictedPaths: string[];
    checkedAt: number;
}

/**
 * Capabilities de ferramentas do sistema (binários detectados via which).
 * A chave é o nome do executável (ex: 'pandoc', 'ffmpeg', 'python3-pptx').
 */
export type ToolCapabilities = Record<string, CapabilityStatus>;

/**
 * Capabilities de rede: acesso externo e ao localhost.
 */
export interface NetworkCapabilities {
    outboundHttp: CapabilityStatus;
    localhostHttp: CapabilityStatus;
    checkedAt: number;
}

/**
 * Capabilities de execução: gerenciadores de pacotes e privilégios.
 */
export interface ExecutionCapabilities {
    pip: CapabilityStatus;
    npm: CapabilityStatus;
    sudo: CapabilityStatus;
    checkedAt: number;
}

/**
 * Snapshot completo das capabilities do ambiente.
 */
export interface EnvironmentCapabilities {
    workspace: WorkspaceCapabilities;
    tools: ToolCapabilities;
    network: NetworkCapabilities;
    execution: ExecutionCapabilities;
    lastFullProbe: number;
}
