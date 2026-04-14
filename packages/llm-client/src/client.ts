declare const process: { env: Record<string, string | undefined> };

import type { ProviderAdapter } from "./adapters/adapter.js";
import { AnthropicAdapter } from "./adapters/anthropic.js";
import { GeminiAdapter } from "./adapters/gemini.js";
import { OpenAIAdapter } from "./adapters/openai.js";
import { ConfigurationError } from "./errors.js";
import type { Middleware } from "./middleware.js";
import { composeCompleteMiddleware, composeStreamMiddleware } from "./middleware.js";
import type { Request, Response, StreamEvent } from "./types.js";

// ---------------------------------------------------------------------------
// ClientConfig
// ---------------------------------------------------------------------------

export interface ClientConfig {
	adapters?: Record<string, ProviderAdapter>;
	default_provider?: string;
	middleware?: Middleware[];
}

// ---------------------------------------------------------------------------
// Model-name → provider inference
// ---------------------------------------------------------------------------

function inferProvider(model: string): string | undefined {
	if (model.startsWith("claude")) return "anthropic";
	if (model.startsWith("gpt-") || model.startsWith("o1-") || model.startsWith("o3-"))
		return "openai";
	if (model.startsWith("gemini")) return "gemini";
	return undefined;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class Client {
	private adapters: Map<string, ProviderAdapter>;
	private default_provider?: string;
	private middlewares: Middleware[];

	constructor(config: ClientConfig) {
		this.adapters = new Map<string, ProviderAdapter>();

		if (config.adapters) {
			for (const [name, adapter] of Object.entries(config.adapters)) {
				this.adapters.set(name, adapter);
			}
		}

		this.default_provider = config.default_provider;
		this.middlewares = config.middleware ? [...config.middleware] : [];
	}

	// -----------------------------------------------------------------------
	// Static factory — auto-detect adapters from environment variables
	// -----------------------------------------------------------------------

	static fromEnv(config?: Partial<ClientConfig>): Client {
		const adapters: Record<string, ProviderAdapter> = {};
		let default_provider: string | undefined;

		// Check environment variables in priority order.
		const anthropicKey = process.env.ANTHROPIC_API_KEY;
		if (anthropicKey) {
			adapters.anthropic = new AnthropicAdapter({ api_key: anthropicKey });
			if (!default_provider) default_provider = "anthropic";
		}

		const openaiKey = process.env.OPENAI_API_KEY;
		if (openaiKey) {
			adapters.openai = new OpenAIAdapter({ api_key: openaiKey });
			if (!default_provider) default_provider = "openai";
		}

		const geminiKey = process.env.GEMINI_API_KEY;
		if (geminiKey) {
			adapters.gemini = new GeminiAdapter({ api_key: geminiKey });
			if (!default_provider) default_provider = "gemini";
		}

		// Merge with user-provided config — user adapters override env-detected ones.
		if (config?.adapters) {
			for (const [name, adapter] of Object.entries(config.adapters)) {
				adapters[name] = adapter;
			}
		}

		return new Client({
			adapters,
			default_provider: config?.default_provider ?? default_provider,
			middleware: config?.middleware,
		});
	}

	// -----------------------------------------------------------------------
	// Adapter registration & middleware
	// -----------------------------------------------------------------------

	registerAdapter(name: string, adapter: ProviderAdapter): void {
		this.adapters.set(name, adapter);
	}

	use(middleware: Middleware): void {
		this.middlewares.push(middleware);
	}

	/**
	 * Return the default model for a provider, or the default provider if none
	 * is specified.  Returns `undefined` when no matching adapter is registered.
	 */
	getDefaultModel(provider?: string): string | undefined {
		const name = provider ?? this.default_provider;
		if (name) {
			return this.adapters.get(name)?.default_model;
		}
		if (this.adapters.size === 1) {
			return this.adapters.values().next().value?.default_model;
		}
		return undefined;
	}

	// -----------------------------------------------------------------------
	// complete — non-streaming request
	// -----------------------------------------------------------------------

	async complete(request: Request): Promise<Response> {
		const resolved = this.resolveRequest(request);
		const adapter = this.getAdapter(resolved.provider!);

		const handler = (req: Request): Promise<Response> => adapter.complete(req);
		const chain = composeCompleteMiddleware(this.middlewares, handler);

		return chain(resolved);
	}

	// -----------------------------------------------------------------------
	// stream — streaming request
	// -----------------------------------------------------------------------

	stream(request: Request): AsyncIterableIterator<StreamEvent> {
		const resolved = this.resolveRequest(request);
		const adapter = this.getAdapter(resolved.provider!);

		const handler = (req: Request): AsyncIterableIterator<StreamEvent> => adapter.stream(req);
		const chain = composeStreamMiddleware(this.middlewares, handler);

		return chain(resolved);
	}

	// -----------------------------------------------------------------------
	// Private — provider resolution
	// -----------------------------------------------------------------------

	/**
	 * Resolve both provider and model for a request.
	 *
	 * Resolution order for provider:
	 *   1. Explicit `request.provider`
	 *   2. Inferred from model name prefix (claude-* → anthropic, etc.)
	 *   3. `default_provider` on the client
	 *   4. Single registered adapter
	 *
	 * Resolution for model:
	 *   - If `request.model` is set, use it as-is.
	 *   - Otherwise, use the resolved adapter's `default_model`.
	 */
	private resolveRequest(request: Request): Request {
		const provider = this.resolveProvider(request);
		const adapter = this.getAdapter(provider);
		const model = request.model || adapter.default_model;
		return { ...request, provider, model };
	}

	private resolveProvider(request: Request): string {
		// 1. Explicit provider on the request.
		if (request.provider) {
			return request.provider;
		}

		// 2. Infer from model name prefix (skip if model is empty/unset).
		if (request.model) {
			const inferred = inferProvider(request.model);
			if (inferred && this.adapters.has(inferred)) {
				return inferred;
			}
		}

		// 3. Default provider.
		if (this.default_provider) {
			return this.default_provider;
		}

		// 4. If only one adapter is registered, use that.
		if (this.adapters.size === 1) {
			return this.adapters.keys().next().value as string;
		}

		// 5. Cannot resolve — error.
		throw new ConfigurationError(
			`Unable to resolve provider for model "${request.model ?? "(none)"}". Set request.provider, configure a default_provider, or register exactly one adapter.`,
		);
	}

	private getAdapter(provider: string): ProviderAdapter {
		const adapter = this.adapters.get(provider);
		if (!adapter) {
			throw new ConfigurationError(
				`No adapter registered for provider "${provider}". ` +
					`Register one with client.registerAdapter("${provider}", adapter).`,
			);
		}
		return adapter;
	}
}
