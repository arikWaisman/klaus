import { redactUrl } from "./http.js";
import type { Request, Response, StreamEvent } from "./types.js";

// ---------------------------------------------------------------------------
// Middleware interface
// ---------------------------------------------------------------------------

export interface Middleware {
	name: string;
	complete?: (request: Request, next: (req: Request) => Promise<Response>) => Promise<Response>;
	stream?: (
		request: Request,
		next: (req: Request) => AsyncIterableIterator<StreamEvent>,
	) => AsyncIterableIterator<StreamEvent>;
}

// ---------------------------------------------------------------------------
// composeCompleteMiddleware
// ---------------------------------------------------------------------------

/**
 * Compose an array of middleware into a single handler for non-streaming
 * completion requests.  Middleware are applied in onion order: the first
 * registered middleware runs first on the request (outermost layer) and last
 * on the response.
 *
 * If a middleware does not define a `complete` hook it is skipped (the
 * request passes straight through to the next layer).
 *
 * The chain is built right-to-left so that invocation proceeds left-to-right.
 */
export function composeCompleteMiddleware(
	middlewares: Middleware[],
	handler: (req: Request) => Promise<Response>,
): (req: Request) => Promise<Response> {
	let composed = handler;

	for (let i = middlewares.length - 1; i >= 0; i--) {
		const mw = middlewares[i];
		if (mw.complete) {
			const next = composed;
			const completeFn = mw.complete;
			composed = (req: Request) => completeFn(req, next);
		}
	}

	return composed;
}

// ---------------------------------------------------------------------------
// composeStreamMiddleware
// ---------------------------------------------------------------------------

/**
 * Compose an array of middleware into a single handler for streaming
 * requests.  Same onion model as {@link composeCompleteMiddleware}.
 *
 * If a middleware does not define a `stream` hook it is skipped.
 */
export function composeStreamMiddleware(
	middlewares: Middleware[],
	handler: (req: Request) => AsyncIterableIterator<StreamEvent>,
): (req: Request) => AsyncIterableIterator<StreamEvent> {
	let composed = handler;

	for (let i = middlewares.length - 1; i >= 0; i--) {
		const mw = middlewares[i];
		if (mw.stream) {
			const next = composed;
			const streamFn = mw.stream;
			composed = (req: Request) => streamFn(req, next);
		}
	}

	return composed;
}

// ---------------------------------------------------------------------------
// loggingMiddleware
// ---------------------------------------------------------------------------

/** Sensitive header names that should be redacted in logs. */
const SENSITIVE_HEADERS = new Set(["authorization", "x-api-key", "api-key", "x-goog-api-key"]);

/** Redact known-sensitive header values. */
function redactHeaders(
	metadata: Record<string, string> | undefined,
): Record<string, string> | undefined {
	if (metadata === undefined) return undefined;
	const redacted: Record<string, string> = {};
	for (const [key, value] of Object.entries(metadata)) {
		if (SENSITIVE_HEADERS.has(key.toLowerCase())) {
			redacted[key] = "[REDACTED]";
		} else {
			redacted[key] = value;
		}
	}
	return redacted;
}

/**
 * A proof-of-concept logging middleware that logs request and response
 * details.
 *
 * - Logs the request model, provider, and message count before sending.
 * - Logs the response model, finish reason, and token usage after
 *   receiving.
 * - Redacts sensitive headers and URL query parameters (API keys).
 */
export function loggingMiddleware(options?: { logger?: (msg: string) => void }): Middleware {
	const log = options?.logger ?? console.log;

	function logRequest(request: Request): void {
		const parts: string[] = ["[llm-client] request", `model=${request.model}`];
		if (request.provider) {
			parts.push(`provider=${request.provider}`);
		}
		parts.push(`messages=${request.messages.length}`);

		if (request.metadata) {
			const safe = redactHeaders(request.metadata);
			parts.push(`metadata=${JSON.stringify(safe)}`);
		}

		log(parts.join(" "));
	}

	function logResponse(response: Response): void {
		const parts: string[] = [
			"[llm-client] response",
			`model=${response.model}`,
			`provider=${response.provider}`,
			`finish_reason=${response.finish_reason.reason}`,
		];

		const u = response.usage;
		parts.push(`usage(in=${u.input_tokens} out=${u.output_tokens} total=${u.total_tokens})`);

		if (u.reasoning_tokens !== undefined) {
			parts.push(`reasoning_tokens=${u.reasoning_tokens}`);
		}
		if (u.cache_read_tokens !== undefined) {
			parts.push(`cache_read=${u.cache_read_tokens}`);
		}
		if (u.cache_write_tokens !== undefined) {
			parts.push(`cache_write=${u.cache_write_tokens}`);
		}

		log(parts.join(" "));
	}

	return {
		name: "logging",

		async complete(request: Request, next: (req: Request) => Promise<Response>): Promise<Response> {
			logRequest(request);
			const response = await next(request);
			logResponse(response);
			return response;
		},

		async *stream(
			request: Request,
			next: (req: Request) => AsyncIterableIterator<StreamEvent>,
		): AsyncIterableIterator<StreamEvent> {
			logRequest(request);

			for await (const event of next(request)) {
				// Log the final response when the stream finishes.
				if (event.type === "FINISH" && event.response) {
					logResponse(event.response);
				}
				yield event;
			}
		},
	};
}

// Re-export redactUrl for convenience — consumers that build custom
// logging middleware can use it without importing from http.js directly.
export { redactUrl };
