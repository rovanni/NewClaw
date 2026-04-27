/**
 * session/index.ts — Barrel export for session module (v2)
 */

export { SessionTranscript, TranscriptEntry, TranscriptMeta, SessionEventType, SessionIndex } from './SessionTranscript';
export { SessionManager, estimateTokens } from './SessionManager';
export type { SessionKey, SessionConfig, CompressionCheckpoint } from './SessionManager';
export { SessionContext } from './SessionContext';
export type { SessionContextResult } from './SessionContext';
export { SessionLearner } from './SessionLearner';
export type { ExtractedFact, SessionLearningResult } from './SessionLearner';
export { EventRanker } from './EventRanker';
export type { RankedEvent } from './EventRanker';