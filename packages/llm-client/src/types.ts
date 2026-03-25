// Roles
export type Role = "system" | "user" | "assistant" | "tool" | "developer";

// Content kinds
export type ContentKind =
	| "text"
	| "image"
	| "audio"
	| "document"
	| "tool_call"
	| "tool_result"
	| "thinking"
	| "redacted_thinking";

// Media data types
export interface ImageData {
	url?: string;
	data?: Uint8Array;
	media_type?: string;
	detail?: "auto" | "low" | "high";
}

export interface AudioData {
	url?: string;
	data?: Uint8Array;
	media_type?: string;
}

export interface DocumentData {
	url?: string;
	data?: Uint8Array;
	media_type?: string;
	file_name?: string;
}

export interface ThinkingData {
	text: string;
	signature?: string;
	redacted: boolean;
}

export interface ToolCallData {
	id: string;
	name: string;
	arguments: Record<string, unknown> | string;
}

export interface ToolResultData {
	tool_call_id: string;
	content: string | Record<string, unknown> | unknown[];
	is_error: boolean;
}

// ContentPart — tagged union on `kind`
export interface ContentPart {
	kind: ContentKind;
	text?: string;
	image?: ImageData;
	audio?: AudioData;
	document?: DocumentData;
	tool_call?: ToolCallData;
	tool_result?: ToolResultData;
	thinking?: ThinkingData;
}

// Message
export interface Message {
	role: Role;
	content: ContentPart[];
}

// Tool definitions
export interface ToolDefinition {
	name: string;
	description: string;
	parameters: Record<string, unknown>; // JSON Schema object
}

export interface ToolCall {
	id: string;
	name: string;
	arguments: Record<string, unknown>;
	raw_arguments?: string;
}

export interface ToolResult {
	tool_call_id: string;
	content: string | Record<string, unknown> | unknown[];
	is_error: boolean;
}

export type ToolChoiceMode = "auto" | "none" | "required" | "named";

export interface ToolChoice {
	mode: ToolChoiceMode;
	tool_name?: string;
}

export type ToolExecuteFn = (
	args: Record<string, unknown>,
	context?: { abort_signal?: AbortSignal },
) => Promise<string | Record<string, unknown>>;

export interface Tool extends ToolDefinition {
	execute?: ToolExecuteFn;
}

// Response format
export interface ResponseFormat {
	type: "text" | "json_object" | "json_schema";
	json_schema?: Record<string, unknown>;
	name?: string;
	strict?: boolean;
}

// Request
export interface Request {
	model: string;
	messages: Message[];
	provider?: string;
	tools?: ToolDefinition[];
	tool_choice?: ToolChoice;
	response_format?: ResponseFormat;
	temperature?: number;
	top_p?: number;
	max_tokens?: number;
	stop_sequences?: string[];
	reasoning_effort?: "low" | "medium" | "high";
	metadata?: Record<string, string>;
	provider_options?: Record<string, unknown>;
}

// Usage
export interface Usage {
	input_tokens: number;
	output_tokens: number;
	total_tokens: number;
	reasoning_tokens?: number;
	cache_read_tokens?: number;
	cache_write_tokens?: number;
}

// Finish reason — object preserving raw provider value
export type FinishReasonValue =
	| "stop"
	| "length"
	| "tool_calls"
	| "content_filter"
	| "error"
	| "other";

export interface FinishReason {
	reason: FinishReasonValue;
	raw?: string;
}

// Warning
export interface Warning {
	message: string;
	code?: string;
}

// Rate limit info
export interface RateLimitInfo {
	requests_remaining?: number;
	requests_limit?: number;
	tokens_remaining?: number;
	tokens_limit?: number;
	reset_at?: Date;
}

// Response
export interface Response {
	id: string;
	model: string;
	provider: string;
	message: Message;
	finish_reason: FinishReason;
	usage: Usage;
	raw?: Record<string, unknown>;
	warnings: Warning[];
	rate_limit?: RateLimitInfo;
}

