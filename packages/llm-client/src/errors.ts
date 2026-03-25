// ---------------------------------------------------------------------------
// SDKError hierarchy for @klaus/llm-client
// ---------------------------------------------------------------------------

// ---- Base error -----------------------------------------------------------

export class SDKError extends Error {
	override readonly name: string = "SDKError";
}

// ---- Provider errors (HTTP / API layer) -----------------------------------

export class ProviderError extends SDKError {
	override readonly name: string = "ProviderError";

	readonly provider: string;
	readonly status_code: number;
	readonly error_code: string | undefined;
	readonly retryable: boolean;
	readonly retry_after: number | undefined;
	readonly raw: Record<string, unknown> | undefined;

	constructor(
		message: string,
		opts: {
			provider: string;
			status_code: number;
			error_code?: string;
			retryable: boolean;
			retry_after?: number;
			raw?: Record<string, unknown>;
		},
	) {
		super(message);
		this.provider = opts.provider;
		this.status_code = opts.status_code;
		this.error_code = opts.error_code;
		this.retryable = opts.retryable;
		this.retry_after = opts.retry_after;
		this.raw = opts.raw;
	}
}

export class AuthenticationError extends ProviderError {
	override readonly name = "AuthenticationError";

	constructor(
		message: string,
		opts: {
			provider: string;
			error_code?: string;
			raw?: Record<string, unknown>;
		},
	) {
		super(message, { ...opts, status_code: 401, retryable: false });
	}
}

export class AccessDeniedError extends ProviderError {
	override readonly name = "AccessDeniedError";

	constructor(
		message: string,
		opts: {
			provider: string;
			error_code?: string;
			raw?: Record<string, unknown>;
		},
	) {
		super(message, { ...opts, status_code: 403, retryable: false });
	}
}

export class NotFoundError extends ProviderError {
	override readonly name = "NotFoundError";

	constructor(
		message: string,
		opts: {
			provider: string;
			error_code?: string;
			raw?: Record<string, unknown>;
		},
	) {
		super(message, { ...opts, status_code: 404, retryable: false });
	}
}

export class InvalidRequestError extends ProviderError {
	override readonly name = "InvalidRequestError";

	constructor(
		message: string,
		opts: {
			provider: string;
			status_code?: number;
			error_code?: string;
			raw?: Record<string, unknown>;
		},
	) {
		super(message, {
			...opts,
			status_code: opts.status_code ?? 400,
			retryable: false,
		});
	}
}

export class ContextLengthError extends ProviderError {
	override readonly name = "ContextLengthError";

	constructor(
		message: string,
		opts: {
			provider: string;
			error_code?: string;
			raw?: Record<string, unknown>;
		},
	) {
		super(message, { ...opts, status_code: 413, retryable: false });
	}
}

export class ContentFilterError extends ProviderError {
	override readonly name = "ContentFilterError";

	constructor(
		message: string,
		opts: {
			provider: string;
			status_code?: number;
			error_code?: string;
			raw?: Record<string, unknown>;
		},
	) {
		super(message, {
			...opts,
			status_code: opts.status_code ?? 400,
			retryable: false,
		});
	}
}

export class QuotaExceededError extends ProviderError {
	override readonly name = "QuotaExceededError";

	constructor(
		message: string,
		opts: {
			provider: string;
			status_code?: number;
			error_code?: string;
			raw?: Record<string, unknown>;
		},
	) {
		super(message, {
			...opts,
			status_code: opts.status_code ?? 429,
			retryable: false,
		});
	}
}

export class RateLimitError extends ProviderError {
	override readonly name = "RateLimitError";

	constructor(
		message: string,
		opts: {
			provider: string;
			error_code?: string;
			retry_after?: number;
			raw?: Record<string, unknown>;
		},
	) {
		super(message, { ...opts, status_code: 429, retryable: true });
	}
}

export class ServerError extends ProviderError {
	override readonly name = "ServerError";

	constructor(
		message: string,
		opts: {
			provider: string;
			status_code?: number;
			error_code?: string;
			raw?: Record<string, unknown>;
		},
	) {
		super(message, {
			...opts,
			status_code: opts.status_code ?? 500,
			retryable: true,
		});
	}
}

