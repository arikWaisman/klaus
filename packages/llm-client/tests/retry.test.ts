import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	AbortError,
	AuthenticationError,
	InvalidRequestError,
	NetworkError,
	RateLimitError,
	ServerError,
} from "../src/errors.js";
import { withRetry } from "../src/retry.js";
import type { RetryPolicy } from "../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a retry policy with no jitter and short delays for testing. */
function testPolicy(overrides: Partial<RetryPolicy> = {}): RetryPolicy {
	return {
		max_retries: 3,
		base_delay: 1,
		max_delay: 60,
		backoff_multiplier: 2,
		jitter: false,
		...overrides,
	};
}

/**
 * Build an async function that throws for the first N calls and then
 * resolves.  Using a closure that throws synchronously inside an async
 * function avoids the "PromiseRejectionHandledWarning" that
 * `vi.fn().mockRejectedValueOnce()` can trigger with fake timers.
 */
function failThenSucceed<T>(error: Error, failures: number, value: T): () => Promise<T> {
	let calls = 0;
	return async () => {
		calls++;
		if (calls <= failures) {
			throw error;
		}
		return value;
	};
}

/** Build an async function that always throws. */
function alwaysFail<T>(error: Error): () => Promise<T> {
	return async () => {
		throw error;
	};
}

// ---------------------------------------------------------------------------
// Setup / teardown for fake timers
// ---------------------------------------------------------------------------

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// withRetry
// ---------------------------------------------------------------------------

