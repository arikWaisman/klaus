import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { Client } from "../src/client.js";
import { AbortError, NoObjectGeneratedError } from "../src/errors.js";
import { stream, generate, generate_object } from "../src/generate.js";
import type { Request, Response, StreamEvent, Tool } from "../src/types.js";

// ---------------------------------------------------------------------------
// Helpers — mock adapter & response builders
// ---------------------------------------------------------------------------

function makeResponse(
	text: string,
	opts?: {
		tool_calls?: Response["message"]["content"];
		usage?: Response["usage"];
		finish_reason?: Response["finish_reason"];
	},
): Response {
	const content: Response["message"]["content"] = [];

	if (text) {
		content.push({ kind: "text", text });
	}

	if (opts?.tool_calls) {
		content.push(...opts.tool_calls);
	}

	return {
		id: "resp-1",
		model: "mock-model",
		provider: "mock",
		message: { role: "assistant", content },
		finish_reason: opts?.finish_reason ?? { reason: "stop" },
		usage: opts?.usage ?? {
			input_tokens: 10,
			output_tokens: 20,
			total_tokens: 30,
		},
		warnings: [],
	};
}

function makeToolCallContent(
	id: string,
	name: string,
	args: Record<string, unknown>,
): Response["message"]["content"][number] {
	return {
		kind: "tool_call",
		tool_call: { id, name, arguments: args },
	};
}

interface MockAdapterOptions {
	complete?: (request: Request) => Promise<Response>;
	stream?: (request: Request) => AsyncIterableIterator<StreamEvent>;
}

function createMockClient(opts: MockAdapterOptions): Client {
	const mockAdapter = {
		name: "mock",
		complete: opts.complete ?? (async () => makeResponse("default")),
		stream: opts.stream ?? async function* () {},
	};
	return new Client({
		adapters: { mock: mockAdapter },
		default_provider: "mock",
	});
}

// ---------------------------------------------------------------------------
// generate() — basic behavior
// ---------------------------------------------------------------------------

describe("generate() — basic", () => {
	it("normalizes a string prompt into a user message", async () => {
		let capturedRequest: Request | undefined;
		const client = createMockClient({
			complete: async (req) => {
				capturedRequest = req;
				return makeResponse("Hi there!");
			},
		});

		await generate({
			client,
			model: "mock-model",
			prompt: "Hello",
			retry_policy: {
				max_retries: 0,
				base_delay: 0,
				max_delay: 0,
				backoff_multiplier: 1,
				jitter: false,
			},
		});

		expect(capturedRequest).toBeDefined();
		const messages = capturedRequest?.messages;
		expect(messages).toHaveLength(1);
		expect(messages[0].role).toBe("user");
		expect(messages[0].content).toEqual([{ kind: "text", text: "Hello" }]);
	});

	it("returns text from a simple completion", async () => {
		const client = createMockClient({
			complete: async () => makeResponse("Hello world!"),
		});

		const result = await generate({
			client,
			model: "mock-model",
			prompt: "Hi",
			retry_policy: {
				max_retries: 0,
				base_delay: 0,
				max_delay: 0,
				backoff_multiplier: 1,
				jitter: false,
			},
		});

		expect(result.text).toBe("Hello world!");
		expect(result.finish_reason.reason).toBe("stop");
		expect(result.steps).toHaveLength(1);
	});

	it("includes system message when provided", async () => {
		let capturedRequest: Request | undefined;
		const client = createMockClient({
			complete: async (req) => {
				capturedRequest = req;
				return makeResponse("ok");
			},
		});

		await generate({
			client,
			model: "mock-model",
			system: "You are helpful",
			prompt: "Hello",
			retry_policy: {
				max_retries: 0,
				base_delay: 0,
				max_delay: 0,
				backoff_multiplier: 1,
				jitter: false,
			},
		});

		expect(capturedRequest?.messages).toHaveLength(2);
		expect(capturedRequest?.messages[0].role).toBe("system");
		expect(capturedRequest?.messages[0].content[0].text).toBe("You are helpful");
		expect(capturedRequest?.messages[1].role).toBe("user");
	});
});

// ---------------------------------------------------------------------------
// generate() — tool execution loop
// ---------------------------------------------------------------------------