// ---- Non-provider errors --------------------------------------------------

export class RequestTimeoutError extends SDKError {
	override readonly name = "RequestTimeoutError";
}

export class AbortError extends SDKError {
	override readonly name = "AbortError";
}

export class NetworkError extends SDKError {
	override readonly name = "NetworkError";
	readonly retryable = true;
}

export class StreamError extends SDKError {
	override readonly name = "StreamError";
	readonly retryable = true;
}

export class InvalidToolCallError extends SDKError {
	override readonly name = "InvalidToolCallError";
}

export class UnsupportedToolChoiceError extends SDKError {
	override readonly name = "UnsupportedToolChoiceError";
}

export class NoObjectGeneratedError extends SDKError {
	override readonly name = "NoObjectGeneratedError";
}

export class ConfigurationError extends SDKError {
	override readonly name = "ConfigurationError";
}

// ---- Helpers --------------------------------------------------------------

/**
 * Returns `true` when the given error is known to be safe to retry.
 */
export function isRetryable(error: unknown): boolean {
	if (error instanceof ProviderError) {
		return error.retryable;
	}
	if (error instanceof NetworkError || error instanceof StreamError) {
		return error.retryable;
	}
	return false;
}

/**
 * Parse the `Retry-After` header value.
 *
 * Supports both integer seconds (e.g. `"120"`) and HTTP-date format
 * (e.g. `"Wed, 21 Oct 2015 07:28:00 GMT"`).  Returns `undefined` when
 * the header is missing or cannot be parsed.
 */
export function parseRetryAfter(headers?: Headers): number | undefined {
	if (!headers) return undefined;

	const value = headers.get("retry-after");
	if (value == null) return undefined;

	// Try integer seconds first.
	const seconds = Number(value);
	if (Number.isFinite(seconds) && seconds >= 0) {
		return seconds;
	}

	// Try HTTP-date format.
	const date = new Date(value);
	if (!Number.isNaN(date.getTime())) {
		const delta = (date.getTime() - Date.now()) / 1000;
		return Math.max(0, Math.ceil(delta));
	}

	return undefined;
}

// ---- Error message extraction ---------------------------------------------

interface BodyWithError {
	error?: { message?: string } | string;
	message?: string;
}

function extractMessage(provider: string, status: number, body: Record<string, unknown>): string {
	const b = body as BodyWithError;

	if (typeof b.error === "object" && b.error !== null && typeof b.error.message === "string") {
		return b.error.message;
	}
	if (typeof b.message === "string") {
		return b.message;
	}
	if (typeof b.error === "string") {
		return b.error;
	}
	return `${provider} API error: HTTP ${status}`;
}

// ---- Factory --------------------------------------------------------------

/**
 * Map an HTTP status code (and optional response body / headers) to the
 * appropriate `ProviderError` subclass.
 */
export function errorFromStatus(
	provider: string,
	status: number,
	body: Record<string, unknown>,
	headers?: Headers,
): ProviderError {
	const message = extractMessage(provider, status, body);
	const raw = body;

	switch (status) {
		case 400:
		case 422:
			return new InvalidRequestError(message, {
				provider,
				status_code: status,
				raw,
			});
		case 401:
			return new AuthenticationError(message, { provider, raw });
		case 403:
			return new AccessDeniedError(message, { provider, raw });
		case 404:
			return new NotFoundError(message, { provider, raw });
		case 408:
			throw new RequestTimeoutError(message);
		case 413:
			return new ContextLengthError(message, { provider, raw });
		case 429:
			return new RateLimitError(message, {
				provider,
				retry_after: parseRetryAfter(headers),
				raw,
			});
		case 529:
			return new ServerError(message, {
				provider,
				status_code: status,
				raw,
			});
		default:
			if (status >= 500 && status < 600) {
				return new ServerError(message, {
					provider,
					status_code: status,
					raw,
				});
			}
			return new ProviderError(message, {
				provider,
				status_code: status,
				retryable: true,
				raw,
			});
	}
}
