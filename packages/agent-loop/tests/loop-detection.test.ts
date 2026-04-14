import { describe, expect, it } from "vitest";
import { detectLoop, loopWarningMessage } from "../src/loop-detection.js";
import type { ToolCallInfo } from "../src/types.js";

/** Helper to create a ToolCallInfo with defaults. */
function call(name: string, args: Record<string, unknown> = {}, id?: string): ToolCallInfo {
	return {
		id: id ?? `call-${name}-${Math.random().toString(36).slice(2, 8)}`,
		name,
		arguments: args,
	};
}

describe("detectLoop", () => {
	it("returns 0 for empty array", () => {
		expect(detectLoop([])).toBe(0);
	});

	it("returns 0 for single call", () => {
		expect(detectLoop([call("Bash", { command: "ls" })])).toBe(0);
	});

	it("returns 0 for non-repeating calls", () => {
		const calls = [
			call("Bash", { command: "ls" }),
			call("Read", { path: "/foo" }),
			call("Write", { path: "/bar", content: "hello" }),
			call("Grep", { pattern: "TODO" }),
			call("Glob", { pattern: "*.ts" }),
		];
		expect(detectLoop(calls)).toBe(0);
	});

	it("detects pattern length 1 (same call repeated 10 times)", () => {
		const calls = Array.from({ length: 10 }, () => call("Bash", { command: "cat /dev/null" }));
		expect(detectLoop(calls)).toBe(1);
	});

	it("detects pattern length 2 (alternating A, B, A, B, ...)", () => {
		const calls: ToolCallInfo[] = [];
		for (let i = 0; i < 10; i++) {
			if (i % 2 === 0) {
				calls.push(call("Read", { path: "/a" }));
			} else {
				calls.push(call("Write", { path: "/a", content: "x" }));
			}
		}
		expect(detectLoop(calls)).toBe(2);
	});

	it("detects pattern length 3 (repeating A, B, C, A, B, C, ...)", () => {
		const calls: ToolCallInfo[] = [];
		for (let i = 0; i < 12; i++) {
			const phase = i % 3;
			if (phase === 0) {
				calls.push(call("Read", { path: "/config" }));
			} else if (phase === 1) {
				calls.push(call("Bash", { command: "build" }));
			} else {
				calls.push(call("Grep", { pattern: "error" }));
			}
		}
		// With windowSize=10, the window captures the last 10 calls
		// which is 3 full repeats plus a partial
		expect(detectLoop(calls, 12)).toBe(3);
	});

	it("does not detect loop with insufficient repeats", () => {
		// Only 3 repetitions of a single call with windowSize=10
		// needs repeats >= floor(10/1) - 1 = 9, but only 3 available
		const calls = Array.from({ length: 3 }, () => call("Bash", { command: "echo hi" }));
		expect(detectLoop(calls)).toBe(0);
	});

	it("respects windowSize parameter", () => {
		// Create 6 identical calls -- with windowSize=6 the threshold is
		// floor(6/1) - 1 = 5 repeats, and 6 identical calls give 5 repeats
		const calls = Array.from({ length: 6 }, () => call("Bash", { command: "echo loop" }));
		expect(detectLoop(calls, 6)).toBe(1);

		// With a larger window, the same 6 calls won't be enough
		// windowSize=20 requires floor(20/1) - 1 = 19 repeats
		expect(detectLoop(calls, 20)).toBe(0);
	});

	it("uses sorted args in signature (different arg order = same signature)", () => {
		const calls = Array.from({ length: 10 }, (_, i) => {
			// Alternate between two key orderings of the same object
			if (i % 2 === 0) {
				return call("Write", { path: "/x", content: "y" });
			}
			// Create with different key order -- construct manually
			const args: Record<string, unknown> = {};
			args.content = "y";
			args.path = "/x";
			return call("Write", args);
		});
		// All calls should produce the same signature due to sorted keys
		expect(detectLoop(calls)).toBe(1);
	});

	it("different args = different signatures", () => {
		const calls: ToolCallInfo[] = [];
		for (let i = 0; i < 10; i++) {
			// Each call has a unique argument value
			calls.push(call("Bash", { command: `echo ${i}` }));
		}
		expect(detectLoop(calls)).toBe(0);
	});

	it("detects loop in the tail of a longer history", () => {
		// First few calls are diverse, then a loop starts
		const diverse = [
			call("Read", { path: "/a" }),
			call("Bash", { command: "make" }),
			call("Grep", { pattern: "foo" }),
		];
		const looping = Array.from({ length: 10 }, () => call("Bash", { command: "retry" }));
		expect(detectLoop([...diverse, ...looping])).toBe(1);
	});
});

describe("loopWarningMessage", () => {
	it("returns correct format", () => {
		const msg = loopWarningMessage(2, 10);
		expect(msg).toBe(
			"Loop detected: the last 10 tool calls follow a repeating pattern of length 2. Try a different approach.",
		);
	});

	it("includes the correct pattern length and window size", () => {
		const msg = loopWarningMessage(3, 15);
		expect(msg).toContain("15");
		expect(msg).toContain("3");
		expect(msg).toContain("Try a different approach");
	});
});
