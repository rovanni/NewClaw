/**
 * CapabilityTypes — Shim de compatibilidade.
 * Tipos movidos para CapabilityRegistry.ts (Fase 2.5).
 * @deprecated Importe diretamente de './CapabilityRegistry'
 */
export type {
    CapabilitySource,
    CapabilityStatus,
    WorkspaceCapabilities,
    ToolCapabilities,
    NetworkCapabilities,
    ExecutionCapabilities,
    OSCapabilities,
    HardwareCapabilities,
    RuntimeCapabilities,
    EnvironmentCapabilities,
} from './CapabilityRegistry';
