import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AnthropicAdapter } from "../src/adapters/anthropic.js";
import { AuthenticationError, RateLimitError, ServerError } from "../src/errors.js";
import type { Request, StreamEvent } from "../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTextRequest(overrides: Partial<Request> = {}): Request {
	return {
		model: "claude-sonnet-4-20250514",
		messages: [
			{
				role: "user",
				content: [{ kind: "text", text: "Hello" }],
			},
		],
		...overrides,
	};
}

function anthropicTextResponse(text: string) {
	return {
		id: "msg_01XFDUDYJgAACzvnptvVoYEL",
		type: "message",
		role: "assistant",
		content: [{ type: "text", text }],
		model: "claude-sonnet-4-20250514",
		stop_reason: "end_turn",
		usage: { input_tokens: 10, output_tokens: 25 },
	};
}

function anthropicToolUseResponse() {
	return {
		id: "msg_tool_01",
		type: "message",
		role: "assistant",
		content: [
			{
				type: "tool_use",
				id: "toolu_01A",
				name: "get_weather",
				input: { location: "San Francisco", unit: "celsius" },
			},
		],
		model: "claude-sonnet-4-20250514",
		stop_reason: "tool_use",
		usage: { input_tokens: 50, output_tokens: 40 },
	};
}

function mockFetchOk(body: unknown, headers: Record<string, string> = {}) {
	return vi.fn().mockResolvedValue(
		new Response(JSON.stringify(body), {
			status: 200,
			headers: { "content-type": "application/json", ...headers },
		}),
	);
}

function mockFetchError(status: number, body: unknown = {}) {
	return vi.fn().mockResolvedValue(
		new Response(JSON.stringify(body), {
			status,
			headers: { "content-type": "application/json" },
		}),
	);
}

/**
 * Build a ReadableStream from SSE-formatted text. Each element of `events`
 * should be a fully-formed SSE block (including trailing blank line).
 */
function sseStream(events: string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	const raw = events.join("");
	return new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(encoder.encode(raw));
			controller.close();
		},
	});
}