describe("generate() — tool execution", () => {
	it("executes tool calls and loops back to the model with results", async () => {
		let callCount = 0;
		const client = createMockClient({
			complete: async () => {
				callCount++;
				if (callCount === 1) {
					// First call: model returns a tool call
					return makeResponse("", {
						tool_calls: [makeToolCallContent("tc-1", "get_weather", { city: "Paris" })],
						finish_reason: { reason: "tool_calls" },
					});
				}
				// Second call: model returns final text
				return makeResponse("The weather in Paris is sunny.");
			},
		});

		const weatherTool: Tool = {
			name: "get_weather",
			description: "Get weather for a city",
			parameters: { type: "object", properties: { city: { type: "string" } } },
			execute: async (args) => `Sunny in ${(args as { city: string }).city}`,
		};

		const result = await generate({
			client,
			model: "mock-model",
			prompt: "What's the weather in Paris?",
			tools: [weatherTool],
			max_tool_rounds: 1,
			retry_policy: {
				max_retries: 0,
				base_delay: 0,
				max_delay: 0,
				backoff_multiplier: 1,
				jitter: false,
			},
		});

		expect(callCount).toBe(2);
		expect(result.text).toBe("The weather in Paris is sunny.");
		expect(result.steps).toHaveLength(2);
		// First step should have tool_calls and tool_results
		expect(result.steps[0].tool_calls).toHaveLength(1);
		expect(result.steps[0].tool_results).toHaveLength(1);
		expect(result.steps[0].tool_results[0].content).toBe("Sunny in Paris");
		expect(result.steps[0].tool_results[0].is_error).toBe(false);
	});

	it("runs tool calls concurrently via Promise.allSettled", async () => {
		const executionOrder: string[] = [];
		let callCount = 0;

		const client = createMockClient({
			complete: async () => {
				callCount++;
				if (callCount === 1) {
					return makeResponse("", {
						tool_calls: [
							makeToolCallContent("tc-1", "tool_a", {}),
							makeToolCallContent("tc-2", "tool_b", {}),
						],
						finish_reason: { reason: "tool_calls" },
					});
				}
				return makeResponse("done");
			},
		});

		const toolA: Tool = {
			name: "tool_a",
			description: "Tool A",
			parameters: {},
			execute: async () => {
				executionOrder.push("a-start");
				// Small delay to test concurrency
				await new Promise((r) => setTimeout(r, 10));
				executionOrder.push("a-end");
				return "result-a";
			},
		};

		const toolB: Tool = {
			name: "tool_b",
			description: "Tool B",
			parameters: {},
			execute: async () => {
				executionOrder.push("b-start");
				executionOrder.push("b-end");
				return "result-b";
			},
		};

		const result = await generate({
			client,
			model: "mock-model",
			prompt: "run both",
			tools: [toolA, toolB],
			max_tool_rounds: 1,
			retry_policy: {
				max_retries: 0,
				base_delay: 0,
				max_delay: 0,
				backoff_multiplier: 1,
				jitter: false,
			},
		});

		// Both tools should have started before either's delay resolved
		// (b should start before a ends since they run concurrently)
		expect(executionOrder.indexOf("a-start")).toBeLessThan(executionOrder.indexOf("a-end"));
		expect(executionOrder.indexOf("b-start")).toBeLessThan(executionOrder.indexOf("b-end"));
		// b should start before a ends (concurrent)
		expect(executionOrder.indexOf("b-start")).toBeLessThan(executionOrder.indexOf("a-end"));

		expect(result.steps[0].tool_results).toHaveLength(2);
	});

	it("returns ToolResult with is_error: true when a tool execution fails", async () => {
		let callCount = 0;
		const client = createMockClient({
			complete: async () => {
				callCount++;
				if (callCount === 1) {
					return makeResponse("", {
						tool_calls: [makeToolCallContent("tc-1", "failing_tool", {})],
						finish_reason: { reason: "tool_calls" },
					});
				}
				return makeResponse("handled error");
			},
		});

		const failingTool: Tool = {
			name: "failing_tool",
			description: "A tool that always fails",
			parameters: {},
			execute: async () => {
				throw new Error("Tool execution failed");
			},
		};

		const result = await generate({
			client,
			model: "mock-model",
			prompt: "run failing tool",
			tools: [failingTool],
			max_tool_rounds: 1,
			retry_policy: {
				max_retries: 0,
				base_delay: 0,
				max_delay: 0,
				backoff_multiplier: 1,
				jitter: false,
			},
		});

		expect(result.steps[0].tool_results).toHaveLength(1);
		expect(result.steps[0].tool_results[0].is_error).toBe(true);
		expect(result.steps[0].tool_results[0].content).toBe("Tool execution failed");
	});

	it("returns is_error: true when tool is not found", async () => {
		let callCount = 0;
		const client = createMockClient({
			complete: async () => {
				callCount++;
				if (callCount === 1) {
					return makeResponse("", {
						tool_calls: [makeToolCallContent("tc-1", "nonexistent_tool", {})],
						finish_reason: { reason: "tool_calls" },
					});
				}
				return makeResponse("ok");
			},
		});

		const someTool: Tool = {
			name: "some_other_tool",
			description: "Not the one being called",
			parameters: {},
			execute: async () => "result",
		};

		const result = await generate({
			client,
			model: "mock-model",
			prompt: "run unknown tool",
			tools: [someTool],
			max_tool_rounds: 1,
			retry_policy: {
				max_retries: 0,
				base_delay: 0,
				max_delay: 0,
				backoff_multiplier: 1,
				jitter: false,
			},
		});

		expect(result.steps[0].tool_results[0].is_error).toBe(true);
		expect(result.steps[0].tool_results[0].content).toContain("nonexistent_tool");
		expect(result.steps[0].tool_results[0].content).toContain("not found");
	});

	it("max_tool_rounds limits tool execution iterations", async () => {
		let callCount = 0;
		const client = createMockClient({
			complete: async () => {
				callCount++;
				// Always return a tool call to force looping
				return makeResponse("", {
					tool_calls: [makeToolCallContent(`tc-${callCount}`, "loop_tool", {})],
					finish_reason: { reason: "tool_calls" },
				});
			},
		});

		const loopTool: Tool = {
			name: "loop_tool",
			description: "A tool that always gets called",
			parameters: {},
			execute: async () => "loop result",
		};

		const result = await generate({
			client,
			model: "mock-model",
			prompt: "loop",
			tools: [loopTool],
			max_tool_rounds: 2,
			retry_policy: {
				max_retries: 0,
				base_delay: 0,
				max_delay: 0,
				backoff_multiplier: 1,
				jitter: false,
			},
		});

		// max_tool_rounds=2 means up to 2 rounds of tool execution, plus the final call
		// round 0: tool call -> execute -> loop
		// round 1: tool call -> execute -> loop
		// round 2: tool call -> NOT executed (round < maxRounds check fails), returns
		expect(callCount).toBe(3);
		expect(result.steps).toHaveLength(3);
		// Last step should not have tool_results since tools were not executed
		expect(result.steps[2].tool_results).toHaveLength(0);
	});

	it("accumulates steps and total_usage across rounds", async () => {
		let callCount = 0;
		const client = createMockClient({
			complete: async () => {
				callCount++;
				if (callCount === 1) {
					return makeResponse("", {
						tool_calls: [makeToolCallContent("tc-1", "my_tool", {})],
						finish_reason: { reason: "tool_calls" },
						usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
					});
				}
				return makeResponse("final", {
					usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 },
				});
			},
		});

		const myTool: Tool = {
			name: "my_tool",
			description: "Tool",
			parameters: {},
			execute: async () => "result",
		};

		const result = await generate({
			client,
			model: "mock-model",
			prompt: "test",
			tools: [myTool],
			max_tool_rounds: 1,
			retry_policy: {
				max_retries: 0,
				base_delay: 0,
				max_delay: 0,
				backoff_multiplier: 1,
				jitter: false,
			},
		});

		expect(result.steps).toHaveLength(2);
		// total_usage should be the sum of both rounds
		expect(result.total_usage.input_tokens).toBe(30);
		expect(result.total_usage.output_tokens).toBe(15);
		expect(result.total_usage.total_tokens).toBe(45);
		// usage should be the last response's usage
		expect(result.usage.input_tokens).toBe(20);
		expect(result.usage.output_tokens).toBe(10);
	});
});

