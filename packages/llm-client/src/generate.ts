import type { z } from "zod";
import { StreamAccumulator } from "./accumulator.js";
import type { Client } from "./client.js";
import { AbortError, NoObjectGeneratedError } from "./errors.js";
import { completeWithRetry, streamWithRetry } from "./retry.js";
import type {
	ContentPart,
	GenerateResult,
	Message,
	Request,
	Response,
	ResponseFormat,
	RetryPolicy,
	StepResult,
	StreamEvent,
	StreamResult,
	Tool,
	ToolCall,
	ToolChoice,
	ToolResult,
	Usage,
} from "./types.js";
import {
	emptyUsage,
	mergeUsage,
	responseReasoning,
	responseText,
	responseToolCalls,
} from "./types.js";

// ---------------------------------------------------------------------------
// GenerateOptions
// ---------------------------------------------------------------------------

export interface GenerateOptions {
	client: Client;
	model: string;
	prompt?: string;
	messages?: Message[];
	system?: string;
	tools?: Tool[];
	tool_choice?: ToolChoice;
	max_tool_rounds?: number;
	temperature?: number;
	top_p?: number;
	max_tokens?: number;
	stop_sequences?: string[];
	reasoning_effort?: "low" | "medium" | "high";
	response_format?: ResponseFormat;
	provider?: string;
	provider_options?: Record<string, unknown>;
	retry_policy?: RetryPolicy;
	abort_signal?: AbortSignal;
	metadata?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeMessages(options: GenerateOptions): Message[] {
	const messages: Message[] = [];

	// Add system message if provided.
	if (options.system) {
		messages.push({
			role: "system",
			content: [{ kind: "text", text: options.system }],
		});
	}

	// Add prior messages.
	if (options.messages) {
		messages.push(...options.messages);
	}

	// Normalize string prompt into a user message.
	if (options.prompt) {
		messages.push({
			role: "user",
			content: [{ kind: "text", text: options.prompt }],
		});
	}

	return messages;
}

function buildRequest(options: GenerateOptions, messages: Message[]): Request {
	const request: Request = {
		model: options.model,
		messages,
		provider: options.provider,
		temperature: options.temperature,
		top_p: options.top_p,
		max_tokens: options.max_tokens,
		stop_sequences: options.stop_sequences,
		reasoning_effort: options.reasoning_effort,
		response_format: options.response_format,
		provider_options: options.provider_options,
		metadata: options.metadata,
	};

	if (options.tools && options.tools.length > 0) {
		request.tools = options.tools.map((t) => ({
			name: t.name,
			description: t.description,
			parameters: t.parameters,
		}));
	}

	if (options.tool_choice) {
		request.tool_choice = options.tool_choice;
	}

	return request;
}

/**
 * Execute tool calls concurrently and return results.
 *
 * Uses `Promise.allSettled` so one failing tool doesn't block the others.
 * Failed tools return a ToolResult with `is_error: true`.
 */
async function executeToolCalls(
	toolCalls: ToolCall[],
	tools: Tool[],
	signal?: AbortSignal,
): Promise<ToolResult[]> {
	const toolMap = new Map(tools.filter((t) => t.execute).map((t) => [t.name, t]));

	const promises = toolCalls.map(async (call): Promise<ToolResult> => {
		const tool = toolMap.get(call.name);
		if (!tool?.execute) {
			return {
				tool_call_id: call.id,
				content: `Tool "${call.name}" not found or has no execute handler`,
				is_error: true,
			};
		}

		try {
			const result = await tool.execute(call.arguments, { abort_signal: signal });
			const content = typeof result === "string" ? result : result;
			return { tool_call_id: call.id, content, is_error: false };
		} catch (error) {
			return {
				tool_call_id: call.id,
				content: error instanceof Error ? error.message : String(error),
				is_error: true,
			};
		}
	});

	const settled = await Promise.allSettled(promises);

	return settled.map((r, i) => {
		if (r.status === "fulfilled") {
			return r.value;
		}
		// Promise.allSettled rejection — shouldn't normally happen with our try/catch above.
		return {
			tool_call_id: toolCalls[i].id,
			content: r.reason instanceof Error ? r.reason.message : String(r.reason),
			is_error: true,
		};
	});
}

/**
 * Build the messages to append after a tool call round.
 */
function toolRoundMessages(response: Response, toolResults: ToolResult[]): Message[] {
	// Assistant message with tool calls.
	const assistantMsg: Message = {
		role: "assistant",
		content: response.message.content,
	};

	// Tool results as a tool message.
	const toolParts: ContentPart[] = toolResults.map((r) => ({
		kind: "tool_result" as const,
		tool_result: {
			tool_call_id: r.tool_call_id,
			content: r.content,
			is_error: r.is_error,
		},
	}));

	const toolMsg: Message = { role: "tool", content: toolParts };

	return [assistantMsg, toolMsg];
}

function buildStepResult(response: Response, toolResults: ToolResult[]): StepResult {
	return {
		text: responseText(response),
		reasoning: responseReasoning(response),
		tool_calls: responseToolCalls(response),
		tool_results: toolResults,
		finish_reason: response.finish_reason,
		usage: response.usage,
		response,
		warnings: response.warnings,
	};
}

// ---------------------------------------------------------------------------
// generate() — Non-streaming with tool execution loop
// ---------------------------------------------------------------------------

/**
 * High-level generate function with tool execution loop and retry.
 *
 * If tools with `execute` handlers are provided, the function will
 * automatically call them and loop back to the model with results,
 * up to `max_tool_rounds` iterations.
 */
export async function generate(options: GenerateOptions): Promise<GenerateResult> {
	const maxRounds = options.max_tool_rounds ?? 1;
	const messages = normalizeMessages(options);
	const steps: StepResult[] = [];
	let totalUsage: Usage = emptyUsage();

	const executableTools = options.tools?.filter((t) => t.execute) ?? [];
	const hasExecutableTools = executableTools.length > 0;

	for (let round = 0; round <= maxRounds; round++) {
		if (options.abort_signal?.aborted) {
			throw new AbortError("Request was aborted");
		}

		const request = buildRequest(options, messages);
		const response = await completeWithRetry(options.client, request, {
			policy: options.retry_policy,
			abort_signal: options.abort_signal,
		});

		const toolCalls = responseToolCalls(response);
		const shouldExecuteTools = hasExecutableTools && toolCalls.length > 0 && round < maxRounds;

		let toolResults: ToolResult[] = [];
		if (shouldExecuteTools) {
			toolResults = await executeToolCalls(toolCalls, options.tools!, options.abort_signal);
			messages.push(...toolRoundMessages(response, toolResults));
		}

		const step = buildStepResult(response, toolResults);
		steps.push(step);
		totalUsage = mergeUsage(totalUsage, response.usage);

		// If no tools were called or we're out of rounds, return.
		if (!shouldExecuteTools) {
			const lastStep = steps[steps.length - 1];
			return {
				text: lastStep.text,
				reasoning: lastStep.reasoning,
				tool_calls: lastStep.tool_calls,
				tool_results: lastStep.tool_results,
				finish_reason: lastStep.finish_reason,
				usage: response.usage,
				total_usage: totalUsage,
				steps,
				response,
			};
		}
	}

	// Should be unreachable — the loop always returns.
	const lastStep = steps[steps.length - 1];
	return {
		text: lastStep.text,
		reasoning: lastStep.reasoning,
		tool_calls: lastStep.tool_calls,
		tool_results: lastStep.tool_results,
		finish_reason: lastStep.finish_reason,
		usage: lastStep.usage,
		total_usage: totalUsage,
		steps,
		response: lastStep.response,
	};
}

// ---------------------------------------------------------------------------
// stream() — Streaming with convenience wrappers
// ---------------------------------------------------------------------------

/**
 * High-level stream function that returns a `StreamResult`.
 *
 * The result is an async iterable of `StreamEvent`s. It also exposes:
 * - `text_stream`: async iterable yielding only text deltas
 * - `response()`: promise resolving to the accumulated Response
 */
export function stream(options: GenerateOptions): StreamResult {
	const messages = normalizeMessages(options);
	const request = buildRequest(options, messages);

	// Create the underlying stream with retry.
	const eventStream = streamWithRetry(options.client, request, {
		policy: options.retry_policy,
		abort_signal: options.abort_signal,
	});

	// We tee the stream: one path for the consumer's iteration,
	// one for accumulation. We use a buffered approach.
	const accumulator = new StreamAccumulator();
	const eventBuffer: StreamEvent[] = [];
	let streamDone = false;
	let streamError: unknown;
	let consumePromiseResolve: (() => void) | undefined;
	let pumpStarted = false;

	// Pump events from the source into the buffer.
	async function pump(): Promise<void> {
		try {
			for await (const event of eventStream) {
				accumulator.push(event);
				eventBuffer.push(event);
				if (consumePromiseResolve) {
					const resolve = consumePromiseResolve;
					consumePromiseResolve = undefined;
					resolve();
				}
			}
		} catch (e) {
			streamError = e;
		} finally {
			streamDone = true;
			if (consumePromiseResolve) {
				const resolve = consumePromiseResolve;
				consumePromiseResolve = undefined;
				resolve();
			}
		}
	}

	function ensurePump(): void {
		if (!pumpStarted) {
			pumpStarted = true;
			pump();
		}
	}

	async function* iterateEvents(): AsyncIterableIterator<StreamEvent> {
		ensurePump();
		let index = 0;

		while (true) {
			if (index < eventBuffer.length) {
				yield eventBuffer[index++];
			} else if (streamDone) {
				if (streamError) throw streamError;
				return;
			} else {
				await new Promise<void>((resolve) => {
					consumePromiseResolve = resolve;
				});
			}
		}
	}

	async function* iterateText(): AsyncIterableIterator<string> {
		for await (const event of iterateEvents()) {
			if (event.type === "TEXT_DELTA" && event.delta) {
				yield event.delta;
			}
		}
	}

	const result: StreamResult = {
		[Symbol.asyncIterator](): AsyncIterableIterator<StreamEvent> {
			return iterateEvents();
		},

		async response(): Promise<Response> {
			// Consume the entire stream to build the response.
			ensurePump();
			while (!streamDone) {
				await new Promise<void>((resolve) => {
					if (streamDone) {
						resolve();
						return;
					}
					const prev = consumePromiseResolve;
					consumePromiseResolve = () => {
						if (prev) prev();
						resolve();
					};
				});
			}
			if (streamError) throw streamError;
			return accumulator.response();
		},

		text_stream: iterateText(),
	};

	return result;
}

// ---------------------------------------------------------------------------
// generate_object() — Structured output with Zod validation
// ---------------------------------------------------------------------------

export interface GenerateObjectOptions extends GenerateOptions {
	schema: z.ZodType;
	schema_name?: string;
	schema_description?: string;
}

/**
 * Generate a structured object from the LLM and validate it against a Zod schema.
 *
 * Uses per-provider JSON mode strategies:
 * - OpenAI: native `json_schema` response format
 * - Gemini: native `responseSchema` in provider_options
 * - Anthropic: tool-based extraction (defines a tool matching the schema, forces tool_choice)
 */
export async function generate_object(options: GenerateObjectOptions): Promise<GenerateResult> {
	const provider = options.provider ?? inferProviderFromModel(options.model);
	const jsonSchema = schemaToJsonSchema(options.schema);
	const schemaName = options.schema_name ?? "extract";

	let modifiedOptions: GenerateOptions;

	if (provider === "openai") {
		modifiedOptions = {
			...options,
			response_format: {
				type: "json_schema",
				json_schema: jsonSchema,
				name: schemaName,
				strict: true,
			},
		};
	} else if (provider === "gemini") {
		modifiedOptions = {
			...options,
			response_format: { type: "json_object" },
			provider_options: {
				...options.provider_options,
				responseSchema: jsonSchema,
			},
		};
	} else {
		// Anthropic: use tool-based extraction.
		const extractTool: Tool = {
			name: schemaName,
			description: options.schema_description ?? "Extract structured data from the content",
			parameters: jsonSchema,
		};

		modifiedOptions = {
			...options,
			tools: [extractTool, ...(options.tools ?? [])],
			tool_choice: { mode: "named", tool_name: schemaName },
			max_tool_rounds: 0, // Don't auto-execute the extraction tool.
		};
	}

	const result = await generate(modifiedOptions);

	// Extract the object from the response.
	let raw: unknown;

	if (provider === "anthropic") {
		// Look for the extraction tool call.
		const extractionCall = result.tool_calls.find((tc) => tc.name === schemaName);
		if (!extractionCall) {
			throw new NoObjectGeneratedError(
				`Model did not produce a "${schemaName}" tool call for structured output`,
			);
		}
		raw = extractionCall.arguments;
	} else {
		// OpenAI/Gemini: parse from text output.
		const text = result.text.trim();
		try {
			raw = JSON.parse(text);
		} catch {
			throw new NoObjectGeneratedError(
				`Failed to parse JSON from model output: ${text.slice(0, 200)}`,
			);
		}
	}

	// Validate with Zod.
	const parsed = options.schema.safeParse(raw);
	if (!parsed.success) {
		throw new NoObjectGeneratedError(`Schema validation failed: ${parsed.error.message}`);
	}

	return {
		...result,
		output: parsed.data,
	};
}

// ---------------------------------------------------------------------------
// stream_object() — Streaming structured output
// ---------------------------------------------------------------------------

export interface StreamObjectResult {
	partial_objects: AsyncIterableIterator<unknown>;
	result: Promise<GenerateResult>;
}

/**
 * Stream structured output from the LLM, yielding partial objects as they arrive.
 */
export function stream_object(options: GenerateObjectOptions): StreamObjectResult {
	const provider = options.provider ?? inferProviderFromModel(options.model);
	const jsonSchema = schemaToJsonSchema(options.schema);
	const schemaName = options.schema_name ?? "extract";

	let modifiedOptions: GenerateOptions;

	if (provider === "openai") {
		modifiedOptions = {
			...options,
			response_format: {
				type: "json_schema",
				json_schema: jsonSchema,
				name: schemaName,
				strict: true,
			},
		};
	} else if (provider === "gemini") {
		modifiedOptions = {
			...options,
			response_format: { type: "json_object" },
			provider_options: {
				...options.provider_options,
				responseSchema: jsonSchema,
			},
		};
	} else {
		// Anthropic: tool-based extraction with streaming.
		const extractTool: Tool = {
			name: schemaName,
			description: options.schema_description ?? "Extract structured data from the content",
			parameters: jsonSchema,
		};

		modifiedOptions = {
			...options,
			tools: [extractTool, ...(options.tools ?? [])],
			tool_choice: { mode: "named", tool_name: schemaName },
			max_tool_rounds: 0,
		};
	}

	const streamResult = stream(modifiedOptions);

	let resultResolve: (r: GenerateResult) => void;
	let resultReject: (e: unknown) => void;
	const resultPromise = new Promise<GenerateResult>((resolve, reject) => {
		resultResolve = resolve;
		resultReject = reject;
	});

	async function* iteratePartials(): AsyncIterableIterator<unknown> {
		const accumulator = new StreamAccumulator();
		let jsonBuffer = "";
		const isToolMode = provider === "anthropic";

		try {
			for await (const event of streamResult) {
				accumulator.push(event);

				if (isToolMode) {
					// Anthropic: accumulate tool call arguments.
					if (event.type === "TOOL_CALL_DELTA" && event.delta) {
						jsonBuffer += event.delta;
						const partial = tryParsePartial(jsonBuffer);
						if (partial !== undefined) {
							yield partial;
						}
					}
				} else {
					// OpenAI/Gemini: accumulate text deltas.
					if (event.type === "TEXT_DELTA" && event.delta) {
						jsonBuffer += event.delta;
						const partial = tryParsePartial(jsonBuffer);
						if (partial !== undefined) {
							yield partial;
						}
					}
				}
			}

			// Build the final result.
			const response = accumulator.response();
			let raw: unknown;

			if (isToolMode) {
				const toolCalls = accumulator.getToolCalls();
				const extractionCall = toolCalls.find((tc) => tc.name === schemaName);
				raw = extractionCall?.arguments;
			} else {
				try {
					raw = JSON.parse(jsonBuffer);
				} catch {
					raw = undefined;
				}
			}

			let output: unknown;
			if (raw !== undefined) {
				const parsed = options.schema.safeParse(raw);
				if (parsed.success) {
					output = parsed.data;
				}
			}

			if (output === undefined) {
				resultReject?.(new NoObjectGeneratedError("Failed to generate valid object from stream"));
				return;
			}

			const toolCalls = accumulator.getToolCalls();
			resultResolve?.({
				text: accumulator.getText(),
				reasoning: accumulator.getReasoning(),
				tool_calls: toolCalls,
				tool_results: [],
				finish_reason: response.finish_reason,
				usage: response.usage,
				total_usage: response.usage,
				steps: [],
				response,
				output,
			});
		} catch (error) {
			resultReject?.(error);
		}
	}

	return {
		partial_objects: iteratePartials(),
		result: resultPromise,
	};
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function inferProviderFromModel(model: string): string | undefined {
	if (model.startsWith("claude")) return "anthropic";
	if (model.startsWith("gpt-") || model.startsWith("o1-") || model.startsWith("o3-"))
		return "openai";
	if (model.startsWith("gemini")) return "gemini";
	return undefined;
}

/**
 * Convert a Zod schema to JSON Schema (basic implementation).
 *
 * Zod provides `z.ZodType.toJsonSchema()` in newer versions, but for
 * compatibility we use a simple recursive approach that handles the most
 * common types.
 */
function schemaToJsonSchema(schema: z.ZodType): Record<string, unknown> {
	// If the schema has a toJsonSchema method (zod >= 3.24), use it.
	if ("_def" in schema) {
		return zodDefToJsonSchema(schema._def as ZodDef);
	}
	return { type: "object" };
}

interface ZodDef {
	typeName?: string;
	shape?: () => Record<string, z.ZodType>;
	type?: z.ZodType;
	options?: z.ZodType[];
	values?: string[];
	checks?: Array<{ kind: string; value?: unknown }>;
	innerType?: z.ZodType;
	description?: string;
}

function zodDefToJsonSchema(def: ZodDef): Record<string, unknown> {
	const base: Record<string, unknown> = {};
	if (def.description) {
		base.description = def.description;
	}

	switch (def.typeName) {
		case "ZodString":
			return { ...base, type: "string" };
		case "ZodNumber":
			return { ...base, type: "number" };
		case "ZodBoolean":
			return { ...base, type: "boolean" };
		case "ZodNull":
			return { ...base, type: "null" };
		case "ZodArray":
			return {
				...base,
				type: "array",
				items: def.type ? schemaToJsonSchema(def.type) : {},
			};
		case "ZodObject": {
			const shape = def.shape?.() ?? {};
			const properties: Record<string, unknown> = {};
			const required: string[] = [];
			for (const [key, value] of Object.entries(shape)) {
				properties[key] = schemaToJsonSchema(value);
				// Check if optional by looking at the def
				const valueDef = (value as { _def?: ZodDef })._def;
				if (valueDef?.typeName !== "ZodOptional") {
					required.push(key);
				}
			}
			return {
				...base,
				type: "object",
				properties,
				...(required.length > 0 ? { required } : {}),
			};
		}
		case "ZodEnum":
			return { ...base, type: "string", enum: def.values };
		case "ZodOptional":
			if (def.innerType) {
				return schemaToJsonSchema(def.innerType);
			}
			return base;
		case "ZodNullable": {
			if (def.innerType) {
				const inner = schemaToJsonSchema(def.innerType);
				return { ...inner, nullable: true };
			}
			return base;
		}
		case "ZodUnion": {
			if (def.options) {
				return {
					...base,
					anyOf: def.options.map((o) => schemaToJsonSchema(o)),
				};
			}
			return base;
		}
		default:
			return { ...base, type: "object" };
	}
}

/**
 * Try to parse a partial JSON string. Returns the parsed value if successful,
 * undefined if the JSON is incomplete or invalid.
 */
function tryParsePartial(json: string): unknown {
	try {
		return JSON.parse(json);
	} catch {
		// Try to "close" the JSON by adding missing brackets/braces.
		const trimmed = json.trim();
		if (trimmed.length === 0) return undefined;

		// Attempt to repair by closing open structures.
		let repaired = trimmed;
		const opens: string[] = [];
		let inString = false;
		let escaped = false;

		for (const ch of repaired) {
			if (escaped) {
				escaped = false;
				continue;
			}
			if (ch === "\\") {
				escaped = true;
				continue;
			}
			if (ch === '"') {
				inString = !inString;
				continue;
			}
			if (inString) continue;

			if (ch === "{") opens.push("}");
			else if (ch === "[") opens.push("]");
			else if (ch === "}" || ch === "]") opens.pop();
		}

		// If we're in a string, close it.
		if (inString) repaired += '"';

		// Close any remaining open structures.
		while (opens.length > 0) {
			repaired += opens.pop();
		}

		try {
			return JSON.parse(repaired);
		} catch {
			return undefined;
		}
	}
}
