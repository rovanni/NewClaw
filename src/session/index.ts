/**
 * session/index.ts — Barrel export for session module (v2)
 */

export { SessionTranscript, TranscriptEntry, TranscriptMeta, SessionEventType, SessionIndex } from './SessionTranscript';
export { SessionManager, estimateTokens } from './SessionManager';
export type { SessionKey, SessionConfig, CompressionCheckpoint } from './SessionManager';
export { SessionContext } from './SessionContext';
export type { SessionContextResult } from './SessionContext';