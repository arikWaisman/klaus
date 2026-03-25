import { ServerError, errorFromStatus } from "../errors.js";
import { extractRateLimitInfo, fetchJSON, fetchSSE } from "../http.js";
import { AnthropicResponseSchema } from "../schemas.js";
import type { AnthropicResponse } from "../schemas.js";
import type {
	ContentPart,
	FinishReason,
	FinishReasonValue,
	Message,
	RateLimitInfo,
	Request,
	Response,
	StreamEvent,
	ToolChoiceMode,
	Usage,
} from "../types.js";
import { emptyUsage } from "../types.js";
import type { ProviderAdapter, ProviderAdapterConfig } from "./adapter.js";

// ---------------------------------------------------------------------------
// Anthropic-specific types
// ---------------------------------------------------------------------------

interface AnthropicTextBlock {
	type: "text";
	text: string;
	cache_control?: { type: "ephemeral" };
}

interface AnthropicToolUseBlock {
	type: "tool_use";
	id: string;
	name: string;
	input: Record<string, unknown>;
}

interface AnthropicToolResultBlock {
	type: "tool_result";
	tool_use_id: string;
	content: string | Array<{ type: "text"; text: string }>;
}

interface AnthropicThinkingBlock {
	type: "thinking";
	thinking: string;
	signature?: string;
}

interface AnthropicRedactedThinkingBlock {
	type: "redacted_thinking";
	data: string;
}

type AnthropicContentBlock =
	| AnthropicTextBlock
	| AnthropicToolUseBlock
	| AnthropicToolResultBlock
	| AnthropicThinkingBlock
	| AnthropicRedactedThinkingBlock;

interface AnthropicSystemBlock {
	type: "text";
	text: string;
	cache_control?: { type: "ephemeral" };
}

interface AnthropicMessage {
	role: "user" | "assistant";
	content: AnthropicContentBlock[];
}

interface AnthropicToolDefinition {
	name: string;
	description: string;
	input_schema: Record<string, unknown>;
	cache_control?: { type: "ephemeral" };
}

interface AnthropicToolChoiceAuto {
	type: "auto";
}

interface AnthropicToolChoiceAny {
	type: "any";
}

interface AnthropicToolChoiceTool {
	type: "tool";
	name: string;
}

type AnthropicToolChoice =
	| AnthropicToolChoiceAuto
	| AnthropicToolChoiceAny
	| AnthropicToolChoiceTool;

