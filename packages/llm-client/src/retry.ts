import type { Client } from "./client.js";
import { AbortError, isRetryable } from "./errors.js";
import type { Request, Response, RetryPolicy, StreamEvent } from "./types.js";
import { DEFAULT_RETRY_POLICY } from "./types.js";

// ---------------------------------------------------------------------------
// withRetry — exponential backoff with jitter and Retry-After support
// ---------------------------------------------------------------------------

export interface RetryOptions {
	policy?: RetryPolicy;
	abort_signal?: AbortSignal;
}

function computeDelay(policy: RetryPolicy, attempt: number, error: unknown): number {
	// Base exponential delay
	let delay = policy.base_delay * policy.backoff_multiplier ** attempt;

	// Cap at max_delay
	delay = Math.min(delay, policy.max_delay);

	// Apply jitter: multiply by a random factor in [0.5, 1.5]
	if (policy.jitter) {
		delay = delay * (0.5 + Math.random());
	}

	// If the error carries a retry_after hint, use it if within max_delay
	if (
		error != null &&
		typeof error === "object" &&
		"retry_after" in error &&
		typeof (error as { retry_after?: number }).retry_after === "number"
	) {
		const retryAfter = (error as { retry_after: number }).retry_after;
		if (retryAfter > 0 && retryAfter <= policy.max_delay) {
			delay = retryAfter;
		}
	}

	return delay;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new AbortError("Request was aborted"));
			return;
		}

		const timer = setTimeout(resolve, ms * 1000);

		const onAbort = () => {
			clearTimeout(timer);
			reject(new AbortError("Request was aborted"));
		};

		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/**
 * Execute an async function with retry logic.
 *
 * Retries only on errors where `isRetryable()` returns `true`.
 * Respects abort signals and the provider's `retry_after` hint.
 */
export async function withRetry<T>(fn: () => Promise<T>, options?: RetryOptions): Promise<T> {
	const policy = options?.policy ?? DEFAULT_RETRY_POLICY;
	const signal = options?.abort_signal;

	let lastError: unknown;

	for (let attempt = 0; attempt <= policy.max_retries; attempt++) {
		if (signal?.aborted) {
			throw new AbortError("Request was aborted");
		}

		try {
			return await fn();
		} catch (error) {
			lastError = error;

			// Don't retry if not retryable or if this was the last attempt.
			if (!isRetryable(error) || attempt >= policy.max_retries) {
				throw error;
			}

			const delay = computeDelay(policy, attempt, error);

			// Notify callback if provided.
			if (policy.on_retry) {
				policy.on_retry(
					error instanceof Error ? error : new Error(String(error)),
					attempt + 1,
					delay,
				);
			}

			await sleep(delay, signal);
		}
	}

	// Should be unreachable, but satisfy TypeScript.
	throw lastError;
}

/**
 * Call `client.complete()` with retry.
 */
export async function completeWithRetry(
	client: Client,
	request: Request,
	options?: RetryOptions,
): Promise<Response> {
	return withRetry(() => client.complete(request), options);
}

/**
 * Call `client.stream()` with retry.
 *
 * Retry only applies to the initial connection — once streaming has begun,
 * errors are not retried (the caller has already consumed some events).
 */
export async function* streamWithRetry(
	client: Client,
	request: Request,
	options?: RetryOptions,
): AsyncIterableIterator<StreamEvent> {
	const policy = options?.policy ?? DEFAULT_RETRY_POLICY;
	const signal = options?.abort_signal;

	let lastError: unknown;

	for (let attempt = 0; attempt <= policy.max_retries; attempt++) {
		if (signal?.aborted) {
			throw new AbortError("Request was aborted");
		}

		try {
			const iterator = client.stream(request);
			// Try to get the first event — this is where connection errors happen.
			const first = await iterator.next();
			if (first.done) {
				return;
			}
			yield first.value;
			// Stream the rest without retry.
			yield* iterator;
			return;
		} catch (error) {
			lastError = error;

			if (!isRetryable(error) || attempt >= policy.max_retries) {
				throw error;
			}

			const delay = computeDelay(policy, attempt, error);

			if (policy.on_retry) {
				policy.on_retry(
					error instanceof Error ? error : new Error(String(error)),
					attempt + 1,
					delay,
				);
			}

			await sleep(delay, signal);
		}
	}

	throw lastError;
}