describe("withRetry", () => {
	it("succeeds on first attempt without retrying", async () => {
		const fn = vi.fn(async () => "success");

		const promise = withRetry(fn, { policy: testPolicy() });
		await vi.runAllTimersAsync();
		const result = await promise;

		expect(result).toBe("success");
		expect(fn).toHaveBeenCalledOnce();
	});

	it("retries on RateLimitError (retryable)", async () => {
		const error = new RateLimitError("rate limited", { provider: "openai" });
		const fn = vi.fn(failThenSucceed(error, 2, "success"));

		const promise = withRetry(fn, { policy: testPolicy() });
		await vi.runAllTimersAsync();
		const result = await promise;

		expect(result).toBe("success");
		expect(fn).toHaveBeenCalledTimes(3);
	});

	it("retries on ServerError (retryable)", async () => {
		const error = new ServerError("server error", { provider: "anthropic" });
		const fn = vi.fn(failThenSucceed(error, 1, "recovered"));

		const promise = withRetry(fn, { policy: testPolicy() });
		await vi.runAllTimersAsync();
		const result = await promise;

		expect(result).toBe("recovered");
		expect(fn).toHaveBeenCalledTimes(2);
	});

	it("retries on NetworkError (retryable)", async () => {
		const error = new NetworkError("connection reset");
		const fn = vi.fn(failThenSucceed(error, 1, "reconnected"));

		const promise = withRetry(fn, { policy: testPolicy() });
		await vi.runAllTimersAsync();
		const result = await promise;

		expect(result).toBe("reconnected");
		expect(fn).toHaveBeenCalledTimes(2);
	});

	it("does NOT retry on AuthenticationError (non-retryable)", async () => {
		const error = new AuthenticationError("bad key", { provider: "anthropic" });
		const fn = vi.fn(alwaysFail(error));

		const promise = withRetry(fn, { policy: testPolicy() });

		await expect(promise).rejects.toThrow(AuthenticationError);
		expect(fn).toHaveBeenCalledOnce();
	});

	it("does NOT retry on InvalidRequestError (non-retryable)", async () => {
		const error = new InvalidRequestError("bad request", { provider: "openai" });
		const fn = vi.fn(alwaysFail(error));

		const promise = withRetry(fn, { policy: testPolicy() });

		await expect(promise).rejects.toThrow(InvalidRequestError);
		expect(fn).toHaveBeenCalledOnce();
	});

	it("respects max_retries limit", async () => {
		const error = new RateLimitError("rate limited", { provider: "openai" });
		const fn = vi.fn(alwaysFail(error));

		const policy = testPolicy({ max_retries: 2 });
		const promise = withRetry(fn, { policy });

		// Attach the rejection handler before advancing timers so the
		// rejection is always caught synchronously by vitest.
		const assertion = expect(promise).rejects.toThrow(RateLimitError);
		await vi.runAllTimersAsync();
		await assertion;

		// Initial attempt + 2 retries = 3 total calls
		expect(fn).toHaveBeenCalledTimes(3);
	});

	it("calls on_retry callback with correct arguments", async () => {
		const error = new ServerError("server down", { provider: "anthropic" });
		const onRetry = vi.fn();
		const fn = vi.fn(failThenSucceed(error, 2, "success"));

		const policy = testPolicy({ on_retry: onRetry });
		const promise = withRetry(fn, { policy });
		await vi.runAllTimersAsync();
		await promise;

		expect(onRetry).toHaveBeenCalledTimes(2);

		// First retry: attempt=1, delay=1*2^0=1
		expect(onRetry).toHaveBeenNthCalledWith(1, error, 1, 1);

		// Second retry: attempt=2, delay=1*2^1=2
		expect(onRetry).toHaveBeenNthCalledWith(2, error, 2, 2);
	});

	it("respects abort signal (already aborted)", async () => {
		const controller = new AbortController();
		controller.abort();

		const fn = vi.fn(async () => "should not run");

		const promise = withRetry(fn, {
			policy: testPolicy(),
			abort_signal: controller.signal,
		});

		await expect(promise).rejects.toThrow(AbortError);
		expect(fn).not.toHaveBeenCalled();
	});

	it("respects abort signal (aborted during sleep)", async () => {
		const controller = new AbortController();
		const error = new RateLimitError("rate limited", { provider: "openai" });

		const fn = vi.fn(failThenSucceed(error, 1, "should not reach"));

		const promise = withRetry(fn, {
			policy: testPolicy(),
			abort_signal: controller.signal,
		});

		// Attach the rejection handler before triggering the abort so
		// the rejection is always caught by vitest.
		const assertion = expect(promise).rejects.toThrow(AbortError);

		// Let the first attempt fail and enter sleep.
		await vi.advanceTimersByTimeAsync(0);

		// Abort while sleeping -- this triggers the abort listener inside sleep().
		controller.abort();

		// Flush any remaining microtasks.
		await vi.advanceTimersByTimeAsync(0);

		await assertion;
	});

	it("uses retry_after from error when available and within max_delay", async () => {
		const error = new RateLimitError("rate limited", {
			provider: "openai",
			retry_after: 5,
		});
		const onRetry = vi.fn();

		const fn = vi.fn(failThenSucceed(error, 1, "success"));

		const policy = testPolicy({ on_retry: onRetry, max_delay: 60 });
		const promise = withRetry(fn, { policy });
		await vi.runAllTimersAsync();
		await promise;

		// The delay should be the retry_after value (5), not the computed backoff (1)
		expect(onRetry).toHaveBeenCalledWith(error, 1, 5);
	});

	it("ignores retry_after when it exceeds max_delay", async () => {
		const error = new RateLimitError("rate limited", {
			provider: "openai",
			retry_after: 120,
		});
		const onRetry = vi.fn();

		const fn = vi.fn(failThenSucceed(error, 1, "success"));

		// max_delay is 10, retry_after (120) exceeds it, so computed delay should be used
		const policy = testPolicy({ on_retry: onRetry, max_delay: 10 });
		const promise = withRetry(fn, { policy });
		await vi.runAllTimersAsync();
		await promise;

		// Delay should be the capped computed delay (min(1*2^0, 10) = 1), not 120
		expect(onRetry).toHaveBeenCalledWith(error, 1, 1);
	});

	it("applies exponential backoff correctly", async () => {
		const error = new ServerError("down", { provider: "anthropic" });
		const onRetry = vi.fn();

		const fn = vi.fn(failThenSucceed(error, 3, "success"));

		const policy = testPolicy({
			base_delay: 1,
			backoff_multiplier: 2,
			max_delay: 60,
			on_retry: onRetry,
		});

		const promise = withRetry(fn, { policy });
		await vi.runAllTimersAsync();
		await promise;

		// attempt 0: delay = 1 * 2^0 = 1
		expect(onRetry).toHaveBeenNthCalledWith(1, error, 1, 1);
		// attempt 1: delay = 1 * 2^1 = 2
		expect(onRetry).toHaveBeenNthCalledWith(2, error, 2, 2);
		// attempt 2: delay = 1 * 2^2 = 4
		expect(onRetry).toHaveBeenNthCalledWith(3, error, 3, 4);
	});

	it("caps delay at max_delay", async () => {
		const error = new ServerError("down", { provider: "anthropic" });
		const onRetry = vi.fn();

		const fn = vi.fn(failThenSucceed(error, 2, "success"));

		const policy = testPolicy({
			base_delay: 10,
			backoff_multiplier: 10,
			max_delay: 15,
			on_retry: onRetry,
		});

		const promise = withRetry(fn, { policy });
		await vi.runAllTimersAsync();
		await promise;

		// attempt 0: delay = min(10 * 10^0, 15) = min(10, 15) = 10
		expect(onRetry).toHaveBeenNthCalledWith(1, error, 1, 10);
		// attempt 1: delay = min(10 * 10^1, 15) = min(100, 15) = 15
		expect(onRetry).toHaveBeenNthCalledWith(2, error, 2, 15);
	});

	it("uses default retry policy when none is specified", async () => {
		const error = new RateLimitError("rate limited", { provider: "openai" });
		const fn = vi.fn(alwaysFail(error));

		const promise = withRetry(fn);

		// Attach the rejection handler before advancing timers.
		const assertion = expect(promise).rejects.toThrow(RateLimitError);
		await vi.runAllTimersAsync();
		await assertion;

		// Default policy has max_retries: 2, so 3 total attempts
		expect(fn).toHaveBeenCalledTimes(3);
	});

	it("applies jitter when enabled", async () => {
		vi.spyOn(Math, "random").mockReturnValue(0.5);

		const error = new ServerError("down", { provider: "openai" });
		const onRetry = vi.fn();

		const fn = vi.fn(failThenSucceed(error, 1, "success"));

		const policy = testPolicy({
			base_delay: 2,
			backoff_multiplier: 1,
			jitter: true,
			on_retry: onRetry,
		});

		const promise = withRetry(fn, { policy });
		await vi.runAllTimersAsync();
		await promise;

		// With jitter and Math.random() = 0.5: delay = 2 * (0.5 + 0.5) = 2
		expect(onRetry).toHaveBeenCalledWith(error, 1, 2);

		vi.spyOn(Math, "random").mockRestore();
	});
});
