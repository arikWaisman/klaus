import { errorFromStatus } from "../errors.js";
import { fetchJSON, fetchSSE } from "../http.js";
import type { OpenAIResponse } from "../schemas.js";
import { OpenAIResponseSchema } from "../schemas.js";
import type {
	ContentPart,
	FinishReason,
	FinishReasonValue,
	Message,
	Request,
	Response,
	StreamEvent,
	ToolChoiceMode,
	Usage,
} from "../types.js";
import type { ProviderAdapter, ProviderAdapterConfig } from "./adapter.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROVIDER = "openai";
const DEFAULT_BASE_URL = "https://api.openai.com/v1";

// Models that support the `reasoning` parameter.
const REASONING_MODELS = new Set(["o1", "o1-pro", "o3", "o3-pro", "o3-mini", "o4-mini"]);

function isReasoningModel(model: string): boolean {
	for (const prefix of REASONING_MODELS) {
		if (model === prefix || model.startsWith(`${prefix}-`)) {
			return true;
		}
	}
	return false;
}

// ---------------------------------------------------------------------------
// Request translation helpers
// ---------------------------------------------------------------------------

type InputItem =
	| { type: "message"; role: "user" | "assistant"; content: string | ContentItem[] }
	| { type: "function_call"; id: string; call_id: string; name: string; arguments: string }
	| { type: "function_call_output"; call_id: string; output: string };

interface ContentItem {
	type: "input_text" | "output_text";
	text: string;
}

function translateToolChoice(
	choice: Request["tool_choice"],
): "auto" | "none" | "required" | { type: "function"; name: string } | undefined {
	if (!choice) return undefined;

	switch (choice.mode) {
		case "auto":
			return "auto";
		case "none":
			return "none";
		case "required":
			return "required";
		case "named":
			return { type: "function", name: choice.tool_name! };
	}
}

function buildInput(messages: Message[]): { instructions: string | undefined; input: InputItem[] } {
	const systemParts: string[] = [];
	const input: InputItem[] = [];

	for (const msg of messages) {
		// Extract system/developer messages into instructions.
		if (msg.role === "system" || msg.role === "developer") {
			for (const part of msg.content) {
				if (part.kind === "text" && part.text) {
					systemParts.push(part.text);
				}
			}
			continue;
		}

		// Tool result messages.
		if (msg.role === "tool") {
			for (const part of msg.content) {
				if (part.kind === "tool_result" && part.tool_result) {
					const output =
						typeof part.tool_result.content === "string"
							? part.tool_result.content
							: JSON.stringify(part.tool_result.content);
					input.push({
						type: "function_call_output",
						call_id: part.tool_result.tool_call_id,
						output,
					});
				}
			}
			continue;
		}

		// Assistant messages — may contain text and/or tool_calls.
		if (msg.role === "assistant") {
			// Emit any tool calls as individual function_call items.
			for (const part of msg.content) {
				if (part.kind === "tool_call" && part.tool_call) {
					const args =
						typeof part.tool_call.arguments === "string"
							? part.tool_call.arguments
							: JSON.stringify(part.tool_call.arguments);
					input.push({
						type: "function_call",
						id: part.tool_call.id,
						call_id: part.tool_call.id,
						name: part.tool_call.name,
						arguments: args,
					});
				}
			}

			// Collect text parts into a message item.
			const textParts = msg.content.filter((p) => p.kind === "text" && p.text);
			if (textParts.length > 0) {
				const contentItems: ContentItem[] = textParts.map((p) => ({
					type: "output_text" as const,
					text: p.text!,
				}));
				input.push({
					type: "message",
					role: "assistant",
					content: contentItems,
				});
			}
			continue;
		}

		// User messages.
		if (msg.role === "user") {
			const textParts = msg.content.filter((p) => p.kind === "text" && p.text);
			if (textParts.length === 1) {
				input.push({
					type: "message",
					role: "user",
					content: textParts[0]?.text!,
				});
			} else if (textParts.length > 1) {
				const contentItems: ContentItem[] = textParts.map((p) => ({
					type: "input_text" as const,
					text: p.text!,
				}));
				input.push({
					type: "message",
					role: "user",
					content: contentItems,
				});
			}
		}
	}

	return {
		instructions: systemParts.length > 0 ? systemParts.join("\n") : undefined,
		input,
	};
}

