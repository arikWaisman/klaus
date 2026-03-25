import { describe, expect, it } from "vitest";
import {
	emptyUsage,
	mergeUsage,
	responseReasoning,
	responseText,
	responseToolCalls,
} from "../src/types.js";
import type { Response, Usage } from "../src/types.js";

// ---------------------------------------------------------------------------
// Helpers to build minimal Response objects for testing
// ---------------------------------------------------------------------------

function makeResponse(content: Response["message"]["content"] = []): Response {
	return {
		id: "resp-1",
		model: "test-model",
		provider: "test",
		message: { role: "assistant", content },
		finish_reason: { reason: "stop" },
		usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
		warnings: [],
	};
}

// ---------------------------------------------------------------------------
// responseText
// ---------------------------------------------------------------------------

describe("responseText", () => {
	it("extracts text from a single text content part", () => {
		const resp = makeResponse([{ kind: "text", text: "Hello world" }]);
		expect(responseText(resp)).toBe("Hello world");
	});

	it("concatenates multiple text parts", () => {
		const resp = makeResponse([
			{ kind: "text", text: "Hello " },
			{ kind: "text", text: "world" },
		]);
		expect(responseText(resp)).toBe("Hello world");
	});

	it("returns empty string when there are no text parts", () => {
		const resp = makeResponse([]);
		expect(responseText(resp)).toBe("");
	});

	it("ignores non-text content parts", () => {
		const resp = makeResponse([
			{ kind: "thinking", thinking: { text: "hmm", redacted: false } },
			{ kind: "text", text: "answer" },
			{
				kind: "tool_call",
				tool_call: { id: "tc-1", name: "fn", arguments: {} },
			},
		]);
		expect(responseText(resp)).toBe("answer");
	});

	it("treats missing text field as empty string", () => {
		const resp = makeResponse([{ kind: "text" }]);
		expect(responseText(resp)).toBe("");
	});
});

// ---------------------------------------------------------------------------
// responseToolCalls
// ---------------------------------------------------------------------------

describe("responseToolCalls", () => {
	it("extracts tool calls with already-parsed arguments", () => {
		const resp = makeResponse([
			{
				kind: "tool_call",
				tool_call: {
					id: "tc-1",
					name: "get_weather",
					arguments: { city: "Paris" },
				},
			},
		]);

		const calls = responseToolCalls(resp);
		expect(calls).toHaveLength(1);
		expect(calls[0]).toEqual({
			id: "tc-1",
			name: "get_weather",
			arguments: { city: "Paris" },
		});
	});

	it("parses string arguments as JSON", () => {
		const resp = makeResponse([
			{
				kind: "tool_call",
				tool_call: {
					id: "tc-2",
					name: "search",
					arguments: '{"query":"vitest"}',
				},
			},
		]);

		const calls = responseToolCalls(resp);
		expect(calls).toHaveLength(1);
		expect(calls[0].arguments).toEqual({ query: "vitest" });
	});

	it("returns empty array when no tool_call parts exist", () => {
		const resp = makeResponse([{ kind: "text", text: "no tools here" }]);
		expect(responseToolCalls(resp)).toEqual([]);
	});

	it("skips tool_call parts where tool_call data is null", () => {
		const resp = makeResponse([{ kind: "tool_call" }]);
		expect(responseToolCalls(resp)).toEqual([]);
	});

	it("handles multiple tool calls", () => {
		const resp = makeResponse([
			{
				kind: "tool_call",
				tool_call: { id: "a", name: "fn_a", arguments: { x: 1 } },
			},
			{
				kind: "tool_call",
				tool_call: { id: "b", name: "fn_b", arguments: { y: 2 } },
			},
		]);

		const calls = responseToolCalls(resp);
		expect(calls).toHaveLength(2);
		expect(calls[0].name).toBe("fn_a");
		expect(calls[1].name).toBe("fn_b");
	});
});

// ---------------------------------------------------------------------------
// responseReasoning
// ---------------------------------------------------------------------------

