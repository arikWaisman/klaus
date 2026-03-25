import {
	NetworkError,
	AbortError as SDKAbortError,
	StreamError,
	errorFromStatus,
} from "./errors.js";
import { type SSEEvent, parseSSEStream } from "./sse.js";
import type { RateLimitInfo } from "./types.js";

// ---------------------------------------------------------------------------
// FetchOptions
// ---------------------------------------------------------------------------

export interface FetchOptions {
	method?: string;
	headers?: Record<string, string>;
	body?: unknown;
	signal?: AbortSignal;
	timeout?: number;
}

// ---------------------------------------------------------------------------
// fetchJSON
// ---------------------------------------------------------------------------

export async function fetchJSON<T>(
	url: string,
	provider: string,
	options: FetchOptions,
): Promise<{ data: T; headers: Headers; rate_limit?: RateLimitInfo }> {
	const { signal, controller, timeoutId } = buildAbortHandles(options);

	try {
		const headers: Record<string, string> = { ...options.headers };
		let requestBody: string | undefined;

		if (options.body !== undefined) {
			headers["Content-Type"] = "application/json";
			requestBody = JSON.stringify(options.body);
		}

		const response = await fetch(url, {
			method: options.method ?? "POST",
			headers,
			body: requestBody,
			signal,
		});

		if (!response.ok) {
			let body: Record<string, unknown>;
			try {
				body = (await response.json()) as Record<string, unknown>;
			} catch {
				body = {};
			}
			throw errorFromStatus(provider, response.status, body, response.headers);
		}

		const data = (await response.json()) as T;
		const rate_limit = extractRateLimitInfo(response.headers);

		return { data, headers: response.headers, rate_limit };
	} catch (error: unknown) {
		throw wrapFetchError(error);
	} finally {
		if (timeoutId !== undefined) {
			clearTimeout(timeoutId);
		}
		// Remove the abort listener added by buildAbortHandles if applicable
		if (controller && options.signal) {
			options.signal.removeEventListener("abort", controller.abort);
		}
	}
}

// ---------------------------------------------------------------------------
// fetchSSE
// ---------------------------------------------------------------------------

export async function* fetchSSE(
	url: string,
	provider: string,
	options: FetchOptions,
): AsyncIterableIterator<SSEEvent> {
	const { signal, controller, timeoutId } = buildAbortHandles(options);

	try {
		const headers: Record<string, string> = {
			...options.headers,
			Accept: "text/event-stream",
		};
		let requestBody: string | undefined;

		if (options.body !== undefined) {
			headers["Content-Type"] = "application/json";
			requestBody = JSON.stringify(options.body);
		}

		const response = await fetch(url, {
			method: options.method ?? "POST",
			headers,
			body: requestBody,
			signal,
		});

		if (!response.ok) {
			let body: Record<string, unknown>;
			try {
				body = (await response.json()) as Record<string, unknown>;
			} catch {
				body = {};
			}
			throw errorFromStatus(provider, response.status, body, response.headers);
		}

		if (response.body === null) {
			throw new StreamError("Response body is null");
		}

		// Clear timeout once the connection is established — the stream
		// can legitimately stay open for a long time.
		if (timeoutId !== undefined) {
			clearTimeout(timeoutId);
		}

		yield* parseSSEStream(response.body, options.signal);
	} catch (error: unknown) {
		throw wrapFetchError(error);
	} finally {
		if (timeoutId !== undefined) {
			clearTimeout(timeoutId);
		}
		if (controller && options.signal) {
			options.signal.removeEventListener("abort", controller.abort);
		}
	}
}

// ---------------------------------------------------------------------------
// extractRateLimitInfo
// ---------------------------------------------------------------------------

export function extractRateLimitInfo(headers: Headers): RateLimitInfo | undefined {
	const requestsLimit = parseIntHeader(headers, "x-ratelimit-limit-requests", "x-ratelimit-limit");
	const requestsRemaining = parseIntHeader(
		headers,
		"x-ratelimit-remaining-requests",
		"x-ratelimit-remaining",
	);
	const tokensLimit = parseIntHeader(headers, "x-ratelimit-limit-tokens");
	const tokensRemaining = parseIntHeader(headers, "x-ratelimit-remaining-tokens");
	const resetAt = parseDateHeader(headers, "x-ratelimit-reset-requests", "x-ratelimit-reset");

	if (
		requestsLimit === undefined &&
		requestsRemaining === undefined &&
		tokensLimit === undefined &&
		tokensRemaining === undefined &&
		resetAt === undefined
	) {
		return undefined;
	}

	return {
		requests_limit: requestsLimit,
		requests_remaining: requestsRemaining,
		tokens_limit: tokensLimit,
		tokens_remaining: tokensRemaining,
		reset_at: resetAt,
	};
}

// ---------------------------------------------------------------------------
// redactUrl
// ---------------------------------------------------------------------------

export function redactUrl(url: string): string {
	return url.replace(/([?&]key=)[^&]*/gi, "$1[REDACTED]");
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function parseIntHeader(headers: Headers, ...names: string[]): number | undefined {
	for (const name of names) {
		const value = headers.get(name);
		if (value !== null) {
			const parsed = Number.parseInt(value, 10);
			if (!Number.isNaN(parsed)) {
				return parsed;
			}
		}
	}
	return undefined;
}

function parseDateHeader(headers: Headers, ...names: string[]): Date | undefined {
	for (const name of names) {
		const value = headers.get(name);
		if (value !== null) {
			const date = new Date(value);
			if (!Number.isNaN(date.getTime())) {
				return date;
			}
		}
	}
	return undefined;
}

/**
 * Build an AbortSignal that fires on *either* the caller's signal or a
 * timeout.  Returns both the derived signal and the timeout id so the
 * caller can clean up.
 */
function buildAbortHandles(options: FetchOptions): {
	signal: AbortSignal | undefined;
	controller: AbortController | undefined;
	timeoutId: ReturnType<typeof setTimeout> | undefined;
} {
	if (options.timeout === undefined && options.signal === undefined) {
		return { signal: undefined, controller: undefined, timeoutId: undefined };
	}

	if (options.timeout === undefined) {
		return {
			signal: options.signal,
			controller: undefined,
			timeoutId: undefined,
		};
	}

	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), options.timeout);

	// If the caller also supplied a signal, forward its abort.
	if (options.signal) {
		if (options.signal.aborted) {
			controller.abort();
		} else {
			options.signal.addEventListener("abort", () => controller.abort(), {
				once: true,
			});
		}
	}

	return { signal: controller.signal, controller, timeoutId };
}

/**
 * Wrap raw fetch errors into SDK error types.
 */
function wrapFetchError(error: unknown): unknown {
	// Already an SDK error — rethrow as-is.
	if (
		error instanceof NetworkError ||
		error instanceof StreamError ||
		error instanceof SDKAbortError
	) {
		return error;
	}

	// Re-throw ProviderError subclasses produced by errorFromStatus.
	if (
		error instanceof Error &&
		error.constructor.name !== "TypeError" &&
		error.constructor.name !== "DOMException" &&
		error.name !== "AbortError"
	) {
		return error;
	}

	if (error instanceof TypeError) {
		return new NetworkError(error.message);
	}

	if (error instanceof DOMException && error.name === "AbortError") {
		return new SDKAbortError(error.message);
	}

	if (error instanceof Error && error.name === "AbortError") {
		return new SDKAbortError(error.message);
	}

	return error;
}
