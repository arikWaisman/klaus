import { describe, expect, it, vi } from "vitest";
import type { Middleware } from "../src/middleware.js";
import {
	composeCompleteMiddleware,
	composeStreamMiddleware,
	loggingMiddleware,
} from "../src/middleware.js";
import type { Request, Response, StreamEvent } from "../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(overrides: Partial<Request> = {}): Request {
	return {
		model: "test-model",
		messages: [{ role: "user", content: [{ kind: "text", text: "Hi" }] }],
		...overrides,
	};
}

function makeResponse(overrides: Partial<Response> = {}): Response {
	return {
		id: "resp-1",
		model: "test-model",
		provider: "test",
		message: { role: "assistant", content: [{ kind: "text", text: "Hello" }] },
		finish_reason: { reason: "stop" },
		usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
		warnings: [],
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// composeCompleteMiddleware
// ---------------------------------------------------------------------------

describe("composeCompleteMiddleware", () => {
	it("calls the handler directly when no middleware is provided", async () => {
		const response = makeResponse();
		const handler = vi.fn(async () => response);

		const composed = composeCompleteMiddleware([], handler);
		const result = await composed(makeRequest());

		expect(handler).toHaveBeenCalledOnce();
		expect(result).toBe(response);
	});

	it("executes middleware in onion order (outer first on request, last on response)", async () => {
		const log: string[] = [];

		const outer: Middleware = {
			name: "outer",
			async complete(request, next) {
				log.push("outer-before");
				const response = await next(request);
				log.push("outer-after");
				return response;
			},
		};

		const inner: Middleware = {
			name: "inner",
			async complete(request, next) {
				log.push("inner-before");
				const response = await next(request);
				log.push("inner-after");
				return response;
			},
		};

		const handler = async (req: Request) => {
			log.push("handler");
			return makeResponse();
		};

		const composed = composeCompleteMiddleware([outer, inner], handler);
		await composed(makeRequest());

		expect(log).toEqual(["outer-before", "inner-before", "handler", "inner-after", "outer-after"]);
	});

	it("skips middleware without a complete hook", async () => {
		const log: string[] = [];

		const withHook: Middleware = {
			name: "with-hook",
			async complete(request, next) {
				log.push("with-hook");
				return next(request);
			},
		};

		const withoutHook: Middleware = {
			name: "without-hook",
			// No complete hook — only stream
			async *stream(request, next) {
				yield* next(request);
			},
		};

		const handler = async (req: Request) => {
			log.push("handler");
			return makeResponse();
		};

		const composed = composeCompleteMiddleware([withHook, withoutHook], handler);
		await composed(makeRequest());

		expect(log).toEqual(["with-hook", "handler"]);
	});

	it("allows middleware to modify the request before passing it on", async () => {
		const modifying: Middleware = {
			name: "modifying",
			async complete(request, next) {
				return next({ ...request, temperature: 0.5 });
			},
		};

		const handler = vi.fn(async (req: Request) => makeResponse());

		const composed = composeCompleteMiddleware([modifying], handler);
		await composed(makeRequest());

		expect(handler).toHaveBeenCalledWith(expect.objectContaining({ temperature: 0.5 }));
	});

	it("allows middleware to modify the response on the way back", async () => {
		const modifying: Middleware = {
			name: "modifying",
			async complete(request, next) {
				const response = await next(request);
				return { ...response, id: "modified-id" };
			},
		};

		const handler = async (req: Request) => makeResponse({ id: "original-id" });

		const composed = composeCompleteMiddleware([modifying], handler);
		const result = await composed(makeRequest());

		expect(result.id).toBe("modified-id");
	});

	it("composes three middleware in correct onion order", async () => {
		const log: string[] = [];

		const mw1: Middleware = {
			name: "mw1",
			async complete(request, next) {
				log.push("mw1-in");
				const r = await next(request);
				log.push("mw1-out");
				return r;
			},
		};

		const mw2: Middleware = {
			name: "mw2",
			async complete(request, next) {
				log.push("mw2-in");
				const r = await next(request);
				log.push("mw2-out");
				return r;
			},
		};

		const mw3: Middleware = {
			name: "mw3",
			async complete(request, next) {
				log.push("mw3-in");
				const r = await next(request);
				log.push("mw3-out");
				return r;
			},
		};

		const handler = async (req: Request) => {
			log.push("handler");
			return makeResponse();
		};

		const composed = composeCompleteMiddleware([mw1, mw2, mw3], handler);
		await composed(makeRequest());

		expect(log).toEqual(["mw1-in", "mw2-in", "mw3-in", "handler", "mw3-out", "mw2-out", "mw1-out"]);
	});
});

// ---------------------------------------------------------------------------
// composeStreamMiddleware
// ---------------------------------------------------------------------------

describe("composeStreamMiddleware", () => {
	it("calls the handler directly when no middleware is provided", async () => {
		const event: StreamEvent = { type: "TEXT_DELTA", delta: "hello" };

		async function* handler(_req: Request): AsyncIterableIterator<StreamEvent> {
			yield event;
		}

		const composed = composeStreamMiddleware([], handler);
		const events: StreamEvent[] = [];

		for await (const e of composed(makeRequest())) {
			events.push(e);
		}

		expect(events).toEqual([event]);
	});

	it("executes stream middleware in onion order", async () => {
		const log: string[] = [];

		const outer: Middleware = {
			name: "outer",
			async *stream(request, next) {
				log.push("outer-before");
				for await (const event of next(request)) {
					log.push("outer-event");
					yield event;
				}
				log.push("outer-after");
			},
		};

		const inner: Middleware = {
			name: "inner",
			async *stream(request, next) {
				log.push("inner-before");
				for await (const event of next(request)) {
					log.push("inner-event");
					yield event;
				}
				log.push("inner-after");
			},
		};

		async function* handler(_req: Request): AsyncIterableIterator<StreamEvent> {
			log.push("handler");
			yield { type: "TEXT_DELTA", delta: "hi" };
		}

		const composed = composeStreamMiddleware([outer, inner], handler);
		const events: StreamEvent[] = [];

		for await (const e of composed(makeRequest())) {
			events.push(e);
		}

		expect(log).toEqual([
			"outer-before",
			"inner-before",
			"handler",
			"inner-event",
			"outer-event",
			"inner-after",
			"outer-after",
		]);

		expect(events).toHaveLength(1);
		expect(events[0].delta).toBe("hi");
	});

	it("skips middleware without a stream hook", async () => {
		const log: string[] = [];

		const withHook: Middleware = {
			name: "with-hook",
			async *stream(request, next) {
				log.push("with-hook");
				yield* next(request);
			},
		};

		const withoutHook: Middleware = {
			name: "without-hook",
			// No stream hook — only complete
			async complete(request, next) {
				return next(request);
			},
		};

		async function* handler(_req: Request): AsyncIterableIterator<StreamEvent> {
			log.push("handler");
			yield { type: "TEXT_DELTA", delta: "hi" };
		}

		const composed = composeStreamMiddleware([withHook, withoutHook], handler);
		const events: StreamEvent[] = [];

		for await (const e of composed(makeRequest())) {
			events.push(e);
		}

		expect(log).toEqual(["with-hook", "handler"]);
		expect(events).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// loggingMiddleware
// ---------------------------------------------------------------------------

describe("loggingMiddleware", () => {
	it("logs request and response for complete calls", async () => {
		const logs: string[] = [];
		const logger = (msg: string) => logs.push(msg);
		const mw = loggingMiddleware({ logger });

		const request = makeRequest({ model: "claude-3-opus", provider: "anthropic" });
		const response = makeResponse({
			model: "claude-3-opus",
			provider: "anthropic",
		});

		const handler = async (_req: Request) => response;
		const composed = composeCompleteMiddleware([mw], handler);

		await composed(request);

		expect(logs).toHaveLength(2);

		// Request log
		expect(logs[0]).toContain("[llm-client] request");
		expect(logs[0]).toContain("model=claude-3-opus");
		expect(logs[0]).toContain("provider=anthropic");
		expect(logs[0]).toContain("messages=1");

		// Response log
		expect(logs[1]).toContain("[llm-client] response");
		expect(logs[1]).toContain("model=claude-3-opus");
		expect(logs[1]).toContain("provider=anthropic");
		expect(logs[1]).toContain("finish_reason=stop");
		expect(logs[1]).toContain("usage(in=10 out=20 total=30)");
	});

	it("logs request and response for stream calls on FINISH event", async () => {
		const logs: string[] = [];
		const logger = (msg: string) => logs.push(msg);
		const mw = loggingMiddleware({ logger });

		const request = makeRequest({ model: "gpt-4o" });
		const response = makeResponse({ model: "gpt-4o", provider: "openai" });

		async function* handler(_req: Request): AsyncIterableIterator<StreamEvent> {
			yield { type: "TEXT_DELTA", delta: "Hello" };
			yield { type: "FINISH", response, finish_reason: { reason: "stop" } };
		}

		const composed = composeStreamMiddleware([mw], handler);
		const events: StreamEvent[] = [];

		for await (const e of composed(request)) {
			events.push(e);
		}

		expect(events).toHaveLength(2);

		// Should have logged request and response
		expect(logs).toHaveLength(2);
		expect(logs[0]).toContain("[llm-client] request");
		expect(logs[0]).toContain("model=gpt-4o");
		expect(logs[1]).toContain("[llm-client] response");
	});

	it("redacts sensitive metadata in request logs", async () => {
		const logs: string[] = [];
		const logger = (msg: string) => logs.push(msg);
		const mw = loggingMiddleware({ logger });

		const request = makeRequest({
			model: "test-model",
			metadata: {
				Authorization: "Bearer secret-key",
				"x-api-key": "another-secret",
				"x-custom": "visible",
			},
		});

		const handler = async (_req: Request) => makeResponse();
		const composed = composeCompleteMiddleware([mw], handler);

		await composed(request);

		// Metadata should be logged but sensitive values should be redacted
		expect(logs[0]).toContain("[REDACTED]");
		expect(logs[0]).not.toContain("secret-key");
		expect(logs[0]).not.toContain("another-secret");
		expect(logs[0]).toContain("visible");
	});

	it("logs optional usage fields when present", async () => {
		const logs: string[] = [];
		const logger = (msg: string) => logs.push(msg);
		const mw = loggingMiddleware({ logger });

		const response = makeResponse({
			usage: {
				input_tokens: 100,
				output_tokens: 50,
				total_tokens: 150,
				reasoning_tokens: 30,
				cache_read_tokens: 20,
				cache_write_tokens: 10,
			},
		});

		const handler = async (_req: Request) => response;
		const composed = composeCompleteMiddleware([mw], handler);

		await composed(makeRequest());

		expect(logs[1]).toContain("reasoning_tokens=30");
		expect(logs[1]).toContain("cache_read=20");
		expect(logs[1]).toContain("cache_write=10");
	});

	it("uses console.log by default when no logger is provided", async () => {
		const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		const mw = loggingMiddleware();
		const handler = async (_req: Request) => makeResponse();
		const composed = composeCompleteMiddleware([mw], handler);

		await composed(makeRequest());

		expect(consoleSpy).toHaveBeenCalledTimes(2);
		consoleSpy.mockRestore();
	});
});
