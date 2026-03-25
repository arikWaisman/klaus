import { describe, expect, it } from "vitest";
import {
	AbortError,
	AccessDeniedError,
	AuthenticationError,
	ConfigurationError,
	ContentFilterError,
	ContextLengthError,
	InvalidRequestError,
	InvalidToolCallError,
	NetworkError,
	NoObjectGeneratedError,
	NotFoundError,
	ProviderError,
	QuotaExceededError,
	RateLimitError,
	RequestTimeoutError,
	SDKError,
	ServerError,
	StreamError,
	UnsupportedToolChoiceError,
	errorFromStatus,
	isRetryable,
	parseRetryAfter,
} from "../src/errors.js";

// ---------------------------------------------------------------------------
// Error hierarchy
// ---------------------------------------------------------------------------

describe("SDKError hierarchy", () => {
	it("SDKError extends Error", () => {
		const err = new SDKError("boom");
		expect(err).toBeInstanceOf(Error);
		expect(err).toBeInstanceOf(SDKError);
		expect(err.name).toBe("SDKError");
		expect(err.message).toBe("boom");
	});

	it("ProviderError extends SDKError", () => {
		const err = new ProviderError("provider boom", {
			provider: "openai",
			status_code: 500,
			retryable: true,
		});
		expect(err).toBeInstanceOf(SDKError);
		expect(err).toBeInstanceOf(ProviderError);
		expect(err.name).toBe("ProviderError");
		expect(err.provider).toBe("openai");
		expect(err.status_code).toBe(500);
		expect(err.retryable).toBe(true);
	});

	it("ProviderError stores optional fields", () => {
		const raw = { code: "rate_limit" };
		const err = new ProviderError("test", {
			provider: "anthropic",
			status_code: 429,
			retryable: true,
			error_code: "rate_limit",
			retry_after: 30,
			raw,
		});
		expect(err.error_code).toBe("rate_limit");
		expect(err.retry_after).toBe(30);
		expect(err.raw).toBe(raw);
	});

	it("AuthenticationError has status 401 and is not retryable", () => {
		const err = new AuthenticationError("bad key", { provider: "openai" });
		expect(err).toBeInstanceOf(ProviderError);
		expect(err.name).toBe("AuthenticationError");
		expect(err.status_code).toBe(401);
		expect(err.retryable).toBe(false);
	});

	it("AccessDeniedError has status 403 and is not retryable", () => {
		const err = new AccessDeniedError("forbidden", { provider: "openai" });
		expect(err).toBeInstanceOf(ProviderError);
		expect(err.name).toBe("AccessDeniedError");
		expect(err.status_code).toBe(403);
		expect(err.retryable).toBe(false);
	});

	it("NotFoundError has status 404 and is not retryable", () => {
		const err = new NotFoundError("model missing", { provider: "openai" });
		expect(err).toBeInstanceOf(ProviderError);
		expect(err.name).toBe("NotFoundError");
		expect(err.status_code).toBe(404);
		expect(err.retryable).toBe(false);
	});

	it("InvalidRequestError defaults to status 400", () => {
		const err = new InvalidRequestError("bad request", { provider: "openai" });
		expect(err.status_code).toBe(400);
		expect(err.retryable).toBe(false);
	});

	it("InvalidRequestError accepts custom status_code", () => {
		const err = new InvalidRequestError("unprocessable", {
			provider: "openai",
			status_code: 422,
		});
		expect(err.status_code).toBe(422);
	});

	it("ContextLengthError has status 413", () => {
		const err = new ContextLengthError("too long", { provider: "openai" });
		expect(err.status_code).toBe(413);
		expect(err.retryable).toBe(false);
	});

	it("ContentFilterError defaults to status 400", () => {
		const err = new ContentFilterError("filtered", { provider: "openai" });
		expect(err.status_code).toBe(400);
		expect(err.retryable).toBe(false);
	});

	it("QuotaExceededError defaults to status 429 and is not retryable", () => {
		const err = new QuotaExceededError("quota hit", { provider: "openai" });
		expect(err.status_code).toBe(429);
		expect(err.retryable).toBe(false);
	});

	it("RateLimitError has status 429 and is retryable", () => {
		const err = new RateLimitError("slow down", {
			provider: "openai",
			retry_after: 60,
		});
		expect(err.status_code).toBe(429);
		expect(err.retryable).toBe(true);
		expect(err.retry_after).toBe(60);
	});

	it("ServerError defaults to status 500 and is retryable", () => {
		const err = new ServerError("internal", { provider: "anthropic" });
		expect(err.status_code).toBe(500);
		expect(err.retryable).toBe(true);
	});

	it("ServerError accepts custom status_code", () => {
		const err = new ServerError("overloaded", {
			provider: "anthropic",
			status_code: 529,
		});
		expect(err.status_code).toBe(529);
		expect(err.retryable).toBe(true);
	});

	it("non-provider errors extend SDKError", () => {
		expect(new RequestTimeoutError("timeout")).toBeInstanceOf(SDKError);
		expect(new AbortError("aborted")).toBeInstanceOf(SDKError);
		expect(new NetworkError("network")).toBeInstanceOf(SDKError);
		expect(new StreamError("stream")).toBeInstanceOf(SDKError);
		expect(new InvalidToolCallError("bad tool")).toBeInstanceOf(SDKError);
		expect(new UnsupportedToolChoiceError("unsupported")).toBeInstanceOf(SDKError);
		expect(new NoObjectGeneratedError("no object")).toBeInstanceOf(SDKError);
		expect(new ConfigurationError("config")).toBeInstanceOf(SDKError);
	});

	it("non-provider errors have correct names", () => {
		expect(new RequestTimeoutError("t").name).toBe("RequestTimeoutError");
		expect(new AbortError("t").name).toBe("AbortError");
		expect(new NetworkError("t").name).toBe("NetworkError");
		expect(new StreamError("t").name).toBe("StreamError");
		expect(new InvalidToolCallError("t").name).toBe("InvalidToolCallError");
		expect(new UnsupportedToolChoiceError("t").name).toBe("UnsupportedToolChoiceError");
		expect(new NoObjectGeneratedError("t").name).toBe("NoObjectGeneratedError");
		expect(new ConfigurationError("t").name).toBe("ConfigurationError");
	});
});

