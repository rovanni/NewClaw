/**
 * ResponseAdapter — Shim de compatibilidade.
 * Conteúdo movido para ResponseBuilder.ts (Fase 2.2).
 * Este arquivo existe apenas para manter compatibilidade com imports existentes.
 * @deprecated Importe diretamente de './ResponseBuilder'
 */
export {
    NormalizedResponse,
    ExtractedText,
    normalizeResponse,
    extractText,
    normalizeFromRaw,
} from './ResponseBuilder';