// ---------------------------------------------------------------------------
// generate() — abort signal
// ---------------------------------------------------------------------------

describe("generate() — abort signal", () => {
	it("throws AbortError when signal is already aborted", async () => {
		const client = createMockClient({
			complete: async () => makeResponse("should not reach"),
		});

		const controller = new AbortController();
		controller.abort();

		await expect(
			generate({
				client,
				model: "mock-model",
				prompt: "test",
				abort_signal: controller.signal,
				retry_policy: {
					max_retries: 0,
					base_delay: 0,
					max_delay: 0,
					backoff_multiplier: 1,
					jitter: false,
				},
			}),
		).rejects.toThrow(AbortError);
	});
});

// ---------------------------------------------------------------------------
// generate_object() — structured output
// ---------------------------------------------------------------------------

describe("generate_object() — OpenAI (json_schema mode)", () => {
	it("validates output against a Zod schema", async () => {
		const schema = z.object({
			name: z.string(),
			age: z.number(),
		});

		const client = createMockClient({
			complete: async () => makeResponse('{"name":"Alice","age":30}'),
		});

		const result = await generate_object({
			client,
			model: "gpt-4",
			provider: "mock",
			prompt: "Extract the person",
			schema,
			retry_policy: {
				max_retries: 0,
				base_delay: 0,
				max_delay: 0,
				backoff_multiplier: 1,
				jitter: false,
			},
		});

		expect(result.output).toEqual({ name: "Alice", age: 30 });
	});

	it("throws NoObjectGeneratedError on invalid JSON output", async () => {
		const schema = z.object({ name: z.string() });

		const client = createMockClient({
			complete: async () => makeResponse("this is not json"),
		});

		await expect(
			generate_object({
				client,
				model: "gpt-4",
				provider: "mock",
				prompt: "Extract",
				schema,
				retry_policy: {
					max_retries: 0,
					base_delay: 0,
					max_delay: 0,
					backoff_multiplier: 1,
					jitter: false,
				},
			}),
		).rejects.toThrow(NoObjectGeneratedError);
	});

	it("throws NoObjectGeneratedError when schema validation fails", async () => {
		const schema = z.object({
			name: z.string(),
			age: z.number(),
		});

		const client = createMockClient({
			// Missing required 'age' field
			complete: async () => makeResponse('{"name":"Alice"}'),
		});

		await expect(
			generate_object({
				client,
				model: "gpt-4",
				provider: "mock",
				prompt: "Extract",
				schema,
				retry_policy: {
					max_retries: 0,
					base_delay: 0,
					max_delay: 0,
					backoff_multiplier: 1,
					jitter: false,
				},
			}),
		).rejects.toThrow(NoObjectGeneratedError);
	});
});