function mockFetchSSE(events: string[]) {
	return vi.fn().mockResolvedValue(
		new Response(sseStream(events), {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		}),
	);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AnthropicAdapter", () => {
	let adapter: AnthropicAdapter;

	beforeEach(() => {
		adapter = new AnthropicAdapter({
			api_key: "test-key-123",
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	// ---- Simple text completion -------------------------------------------

	describe("complete() — simple text", () => {
		it("returns a well-formed response for a basic text completion", async () => {
			const fetchMock = mockFetchOk(anthropicTextResponse("Hello there!"));
			vi.stubGlobal("fetch", fetchMock);

			const response = await adapter.complete(makeTextRequest());

			expect(response.id).toBe("msg_01XFDUDYJgAACzvnptvVoYEL");
			expect(response.model).toBe("claude-sonnet-4-20250514");
			expect(response.provider).toBe("anthropic");
			expect(response.message.role).toBe("assistant");
			expect(response.message.content).toHaveLength(1);
			expect(response.message.content[0]?.kind).toBe("text");
			expect(response.message.content[0]?.text).toBe("Hello there!");
			expect(response.finish_reason.reason).toBe("stop");
			expect(response.finish_reason.raw).toBe("end_turn");
			expect(response.usage.input_tokens).toBe(10);
			expect(response.usage.output_tokens).toBe(25);
			expect(response.usage.total_tokens).toBe(35);
		});

		it("sends the request to /v1/messages with correct headers", async () => {
			const fetchMock = mockFetchOk(anthropicTextResponse("Hi"));
			vi.stubGlobal("fetch", fetchMock);

			await adapter.complete(makeTextRequest());

			expect(fetchMock).toHaveBeenCalledTimes(1);
			const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
			expect(url).toBe("https://api.anthropic.com/v1/messages");
			const headers = init.headers as Record<string, string>;
			expect(headers["x-api-key"]).toBe("test-key-123");
			expect(headers["anthropic-version"]).toBe("2023-06-01");
		});
	});

	// ---- max_tokens defaults to 4096 --------------------------------------

	describe("max_tokens default", () => {
		it("defaults max_tokens to 4096 when not specified", async () => {
			const fetchMock = mockFetchOk(anthropicTextResponse("OK"));
			vi.stubGlobal("fetch", fetchMock);

			await adapter.complete(makeTextRequest());

			const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
			const body = JSON.parse(init.body as string) as Record<string, unknown>;
			expect(body.max_tokens).toBe(4096);
		});

		it("uses the user-supplied max_tokens when provided", async () => {
			const fetchMock = mockFetchOk(anthropicTextResponse("OK"));
			vi.stubGlobal("fetch", fetchMock);

			await adapter.complete(makeTextRequest({ max_tokens: 1024 }));

			const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
			const body = JSON.parse(init.body as string) as Record<string, unknown>;
			expect(body.max_tokens).toBe(1024);
		});
	});

	// ---- System message extraction ----------------------------------------

	describe("system message extraction", () => {
		it("extracts system messages into the system field", async () => {
			const fetchMock = mockFetchOk(anthropicTextResponse("OK"));
			vi.stubGlobal("fetch", fetchMock);

			const request = makeTextRequest({
				messages: [
					{
						role: "system",
						content: [{ kind: "text", text: "You are a helpful assistant." }],
					},
					{
						role: "user",
						content: [{ kind: "text", text: "Hi" }],
					},
				],
			});

			await adapter.complete(request);

			const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
			const body = JSON.parse(init.body as string) as Record<string, unknown>;
			const system = body.system as Array<{ type: string; text: string }>;
			expect(system).toHaveLength(1);
			expect(system[0]?.text).toBe("You are a helpful assistant.");

			// System messages should not appear in the messages array
			const messages = body.messages as Array<{ role: string }>;
			expect(messages.every((m) => m.role !== "system")).toBe(true);
		});

		it("extracts developer role messages as system messages", async () => {
			const fetchMock = mockFetchOk(anthropicTextResponse("OK"));
			vi.stubGlobal("fetch", fetchMock);

			const request = makeTextRequest({
				messages: [
					{
						role: "developer",
						content: [{ kind: "text", text: "Be concise." }],
					},
					{
						role: "user",
						content: [{ kind: "text", text: "Hi" }],
					},
				],
			});

			await adapter.complete(request);

			const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
			const body = JSON.parse(init.body as string) as Record<string, unknown>;
			const system = body.system as Array<{ type: string; text: string }>;
			expect(system).toHaveLength(1);
			expect(system[0]?.text).toBe("Be concise.");
		});
	});

	// ---- Tool use ---------------------------------------------------------

	describe("tool use", () => {
		it("sends tool definitions and parses tool call from response", async () => {
			const fetchMock = mockFetchOk(anthropicToolUseResponse());
			vi.stubGlobal("fetch", fetchMock);

			const request = makeTextRequest({
				tools: [
					{
						name: "get_weather",
						description: "Get current weather",
						parameters: {
							type: "object",
							properties: {
								location: { type: "string" },
								unit: { type: "string", enum: ["celsius", "fahrenheit"] },
							},
							required: ["location"],
						},
					},
				],
			});

			const response = await adapter.complete(request);

			// Verify tool definitions were sent in the request body
			const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
			const body = JSON.parse(init.body as string) as Record<string, unknown>;
			const tools = body.tools as Array<{
				name: string;
				description: string;
				input_schema: unknown;
			}>;
			expect(tools).toHaveLength(1);
			expect(tools[0]?.name).toBe("get_weather");
			expect(tools[0]?.description).toBe("Get current weather");
			expect(tools[0]?.input_schema).toBeDefined();

			// Verify the response parsed the tool call
			expect(response.finish_reason.reason).toBe("tool_calls");
			expect(response.message.content).toHaveLength(1);
			const toolCallPart = response.message.content[0]!;
			expect(toolCallPart.kind).toBe("tool_call");
			expect(toolCallPart.tool_call?.id).toBe("toolu_01A");
			expect(toolCallPart.tool_call?.name).toBe("get_weather");
			expect(toolCallPart.tool_call?.arguments).toEqual({
				location: "San Francisco",
				unit: "celsius",
			});
		});
	});

	// ---- Consecutive same-role message merging ----------------------------

	describe("consecutive same-role message merging", () => {
		it("merges consecutive user messages into a single Anthropic message", async () => {
			const fetchMock = mockFetchOk(anthropicTextResponse("OK"));
			vi.stubGlobal("fetch", fetchMock);

			const request = makeTextRequest({
				messages: [
					{
						role: "user",
						content: [{ kind: "text", text: "First message" }],
					},
					{
						role: "user",
						content: [{ kind: "text", text: "Second message" }],
					},
				],
			});

			await adapter.complete(request);

			const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
			const body = JSON.parse(init.body as string) as Record<string, unknown>;
			const messages = body.messages as Array<{
				role: string;
				content: Array<{ type: string; text: string }>;
			}>;

			// The two user messages should be merged into one
			expect(messages).toHaveLength(1);
			expect(messages[0]?.role).toBe("user");
			expect(messages[0]?.content).toHaveLength(2);
			expect(messages[0]?.content[0]?.text).toBe("First message");
			expect(messages[0]?.content[1]?.text).toBe("Second message");
		});

		it("merges consecutive tool messages (as user role) with actual user messages", async () => {
			const fetchMock = mockFetchOk(anthropicTextResponse("OK"));
			vi.stubGlobal("fetch", fetchMock);

			const request = makeTextRequest({
				messages: [
					{
						role: "user",
						content: [{ kind: "text", text: "Use that tool" }],
					},
					{
						role: "assistant",
						content: [
							{
								kind: "tool_call",
								tool_call: {
									id: "toolu_01",
									name: "get_weather",
									arguments: { location: "SF" },
								},
							},
						],
					},
					{
						role: "tool",
						content: [
							{
								kind: "tool_result",
								tool_result: {
									tool_call_id: "toolu_01",
									content: "72F and sunny",
									is_error: false,
								},
							},
						],
					},
					{
						role: "user",
						content: [{ kind: "text", text: "Thanks!" }],
					},
				],
			});

			await adapter.complete(request);

			const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
			const body = JSON.parse(init.body as string) as Record<string, unknown>;
			const messages = body.messages as Array<{
				role: string;
				content: Array<Record<string, unknown>>;
			}>;

			// tool → user, so "tool" + following "user" get merged into one user message
			expect(messages).toHaveLength(3);
			expect(messages[0]?.role).toBe("user");
			expect(messages[1]?.role).toBe("assistant");
			// tool result (user) + next user message merged
			expect(messages[2]?.role).toBe("user");
			expect(messages[2]?.content).toHaveLength(2);
		});
	});

	// ---- Streaming --------------------------------------------------------

	describe("stream()", () => {
		it("yields STREAM_START, TEXT_START, TEXT_DELTA, TEXT_END, and FINISH events", async () => {
			const sseEvents = [
				`event: message_start\ndata: ${JSON.stringify({
					type: "message_start",
					message: {
						id: "msg_stream_01",
						type: "message",
						role: "assistant",
						content: [],
						model: "claude-sonnet-4-20250514",
						usage: { input_tokens: 10, output_tokens: 0 },
					},
				})}\n\n`,
				`event: content_block_start\ndata: ${JSON.stringify({
					type: "content_block_start",
					index: 0,
					content_block: { type: "text", text: "" },
				})}\n\n`,
				`event: content_block_delta\ndata: ${JSON.stringify({
					type: "content_block_delta",
					index: 0,
					delta: { type: "text_delta", text: "Hello " },
				})}\n\n`,
				`event: content_block_delta\ndata: ${JSON.stringify({
					type: "content_block_delta",
					index: 0,
					delta: { type: "text_delta", text: "world!" },
				})}\n\n`,
				`event: content_block_stop\ndata: ${JSON.stringify({
					type: "content_block_stop",
					index: 0,
				})}\n\n`,
				`event: message_delta\ndata: ${JSON.stringify({
					type: "message_delta",
					delta: { stop_reason: "end_turn" },
					usage: { output_tokens: 5 },
				})}\n\n`,
				`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
			];

			const fetchMock = mockFetchSSE(sseEvents);
			vi.stubGlobal("fetch", fetchMock);

			const events: StreamEvent[] = [];
			for await (const event of adapter.stream(makeTextRequest())) {
				events.push(event);
			}

			const types = events.map((e) => e.type);
			expect(types).toContain("STREAM_START");
			expect(types).toContain("TEXT_START");
			expect(types).toContain("TEXT_DELTA");
			expect(types).toContain("TEXT_END");
			expect(types).toContain("FINISH");

			// Verify text deltas
			const textDeltas = events.filter((e) => e.type === "TEXT_DELTA");
			expect(textDeltas).toHaveLength(2);
			expect(textDeltas[0]?.delta).toBe("Hello ");
			expect(textDeltas[1]?.delta).toBe("world!");

			// Verify FINISH event has accumulated content
			const finishEvent = events.find((e) => e.type === "FINISH")!;
			expect(finishEvent.finish_reason?.reason).toBe("stop");
			expect(finishEvent.response?.message.content).toHaveLength(1);
			expect(finishEvent.response?.message.content[0]?.kind).toBe("text");
			expect(finishEvent.response?.message.content[0]?.text).toBe("Hello world!");
		});
	});

	// ---- Error mapping ----------------------------------------------------

	describe("error mapping", () => {
		it("maps 401 to AuthenticationError", async () => {
			const fetchMock = mockFetchError(401, {
				error: { type: "authentication_error", message: "Invalid API key" },
			});
			vi.stubGlobal("fetch", fetchMock);

			await expect(adapter.complete(makeTextRequest())).rejects.toThrow(AuthenticationError);
		});

		it("maps 429 to RateLimitError", async () => {
			const fetchMock = mockFetchError(429, {
				error: { type: "rate_limit_error", message: "Rate limit exceeded" },
			});
			vi.stubGlobal("fetch", fetchMock);

			await expect(adapter.complete(makeTextRequest())).rejects.toThrow(RateLimitError);
		});

		it("maps 500 to ServerError", async () => {
			const fetchMock = mockFetchError(500, {
				error: { type: "api_error", message: "Internal server error" },
			});
			vi.stubGlobal("fetch", fetchMock);

			await expect(adapter.complete(makeTextRequest())).rejects.toThrow(ServerError);
		});

		it("maps 529 (overloaded) to ServerError", async () => {
			const fetchMock = mockFetchError(529, {
				error: { type: "overloaded_error", message: "API is overloaded" },
			});
			vi.stubGlobal("fetch", fetchMock);

			await expect(adapter.complete(makeTextRequest())).rejects.toThrow(ServerError);
		});
	});

	// ---- Model pass-through ------------------------------------------------

	describe("model pass-through", () => {
		it("sends any arbitrary model string directly to the API body", async () => {
			const fetchMock = mockFetchOk(anthropicTextResponse("hi"));
			vi.stubGlobal("fetch", fetchMock);

			await adapter.complete(makeTextRequest({ model: "claude-some-future-model-v99" }));

			const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
			const body = JSON.parse(init.body as string);
			expect(body.model).toBe("claude-some-future-model-v99");
		});

		it("exposes default_model from config", () => {
			expect(adapter.default_model).toBe("claude-sonnet-4-5-20250929");

			const custom = new AnthropicAdapter({
				api_key: "key",
				default_model: "claude-custom-latest",
			});
			expect(custom.default_model).toBe("claude-custom-latest");
		});
	});
});
