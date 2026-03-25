// @klaus/llm-client — Unified LLM Client
// Public API barrel export

// Types
export type {
	Role,
	ContentKind,
	ImageData,
	AudioData,
	DocumentData,
	ThinkingData,
	ToolCallData,
	ToolResultData,
	ContentPart,
	Message,
	ToolDefinition,
	ToolCall,
	ToolResult,
	ToolChoiceMode,
	ToolChoice,
	ToolExecuteFn,
	Tool,
	ResponseFormat,
	Request,
	Usage,
	FinishReasonValue,
	FinishReason,
	Warning,
	RateLimitInfo,
	Response,
	StreamEventType,
	StreamEvent,
	RetryPolicy,
	StepResult,
	GenerateResult,
	StreamResult,
} from "./types.js";

export {
	responseText,
	responseToolCalls,
	responseReasoning,
	emptyUsage,
	mergeUsage,
	DEFAULT_RETRY_POLICY,
} from "./types.js";

// Errors
export {
	SDKError,
	ProviderError,
	AuthenticationError,
	AccessDeniedError,
	NotFoundError,
	InvalidRequestError,
	ContextLengthError,
	ContentFilterError,
	QuotaExceededError,
	RateLimitError,
	ServerError,
	RequestTimeoutError,
	AbortError,
	NetworkError,
	StreamError,
	InvalidToolCallError,
	UnsupportedToolChoiceError,
	NoObjectGeneratedError,
	ConfigurationError,
	isRetryable,
	parseRetryAfter,
	errorFromStatus,
} from "./errors.js";

// Client
export { Client } from "./client.js";
export type { ClientConfig } from "./client.js";

// Adapter interface
export type { ProviderAdapter, ProviderAdapterConfig } from "./adapters/adapter.js";

// Concrete adapters
export { AnthropicAdapter } from "./adapters/anthropic.js";
export { OpenAIAdapter } from "./adapters/openai.js";
export { GeminiAdapter } from "./adapters/gemini.js";

// Middleware
export { loggingMiddleware, redactUrl } from "./middleware.js";
export type { Middleware } from "./middleware.js";
export { composeCompleteMiddleware, composeStreamMiddleware } from "./middleware.js";

// Retry
export { withRetry, completeWithRetry, streamWithRetry } from "./retry.js";
export type { RetryOptions } from "./retry.js";

// Accumulator
export { StreamAccumulator } from "./accumulator.js";

// High-level API
export { generate, stream, generate_object, stream_object } from "./generate.js";
export type { GenerateOptions, GenerateObjectOptions, StreamObjectResult } from "./generate.js";

// Model catalog
export { getModelInfo, listModels, getLatestModel, registerModel } from "./catalog.js";
export type { ModelInfo } from "./catalog.js";

// SSE (exposed for advanced use / testing)
export { parseSSEStream } from "./sse.js";
export type { SSEEvent } from "./sse.js";

// HTTP utilities (exposed for advanced use / custom adapters)
export { fetchJSON, fetchSSE, extractRateLimitInfo } from "./http.js";