describe("generate_object() — Anthropic (tool-based extraction)", () => {
	function createAnthropicMockClient(complete: (request: Request) => Promise<Response>): Client {
		const mockAdapter = {
			name: "anthropic",
			complete,
			stream: async function* () {} as () => AsyncIterableIterator<StreamEvent>,
		};
		return new Client({
			adapters: { anthropic: mockAdapter },
			default_provider: "anthropic",
		});
	}

	it("uses tool-based extraction for Anthropic provider", async () => {
		const schema = z.object({
			name: z.string(),
			age: z.number(),
		});

		let capturedRequest: Request | undefined;
		const client = createAnthropicMockClient(async (req) => {
			capturedRequest = req;
			// Anthropic mode: return a tool call with the extraction result
			return makeResponse("", {
				tool_calls: [
					makeToolCallContent("tc-1", "extract", {
						name: "Bob",
						age: 25,
					}),
				],
				finish_reason: { reason: "tool_calls" },
			});
		});

		const result = await generate_object({
			client,
			model: "claude-3-sonnet",
			provider: "anthropic",
			prompt: "Extract the person",
			schema,
			retry_policy: {
				max_retries: 0,
				base_delay: 0,
				max_delay: 0,
				backoff_multiplier: 1,
				jitter: false,
			},
		});

		// Should have added a tool named "extract"
		expect(capturedRequest?.tools).toBeDefined();
		const extractTool = capturedRequest?.tools?.find((t) => t.name === "extract");
		expect(extractTool).toBeDefined();

		// Should have set tool_choice to force the extract tool
		expect(capturedRequest?.tool_choice).toEqual({
			mode: "named",
			tool_name: "extract",
		});

		expect(result.output).toEqual({ name: "Bob", age: 25 });
	});

	it("throws NoObjectGeneratedError when extraction tool call is missing", async () => {
		const schema = z.object({ name: z.string() });

		const client = createAnthropicMockClient(async () => makeResponse("I cannot extract that"));

		await expect(
			generate_object({
				client,
				model: "claude-3-sonnet",
				provider: "anthropic",
				prompt: "Extract",
				schema,
				retry_policy: {
					max_retries: 0,
					base_delay: 0,
					max_delay: 0,
					backoff_multiplier: 1,
					jitter: false,
				},
			}),
		).rejects.toThrow(NoObjectGeneratedError);
	});

	it("uses custom schema_name for the extraction tool", async () => {
		const schema = z.object({ city: z.string() });

		let capturedRequest: Request | undefined;
		const client = createAnthropicMockClient(async (req) => {
			capturedRequest = req;
			return makeResponse("", {
				tool_calls: [makeToolCallContent("tc-1", "get_location", { city: "NYC" })],
				finish_reason: { reason: "tool_calls" },
			});
		});

		const result = await generate_object({
			client,
			model: "claude-3-sonnet",
			provider: "anthropic",
			prompt: "Where?",
			schema,
			schema_name: "get_location",
			retry_policy: {
				max_retries: 0,
				base_delay: 0,
				max_delay: 0,
				backoff_multiplier: 1,
				jitter: false,
			},
		});

		expect(capturedRequest?.tools?.find((t) => t.name === "get_location")).toBeDefined();
		expect(result.output).toEqual({ city: "NYC" });
	});
});

