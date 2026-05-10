/**
 * Core module exports
 */

export { AgentController } from './AgentController';
export type { NewClawConfig } from './AgentController';
export { AgentStateManager } from './AgentStateManager';
export type { AgentState, AgentMode, AgentFocus } from './AgentStateManager';
export { eventBus } from './EventBus';
export type { EventBusEvents, Confidence, ClassifiedContent } from './EventBus';
export { CONFIDENCE_SCORES, CONFIDENCE_TTL } from './EventBus';
export { CircuitBreaker, circuitRegistry, CircuitBreakerOpenError } from './CircuitBreaker';
export type { CircuitBreakerConfig, CircuitState } from './CircuitBreaker';
export { ConfidenceClassifier } from './ConfidenceClassifier';
export type { ClassificationResult, ClassificationInput } from './ConfidenceClassifier';
export { ToolExecutorService, toolExecutor } from './ToolExecutor';
export type { ToolExecutionOptions, ToolExecutionResult, ToolExecutorLike } from './ToolExecutor';
export { PromptRegistry, promptRegistry } from './PromptRegistry';
export type { PromptCategoryConfig } from './PromptRegistry';
export { ExecutionTrace, traceManager } from './ExecutionTrace';
export type { StepType, TraceStep } from './ExecutionTrace';
export { ProviderFactory } from './ProviderFactory';

export { StateStabilityGuard } from './StateStabilityGuard';
export { ToolRegistry } from './ToolRegistry';