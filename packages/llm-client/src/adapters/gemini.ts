import { ContentFilterError, errorFromStatus } from "../errors.js";
import { fetchJSON, fetchSSE } from "../http.js";
import type { GeminiResponse } from "../schemas.js";
import { GeminiResponseSchema } from "../schemas.js";
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
// Gemini-native request / response shapes
// ---------------------------------------------------------------------------

interface GeminiPart {
	text?: string;
	functionCall?: { name: string; args: Record<string, unknown> };
	functionResponse?: { name: string; response: Record<string, unknown> };
	inlineData?: { mimeType: string; data: string };
	fileData?: { mimeType: string; fileUri: string };
	thought?: boolean;
}

interface GeminiContent {
	role: "user" | "model";
	parts: GeminiPart[];
}

interface GeminiFunctionDeclaration {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
}

interface GeminiFunctionCallingConfig {
	mode: "AUTO" | "NONE" | "ANY";
	allowedFunctionNames?: string[];
}

interface GeminiThinkingConfig {
	thinkingBudget: number;
}

interface GeminiGenerationConfig {
	temperature?: number;
	topP?: number;
	maxOutputTokens?: number;
	stopSequences?: string[];
	responseMimeType?: string;
	responseSchema?: Record<string, unknown>;
	thinkingConfig?: GeminiThinkingConfig;
}

