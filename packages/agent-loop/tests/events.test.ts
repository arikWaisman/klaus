import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "../src/events.js";
import type { SessionEvent } from "../src/types.js";

describe("EventEmitter", () => {
	const SESSION_ID = "test-session-001";

	it("emit creates events with correct session_id and timestamp", () => {
		const now = 1700000000000;
		vi.spyOn(Date, "now").mockReturnValue(now);

		const emitter = new EventEmitter(SESSION_ID);
		emitter.emit("SESSION_START");

		const history = emitter.getHistory();
		expect(history).toHaveLength(1);
		expect(history[0]!.session_id).toBe(SESSION_ID);
		expect(history[0]!.timestamp).toBe(now);
		expect(history[0]!.kind).toBe("SESSION_START");

		vi.restoreAllMocks();
	});

	it("on listener receives emitted events", () => {
		const emitter = new EventEmitter(SESSION_ID);
		const received: SessionEvent[] = [];

		emitter.on((event) => {
			received.push(event);
		});

		emitter.emit("SESSION_START");
		emitter.emit("SESSION_END");

		expect(received).toHaveLength(2);
		expect(received[0]!.kind).toBe("SESSION_START");
		expect(received[1]!.kind).toBe("SESSION_END");
	});

	it("on returns unsubscribe function that removes the listener", () => {
		const emitter = new EventEmitter(SESSION_ID);
		const received: SessionEvent[] = [];

		const unsub = emitter.on((event) => {
			received.push(event);
		});

		emitter.emit("SESSION_START");
		expect(received).toHaveLength(1);

		unsub();

		emitter.emit("SESSION_END");
		expect(received).toHaveLength(1);
	});

	it("multiple listeners all receive the same event", () => {
		const emitter = new EventEmitter(SESSION_ID);
		const received1: SessionEvent[] = [];
		const received2: SessionEvent[] = [];
		const received3: SessionEvent[] = [];

		emitter.on((event) => received1.push(event));
		emitter.on((event) => received2.push(event));
		emitter.on((event) => received3.push(event));

		emitter.emit("USER_INPUT", { text: "hello" });

		expect(received1).toHaveLength(1);
		expect(received2).toHaveLength(1);
		expect(received3).toHaveLength(1);

		// All listeners receive the exact same event object
		expect(received1[0]).toBe(received2[0]);
		expect(received2[0]).toBe(received3[0]);
	});

	it("closed emitter ignores emit calls", () => {
		const emitter = new EventEmitter(SESSION_ID);
		const received: SessionEvent[] = [];

		emitter.on((event) => received.push(event));

		emitter.emit("SESSION_START");
		expect(received).toHaveLength(1);

		emitter.close();

		emitter.emit("SESSION_END");
		expect(received).toHaveLength(1);
		expect(emitter.getHistory()).toHaveLength(1);
	});

	it("emitToolCallStart creates TOOL_CALL_START event with correct data", () => {
		const emitter = new EventEmitter(SESSION_ID);

		emitter.emitToolCallStart("Bash", "call-123", { command: "ls -la" });

		const history = emitter.getHistory();
		expect(history).toHaveLength(1);
		expect(history[0]!.kind).toBe("TOOL_CALL_START");
		expect(history[0]!.data).toEqual({
			tool_name: "Bash",
			call_id: "call-123",
			args: { command: "ls -la" },
		});
	});

	it("emitToolCallEnd creates TOOL_CALL_END event with output and truncated_output", () => {
		const emitter = new EventEmitter(SESSION_ID);

		emitter.emitToolCallEnd("call-123", "full output text", "truncated...", false);

		const history = emitter.getHistory();
		expect(history).toHaveLength(1);
		expect(history[0]!.kind).toBe("TOOL_CALL_END");
		expect(history[0]!.data).toEqual({
			call_id: "call-123",
			output: "full output text",
			truncated_output: "truncated...",
			is_error: false,
		});
	});

	it("emitToolCallEnd records is_error flag", () => {
		const emitter = new EventEmitter(SESSION_ID);

		emitter.emitToolCallEnd("call-456", "error output", "error...", true);

		const history = emitter.getHistory();
		expect(history[0]!.data!.is_error).toBe(true);
	});

	it("emitTextStart/emitTextDelta/emitTextEnd emit correct event kinds", () => {
		const emitter = new EventEmitter(SESSION_ID);

		emitter.emitTextStart();
		emitter.emitTextDelta("Hello ");
		emitter.emitTextDelta("world");
		emitter.emitTextEnd("Hello world");

		const history = emitter.getHistory();
		expect(history).toHaveLength(4);

		expect(history[0]!.kind).toBe("ASSISTANT_TEXT_START");
		expect(history[0]!.data).toBeUndefined();

		expect(history[1]!.kind).toBe("ASSISTANT_TEXT_DELTA");
		expect(history[1]!.data).toEqual({ text: "Hello " });

		expect(history[2]!.kind).toBe("ASSISTANT_TEXT_DELTA");
		expect(history[2]!.data).toEqual({ text: "world" });

		expect(history[3]!.kind).toBe("ASSISTANT_TEXT_END");
		expect(history[3]!.data).toEqual({ text: "Hello world" });
	});

	it("emitError extracts message and stack from Error objects", () => {
		const emitter = new EventEmitter(SESSION_ID);
		const err = new Error("something went wrong");

		emitter.emitError(err);

		const history = emitter.getHistory();
		expect(history).toHaveLength(1);
		expect(history[0]!.kind).toBe("ERROR");
		expect(history[0]!.data!.message).toBe("something went wrong");
		expect(history[0]!.data!.stack).toBeDefined();
		expect(typeof history[0]!.data!.stack).toBe("string");
		expect(history[0]!.data!.raw).toBe(err);
	});

	it("emitError handles non-Error values", () => {
		const emitter = new EventEmitter(SESSION_ID);

		emitter.emitError("plain string error");

		const history = emitter.getHistory();
		expect(history[0]!.data!.message).toBe("plain string error");
		expect(history[0]!.data!.stack).toBeUndefined();
	});

	it("emitWarning emits WARNING event with message", () => {
		const emitter = new EventEmitter(SESSION_ID);

		emitter.emitWarning("disk space low");

		const history = emitter.getHistory();
		expect(history).toHaveLength(1);
		expect(history[0]!.kind).toBe("WARNING");
		expect(history[0]!.data).toEqual({ message: "disk space low" });
	});

	it("getHistory returns all buffered events", () => {
		const emitter = new EventEmitter(SESSION_ID);

		emitter.emit("SESSION_START");
		emitter.emit("USER_INPUT", { text: "hi" });
		emitter.emit("ASSISTANT_TEXT_START");

		const history = emitter.getHistory();
		expect(history).toHaveLength(3);
		expect(history.map((e) => e.kind)).toEqual([
			"SESSION_START",
			"USER_INPUT",
			"ASSISTANT_TEXT_START",
		]);
	});

	it("getHistory returns a shallow copy", () => {
		const emitter = new EventEmitter(SESSION_ID);
		emitter.emit("SESSION_START");

		const history1 = emitter.getHistory();
		const history2 = emitter.getHistory();

		expect(history1).not.toBe(history2);
		expect(history1).toEqual(history2);
	});

	it("async iterator yields events as they are emitted", async () => {
		const emitter = new EventEmitter(SESSION_ID);

		// Emit some events before iteration starts
		emitter.emit("SESSION_START");
		emitter.emit("USER_INPUT", { text: "hello" });

		const collected: SessionEvent[] = [];
		const iter = emitter[Symbol.asyncIterator]();

		// Drain the buffered events
		const first = await iter.next();
		expect(first.done).toBe(false);
		expect(first.value!.kind).toBe("SESSION_START");
		collected.push(first.value!);

		const second = await iter.next();
		expect(second.done).toBe(false);
		expect(second.value!.kind).toBe("USER_INPUT");
		collected.push(second.value!);

		// Now emit a new event while the iterator is waiting
		const thirdPromise = iter.next();
		emitter.emit("SESSION_END");

		const third = await thirdPromise;
		expect(third.done).toBe(false);
		expect(third.value!.kind).toBe("SESSION_END");
		collected.push(third.value!);

		expect(collected).toHaveLength(3);
	});

	it("async iterator completes when close() is called", async () => {
		const emitter = new EventEmitter(SESSION_ID);

		// Pre-buffer two events before creating the iterator
		emitter.emit("SESSION_START");
		emitter.emit("USER_INPUT", { text: "hi" });

		const collected: SessionEvent[] = [];

		// Use for-await to consume events
		const consumePromise = (async () => {
			for await (const event of emitter) {
				collected.push(event);
			}
		})();

		// Give the loop time to drain the buffered events and park
		await new Promise((resolve) => setTimeout(resolve, 10));

		// Close the emitter; the parked iterator should receive done=true
		emitter.close();

		await consumePromise;

		expect(collected).toHaveLength(2);
		expect(collected[0]!.kind).toBe("SESSION_START");
		expect(collected[1]!.kind).toBe("USER_INPUT");
	});

	it("close resolves any pending async iterator promise", async () => {
		const emitter = new EventEmitter(SESSION_ID);
		const iter = emitter[Symbol.asyncIterator]();

		// Call next() which will park a promise since there are no buffered events
		const pendingPromise = iter.next();

		// Close the emitter which should resolve the pending promise
		emitter.close();

		const result = await pendingPromise;
		expect(result.done).toBe(true);
		expect(result.value).toBeUndefined();
	});

	it("close is idempotent", () => {
		const emitter = new EventEmitter(SESSION_ID);
		emitter.emit("SESSION_START");

		emitter.close();
		emitter.close(); // should not throw

		expect(emitter.getHistory()).toHaveLength(1);
	});

	it("emit without data produces event with no data property", () => {
		const emitter = new EventEmitter(SESSION_ID);

		emitter.emit("SESSION_START");

		const history = emitter.getHistory();
		expect(history[0]!.data).toBeUndefined();
		expect("data" in history[0]!).toBe(false);
	});
});
