import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GeminiAdapter } from "../src/adapters/gemini.js";
import {
	AuthenticationError,
	ContentFilterError,
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
		model: "gemini-2.5-pro",
		messages: [
			{
				role: "user",
				content: [{ kind: "text", text: "Hello" }],
			},
		],
		...overrides,
	};
}

function geminiTextResponse(text: string) {
	return {
		candidates: [
			{
				content: {
					parts: [{ text }],
					role: "model",
				},
				finishReason: "STOP",
			},
		],
		usageMetadata: {
			promptTokenCount: 8,
			candidatesTokenCount: 15,
			totalTokenCount: 23,
		},
	};
}

function geminiToolCallResponse() {
	return {
		candidates: [
			{
				content: {
					parts: [
						{
							functionCall: {
								name: "get_weather",
								args: { location: "San Francisco", unit: "celsius" },
							},
						},
					],
					role: "model",
				},
				finishReason: "STOP",
			},
		],
		usageMetadata: {
			promptTokenCount: 20,
			candidatesTokenCount: 10,
			totalTokenCount: 30,
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

describe("GeminiAdapter", () => {
	let adapter: GeminiAdapter;

	beforeEach(() => {
		adapter = new GeminiAdapter({
			api_key: "gemini-test-key-123",
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	// ---- Simple text completion -------------------------------------------

	describe("complete() — simple text", () => {
		it("returns a well-formed response for a basic text completion", async () => {
			const fetchMock = mockFetchOk(geminiTextResponse("Hello there!"));
			vi.stubGlobal("fetch", fetchMock);

			const response = await adapter.complete(makeTextRequest());

			expect(response.provider).toBe("gemini");
			expect(response.model).toBe("gemini-2.5-pro");
			expect(response.message.role).toBe("assistant");
			expect(response.message.content).toHaveLength(1);
			expect(response.message.content[0]?.kind).toBe("text");
			expect(response.message.content[0]?.text).toBe("Hello there!");
			expect(response.finish_reason.reason).toBe("stop");
			expect(response.finish_reason.raw).toBe("STOP");
			expect(response.usage.input_tokens).toBe(8);
			expect(response.usage.output_tokens).toBe(15);
			expect(response.usage.total_tokens).toBe(23);
		});

		it("generates an ID prefixed with 'gemini-'", async () => {
			const fetchMock = mockFetchOk(geminiTextResponse("Hi"));
			vi.stubGlobal("fetch", fetchMock);

			const response = await adapter.complete(makeTextRequest());

			expect(response.id).toMatch(/^gemini-/);
		});
	});

	// ---- API key in URL ---------------------------------------------------

	describe("API key in URL", () => {
		it("sends the API key as a query parameter, not in a header", async () => {
			const fetchMock = mockFetchOk(geminiTextResponse("OK"));
			vi.stubGlobal("fetch", fetchMock);

			await adapter.complete(makeTextRequest());

			expect(fetchMock).toHaveBeenCalledTimes(1);
			const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];

			// Key should be in the URL
			expect(url).toContain("key=gemini-test-key-123");
			expect(url).toContain("generativelanguage.googleapis.com");
			expect(url).toContain(":generateContent");

			// Key should NOT be in headers as Authorization or x-api-key
			const headers = init.headers as Record<string, string>;
			expect(headers.Authorization).toBeUndefined();
			expect(headers["x-api-key"]).toBeUndefined();
		});
	});

	// ---- System instruction extraction ------------------------------------

	describe("system instruction extraction", () => {
		it("extracts system messages into the systemInstruction field", async () => {
			const fetchMock = mockFetchOk(geminiTextResponse("OK"));
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
			const systemInstruction = body.systemInstruction as {
				parts: Array<{ text: string }>;
			};
			expect(systemInstruction).toBeDefined();
			expect(systemInstruction.parts).toHaveLength(1);
			expect(systemInstruction.parts[0]?.text).toBe("You are a helpful assistant.");

			// System messages should not appear in the contents array
			const contents = body.contents as Array<{ role: string }>;
			expect(contents.every((c) => c.role !== "system")).toBe(true);
		});

		it("extracts developer role messages as system instructions", async () => {
			const fetchMock = mockFetchOk(geminiTextResponse("OK"));
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
			const systemInstruction = body.systemInstruction as {
				parts: Array<{ text: string }>;
			};
			expect(systemInstruction.parts[0]?.text).toBe("Be concise.");
		});
	});

	// ---- assistant ↔ model role mapping -----------------------------------

	describe("assistant ↔ model role mapping", () => {
		it("maps 'assistant' role to 'model' in the request", async () => {
			const fetchMock = mockFetchOk(geminiTextResponse("OK"));
			vi.stubGlobal("fetch", fetchMock);

			const request = makeTextRequest({
				messages: [
					{
						role: "user",
						content: [{ kind: "text", text: "Hi" }],
					},
					{
						role: "assistant",
						content: [{ kind: "text", text: "Hello!" }],
					},
					{
						role: "user",
						content: [{ kind: "text", text: "How are you?" }],
					},
				],
			});

			await adapter.complete(request);

			const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
			const body = JSON.parse(init.body as string) as Record<string, unknown>;
			const contents = body.contents as Array<{ role: string; parts: unknown[] }>;

			expect(contents).toHaveLength(3);
			expect(contents[0]?.role).toBe("user");
			expect(contents[1]?.role).toBe("model");
			expect(contents[2]?.role).toBe("user");
		});

		it("maps 'model' role in response to 'assistant' in unified response", async () => {
			const fetchMock = mockFetchOk(geminiTextResponse("I am fine!"));
			vi.stubGlobal("fetch", fetchMock);

			const response = await adapter.complete(makeTextRequest());

			// The Gemini API returns role: "model" but the unified response should be "assistant"
			expect(response.message.role).toBe("assistant");
		});
	});

	// ---- Tool use with synthetic IDs --------------------------------------

	describe("tool use with synthetic IDs", () => {
		it("generates synthetic IDs for tool calls (call_<uuid> format)", async () => {
			const fetchMock = mockFetchOk(geminiToolCallResponse());
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
								unit: { type: "string" },
							},
							required: ["location"],
						},
					},
				],
			});

			const response = await adapter.complete(request);

			// Verify tool definitions were sent as functionDeclarations
			const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
			const body = JSON.parse(init.body as string) as Record<string, unknown>;
			const tools = body.tools as Array<{
				functionDeclarations: Array<{
					name: string;
					description: string;
					parameters: unknown;
				}>;
			}>;
			expect(tools).toHaveLength(1);
			expect(tools[0]?.functionDeclarations).toHaveLength(1);
			expect(tools[0]?.functionDeclarations[0]?.name).toBe("get_weather");

			// Verify the tool call in the response
			expect(response.message.content).toHaveLength(1);
			const toolCallPart = response.message.content[0]!;
			expect(toolCallPart.kind).toBe("tool_call");
			expect(toolCallPart.tool_call?.name).toBe("get_weather");
			expect(toolCallPart.tool_call?.arguments).toEqual({
				location: "San Francisco",
				unit: "celsius",
			});

			// Synthetic ID should follow call_<uuid> pattern
			expect(toolCallPart.tool_call?.id).toMatch(/^call_/);
		});
	});

	// ---- Zero candidates → ContentFilterError -----------------------------

	describe("zero candidates", () => {
		it("throws ContentFilterError when response has zero candidates", async () => {
			const fetchMock = mockFetchOk({
				candidates: [],
				usageMetadata: {
					promptTokenCount: 10,
					candidatesTokenCount: 0,
					totalTokenCount: 10,
				},
			});
			vi.stubGlobal("fetch", fetchMock);

			await expect(adapter.complete(makeTextRequest())).rejects.toThrow(ContentFilterError);
		});

		it("throws ContentFilterError when candidates field is missing", async () => {
			const fetchMock = mockFetchOk({
				usageMetadata: {
					promptTokenCount: 10,
					candidatesTokenCount: 0,
					totalTokenCount: 10,
				},
			});
			vi.stubGlobal("fetch", fetchMock);

			await expect(adapter.complete(makeTextRequest())).rejects.toThrow(ContentFilterError);
		});
	});

	// ---- Streaming --------------------------------------------------------

	describe("stream()", () => {
		it("yields STREAM_START, TEXT_START, TEXT_DELTA, TEXT_END, and FINISH events", async () => {
			const sseEvents = [
				`data: ${JSON.stringify({
					candidates: [
						{
							content: {
								parts: [{ text: "Hello " }],
								role: "model",
							},
						},
					],
					usageMetadata: {
						promptTokenCount: 5,
						candidatesTokenCount: 2,
						totalTokenCount: 7,
					},
				})}\n\n`,
				`data: ${JSON.stringify({
					candidates: [
						{
							content: {
								parts: [{ text: "world!" }],
								role: "model",
							},
							finishReason: "STOP",
						},
					],
					usageMetadata: {
						promptTokenCount: 5,
						candidatesTokenCount: 5,
						totalTokenCount: 10,
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

			// Verify FINISH event
			const finishEvent = events.find((e) => e.type === "FINISH")!;
			expect(finishEvent.finish_reason?.reason).toBe("stop");
			expect(finishEvent.usage?.input_tokens).toBe(5);
			expect(finishEvent.usage?.output_tokens).toBe(5);
			expect(finishEvent.usage?.total_tokens).toBe(10);
		});

		it("uses streamGenerateContent endpoint with alt=sse", async () => {
			const sseEvents = [
				`data: ${JSON.stringify({
					candidates: [
						{
							content: {
								parts: [{ text: "Hi" }],
								role: "model",
							},
							finishReason: "STOP",
						},
					],
					usageMetadata: {
						promptTokenCount: 3,
						candidatesTokenCount: 1,
						totalTokenCount: 4,
					},
				})}\n\n`,
			];

			const fetchMock = mockFetchSSE(sseEvents);
			vi.stubGlobal("fetch", fetchMock);

			const events: StreamEvent[] = [];
			for await (const event of adapter.stream(makeTextRequest())) {
				events.push(event);
			}

			const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
			expect(url).toContain(":streamGenerateContent");
			expect(url).toContain("alt=sse");
			expect(url).toContain("key=gemini-test-key-123");
		});
	});

	// ---- Error mapping ----------------------------------------------------

	describe("error mapping", () => {
		it("maps 401 to AuthenticationError", async () => {
			const fetchMock = mockFetchError(401, {
				error: {
					code: 401,
					message: "API key not valid",
					status: "UNAUTHENTICATED",
				},
			});
			vi.stubGlobal("fetch", fetchMock);

			await expect(adapter.complete(makeTextRequest())).rejects.toThrow(AuthenticationError);
		});

		it("maps 429 to RateLimitError", async () => {
			const fetchMock = mockFetchError(429, {
				error: {
					code: 429,
					message: "Resource has been exhausted",
					status: "RESOURCE_EXHAUSTED",
				},
			});
			vi.stubGlobal("fetch", fetchMock);

			await expect(adapter.complete(makeTextRequest())).rejects.toThrow(RateLimitError);
		});

		it("maps 500 to ServerError", async () => {
			const fetchMock = mockFetchError(500, {
				error: {
					code: 500,
					message: "Internal error",
					status: "INTERNAL",
				},
			});
			vi.stubGlobal("fetch", fetchMock);

			await expect(adapter.complete(makeTextRequest())).rejects.toThrow(ServerError);
		});

		it("maps 400 to InvalidRequestError", async () => {
			const fetchMock = mockFetchError(400, {
				error: {
					code: 400,
					message: "Invalid argument",
					status: "INVALID_ARGUMENT",
				},
			});
			vi.stubGlobal("fetch", fetchMock);

			await expect(adapter.complete(makeTextRequest())).rejects.toThrow(InvalidRequestError);
		});
	});
});