// Convenience functions for Response
export function responseText(response: Response): string {
	return response.message.content
		.filter((p) => p.kind === "text")
		.map((p) => p.text ?? "")
		.join("");
}

export function responseToolCalls(response: Response): ToolCall[] {
	return response.message.content
		.filter(
			(p): p is ContentPart & { tool_call: ToolCallData } =>
				p.kind === "tool_call" && p.tool_call != null,
		)
		.map((p) => ({
			id: p.tool_call.id,
			name: p.tool_call.name,
			arguments:
				typeof p.tool_call.arguments === "string"
					? (JSON.parse(p.tool_call.arguments) as Record<string, unknown>)
					: (p.tool_call.arguments as Record<string, unknown>),
		}));
}

export function responseReasoning(response: Response): string | undefined {
	const parts = response.message.content.filter((p) => p.kind === "thinking" && p.thinking);
	if (parts.length === 0) return undefined;
	return parts.map((p) => p.thinking?.text).join("");
}

// Stream event types
export type StreamEventType =
	| "STREAM_START"
	| "TEXT_START"
	| "TEXT_DELTA"
	| "TEXT_END"
	| "REASONING_START"
	| "REASONING_DELTA"
	| "REASONING_END"
	| "TOOL_CALL_START"
	| "TOOL_CALL_DELTA"
	| "TOOL_CALL_END"
	| "FINISH"
	| "ERROR"
	| "PROVIDER_EVENT";

export interface StreamEvent {
	type: StreamEventType;
	delta?: string;
	text_id?: string;
	reasoning_delta?: string;
	tool_call?: Partial<ToolCall>;
	tool_call_id?: string;
	finish_reason?: FinishReason;
	usage?: Usage;
	response?: Response;
	error?: Error;
	raw?: Record<string, unknown>;
}

// Retry policy
export interface RetryPolicy {
	max_retries: number;
	base_delay: number;
	max_delay: number;
	backoff_multiplier: number;
	jitter: boolean;
	on_retry?: (error: Error, attempt: number, delay: number) => void;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
	max_retries: 2,
	base_delay: 1.0,
	max_delay: 60.0,
	backoff_multiplier: 2.0,
	jitter: true,
};

// Step result (one round of the tool loop)
export interface StepResult {
	text: string;
	reasoning?: string;
	tool_calls: ToolCall[];
	tool_results: ToolResult[];
	finish_reason: FinishReason;
	usage: Usage;
	response: Response;
	warnings: Warning[];
}

// Generate result (full tool loop)
export interface GenerateResult {
	text: string;
	reasoning?: string;
	tool_calls: ToolCall[];
	tool_results: ToolResult[];
	finish_reason: FinishReason;
	usage: Usage;
	total_usage: Usage;
	steps: StepResult[];
	response: Response;
	output?: unknown;
}

// Stream result
export interface StreamResult {
	[Symbol.asyncIterator](): AsyncIterableIterator<StreamEvent>;
	response(): Promise<Response>;
	text_stream: AsyncIterableIterator<string>;
}

// Helper to create empty usage
export function emptyUsage(): Usage {
	return {
		input_tokens: 0,
		output_tokens: 0,
		total_tokens: 0,
	};
}

// Helper to merge usage
export function mergeUsage(a: Usage, b: Usage): Usage {
	return {
		input_tokens: a.input_tokens + b.input_tokens,
		output_tokens: a.output_tokens + b.output_tokens,
		total_tokens: a.total_tokens + b.total_tokens,
		reasoning_tokens: (a.reasoning_tokens ?? 0) + (b.reasoning_tokens ?? 0) || undefined,
		cache_read_tokens: (a.cache_read_tokens ?? 0) + (b.cache_read_tokens ?? 0) || undefined,
		cache_write_tokens: (a.cache_write_tokens ?? 0) + (b.cache_write_tokens ?? 0) || undefined,
	};
}
