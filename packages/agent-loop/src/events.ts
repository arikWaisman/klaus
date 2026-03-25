import type { EventKind, SessionEvent } from "./types.js";

// ---------------------------------------------------------------------------
// EventEmitter – pub/sub + async iteration for SessionEvents
// ---------------------------------------------------------------------------

export class EventEmitter {
	private session_id: string;
	private listeners: Array<(event: SessionEvent) => void> = [];
	private buffer: SessionEvent[] = [];
	private closed = false;

	/** Resolve function for the currently pending async-iterator pull, if any. */
	private pending_resolve: ((value: IteratorResult<SessionEvent, undefined>) => void) | null = null;

	constructor(session_id: string) {
		this.session_id = session_id;
	}

	// -----------------------------------------------------------------------
	// Listener registration
	// -----------------------------------------------------------------------

	/**
	 * Register a listener that is called for every emitted event.
	 * Returns an unsubscribe function.
	 */
	on(listener: (event: SessionEvent) => void): () => void {
		this.listeners.push(listener);
		return () => {
			const idx = this.listeners.indexOf(listener);
			if (idx !== -1) {
				this.listeners.splice(idx, 1);
			}
		};
	}

	// -----------------------------------------------------------------------
	// Emit helpers
	// -----------------------------------------------------------------------

	/** Emit an event to all listeners and the async-iterator consumer. */
	emit(kind: EventKind, data?: Record<string, unknown>): void {
		if (this.closed) {
			return;
		}

		const event: SessionEvent = {
			kind,
			session_id: this.session_id,
			timestamp: Date.now(),
			...(data !== undefined ? { data } : {}),
		};

		this.buffer.push(event);

		// Notify all synchronous listeners.
		for (const listener of this.listeners) {
			listener(event);
		}

		// If the async iterator is waiting for the next value, resolve it.
		if (this.pending_resolve) {
			const resolve = this.pending_resolve;
			this.pending_resolve = null;
			resolve({ value: event, done: false });
		}
	}

	// -----------------------------------------------------------------------
	// Convenience emitters
	// -----------------------------------------------------------------------

	emitToolCallStart(toolName: string, callId: string, args: Record<string, unknown>): void {
		this.emit("TOOL_CALL_START", { tool_name: toolName, call_id: callId, args });
	}

	emitToolCallEnd(
		callId: string,
		output: string,
		truncatedOutput: string,
		is_error: boolean,
	): void {
		this.emit("TOOL_CALL_END", {
			call_id: callId,
			output,
			truncated_output: truncatedOutput,
			is_error,
		});
	}

	emitTextStart(): void {
		this.emit("ASSISTANT_TEXT_START");
	}

	emitTextDelta(text: string): void {
		this.emit("ASSISTANT_TEXT_DELTA", { text });
	}

	emitTextEnd(fullText: string): void {
		this.emit("ASSISTANT_TEXT_END", { text: fullText });
	}

	emitError(error: unknown): void {
		const message = error instanceof Error ? error.message : String(error);
		const stack = error instanceof Error ? error.stack : undefined;
		this.emit("ERROR", { message, stack, raw: error as unknown as Record<string, unknown> });
	}

	emitWarning(message: string): void {
		this.emit("WARNING", { message });
	}

	// -----------------------------------------------------------------------
	// Async iteration
	// -----------------------------------------------------------------------

	/**
	 * Async iterator that yields events as they are emitted.
	 *
	 * Uses a pull-based approach: when the consumer calls `next()`, we either
	 * return a buffered event that has not yet been yielded, or park a promise
	 * that will be resolved the next time `emit()` is called.
	 */
	[Symbol.asyncIterator](): AsyncIterableIterator<SessionEvent> {
		/** Index into `this.buffer` tracking how far the iterator has read. */
		let cursor = 0;

		const self = this;

		return {
			next(): Promise<IteratorResult<SessionEvent, undefined>> {
				// Drain buffered events first.
				if (cursor < self.buffer.length) {
					const event = self.buffer[cursor++]!;
					return Promise.resolve({ value: event, done: false });
				}

				// If the emitter is closed and there is nothing left, we are done.
				if (self.closed) {
					return Promise.resolve({ value: undefined, done: true });
				}

				// Park until the next emit() or close().
				return new Promise<IteratorResult<SessionEvent, undefined>>((resolve) => {
					self.pending_resolve = resolve;
				});
			},

			return(): Promise<IteratorResult<SessionEvent, undefined>> {
				return Promise.resolve({ value: undefined, done: true });
			},

			[Symbol.asyncIterator]() {
				return this;
			},
		};
	}

	// -----------------------------------------------------------------------
	// Lifecycle
	// -----------------------------------------------------------------------

	/** Close the emitter. No further events will be accepted. */
	close(): void {
		if (this.closed) {
			return;
		}
		this.closed = true;

		// Resolve any pending async-iterator pull so the consumer exits.
		if (this.pending_resolve) {
			const resolve = this.pending_resolve;
			this.pending_resolve = null;
			resolve({ value: undefined, done: true });
		}
	}

	/** Return a shallow copy of all buffered events. */
	getHistory(): SessionEvent[] {
		return [...this.buffer];
	}
}