// ---------------------------------------------------------------------------
// isRetryable
// ---------------------------------------------------------------------------

describe("isRetryable", () => {
	it("returns true for RateLimitError", () => {
		const err = new RateLimitError("rate", { provider: "openai" });
		expect(isRetryable(err)).toBe(true);
	});

	it("returns true for ServerError", () => {
		const err = new ServerError("server", { provider: "openai" });
		expect(isRetryable(err)).toBe(true);
	});

	it("returns true for NetworkError", () => {
		const err = new NetworkError("net");
		expect(isRetryable(err)).toBe(true);
	});

	it("returns true for StreamError", () => {
		const err = new StreamError("stream");
		expect(isRetryable(err)).toBe(true);
	});

	it("returns false for AuthenticationError", () => {
		const err = new AuthenticationError("auth", { provider: "openai" });
		expect(isRetryable(err)).toBe(false);
	});

	it("returns false for InvalidRequestError", () => {
		const err = new InvalidRequestError("bad", { provider: "openai" });
		expect(isRetryable(err)).toBe(false);
	});

	it("returns false for AccessDeniedError", () => {
		const err = new AccessDeniedError("denied", { provider: "openai" });
		expect(isRetryable(err)).toBe(false);
	});

	it("returns false for NotFoundError", () => {
		const err = new NotFoundError("missing", { provider: "openai" });
		expect(isRetryable(err)).toBe(false);
	});

	it("returns false for ContextLengthError", () => {
		const err = new ContextLengthError("too long", { provider: "openai" });
		expect(isRetryable(err)).toBe(false);
	});

	it("returns false for ContentFilterError", () => {
		const err = new ContentFilterError("filtered", { provider: "openai" });
		expect(isRetryable(err)).toBe(false);
	});

	it("returns false for QuotaExceededError", () => {
		const err = new QuotaExceededError("quota", { provider: "openai" });
		expect(isRetryable(err)).toBe(false);
	});

	it("returns false for non-SDK errors", () => {
		expect(isRetryable(new Error("generic"))).toBe(false);
	});

	it("returns false for non-error values", () => {
		expect(isRetryable(null)).toBe(false);
		expect(isRetryable(undefined)).toBe(false);
		expect(isRetryable("string")).toBe(false);
		expect(isRetryable(42)).toBe(false);
	});

	it("returns false for plain SDKError", () => {
		expect(isRetryable(new SDKError("sdk"))).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// parseRetryAfter
// ---------------------------------------------------------------------------

describe("parseRetryAfter", () => {
	it("parses integer seconds", () => {
		const headers = new Headers({ "retry-after": "120" });
		expect(parseRetryAfter(headers)).toBe(120);
	});

	it("parses zero seconds", () => {
		const headers = new Headers({ "retry-after": "0" });
		expect(parseRetryAfter(headers)).toBe(0);
	});

	it("parses HTTP-date format", () => {
		// Set the date to 60 seconds in the future
		const future = new Date(Date.now() + 60_000);
		const headers = new Headers({
			"retry-after": future.toUTCString(),
		});
		const result = parseRetryAfter(headers);
		expect(result).toBeTypeOf("number");
		// Should be approximately 60 seconds (allow some tolerance for test execution time)
		expect(result).toBeGreaterThanOrEqual(58);
		expect(result).toBeLessThanOrEqual(62);
	});

	it("returns at least 0 for HTTP-date in the past", () => {
		const past = new Date(Date.now() - 60_000);
		const headers = new Headers({
			"retry-after": past.toUTCString(),
		});
		expect(parseRetryAfter(headers)).toBe(0);
	});

	it("returns undefined when headers are missing", () => {
		expect(parseRetryAfter(undefined)).toBeUndefined();
	});

	it("returns undefined when retry-after header is absent", () => {
		const headers = new Headers({ "content-type": "application/json" });
		expect(parseRetryAfter(headers)).toBeUndefined();
	});

	it("returns undefined for unparseable value", () => {
		const headers = new Headers({ "retry-after": "not-a-number-or-date" });
		expect(parseRetryAfter(headers)).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// errorFromStatus
// ---------------------------------------------------------------------------

describe("errorFromStatus", () => {
	const provider = "test-provider";
	const body = { error: { message: "something went wrong" } };

	it("maps 400 to InvalidRequestError", () => {
		const err = errorFromStatus(provider, 400, body);
		expect(err).toBeInstanceOf(InvalidRequestError);
		expect(err.status_code).toBe(400);
		expect(err.message).toBe("something went wrong");
		expect(err.provider).toBe(provider);
	});

	it("maps 422 to InvalidRequestError", () => {
		const err = errorFromStatus(provider, 422, body);
		expect(err).toBeInstanceOf(InvalidRequestError);
		expect(err.status_code).toBe(422);
	});

	it("maps 401 to AuthenticationError", () => {
		const err = errorFromStatus(provider, 401, body);
		expect(err).toBeInstanceOf(AuthenticationError);
		expect(err.status_code).toBe(401);
	});

	it("maps 403 to AccessDeniedError", () => {
		const err = errorFromStatus(provider, 403, body);
		expect(err).toBeInstanceOf(AccessDeniedError);
		expect(err.status_code).toBe(403);
	});

	it("maps 404 to NotFoundError", () => {
		const err = errorFromStatus(provider, 404, body);
		expect(err).toBeInstanceOf(NotFoundError);
		expect(err.status_code).toBe(404);
	});

	it("maps 408 by throwing RequestTimeoutError", () => {
		expect(() => errorFromStatus(provider, 408, body)).toThrow(RequestTimeoutError);
	});

	it("maps 413 to ContextLengthError", () => {
		const err = errorFromStatus(provider, 413, body);
		expect(err).toBeInstanceOf(ContextLengthError);
		expect(err.status_code).toBe(413);
	});

	it("maps 429 to RateLimitError", () => {
		const err = errorFromStatus(provider, 429, body);
		expect(err).toBeInstanceOf(RateLimitError);
		expect(err.status_code).toBe(429);
		expect(err.retryable).toBe(true);
	});

	it("maps 429 with Retry-After header", () => {
		const headers = new Headers({ "retry-after": "30" });
		const err = errorFromStatus(provider, 429, body, headers);
		expect(err).toBeInstanceOf(RateLimitError);
		expect(err.retry_after).toBe(30);
	});

	it("maps 500 to ServerError", () => {
		const err = errorFromStatus(provider, 500, body);
		expect(err).toBeInstanceOf(ServerError);
		expect(err.status_code).toBe(500);
		expect(err.retryable).toBe(true);
	});

	it("maps 529 to ServerError", () => {
		const err = errorFromStatus(provider, 529, body);
		expect(err).toBeInstanceOf(ServerError);
		expect(err.status_code).toBe(529);
	});

	it("maps 502 to ServerError (generic 5xx)", () => {
		const err = errorFromStatus(provider, 502, body);
		expect(err).toBeInstanceOf(ServerError);
		expect(err.status_code).toBe(502);
	});

	it("maps 503 to ServerError (generic 5xx)", () => {
		const err = errorFromStatus(provider, 503, body);
		expect(err).toBeInstanceOf(ServerError);
		expect(err.status_code).toBe(503);
	});

	it("maps unknown status to generic ProviderError", () => {
		const err = errorFromStatus(provider, 418, body);
		expect(err).toBeInstanceOf(ProviderError);
		expect(err.status_code).toBe(418);
	});

	it("extracts message from body.error.message", () => {
		const err = errorFromStatus(provider, 400, {
			error: { message: "invalid param" },
		});
		expect(err.message).toBe("invalid param");
	});

	it("extracts message from body.message", () => {
		const err = errorFromStatus(provider, 400, {
			message: "top-level message",
		});
		expect(err.message).toBe("top-level message");
	});

	it("extracts message from body.error when it is a string", () => {
		const err = errorFromStatus(provider, 400, {
			error: "string error",
		});
		expect(err.message).toBe("string error");
	});

	it("falls back to generic message when body has no recognizable message", () => {
		const err = errorFromStatus(provider, 400, { foo: "bar" });
		expect(err.message).toBe("test-provider API error: HTTP 400");
	});

	it("stores the raw body on the error", () => {
		const rawBody = { error: { message: "err" }, extra: "data" };
		const err = errorFromStatus(provider, 400, rawBody);
		expect(err.raw).toBe(rawBody);
	});
});