interface AnthropicRequestBody {
	model: string;
	messages: AnthropicMessage[];
	max_tokens: number;
	system?: AnthropicSystemBlock[];
	tools?: AnthropicToolDefinition[];
	tool_choice?: AnthropicToolChoice;
	temperature?: number;
	top_p?: number;
	stop_sequences?: string[];
	metadata?: Record<string, string>;
	stream?: boolean;
	thinking?: { type: "enabled"; budget_tokens: number };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PROVIDER_NAME = "anthropic";
const DEFAULT_BASE_URL = "https://api.anthropic.com";
const API_VERSION = "2023-06-01";
const DEFAULT_MAX_TOKENS = 4096;

function mapStopReason(raw: string | null): FinishReason {
	if (raw === null) {
		return { reason: "other", raw: "null" };
	}
	const map: Record<string, FinishReasonValue> = {
		end_turn: "stop",
		tool_use: "tool_calls",
		max_tokens: "length",
		content_filter: "content_filter",
		stop_sequence: "stop",
	};
	return {
		reason: map[raw] ?? "other",
		raw,
	};
}

function translateContentPartToBlock(part: ContentPart): AnthropicContentBlock {
	switch (part.kind) {
		case "text":
			return { type: "text", text: part.text ?? "" };
		case "tool_call": {
			const tc = part.tool_call;
			return {
				type: "tool_use",
				id: tc?.id ?? "",
				name: tc?.name ?? "",
				input:
					typeof tc?.arguments === "string"
						? (JSON.parse(tc.arguments) as Record<string, unknown>)
						: (tc?.arguments ?? {}),
			};
		}
		case "tool_result": {
			const content = part.tool_result?.content;
			const textContent = typeof content === "string" ? content : JSON.stringify(content);
			return {
				type: "tool_result",
				tool_use_id: part.tool_result?.tool_call_id ?? "",
				content: textContent,
			};
		}
		case "thinking":
			return {
				type: "thinking",
				thinking: part.thinking?.text ?? "",
				signature: part.thinking?.signature,
			};
		case "redacted_thinking":
			return {
				type: "redacted_thinking",
				data: part.thinking?.signature ?? "",
			};
		default:
			return { type: "text", text: part.text ?? "" };
	}
}

function translateAnthropicContentBlock(block: AnthropicResponse["content"][number]): ContentPart {
	switch (block.type) {
		case "text":
			return { kind: "text", text: block.text };
		case "tool_use":
			return {
				kind: "tool_call",
				tool_call: {
					id: block.id,
					name: block.name,
					arguments: block.input,
				},
			};
		case "thinking":
			return {
				kind: "thinking",
				thinking: {
					text: block.thinking,
					signature: block.signature,
					redacted: false,
				},
			};
		case "redacted_thinking":
			return {
				kind: "redacted_thinking",
				thinking: {
					text: "",
					redacted: true,
				},
			};
		default:
			return { kind: "text", text: "" };
	}
}

function extractUsage(raw: AnthropicResponse["usage"]): Usage {
	const input = raw.input_tokens;
	const output = raw.output_tokens;
	const cacheWrite = (raw as Record<string, unknown>).cache_creation_input_tokens as
		| number
		| undefined;
	const cacheRead = (raw as Record<string, unknown>).cache_read_input_tokens as number | undefined;
	return {
		input_tokens: input,
		output_tokens: output,
		total_tokens: input + output,
		cache_write_tokens: cacheWrite ?? undefined,
		cache_read_tokens: cacheRead ?? undefined,
	};
}

function extractRateLimitFromHeaders(headers: Headers): RateLimitInfo | undefined {
	return extractRateLimitInfo(headers);
}

function getAnthropicProviderOptions(request: Request): Record<string, unknown> {
	const opts = request.provider_options;
	if (!opts) return {};
	return (opts.anthropic as Record<string, unknown>) ?? {};
}

// ---------------------------------------------------------------------------
// Request translation
// ---------------------------------------------------------------------------

interface TranslatedRequest {
	url: string;
	headers: Record<string, string>;
	body: AnthropicRequestBody;
}

function translateRequest(
	request: Request,
	config: ProviderAdapterConfig,
	stream: boolean,
): TranslatedRequest {
	const providerOpts = getAnthropicProviderOptions(request);
	const baseUrl = config.base_url ?? DEFAULT_BASE_URL;
	const url = `${baseUrl}/v1/messages`;

	// ---- Headers ----------------------------------------------------------
	const headers: Record<string, string> = {
		"x-api-key": config.api_key,
		"anthropic-version": API_VERSION,
		...config.default_headers,
	};

	const betaHeaders = providerOpts.beta_headers as string[] | undefined;
	if (betaHeaders && betaHeaders.length > 0) {
		headers["anthropic-beta"] = betaHeaders.join(",");
	}

	// ---- System messages --------------------------------------------------
	const systemBlocks: AnthropicSystemBlock[] = [];
	const conversationMessages: Message[] = [];

	for (const msg of request.messages) {
		if (msg.role === "system" || msg.role === "developer") {
			for (const part of msg.content) {
				if (part.kind === "text" && part.text) {
					systemBlocks.push({ type: "text", text: part.text });
				}
			}
		} else {
			conversationMessages.push(msg);
		}
	}

	// ---- Translate messages and enforce alternation -----------------------
	const rawMessages: AnthropicMessage[] = [];

	for (const msg of conversationMessages) {
		// Determine Anthropic role: tool results go into user messages
		let role: "user" | "assistant";
		if (msg.role === "tool") {
			role = "user";
		} else if (msg.role === "assistant") {
			role = "assistant";
		} else {
			role = "user";
		}

		const blocks: AnthropicContentBlock[] = [];
		for (const part of msg.content) {
			blocks.push(translateContentPartToBlock(part));
		}

		if (blocks.length === 0) continue;

		rawMessages.push({ role, content: blocks });
	}

	// Merge consecutive same-role messages
	const messages: AnthropicMessage[] = [];
	for (const msg of rawMessages) {
		const last = messages[messages.length - 1];
		if (last && last.role === msg.role) {
			last.content = [...last.content, ...msg.content];
		} else {
			messages.push({ role: msg.role, content: [...msg.content] });
		}
	}

	// ---- Tools -----------------------------------------------------------
	let tools: AnthropicToolDefinition[] | undefined;
	let toolChoice: AnthropicToolChoice | undefined;

	const isNoneChoice = request.tool_choice?.mode === "none";

	if (request.tools && request.tools.length > 0 && !isNoneChoice) {
		tools = request.tools.map((t) => ({
			name: t.name,
			description: t.description,
			input_schema: t.parameters,
		}));

		if (request.tool_choice) {
			switch (request.tool_choice.mode) {
				case "auto":
					toolChoice = { type: "auto" };
					break;
				case "required":
					toolChoice = { type: "any" };
					break;
				case "named":
					toolChoice = {
						type: "tool",
						name: request.tool_choice.tool_name!,
					};
					break;
			}
		}
	}

	// ---- Body ------------------------------------------------------------
	const body: AnthropicRequestBody = {
		model: request.model,
		messages,
		max_tokens: request.max_tokens ?? DEFAULT_MAX_TOKENS,
	};

	if (systemBlocks.length > 0) {
		body.system = systemBlocks;
	}

	if (tools) {
		body.tools = tools;
	}

	if (toolChoice) {
		body.tool_choice = toolChoice;
	}

	if (request.temperature !== undefined) {
		body.temperature = request.temperature;
	}

	if (request.top_p !== undefined) {
		body.top_p = request.top_p;
	}

	if (request.stop_sequences && request.stop_sequences.length > 0) {
		body.stop_sequences = request.stop_sequences;
	}

	if (request.metadata) {
		body.metadata = request.metadata;
	}

	if (stream) {
		body.stream = true;
	}

	// ---- Thinking / reasoning_effort ------------------------------------
	const thinkingConfig = providerOpts.thinking as
		| { type: "enabled"; budget_tokens: number }
		| undefined;
	if (thinkingConfig) {
		body.thinking = thinkingConfig;
	} else if (request.reasoning_effort) {
		// Map reasoning_effort to a thinking budget
		const effortMap: Record<string, number> = {
			low: 1024,
			medium: 4096,
			high: 16384,
		};
		const budget = effortMap[request.reasoning_effort] ?? 4096;
		body.thinking = { type: "enabled", budget_tokens: budget };
	}

	// ---- Auto-cache ------------------------------------------------------
	const autoCache = providerOpts.auto_cache;
	if (autoCache !== false) {
		// Add cache_control to last system block
		if (body.system && body.system.length > 0) {
			body.system[body.system.length - 1]!.cache_control = {
				type: "ephemeral",
			};
		}
		// Add cache_control to last tool definition
		if (body.tools && body.tools.length > 0) {
			body.tools[body.tools.length - 1]!.cache_control = {
				type: "ephemeral",
			};
		}
	}

	return { url, headers, body };
}

// ---------------------------------------------------------------------------
// Response translation
// ---------------------------------------------------------------------------

function translateResponse(raw: AnthropicResponse, rateLimit?: RateLimitInfo): Response {
	const content: ContentPart[] = raw.content.map(translateAnthropicContentBlock);
	const finishReason = mapStopReason(raw.stop_reason);
	const usage = extractUsage(raw.usage);

	return {
		id: raw.id,
		model: raw.model,
		provider: PROVIDER_NAME,
		message: {
			role: "assistant",
			content,
		},
		finish_reason: finishReason,
		usage,
		raw: raw as unknown as Record<string, unknown>,
		warnings: [],
		rate_limit: rateLimit,
	};
}

// ---------------------------------------------------------------------------
// AnthropicAdapter
// ---------------------------------------------------------------------------

export class AnthropicAdapter implements ProviderAdapter {
	readonly name = PROVIDER_NAME;
	private readonly config: ProviderAdapterConfig;