interface GeminiRequest {
	contents: GeminiContent[];
	systemInstruction?: { parts: Array<{ text: string }> };
	tools?: Array<{ functionDeclarations: GeminiFunctionDeclaration[] }>;
	toolConfig?: { functionCallingConfig: GeminiFunctionCallingConfig };
	generationConfig?: GeminiGenerationConfig;
	safetySettings?: unknown[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROVIDER = "gemini";
const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

const THINKING_BUDGET: Record<string, number> = {
	low: 1024,
	medium: 8192,
	high: 32768,
};

// ---------------------------------------------------------------------------
// GeminiAdapter
// ---------------------------------------------------------------------------

export class GeminiAdapter implements ProviderAdapter {
	readonly name = PROVIDER;
	readonly default_model: string;

	private readonly api_key: string;
	private readonly base_url: string;
	private readonly default_headers: Record<string, string>;
	private readonly timeout: number | undefined;

	/**
	 * Maps synthetic tool-call IDs (call_<uuid>) to the function name that
	 * was returned by the model.  Gemini's `functionResponse` requires the
	 * function *name*, but our unified format correlates via call IDs.
	 */
	private readonly callIdToName: Map<string, string> = new Map();

	constructor(config: ProviderAdapterConfig) {
		this.api_key = config.api_key;
		this.base_url = (config.base_url ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
		this.default_headers = config.default_headers ?? {};
		this.timeout = config.timeout;
		this.default_model = config.default_model ?? "gemini-2.0-flash";
	}

	// -----------------------------------------------------------------------
	// supports_tool_choice
	// -----------------------------------------------------------------------

	supports_tool_choice(mode: ToolChoiceMode): boolean {
		return mode === "auto" || mode === "none" || mode === "required" || mode === "named";
	}

	// -----------------------------------------------------------------------
	// complete
	// -----------------------------------------------------------------------

	async complete(request: Request): Promise<Response> {
		const geminiBody = this.translateRequest(request);
		const url = `${this.base_url}/models/${request.model}:generateContent?key=${this.api_key}`;

		const { data } = await fetchJSON<unknown>(url, PROVIDER, {
			method: "POST",
			headers: { ...this.default_headers },
			body: geminiBody,
			timeout: this.timeout,
		});

		const parsed = GeminiResponseSchema.parse(data) as GeminiResponse;
		return this.translateResponse(parsed, request.model);
	}

	// -----------------------------------------------------------------------
	// stream
	// -----------------------------------------------------------------------

	async *stream(request: Request): AsyncIterableIterator<StreamEvent> {
		const geminiBody = this.translateRequest(request);
		const url = `${this.base_url}/models/${request.model}:streamGenerateContent?alt=sse&key=${this.api_key}`;

		const sseStream = fetchSSE(url, PROVIDER, {
			method: "POST",
			headers: { ...this.default_headers },
			body: geminiBody,
			timeout: this.timeout,
		});

		let started = false;
		let textStarted = false;
		let accumulatedText = "";
		const accumulatedParts: ContentPart[] = [];
		let lastUsage: Usage | undefined;
		let lastFinishReason: FinishReason | undefined;

		for await (const sse of sseStream) {
			let chunk: GeminiResponse;
			try {
				chunk = GeminiResponseSchema.parse(JSON.parse(sse.data)) as GeminiResponse;
			} catch {
				continue;
			}

			// Emit STREAM_START on the very first chunk
			if (!started) {
				started = true;
				yield { type: "STREAM_START", raw: chunk as unknown as Record<string, unknown> };
			}

			// Extract usage from the chunk if present
			if (chunk.usageMetadata) {
				lastUsage = this.extractUsage(chunk);
			}

			const candidate = chunk.candidates?.[0];
			if (!candidate) continue;

			// Capture finish reason
			if (candidate.finishReason) {
				lastFinishReason = this.mapFinishReason(candidate.finishReason);
			}

			const rawParts = candidate.content?.parts ?? [];

			for (const rawPart of rawParts) {
				// Cast to a loose record so we can inspect Gemini-specific
				// properties (e.g. `thought`) that aren't in the Zod union.
				const p = rawPart as Record<string, unknown>;

				// Thinking text
				if (p.thought === true && typeof p.text === "string") {
					accumulatedParts.push({
						kind: "thinking",
						thinking: { text: p.text, redacted: false },
					});
					continue;
				}

				// Text part
				if (typeof p.text === "string" && p.thought !== true) {
					const text = p.text;
					if (!textStarted) {
						textStarted = true;
						yield { type: "TEXT_START" };
					}
					accumulatedText += text;
					yield { type: "TEXT_DELTA", delta: text };
					continue;
				}

				// Function call — arrives complete (not streamed)
				if (p.functionCall != null) {
					const fc = p.functionCall as {
						name: string;
						args: Record<string, unknown>;
					};
					const syntheticId = `call_${crypto.randomUUID()}`;
					this.callIdToName.set(syntheticId, fc.name);

					const toolCall = {
						id: syntheticId,
						name: fc.name,
						arguments: fc.args,
					};

					accumulatedParts.push({
						kind: "tool_call",
						tool_call: {
							id: syntheticId,
							name: fc.name,
							arguments: fc.args,
						},
					});

					yield {
						type: "TOOL_CALL_START",
						tool_call: toolCall,
						tool_call_id: syntheticId,
					};
					yield {
						type: "TOOL_CALL_END",
						tool_call: toolCall,
						tool_call_id: syntheticId,
					};
				}
			}
		}

		// Close the text span if one was opened
		if (textStarted) {
			accumulatedParts.push({ kind: "text", text: accumulatedText });
			yield { type: "TEXT_END" };
		}

		// Build the final response for the FINISH event
		const finishReason = lastFinishReason ?? { reason: "stop" as const };
		const usage = lastUsage ?? {
			input_tokens: 0,
			output_tokens: 0,
			total_tokens: 0,
		};

		const response: Response = {
			id: `gemini-${crypto.randomUUID()}`,
			model: request.model,
			provider: PROVIDER,
			message: { role: "assistant", content: accumulatedParts },
			finish_reason: finishReason,
			usage,
			warnings: [],
		};

		yield {
			type: "FINISH",
			finish_reason: finishReason,
			usage,
			response,
		};
	}

	// -----------------------------------------------------------------------
	// translateRequest
	// -----------------------------------------------------------------------

	translateRequest(request: Request): GeminiRequest {
		const result: GeminiRequest = { contents: [] };

		// -- System instruction ------------------------------------------------
		const systemTexts: string[] = [];
		const nonSystemMessages: Message[] = [];

		for (const msg of request.messages) {
			if (msg.role === "system" || msg.role === "developer") {
				for (const part of msg.content) {
					if (part.kind === "text" && part.text) {
						systemTexts.push(part.text);
					}
				}
			} else {
				nonSystemMessages.push(msg);
			}
		}

		if (systemTexts.length > 0) {
			result.systemInstruction = {
				parts: systemTexts.map((t) => ({ text: t })),
			};
		}

		// -- Contents (with consecutive same-role merging) ---------------------
		const rawContents: GeminiContent[] = [];

		for (const msg of nonSystemMessages) {
			const geminiRole = msg.role === "assistant" ? "model" : "user";
			const geminiParts = this.translateParts(msg);

			if (geminiParts.length === 0) continue;

			rawContents.push({ role: geminiRole, parts: geminiParts });
		}

		// Merge consecutive messages with the same role
		for (const content of rawContents) {
			const last = result.contents[result.contents.length - 1];
			if (last && last.role === content.role) {
				last.parts.push(...content.parts);
			} else {
				result.contents.push(content);
			}
		}

		// -- Tools -------------------------------------------------------------
		if (request.tools && request.tools.length > 0) {
			result.tools = [
				{
					functionDeclarations: request.tools.map((t) => ({
						name: t.name,
						description: t.description,
						parameters: t.parameters,
					})),
				},
			];
		}

		// -- Tool choice -------------------------------------------------------
		if (request.tool_choice) {
			result.toolConfig = {
				functionCallingConfig: this.mapToolChoice(request.tool_choice),
			};
		}

		// -- Generation config -------------------------------------------------
		const genConfig: GeminiGenerationConfig = {};
		let hasGenConfig = false;

		if (request.temperature !== undefined) {
			genConfig.temperature = request.temperature;
			hasGenConfig = true;
		}
		if (request.top_p !== undefined) {
			genConfig.topP = request.top_p;
			hasGenConfig = true;
		}
		if (request.max_tokens !== undefined) {
			genConfig.maxOutputTokens = request.max_tokens;
			hasGenConfig = true;
		}
		if (request.stop_sequences && request.stop_sequences.length > 0) {
			genConfig.stopSequences = request.stop_sequences;
			hasGenConfig = true;
		}

		// Reasoning effort → thinkingConfig.thinkingBudget
		if (request.reasoning_effort) {
			const budget = THINKING_BUDGET[request.reasoning_effort];
			if (budget !== undefined) {
				genConfig.thinkingConfig = { thinkingBudget: budget };
				hasGenConfig = true;
			}
		}

		// Response format → responseMimeType + responseSchema
		if (request.response_format) {
			if (
				request.response_format.type === "json_object" ||
				request.response_format.type === "json_schema"
			) {
				genConfig.responseMimeType = "application/json";
				hasGenConfig = true;
			}
			if (request.response_format.type === "json_schema" && request.response_format.json_schema) {
				genConfig.responseSchema = request.response_format.json_schema;
				hasGenConfig = true;
			}
		}

		if (hasGenConfig) {
			result.generationConfig = genConfig;
		}

		// -- Safety settings ---------------------------------------------------
		const providerOptions = request.provider_options as Record<string, unknown> | undefined;
		const geminiOptions = providerOptions?.gemini as Record<string, unknown> | undefined;

		if (geminiOptions?.safety_settings) {
			result.safetySettings = geminiOptions.safety_settings as unknown[];
		}

		return result;
	}

	// -----------------------------------------------------------------------
	// translateResponse
	// -----------------------------------------------------------------------

	translateResponse(raw: GeminiResponse, model: string): Response {
		if (!raw.candidates || raw.candidates.length === 0) {
			throw new ContentFilterError(
				"Gemini returned zero candidates (content was likely filtered)",
				{ provider: PROVIDER },
			);
		}

		const candidate = raw.candidates[0];
		const parts: ContentPart[] = [];

		if (candidate.content?.parts) {
			for (const p of candidate.content.parts) {
				// Thinking parts (Gemini marks them with a `thought` property)
				const rawPart = p as Record<string, unknown>;
				if (rawPart.thought === true && typeof rawPart.text === "string") {
					parts.push({
						kind: "thinking",
						thinking: {
							text: rawPart.text as string,
							redacted: false,
						},
					});
					continue;
				}

				// Text
				if ("text" in p && typeof p.text === "string") {
					parts.push({ kind: "text", text: p.text });
					continue;
				}

				// Function call
				if ("functionCall" in p && p.functionCall) {
					const fc = p.functionCall as { name: string; args: Record<string, unknown> };
					const syntheticId = `call_${crypto.randomUUID()}`;
					this.callIdToName.set(syntheticId, fc.name);
					parts.push({
						kind: "tool_call",
						tool_call: {
							id: syntheticId,
							name: fc.name,
							arguments: fc.args,
						},
					});
				}
			}
		}

		const finishReason = this.mapFinishReason(candidate.finishReason ?? "STOP");

		const usage = this.extractUsage(raw);

		return {
			id: `gemini-${crypto.randomUUID()}`,
			model,
			provider: PROVIDER,
			message: { role: "assistant", content: parts },
			finish_reason: finishReason,
			usage,
			raw: raw as unknown as Record<string, unknown>,
			warnings: [],
		};
	}

	// -----------------------------------------------------------------------
	// Private helpers
	// -----------------------------------------------------------------------

	private translateParts(msg: Message): GeminiPart[] {
		const parts: GeminiPart[] = [];

		for (const part of msg.content) {
			switch (part.kind) {
				case "text":
					if (part.text) {
						parts.push({ text: part.text });
					}
					break;

				case "tool_call":
					if (part.tool_call) {
						// Store the mapping so we can resolve it when tool results come back
						this.callIdToName.set(part.tool_call.id, part.tool_call.name);
						const args =
							typeof part.tool_call.arguments === "string"
								? (JSON.parse(part.tool_call.arguments) as Record<string, unknown>)
								: part.tool_call.arguments;
						parts.push({
							functionCall: {
								name: part.tool_call.name,
								args,
							},
						});
					}
					break;

				case "tool_result":
					if (part.tool_result) {
						const functionName =
							this.callIdToName.get(part.tool_result.tool_call_id) ?? part.tool_result.tool_call_id;

						const resultContent =
							typeof part.tool_result.content === "string"
								? { result: part.tool_result.content }
								: Array.isArray(part.tool_result.content)
									? { result: part.tool_result.content }
									: (part.tool_result.content as Record<string, unknown>);

						parts.push({
							functionResponse: {
								name: functionName,
								response: resultContent,
							},
						});
					}
					break;

				case "image":
					if (part.image) {
						if (part.image.data) {
							// Binary data → base64 inlineData
							const base64 = bufferToBase64(part.image.data);
							parts.push({
								inlineData: {
									mimeType: part.image.media_type ?? "image/png",
									data: base64,
								},
							});
						} else if (part.image.url) {
							parts.push({
								fileData: {
									mimeType: part.image.media_type ?? "image/png",
									fileUri: part.image.url,
								},
							});
						}
					}
					break;

				case "thinking":
					// Thinking parts are not sent back to the model
					break;

				case "redacted_thinking":
					// Redacted thinking is not sent back to the model
					break;

				default:
					// Unsupported kinds (audio, document) are silently skipped
					break;
			}
		}

		return parts;
	}

	private mapToolChoice(choice: NonNullable<Request["tool_choice"]>): GeminiFunctionCallingConfig {
		switch (choice.mode) {
			case "auto":
				return { mode: "AUTO" };
			case "none":
				return { mode: "NONE" };
			case "required":
				return { mode: "ANY" };
			case "named":
				return {
					mode: "ANY",
					allowedFunctionNames: choice.tool_name ? [choice.tool_name] : undefined,
				};
			default:
				return { mode: "AUTO" };
		}
	}

	private mapFinishReason(raw: string): FinishReason {
		const mapping: Record<string, FinishReasonValue> = {
			STOP: "stop",
			MAX_TOKENS: "length",
			SAFETY: "content_filter",
			RECITATION: "content_filter",
		};
		return {
			reason: mapping[raw] ?? "other",
			raw,
		};
	}

	private extractUsage(raw: GeminiResponse): Usage {
		const meta = raw.usageMetadata;
		if (!meta) {
			return {
				input_tokens: 0,
				output_tokens: 0,
				total_tokens: 0,
			};
		}
		return {
			input_tokens: meta.promptTokenCount,
			output_tokens: meta.candidatesTokenCount,
			total_tokens: meta.totalTokenCount,
			reasoning_tokens: meta.thoughtsTokenCount,
		};
	}
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function bufferToBase64(data: Uint8Array): string {
	// Build a binary string and use btoa, which is available in Node 16+
	// and all modern runtimes (browsers, Deno, Cloudflare Workers).
	let binary = "";
	for (let i = 0; i < data.length; i++) {
		binary += String.fromCharCode(data[i]);
	}
	return btoa(binary);
}