function translateRequest(request: Request): Record<string, unknown> {
	const { instructions, input } = buildInput(request.messages);

	const body: Record<string, unknown> = {
		model: request.model,
		input,
	};

	if (instructions !== undefined) {
		body.instructions = instructions;
	}

	// Tools
	if (request.tools && request.tools.length > 0) {
		body.tools = request.tools.map((t) => ({
			type: "function",
			name: t.name,
			description: t.description,
			parameters: t.parameters,
			strict: false,
		}));
	}

	// Tool choice
	const toolChoice = translateToolChoice(request.tool_choice);
	if (toolChoice !== undefined) {
		body.tool_choice = toolChoice;
	}

	// Temperature
	if (request.temperature !== undefined) {
		body.temperature = request.temperature;
	}

	// Top-p
	if (request.top_p !== undefined) {
		body.top_p = request.top_p;
	}

	// Max tokens → max_output_tokens
	if (request.max_tokens !== undefined) {
		body.max_output_tokens = request.max_tokens;
	}

	// Reasoning effort (only for reasoning-capable models)
	if (request.reasoning_effort && isReasoningModel(request.model)) {
		body.reasoning = { effort: request.reasoning_effort };
	}

	// Response format → text.format
	if (request.response_format) {
		if (request.response_format.type === "json_schema" && request.response_format.json_schema) {
			body.text = {
				format: {
					type: "json_schema",
					name: request.response_format.name ?? "response",
					schema: request.response_format.json_schema,
					strict: request.response_format.strict ?? true,
				},
			};
		} else if (request.response_format.type === "json_object") {
			body.text = {
				format: { type: "json_object" },
			};
		}
	}

	// Pass-through provider options
	if (request.provider_options) {
		for (const [key, value] of Object.entries(request.provider_options)) {
			if (!(key in body)) {
				body[key] = value;
			}
		}
	}

	return body;
}

// ---------------------------------------------------------------------------
// Response translation
// ---------------------------------------------------------------------------

function mapFinishReason(status: string): FinishReason {
	let reason: FinishReasonValue;
	switch (status) {
		case "completed":
			reason = "stop";
			break;
		case "incomplete":
			reason = "length";
			break;
		case "failed":
			reason = "error";
			break;
		default:
			reason = "other";
			break;
	}
	return { reason, raw: status };
}

function translateResponse(raw: OpenAIResponse, requestModel: string): Response {
	const contentParts: ContentPart[] = [];

	for (const item of raw.output) {
		if (item.type === "message") {
			for (const c of item.content) {
				if (c.type === "output_text") {
					contentParts.push({ kind: "text", text: c.text });
				}
			}
		} else if (item.type === "function_call") {
			let parsedArgs: Record<string, unknown>;
			try {
				parsedArgs = JSON.parse(item.arguments) as Record<string, unknown>;
			} catch {
				parsedArgs = {};
			}
			contentParts.push({
				kind: "tool_call",
				tool_call: {
					id: item.call_id,
					name: item.name,
					arguments: parsedArgs,
				},
			});
		}
	}

	const usage: Usage = {
		input_tokens: raw.usage?.input_tokens ?? 0,
		output_tokens: raw.usage?.output_tokens ?? 0,
		total_tokens: raw.usage?.total_tokens ?? 0,
	};

	const reasoningTokens = raw.usage?.output_tokens_details?.reasoning_tokens;
	if (reasoningTokens !== undefined && reasoningTokens > 0) {
		usage.reasoning_tokens = reasoningTokens;
	}

	const message: Message = {
		role: "assistant",
		content: contentParts,
	};

	return {
		id: raw.id,
		model: raw.model ?? requestModel,
		provider: PROVIDER,
		message,
		finish_reason: mapFinishReason(raw.status),
		usage,
		raw: raw as unknown as Record<string, unknown>,
		warnings: [],
	};
}

// ---------------------------------------------------------------------------
// Streaming helpers
// ---------------------------------------------------------------------------

interface StreamingState {
	response_id: string;
	model: string;
	// Track current function call being streamed
	current_tool_call_id: string | undefined;
	current_tool_call_name: string | undefined;
	current_tool_call_args: string;
}