	constructor(config: ProviderAdapterConfig) {
		this.config = config;
	}

	supports_tool_choice?(mode: ToolChoiceMode): boolean {
		return mode === "auto" || mode === "none" || mode === "required" || mode === "named";
	}

	async complete(request: Request): Promise<Response> {
		const { url, headers, body } = translateRequest(request, this.config, false);

		const {
			data,
			headers: responseHeaders,
			rate_limit,
		} = await fetchJSON<Record<string, unknown>>(url, PROVIDER_NAME, {
			headers,
			body,
			signal: undefined,
			timeout: this.config.timeout,
		});

		const parsed = AnthropicResponseSchema.safeParse(data);
		const anthropicResponse: AnthropicResponse = parsed.success
			? parsed.data
			: (data as unknown as AnthropicResponse);

		const rateLimit = rate_limit ?? extractRateLimitFromHeaders(responseHeaders);
		return translateResponse(anthropicResponse, rateLimit);
	}

	async *stream(request: Request): AsyncIterableIterator<StreamEvent> {
		const { url, headers, body } = translateRequest(request, this.config, true);

		// Track block index → block type for content_block_stop
		const blockTypes = new Map<number, string>();

		// Accumulate response data for the final FINISH event
		let responseId = "";
		let responseModel = request.model;
		let stopReason: FinishReason = { reason: "other" };
		const accumulatedContent: ContentPart[] = [];
		let accumulatedUsage: Usage = emptyUsage();
		let rateLimit: RateLimitInfo | undefined;

		// Per-block accumulators
		const blockContent = new Map<
			number,
			{
				type: string;
				text?: string;
				toolId?: string;
				toolName?: string;
				toolArgs?: string;
				thinkingText?: string;
				thinkingSignature?: string;
			}
		>();

		const events = fetchSSE(url, PROVIDER_NAME, {
			headers,
			body,
			signal: undefined,
			timeout: this.config.timeout,
		});

		for await (const sse of events) {
			const eventType = sse.event ?? "";
			let data: Record<string, unknown>;

			try {
				data = JSON.parse(sse.data) as Record<string, unknown>;
			} catch {
				continue;
			}

			switch (eventType) {
				case "message_start": {
					const message = data.message as Record<string, unknown> | undefined;
					if (message) {
						responseId = (message.id as string) ?? "";
						responseModel = (message.model as string) ?? request.model;
						const usage = message.usage as Record<string, unknown> | undefined;
						if (usage) {
							accumulatedUsage = {
								input_tokens: (usage.input_tokens as number) ?? 0,
								output_tokens: (usage.output_tokens as number) ?? 0,
								total_tokens:
									((usage.input_tokens as number) ?? 0) + ((usage.output_tokens as number) ?? 0),
								cache_read_tokens: (usage.cache_read_input_tokens as number) ?? undefined,
								cache_write_tokens: (usage.cache_creation_input_tokens as number) ?? undefined,
							};
						}
					}
					yield { type: "STREAM_START", raw: data };
					break;
				}

				case "content_block_start": {
					const index = data.index as number;
					const block = data.content_block as Record<string, unknown>;
					const blockType = block.type as string;

					blockTypes.set(index, blockType);

					switch (blockType) {
						case "text": {
							blockContent.set(index, { type: "text", text: "" });
							yield { type: "TEXT_START", raw: data };
							break;
						}
						case "tool_use": {
							const toolId = block.id as string;
							const toolName = block.name as string;
							blockContent.set(index, {
								type: "tool_use",
								toolId,
								toolName,
								toolArgs: "",
							});
							yield {
								type: "TOOL_CALL_START",
								tool_call: {
									id: toolId,
									name: toolName,
								},
								tool_call_id: toolId,
								raw: data,
							};
							break;
						}
						case "thinking": {
							blockContent.set(index, {
								type: "thinking",
								thinkingText: "",
							});
							yield { type: "REASONING_START", raw: data };
							break;
						}
					}
					break;
				}

				case "content_block_delta": {
					const index = data.index as number;
					const delta = data.delta as Record<string, unknown>;
					const deltaType = delta.type as string;
					const acc = blockContent.get(index);

					switch (deltaType) {
						case "text_delta": {
							const text = delta.text as string;
							if (acc) acc.text = (acc.text ?? "") + text;
							yield { type: "TEXT_DELTA", delta: text, raw: data };
							break;
						}
						case "input_json_delta": {
							const partial = delta.partial_json as string;
							if (acc) acc.toolArgs = (acc.toolArgs ?? "") + partial;
							yield {
								type: "TOOL_CALL_DELTA",
								delta: partial,
								tool_call_id: acc?.toolId,
								raw: data,
							};
							break;
						}
						case "thinking_delta": {
							const thinking = delta.thinking as string;
							if (acc) acc.thinkingText = (acc.thinkingText ?? "") + thinking;
							yield {
								type: "REASONING_DELTA",
								reasoning_delta: thinking,
								raw: data,
							};
							break;
						}
						case "signature_delta": {
							const signature = delta.signature as string;
							if (acc) acc.thinkingSignature = signature;
							break;
						}
					}
					break;
				}

				case "content_block_stop": {
					const index = data.index as number;
					const blockType = blockTypes.get(index);
					const acc = blockContent.get(index);

					switch (blockType) {
						case "text": {
							accumulatedContent.push({
								kind: "text",
								text: acc?.text ?? "",
							});
							yield { type: "TEXT_END", raw: data };
							break;
						}
						case "tool_use": {
							let parsedArgs: Record<string, unknown> = {};
							if (acc?.toolArgs) {
								try {
									parsedArgs = JSON.parse(acc.toolArgs) as Record<string, unknown>;
								} catch {
									// keep empty
								}
							}
							accumulatedContent.push({
								kind: "tool_call",
								tool_call: {
									id: acc?.toolId ?? "",
									name: acc?.toolName ?? "",
									arguments: parsedArgs,
								},
							});
							yield {
								type: "TOOL_CALL_END",
								tool_call: {
									id: acc?.toolId,
									name: acc?.toolName,
									arguments: parsedArgs,
								},
								tool_call_id: acc?.toolId,
								raw: data,
							};
							break;
						}
						case "thinking": {
							accumulatedContent.push({
								kind: "thinking",
								thinking: {
									text: acc?.thinkingText ?? "",
									signature: acc?.thinkingSignature,
									redacted: false,
								},
							});
							yield { type: "REASONING_END", raw: data };
							break;
						}
					}

					blockContent.delete(index);
					blockTypes.delete(index);
					break;
				}

				case "message_delta": {
					const delta = data.delta as Record<string, unknown> | undefined;
					const usage = data.usage as Record<string, unknown> | undefined;

					if (delta?.stop_reason) {
						stopReason = mapStopReason(delta.stop_reason as string);
					}

					if (usage) {
						accumulatedUsage = {
							...accumulatedUsage,
							output_tokens: (usage.output_tokens as number) ?? accumulatedUsage.output_tokens,
							total_tokens:
								accumulatedUsage.input_tokens +
								((usage.output_tokens as number) ?? accumulatedUsage.output_tokens),
						};
					}
					break;
				}

				case "message_stop": {
					const response: Response = {
						id: responseId,
						model: responseModel,
						provider: PROVIDER_NAME,
						message: {
							role: "assistant",
							content: accumulatedContent,
						},
						finish_reason: stopReason,
						usage: accumulatedUsage,
						raw: data,
						warnings: [],
						rate_limit: rateLimit,
					};
					yield {
						type: "FINISH",
						finish_reason: stopReason,
						usage: accumulatedUsage,
						response,
						raw: data,
					};
					break;
				}

				case "error": {
					const errorData = data.error as Record<string, unknown> | undefined;
					const message = (errorData?.message as string) ?? "Unknown stream error";
					const status = (errorData?.type as string) === "overloaded_error" ? 529 : 500;
					const err = errorFromStatus(PROVIDER_NAME, status, data);
					yield {
						type: "ERROR",
						error: err,
						raw: data,
					};
					break;
				}

				case "ping":
					// Ignore keepalive pings
					break;

				default:
					// Forward unknown events as PROVIDER_EVENT
					yield {
						type: "PROVIDER_EVENT",
						raw: data,
					};
					break;
			}
		}
	}
}
