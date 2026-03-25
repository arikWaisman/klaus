import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenAIAdapter } from "../src/adapters/openai.js";
import {
	AuthenticationError,
	InvalidRequestError,
	RateLimitError,
	ServerError,
} from "../src/errors.js";
import type { Request, StreamEvent } from "../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTextRequest(overrides: Partial<Request> = {}): Request {
	return {
		model: "gpt-4o",
		messages: [
			{
				role: "user",
				content: [{ kind: "text", text: "Hello" }],
			},
		],
		...overrides,
	};
}

function openaiTextResponse(text: string) {
	return {
		id: "resp_abc123",
		output: [
			{
				type: "message",
				role: "assistant",
				content: [{ type: "output_text", text }],
			},
		],
		status: "completed",
		model: "gpt-4o-2025-05-13",
		usage: {
			input_tokens: 12,
			output_tokens: 20,
			total_tokens: 32,
		},
	};
}

function openaiToolCallResponse() {
	return {
		id: "resp_tool_01",
		output: [
			{
				type: "function_call",
				id: "fc_01",
				name: "get_weather",
				arguments: JSON.stringify({ location: "San Francisco" }),
				call_id: "call_abc123",
			},
		],
		status: "completed",
		model: "gpt-4o-2025-05-13",
		usage: {
			input_tokens: 30,
			output_tokens: 15,
			total_tokens: 45,
		},
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

describe("OpenAIAdapter", () => {
	let adapter: OpenAIAdapter;

	beforeEach(() => {
		adapter = new OpenAIAdapter({
			api_key: "sk-test-key-123",
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	// ---- Simple text completion -------------------------------------------

	describe("complete() — simple text", () => {
		it("returns a well-formed response for a basic text completion", async () => {
			const fetchMock = mockFetchOk(openaiTextResponse("Hello there!"));
			vi.stubGlobal("fetch", fetchMock);

			const response = await adapter.complete(makeTextRequest());

			expect(response.id).toBe("resp_abc123");
			expect(response.model).toBe("gpt-4o-2025-05-13");
			expect(response.provider).toBe("openai");
			expect(response.message.role).toBe("assistant");
			expect(response.message.content).toHaveLength(1);
			expect(response.message.content[0]?.kind).toBe("text");
			expect(response.message.content[0]?.text).toBe("Hello there!");
			expect(response.finish_reason.reason).toBe("stop");
			expect(response.finish_reason.raw).toBe("completed");
			expect(response.usage.input_tokens).toBe(12);
			expect(response.usage.output_tokens).toBe(20);
			expect(response.usage.total_tokens).toBe(32);
		});

		it("uses /v1/responses endpoint (not /v1/chat/completions)", async () => {
			const fetchMock = mockFetchOk(openaiTextResponse("Hi"));
			vi.stubGlobal("fetch", fetchMock);

			await adapter.complete(makeTextRequest());

			expect(fetchMock).toHaveBeenCalledTimes(1);
			const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
			expect(url).toBe("https://api.openai.com/v1/responses");
			expect(url).not.toContain("chat/completions");
		});

		it("sends Authorization Bearer header", async () => {
			const fetchMock = mockFetchOk(openaiTextResponse("Hi"));
			vi.stubGlobal("fetch", fetchMock);

			await adapter.complete(makeTextRequest());

			const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
			const headers = init.headers as Record<string, string>;
			expect(headers.Authorization).toBe("Bearer sk-test-key-123");
		});
	});

	// ---- System message extraction to instructions ------------------------

	describe("system message extraction", () => {
		it("extracts system messages into the instructions field", async () => {
			const fetchMock = mockFetchOk(openaiTextResponse("OK"));
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
			expect(body.instructions).toBe("You are a helpful assistant.");

			// System messages should not appear in the input array
			const input = body.input as Array<{ type: string; role?: string }>;
			expect(input.every((item) => item.role !== "system")).toBe(true);
		});

		it("joins multiple system messages with newline", async () => {
			const fetchMock = mockFetchOk(openaiTextResponse("OK"));
			vi.stubGlobal("fetch", fetchMock);

			const request = makeTextRequest({
				messages: [
					{
						role: "system",
						content: [{ kind: "text", text: "Be helpful." }],
					},
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
			expect(body.instructions).toBe("Be helpful.\nBe concise.");
		});
	});

	// ---- Tool use ---------------------------------------------------------

	describe("tool use", () => {
		it("sends tool definitions and parses function_call items from response", async () => {
			const fetchMock = mockFetchOk(openaiToolCallResponse());
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
							},
							required: ["location"],
						},
					},
				],
			});

			const response = await adapter.complete(request);

			// Verify tool definitions in the request body
			const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
			const body = JSON.parse(init.body as string) as Record<string, unknown>;
			const tools = body.tools as Array<{
				type: string;
				name: string;
				description: string;
				parameters: unknown;
				strict: boolean;
			}>;
			expect(tools).toHaveLength(1);
			expect(tools[0]?.type).toBe("function");
			expect(tools[0]?.name).toBe("get_weather");
			expect(tools[0]?.strict).toBe(false);

			// Verify the response parsed the tool call
			expect(response.message.content).toHaveLength(1);
			const toolCallPart = response.message.content[0]!;
			expect(toolCallPart.kind).toBe("tool_call");
			expect(toolCallPart.tool_call?.id).toBe("call_abc123");
			expect(toolCallPart.tool_call?.name).toBe("get_weather");
			expect(toolCallPart.tool_call?.arguments).toEqual({
				location: "San Francisco",
			});
		});
	});

	// ---- Streaming --------------------------------------------------------

	describe("stream()", () => {
		it("yields stream events for the Responses API event format", async () => {
			const sseEvents = [
				`event: response.created\ndata: ${JSON.stringify({
					type: "response.created",
					id: "resp_stream_01",
					model: "gpt-4o-2025-05-13",
					status: "in_progress",
					output: [],
				})}\n\n`,
				`event: response.output_item.added\ndata: ${JSON.stringify({
					type: "response.output_item.added",
					output_index: 0,
					item: {
						type: "message",
						role: "assistant",
						content: [],
					},
				})}\n\n`,
				`event: response.content_part.added\ndata: ${JSON.stringify({
					type: "response.content_part.added",
					output_index: 0,
					content_index: 0,
					part: { type: "output_text", text: "" },
				})}\n\n`,
				`event: response.output_text.delta\ndata: ${JSON.stringify({
					type: "response.output_text.delta",
					output_index: 0,
					content_index: 0,
					delta: "Hello ",
				})}\n\n`,
				`event: response.output_text.delta\ndata: ${JSON.stringify({
					type: "response.output_text.delta",
					output_index: 0,
					content_index: 0,
					delta: "world!",
				})}\n\n`,
				`event: response.content_part.done\ndata: ${JSON.stringify({
					type: "response.content_part.done",
					output_index: 0,
					content_index: 0,
					part: { type: "output_text", text: "Hello world!" },
				})}\n\n`,
				`event: response.completed\ndata: ${JSON.stringify({
					type: "response.completed",
					response: {
						id: "resp_stream_01",
						status: "completed",
						model: "gpt-4o-2025-05-13",
						output: [
							{
								type: "message",
								role: "assistant",
								content: [{ type: "output_text", text: "Hello world!" }],
							},
						],
						usage: {
							input_tokens: 10,
							output_tokens: 5,
							total_tokens: 15,
						},
					},
				})}\n\n`,
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

			// Verify FINISH event has usage
			const finishEvent = events.find((e) => e.type === "FINISH")!;
			expect(finishEvent.finish_reason?.reason).toBe("stop");
			expect(finishEvent.usage?.input_tokens).toBe(10);
			expect(finishEvent.usage?.output_tokens).toBe(5);
		});

		it("streams with stream: true in the request body", async () => {
			const sseEvents = [
				`event: response.created\ndata: ${JSON.stringify({
					type: "response.created",
					id: "resp_01",
					model: "gpt-4o",
					status: "in_progress",
					output: [],
				})}\n\n`,
				`event: response.completed\ndata: ${JSON.stringify({
					type: "response.completed",
					response: {
						id: "resp_01",
						status: "completed",
						model: "gpt-4o",
						output: [],
						usage: { input_tokens: 5, output_tokens: 0, total_tokens: 5 },
					},
				})}\n\n`,
			];

			const fetchMock = mockFetchSSE(sseEvents);
			vi.stubGlobal("fetch", fetchMock);

			const events: StreamEvent[] = [];
			for await (const event of adapter.stream(makeTextRequest())) {
				events.push(event);
			}

			const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
			const body = JSON.parse(init.body as string) as Record<string, unknown>;
			expect(body.stream).toBe(true);
		});
	});

	// ---- Error mapping ----------------------------------------------------

	describe("error mapping", () => {
		it("maps 401 to AuthenticationError", async () => {
			const fetchMock = mockFetchError(401, {
				error: { message: "Invalid API key", type: "authentication_error" },
			});
			vi.stubGlobal("fetch", fetchMock);

			await expect(adapter.complete(makeTextRequest())).rejects.toThrow(AuthenticationError);
		});

		it("maps 429 to RateLimitError", async () => {
			const fetchMock = mockFetchError(429, {
				error: { message: "Rate limit exceeded", type: "rate_limit_error" },
			});
			vi.stubGlobal("fetch", fetchMock);

			await expect(adapter.complete(makeTextRequest())).rejects.toThrow(RateLimitError);
		});

		it("maps 500 to ServerError", async () => {
			const fetchMock = mockFetchError(500, {
				error: { message: "Internal server error", type: "server_error" },
			});
			vi.stubGlobal("fetch", fetchMock);

			await expect(adapter.complete(makeTextRequest())).rejects.toThrow(ServerError);
		});

		it("maps 400 to InvalidRequestError", async () => {
			const fetchMock = mockFetchError(400, {
				error: { message: "Invalid request", type: "invalid_request_error" },
			});
			vi.stubGlobal("fetch", fetchMock);

			await expect(adapter.complete(makeTextRequest())).rejects.toThrow(InvalidRequestError);
		});
	});
});