function handleStreamEvent(
	eventType: string,
	data: Record<string, unknown>,
	state: StreamingState,
): StreamEvent | undefined {
	switch (eventType) {
		case "response.created": {
			const response = data as Record<string, unknown>;
			state.response_id = (response.id as string) ?? state.response_id;
			state.model = (response.model as string) ?? state.model;
			return { type: "STREAM_START", raw: data };
		}

		case "response.output_item.added": {
			const item = data.item as Record<string, unknown> | undefined;
			if (!item) return undefined;

			if (item.type === "function_call") {
				state.current_tool_call_id = (item.call_id as string) ?? (item.id as string);
				state.current_tool_call_name = item.name as string;
				state.current_tool_call_args = "";
				return {
					type: "TOOL_CALL_START",
					tool_call: {
						id: state.current_tool_call_id,
						name: state.current_tool_call_name,
					},
					raw: data,
				};
			}

			// message type — no event needed yet; content_part.added will fire
			return undefined;
		}

		case "response.content_part.added": {
			return { type: "TEXT_START", raw: data };
		}

		case "response.output_text.delta": {
			const delta = data.delta as string | undefined;
			if (delta !== undefined) {
				return { type: "TEXT_DELTA", delta, raw: data };
			}
			return undefined;
		}

		case "response.content_part.done": {
			return { type: "TEXT_END", raw: data };
		}

		case "response.function_call_arguments.delta": {
			const delta = data.delta as string | undefined;
			if (delta !== undefined) {
				state.current_tool_call_args += delta;
				return {
					type: "TOOL_CALL_DELTA",
					delta,
					tool_call_id: state.current_tool_call_id,
					raw: data,
				};
			}
			return undefined;
		}

		case "response.output_item.done": {
			const item = data.item as Record<string, unknown> | undefined;
			if (!item || item.type !== "function_call") return undefined;

			let parsedArgs: Record<string, unknown>;
			try {
				parsedArgs = JSON.parse(state.current_tool_call_args) as Record<string, unknown>;
			} catch {
				parsedArgs = {};
			}

			const event: StreamEvent = {
				type: "TOOL_CALL_END",
				tool_call: {
					id: state.current_tool_call_id,
					name: state.current_tool_call_name,
					arguments: parsedArgs,
				},
				raw: data,
			};

			// Reset tool call state
			state.current_tool_call_id = undefined;
			state.current_tool_call_name = undefined;
			state.current_tool_call_args = "";

			return event;
		}

		case "response.completed": {
			const response = data.response as Record<string, unknown> | undefined;
			let usage: Usage | undefined;
			let finish_reason: FinishReason | undefined;

			if (response) {
				const rawUsage = response.usage as Record<string, unknown> | undefined;
				if (rawUsage) {
					usage = {
						input_tokens: (rawUsage.input_tokens as number) ?? 0,
						output_tokens: (rawUsage.output_tokens as number) ?? 0,
						total_tokens: (rawUsage.total_tokens as number) ?? 0,
					};
					const details = rawUsage.output_tokens_details as Record<string, unknown> | undefined;
					if (details?.reasoning_tokens !== undefined && (details.reasoning_tokens as number) > 0) {
						usage.reasoning_tokens = details.reasoning_tokens as number;
					}
				}

				const status = response.status as string | undefined;
				if (status) {
					finish_reason = mapFinishReason(status);
				}
			}

			return {
				type: "FINISH",
				finish_reason,
				usage,
				raw: data,
			};
		}

		default:
			// Pass through unknown events as PROVIDER_EVENT
			return { type: "PROVIDER_EVENT", raw: data };
	}
}

// ---------------------------------------------------------------------------
// OpenAIAdapter
// ---------------------------------------------------------------------------

export class OpenAIAdapter implements ProviderAdapter {
	readonly name = PROVIDER;
	readonly default_model: string;

	private readonly api_key: string;
	private readonly base_url: string;
	private readonly default_headers: Record<string, string>;
	private readonly timeout: number | undefined;

	constructor(config: ProviderAdapterConfig) {
		this.api_key = config.api_key;
		this.base_url = (config.base_url ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
		this.default_headers = config.default_headers ?? {};
		this.timeout = config.timeout;
		this.default_model = config.default_model ?? "gpt-4o";
	}

	// -- Public API ----------------------------------------------------------

	async complete(request: Request): Promise<Response> {
		const url = `${this.base_url}/responses`;
		const body = translateRequest(request);

		const { data } = await fetchJSON<unknown>(url, PROVIDER, {
			method: "POST",
			headers: this.buildHeaders(),
			body,
			timeout: this.timeout,
		});

		const parsed = OpenAIResponseSchema.parse(data);
		return translateResponse(parsed, request.model);
	}

	async *stream(request: Request): AsyncIterableIterator<StreamEvent> {
		const url = `${this.base_url}/responses`;
		const body = { ...translateRequest(request), stream: true };

		const state: StreamingState = {
			response_id: "",
			model: request.model,
			current_tool_call_id: undefined,
			current_tool_call_name: undefined,
			current_tool_call_args: "",
		};

		const sseStream = fetchSSE(url, PROVIDER, {
			method: "POST",
			headers: this.buildHeaders(),
			body,
			timeout: this.timeout,
		});

		for await (const sse of sseStream) {
			// Skip empty data or [DONE] markers
			if (!sse.data || sse.data === "[DONE]") {
				continue;
			}

			let data: Record<string, unknown>;
			try {
				data = JSON.parse(sse.data) as Record<string, unknown>;
			} catch {
				continue;
			}

			// The event type comes from the SSE `event:` field, or from
			// the `type` field in the JSON data itself.
			const eventType = sse.event ?? (data.type as string | undefined);
			if (!eventType) continue;

			// Check for error events
			if (eventType === "error") {
				const errorData = data.error as Record<string, unknown> | undefined;
				const message = (errorData?.message as string) ?? "Unknown OpenAI streaming error";
				const status = (errorData?.code as number) ?? 500;
				throw errorFromStatus(PROVIDER, status, data);
			}

			const event = handleStreamEvent(eventType, data, state);
			if (event) {
				yield event;
			}
		}
	}

	supports_tool_choice?(mode: ToolChoiceMode): boolean {
		// OpenAI supports all tool_choice modes.
		return mode === "auto" || mode === "none" || mode === "required" || mode === "named";
	}

	// -- Private helpers -----------------------------------------------------

	private buildHeaders(): Record<string, string> {
		return {
			...this.default_headers,
			Authorization: `Bearer ${this.api_key}`,
		};
	}
}