// ---------------------------------------------------------------------------
// stream() — streaming with convenience wrappers
// ---------------------------------------------------------------------------

describe("stream()", () => {
	it("returns a StreamResult with text_stream convenience", async () => {
		const client = createMockClient({
			stream: async function* () {
				yield { type: "STREAM_START" } as StreamEvent;
				yield { type: "TEXT_DELTA", delta: "Hello" } as StreamEvent;
				yield { type: "TEXT_DELTA", delta: " " } as StreamEvent;
				yield { type: "TEXT_DELTA", delta: "world" } as StreamEvent;
				yield {
					type: "FINISH",
					finish_reason: { reason: "stop" },
					usage: { input_tokens: 5, output_tokens: 10, total_tokens: 15 },
				} as StreamEvent;
			},
		});

		const result = stream({
			client,
			model: "mock-model",
			prompt: "Hi",
			retry_policy: {
				max_retries: 0,
				base_delay: 0,
				max_delay: 0,
				backoff_multiplier: 1,
				jitter: false,
			},
		});

		// Collect text from text_stream
		const textChunks: string[] = [];
		for await (const chunk of result.text_stream) {
			textChunks.push(chunk);
		}

		expect(textChunks).toEqual(["Hello", " ", "world"]);
	});

	it("returns an async iterable of StreamEvents", async () => {
		const client = createMockClient({
			stream: async function* () {
				yield { type: "STREAM_START" } as StreamEvent;
				yield { type: "TEXT_DELTA", delta: "hi" } as StreamEvent;
				yield {
					type: "FINISH",
					finish_reason: { reason: "stop" },
					usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
				} as StreamEvent;
			},
		});

		const result = stream({
			client,
			model: "mock-model",
			prompt: "test",
			retry_policy: {
				max_retries: 0,
				base_delay: 0,
				max_delay: 0,
				backoff_multiplier: 1,
				jitter: false,
			},
		});

		const events: StreamEvent[] = [];
		for await (const event of result) {
			events.push(event);
		}

		expect(events).toHaveLength(3);
		expect(events[0].type).toBe("STREAM_START");
		expect(events[1].type).toBe("TEXT_DELTA");
		expect(events[1].delta).toBe("hi");
		expect(events[2].type).toBe("FINISH");
	});

	it("response() returns the accumulated Response", async () => {
		const finishResponse: Response = {
			id: "resp-stream",
			model: "mock-model",
			provider: "mock",
			message: {
				role: "assistant",
				content: [{ kind: "text", text: "streamed text" }],
			},
			finish_reason: { reason: "stop" },
			usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
			warnings: [],
		};

		const client = createMockClient({
			stream: async function* () {
				yield { type: "STREAM_START" } as StreamEvent;
				yield { type: "TEXT_DELTA", delta: "streamed text" } as StreamEvent;
				yield {
					type: "FINISH",
					finish_reason: { reason: "stop" },
					usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
					response: finishResponse,
				} as StreamEvent;
			},
		});

		const result = stream({
			client,
			model: "mock-model",
			prompt: "test",
			retry_policy: {
				max_retries: 0,
				base_delay: 0,
				max_delay: 0,
				backoff_multiplier: 1,
				jitter: false,
			},
		});

		const response = await result.response();
		expect(response.id).toBe("resp-stream");
		expect(response.finish_reason.reason).toBe("stop");
		expect(response.usage.input_tokens).toBe(10);
	});

	it("text_stream only yields text deltas, ignoring other events", async () => {
		const client = createMockClient({
			stream: async function* () {
				yield { type: "STREAM_START" } as StreamEvent;
				yield { type: "REASONING_DELTA", reasoning_delta: "thinking..." } as StreamEvent;
				yield { type: "TEXT_DELTA", delta: "only this" } as StreamEvent;
				yield {
					type: "TOOL_CALL_START",
					tool_call: { id: "tc-1", name: "fn" },
				} as StreamEvent;
				yield {
					type: "FINISH",
					finish_reason: { reason: "stop" },
				} as StreamEvent;
			},
		});

		const result = stream({
			client,
			model: "mock-model",
			prompt: "test",
			retry_policy: {
				max_retries: 0,
				base_delay: 0,
				max_delay: 0,
				backoff_multiplier: 1,
				jitter: false,
			},
		});

		const textChunks: string[] = [];
		for await (const chunk of result.text_stream) {
			textChunks.push(chunk);
		}

		expect(textChunks).toEqual(["only this"]);
	});
});

