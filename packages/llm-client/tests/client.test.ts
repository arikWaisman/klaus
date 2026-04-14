import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderAdapter } from "../src/adapters/adapter.js";
import { AnthropicAdapter } from "../src/adapters/anthropic.js";
import { Client } from "../src/client.js";
import { ConfigurationError } from "../src/errors.js";
import type { Middleware } from "../src/middleware.js";
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
		provider: "mock",
		message: { role: "assistant", content: [{ kind: "text", text: "Hello" }] },
		finish_reason: { reason: "stop" },
		usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
		warnings: [],
		...overrides,
	};
}

function makeMockAdapter(name: string): ProviderAdapter {
	const response = makeResponse({ provider: name });
	const event: StreamEvent = { type: "TEXT_DELTA", delta: "hi" };
	return {
		name,
		default_model: `${name}-default`,
		async complete(_request: Request) {
			return response;
		},
		async *stream(_request: Request) {
			yield event;
		},
	};
}

// ---------------------------------------------------------------------------
// Provider routing
// ---------------------------------------------------------------------------

describe("Client", () => {
	describe("provider routing", () => {
		it("routes to the correct adapter via explicit provider on request", async () => {
			const anthropic = makeMockAdapter("anthropic");
			const openai = makeMockAdapter("openai");

			const client = new Client({
				adapters: { anthropic, openai },
			});

			const request = makeRequest({ model: "my-custom-model", provider: "openai" });
			const response = await client.complete(request);

			expect(response.provider).toBe("openai");
		});

		it("routes via model-name inference: claude-* -> anthropic", async () => {
			const anthropic = makeMockAdapter("anthropic");
			const openai = makeMockAdapter("openai");

			const client = new Client({
				adapters: { anthropic, openai },
			});

			const request = makeRequest({ model: "claude-3-opus" });
			const response = await client.complete(request);

			expect(response.provider).toBe("anthropic");
		});

		it("routes via model-name inference: gpt-* -> openai", async () => {
			const anthropic = makeMockAdapter("anthropic");
			const openai = makeMockAdapter("openai");

			const client = new Client({
				adapters: { anthropic, openai },
			});

			const request = makeRequest({ model: "gpt-4o" });
			const response = await client.complete(request);

			expect(response.provider).toBe("openai");
		});

		it("routes via model-name inference: gemini-* -> gemini", async () => {
			const anthropic = makeMockAdapter("anthropic");
			const gemini = makeMockAdapter("gemini");

			const client = new Client({
				adapters: { anthropic, gemini },
			});

			const request = makeRequest({ model: "gemini-1.5-pro" });
			const response = await client.complete(request);

			expect(response.provider).toBe("gemini");
		});

		it("routes via default_provider when model name cannot be inferred", async () => {
			const anthropic = makeMockAdapter("anthropic");
			const openai = makeMockAdapter("openai");

			const client = new Client({
				adapters: { anthropic, openai },
				default_provider: "anthropic",
			});

			const request = makeRequest({ model: "my-custom-model" });
			const response = await client.complete(request);

			expect(response.provider).toBe("anthropic");
		});

		it("routes to the single registered adapter as fallback", async () => {
			const openai = makeMockAdapter("openai");

			const client = new Client({
				adapters: { openai },
			});

			const request = makeRequest({ model: "unknown-model" });
			const response = await client.complete(request);

			expect(response.provider).toBe("openai");
		});

		it("throws ConfigurationError when no provider can be resolved", async () => {
			const anthropic = makeMockAdapter("anthropic");
			const openai = makeMockAdapter("openai");

			const client = new Client({
				adapters: { anthropic, openai },
			});

			const request = makeRequest({ model: "unknown-model" });

			await expect(client.complete(request)).rejects.toThrow(ConfigurationError);
		});

		it("throws ConfigurationError for an unregistered provider", async () => {
			const anthropic = makeMockAdapter("anthropic");

			const client = new Client({
				adapters: { anthropic },
			});

			const request = makeRequest({ model: "gpt-4o", provider: "openai" });

			await expect(client.complete(request)).rejects.toThrow(ConfigurationError);
			await expect(client.complete(request)).rejects.toThrow(
				/No adapter registered for provider "openai"/,
			);
		});
	});

	// -----------------------------------------------------------------------
	// stream routing
	// -----------------------------------------------------------------------

	describe("stream routing", () => {
		it("routes stream to the correct adapter via explicit provider", async () => {
			const anthropic = makeMockAdapter("anthropic");
			const openai = makeMockAdapter("openai");

			const client = new Client({
				adapters: { anthropic, openai },
			});

			const request = makeRequest({ model: "anything", provider: "anthropic" });
			const events: StreamEvent[] = [];

			for await (const event of client.stream(request)) {
				events.push(event);
			}

			expect(events).toHaveLength(1);
			expect(events[0].type).toBe("TEXT_DELTA");
		});

		it("throws ConfigurationError for stream with unresolvable provider", () => {
			const anthropic = makeMockAdapter("anthropic");
			const openai = makeMockAdapter("openai");

			const client = new Client({
				adapters: { anthropic, openai },
			});

			const request = makeRequest({ model: "unknown-model" });

			expect(() => client.stream(request)).toThrow(ConfigurationError);
		});
	});

	// -----------------------------------------------------------------------
	// Client.fromEnv
	// -----------------------------------------------------------------------

	describe("Client.fromEnv", () => {
		const originalEnv = process.env;

		beforeEach(() => {
			vi.stubEnv("ANTHROPIC_API_KEY", "");
			vi.stubEnv("OPENAI_API_KEY", "");
			vi.stubEnv("GEMINI_API_KEY", "");
		});

		afterEach(() => {
			vi.unstubAllEnvs();
		});

		it("creates an anthropic adapter when ANTHROPIC_API_KEY is set", () => {
			vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");

			const client = Client.fromEnv();

			// The client should be able to route claude models
			// We verify by checking it does not throw for a claude model
			const request = makeRequest({ model: "claude-3-opus" });
			expect(() => client.complete(request)).not.toThrow();
		});

		it("creates an openai adapter when OPENAI_API_KEY is set", () => {
			vi.stubEnv("OPENAI_API_KEY", "sk-openai-test");

			const client = Client.fromEnv();

			const request = makeRequest({ model: "gpt-4o" });
			expect(() => client.complete(request)).not.toThrow();
		});

		it("creates a gemini adapter when GEMINI_API_KEY is set", () => {
			vi.stubEnv("GEMINI_API_KEY", "gemini-test-key");

			const client = Client.fromEnv();

			const request = makeRequest({ model: "gemini-1.5-pro" });
			expect(() => client.complete(request)).not.toThrow();
		});

		it("sets first detected provider as default_provider", () => {
			vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
			vi.stubEnv("OPENAI_API_KEY", "sk-openai-test");

			const client = Client.fromEnv();

			// With an unknown model, should fall back to default_provider (anthropic, first detected)
			const request = makeRequest({ model: "unknown-model" });
			expect(() => client.complete(request)).not.toThrow();
		});

		it("allows user config to override default_provider", () => {
			vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
			vi.stubEnv("OPENAI_API_KEY", "sk-openai-test");

			const client = Client.fromEnv({ default_provider: "openai" });

			// With an unknown model, should fall back to user-specified default_provider (openai)
			const request = makeRequest({ model: "unknown-model" });
			expect(() => client.complete(request)).not.toThrow();
		});
	});

	// -----------------------------------------------------------------------
	// Default model resolution
	// -----------------------------------------------------------------------

	describe("default model resolution", () => {
		it("uses adapter's default_model when request has no model", async () => {
			let capturedModel: string | undefined;
			const adapter: ProviderAdapter = {
				name: "mock",
				default_model: "mock-best-v2",
				async complete(request: Request) {
					capturedModel = request.model;
					return makeResponse({ provider: "mock" });
				},
				async *stream(_request: Request) {
					yield { type: "TEXT_DELTA" as const, delta: "hi" };
				},
			};

			const client = new Client({
				adapters: { mock: adapter },
				default_provider: "mock",
			});

			await client.complete(makeRequest({ model: "" }));
			expect(capturedModel).toBe("mock-best-v2");
		});

		it("preserves explicit model when provided", async () => {
			let capturedModel: string | undefined;
			const adapter: ProviderAdapter = {
				name: "anthropic",
				default_model: "claude-sonnet-4-5-20250929",
				async complete(request: Request) {
					capturedModel = request.model;
					return makeResponse({ provider: "anthropic" });
				},
				async *stream(_request: Request) {
					yield { type: "TEXT_DELTA" as const, delta: "hi" };
				},
			};

			const client = new Client({
				adapters: { anthropic: adapter },
			});

			await client.complete(makeRequest({ model: "claude-opus-4-6" }));
			expect(capturedModel).toBe("claude-opus-4-6");
		});

		it("uses default_model for streaming when request has no model", async () => {
			let capturedModel: string | undefined;
			const adapter: ProviderAdapter = {
				name: "mock",
				default_model: "mock-stream-v1",
				async complete(_request: Request) {
					return makeResponse({ provider: "mock" });
				},
				async *stream(request: Request) {
					capturedModel = request.model;
					yield { type: "TEXT_DELTA" as const, delta: "hi" };
				},
			};

			const client = new Client({
				adapters: { mock: adapter },
				default_provider: "mock",
			});

			const events: StreamEvent[] = [];
			for await (const event of client.stream(makeRequest({ model: "" }))) {
				events.push(event);
			}
			expect(capturedModel).toBe("mock-stream-v1");
		});
	});

	// -----------------------------------------------------------------------
	// getDefaultModel
	// -----------------------------------------------------------------------

	describe("getDefaultModel", () => {
		it("returns the default model for a named provider", () => {
			const anthropic = makeMockAdapter("anthropic");
			const openai = makeMockAdapter("openai");

			const client = new Client({
				adapters: { anthropic, openai },
				default_provider: "anthropic",
			});

			expect(client.getDefaultModel("anthropic")).toBe("anthropic-default");
			expect(client.getDefaultModel("openai")).toBe("openai-default");
		});

		it("returns the default provider's model when no provider arg given", () => {
			const anthropic = makeMockAdapter("anthropic");
			const openai = makeMockAdapter("openai");

			const client = new Client({
				adapters: { anthropic, openai },
				default_provider: "openai",
			});

			expect(client.getDefaultModel()).toBe("openai-default");
		});

		it("returns single adapter's model when no provider specified and no default", () => {
			const mock = makeMockAdapter("mock");

			const client = new Client({
				adapters: { mock },
			});

			expect(client.getDefaultModel()).toBe("mock-default");
		});

		it("returns undefined when provider is not registered", () => {
			const mock = makeMockAdapter("mock");

			const client = new Client({
				adapters: { mock },
			});

			expect(client.getDefaultModel("nonexistent")).toBeUndefined();
		});

		it("returns correct defaults from real adapters via fromEnv", () => {
			vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
			vi.stubEnv("OPENAI_API_KEY", "sk-openai-test");
			vi.stubEnv("GEMINI_API_KEY", "gemini-test-key");

			const client = Client.fromEnv();

			expect(client.getDefaultModel("anthropic")).toBe("claude-sonnet-4-5-20250929");
			expect(client.getDefaultModel("openai")).toBe("gpt-4o");
			expect(client.getDefaultModel("gemini")).toBe("gemini-2.0-flash");

			vi.unstubAllEnvs();
		});

		it("respects default_model config override passed to adapter", () => {
			const client = new Client({
				adapters: {
					anthropic: new AnthropicAdapter({
						api_key: "sk-test",
						default_model: "claude-opus-4-6",
					}),
				},
				default_provider: "anthropic",
			});

			expect(client.getDefaultModel("anthropic")).toBe("claude-opus-4-6");
		});
	});

	// -----------------------------------------------------------------------
	// registerAdapter and use
	// -----------------------------------------------------------------------

	describe("registerAdapter", () => {
		it("registers a new adapter that can be used for routing", async () => {
			const client = new Client({ adapters: {} });
			const mock = makeMockAdapter("custom");

			client.registerAdapter("custom", mock);

			const request = makeRequest({ model: "any-model", provider: "custom" });
			const response = await client.complete(request);

			expect(response.provider).toBe("custom");
		});

		it("overwrites an existing adapter with the same name", async () => {
			const original = makeMockAdapter("anthropic");
			const replacement = makeMockAdapter("anthropic");
			const replacementResponse = makeResponse({ provider: "anthropic", id: "replaced" });
			replacement.complete = async () => replacementResponse;

			const client = new Client({ adapters: { anthropic: original } });
			client.registerAdapter("anthropic", replacement);

			const request = makeRequest({ model: "claude-3-opus" });
			const response = await client.complete(request);

			expect(response.id).toBe("replaced");
		});
	});

	describe("use", () => {
		it("adds middleware that is applied to subsequent requests", async () => {
			const log: string[] = [];

			const middleware: Middleware = {
				name: "test-mw",
				async complete(request, next) {
					log.push("before");
					const response = await next(request);
					log.push("after");
					return response;
				},
			};

			const mock = makeMockAdapter("mock");
			const client = new Client({ adapters: { mock }, default_provider: "mock" });
			client.use(middleware);

			const request = makeRequest({ model: "test-model" });
			await client.complete(request);

			expect(log).toEqual(["before", "after"]);
		});

		it("appends middleware in order", async () => {
			const log: string[] = [];

			const mw1: Middleware = {
				name: "mw1",
				async complete(request, next) {
					log.push("mw1-before");
					const response = await next(request);
					log.push("mw1-after");
					return response;
				},
			};

			const mw2: Middleware = {
				name: "mw2",
				async complete(request, next) {
					log.push("mw2-before");
					const response = await next(request);
					log.push("mw2-after");
					return response;
				},
			};

			const mock = makeMockAdapter("mock");
			const client = new Client({ adapters: { mock }, default_provider: "mock" });
			client.use(mw1);
			client.use(mw2);

			const request = makeRequest({ model: "test-model" });
			await client.complete(request);

			expect(log).toEqual(["mw1-before", "mw2-before", "mw2-after", "mw1-after"]);
		});
	});
});