describe("responseReasoning", () => {
	it("extracts thinking text", () => {
		const resp = makeResponse([
			{
				kind: "thinking",
				thinking: { text: "Let me think...", redacted: false },
			},
		]);
		expect(responseReasoning(resp)).toBe("Let me think...");
	});

	it("concatenates multiple thinking parts", () => {
		const resp = makeResponse([
			{
				kind: "thinking",
				thinking: { text: "Step 1. ", redacted: false },
			},
			{
				kind: "thinking",
				thinking: { text: "Step 2.", redacted: false },
			},
		]);
		expect(responseReasoning(resp)).toBe("Step 1. Step 2.");
	});

	it("returns undefined when there are no thinking parts", () => {
		const resp = makeResponse([{ kind: "text", text: "just text" }]);
		expect(responseReasoning(resp)).toBeUndefined();
	});

	it("returns undefined when content is empty", () => {
		const resp = makeResponse([]);
		expect(responseReasoning(resp)).toBeUndefined();
	});

	it("skips thinking parts where thinking data is missing", () => {
		const resp = makeResponse([{ kind: "thinking" }]);
		expect(responseReasoning(resp)).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// emptyUsage
// ---------------------------------------------------------------------------

describe("emptyUsage", () => {
	it("returns zeroed usage with required fields", () => {
		const usage = emptyUsage();
		expect(usage).toEqual({
			input_tokens: 0,
			output_tokens: 0,
			total_tokens: 0,
		});
	});

	it("does not include optional fields", () => {
		const usage = emptyUsage();
		expect(usage.reasoning_tokens).toBeUndefined();
		expect(usage.cache_read_tokens).toBeUndefined();
		expect(usage.cache_write_tokens).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// mergeUsage
// ---------------------------------------------------------------------------

describe("mergeUsage", () => {
	it("sums required fields", () => {
		const a: Usage = { input_tokens: 10, output_tokens: 20, total_tokens: 30 };
		const b: Usage = { input_tokens: 5, output_tokens: 15, total_tokens: 20 };
		const merged = mergeUsage(a, b);

		expect(merged.input_tokens).toBe(15);
		expect(merged.output_tokens).toBe(35);
		expect(merged.total_tokens).toBe(50);
	});

	it("merges optional fields when both are present", () => {
		const a: Usage = {
			input_tokens: 10,
			output_tokens: 20,
			total_tokens: 30,
			reasoning_tokens: 5,
			cache_read_tokens: 3,
			cache_write_tokens: 2,
		};
		const b: Usage = {
			input_tokens: 10,
			output_tokens: 20,
			total_tokens: 30,
			reasoning_tokens: 7,
			cache_read_tokens: 4,
			cache_write_tokens: 1,
		};
		const merged = mergeUsage(a, b);

		expect(merged.reasoning_tokens).toBe(12);
		expect(merged.cache_read_tokens).toBe(7);
		expect(merged.cache_write_tokens).toBe(3);
	});

	it("treats missing optional fields as zero", () => {
		const a: Usage = {
			input_tokens: 10,
			output_tokens: 20,
			total_tokens: 30,
			reasoning_tokens: 5,
		};
		const b: Usage = { input_tokens: 10, output_tokens: 20, total_tokens: 30 };
		const merged = mergeUsage(a, b);

		expect(merged.reasoning_tokens).toBe(5);
	});

	it("returns undefined for optional fields when both are absent", () => {
		const a: Usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
		const b: Usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
		const merged = mergeUsage(a, b);

		expect(merged.reasoning_tokens).toBeUndefined();
		expect(merged.cache_read_tokens).toBeUndefined();
		expect(merged.cache_write_tokens).toBeUndefined();
	});

	it("merges two empty usages into an empty usage", () => {
		const merged = mergeUsage(emptyUsage(), emptyUsage());
		expect(merged).toEqual({
			input_tokens: 0,
			output_tokens: 0,
			total_tokens: 0,
			reasoning_tokens: undefined,
			cache_read_tokens: undefined,
			cache_write_tokens: undefined,
		});
	});
});