// ---------------------------------------------------------------------------
// generate() — tools without execute handlers
// ---------------------------------------------------------------------------

describe("generate() — tools without execute handlers", () => {
	it("does not attempt to execute tools that lack execute handlers", async () => {
		const client = createMockClient({
			complete: async () =>
				makeResponse("", {
					tool_calls: [makeToolCallContent("tc-1", "readonly_tool", { q: "test" })],
					finish_reason: { reason: "tool_calls" },
				}),
		});

		const readonlyTool: Tool = {
			name: "readonly_tool",
			description: "A tool with no execute handler",
			parameters: { type: "object" },
			// No execute property
		};

		const result = await generate({
			client,
			model: "mock-model",
			prompt: "test",
			tools: [readonlyTool],
			max_tool_rounds: 1,
			retry_policy: {
				max_retries: 0,
				base_delay: 0,
				max_delay: 0,
				backoff_multiplier: 1,
				jitter: false,
			},
		});

		// With no executable tools, the model is called once and returns
		expect(result.steps).toHaveLength(1);
		expect(result.tool_calls).toHaveLength(1);
		expect(result.tool_results).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// generate() — edge cases
// ---------------------------------------------------------------------------

describe("generate() — edge cases", () => {
	it("defaults max_tool_rounds to 1 when not specified", async () => {
		let callCount = 0;
		const client = createMockClient({
			complete: async () => {
				callCount++;
				if (callCount <= 2) {
					return makeResponse("", {
						tool_calls: [makeToolCallContent(`tc-${callCount}`, "tool", {})],
						finish_reason: { reason: "tool_calls" },
					});
				}
				return makeResponse("done");
			},
		});

		const tool: Tool = {
			name: "tool",
			description: "Tool",
			parameters: {},
			execute: async () => "ok",
		};

		const result = await generate({
			client,
			model: "mock-model",
			prompt: "test",
			tools: [tool],
			// max_tool_rounds not specified, defaults to 1
			retry_policy: {
				max_retries: 0,
				base_delay: 0,
				max_delay: 0,
				backoff_multiplier: 1,
				jitter: false,
			},
		});

		// Default max_tool_rounds is 1: round 0 executes tools, round 1 is the last (not executed)
		expect(callCount).toBe(2);
		expect(result.steps).toHaveLength(2);
	});

	it("handles messages option together with prompt", async () => {
		let capturedRequest: Request | undefined;
		const client = createMockClient({
			complete: async (req) => {
				capturedRequest = req;
				return makeResponse("ok");
			},
		});

		await generate({
			client,
			model: "mock-model",
			messages: [
				{ role: "user", content: [{ kind: "text", text: "First message" }] },
				{ role: "assistant", content: [{ kind: "text", text: "First reply" }] },
			],
			prompt: "Follow-up question",
			retry_policy: {
				max_retries: 0,
				base_delay: 0,
				max_delay: 0,
				backoff_multiplier: 1,
				jitter: false,
			},
		});

		const messages = capturedRequest?.messages;
		expect(messages).toHaveLength(3);
		expect(messages[0].role).toBe("user");
		expect(messages[0].content[0].text).toBe("First message");
		expect(messages[1].role).toBe("assistant");
		expect(messages[2].role).toBe("user");
		expect(messages[2].content[0].text).toBe("Follow-up question");
	});
});
