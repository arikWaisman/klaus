import { describe, expect, it } from "vitest";
import { StreamAccumulator } from "../src/accumulator.js";
import type { Response, StreamEvent, Usage } from "../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeUsage(input = 10, output = 20): Usage {
	return {
		input_tokens: input,
		output_tokens: output,
		total_tokens: input + output,
	};
}

function makeFinishResponse(): Response {
	return {
		id: "resp-finish",
		model: "test-model",
		provider: "test",
		message: {
			role: "assistant",
			content: [{ kind: "text", text: "finished" }],
		},
		finish_reason: { reason: "stop" },
		usage: makeUsage(50, 100),
		warnings: [],
	};
}

// ---------------------------------------------------------------------------
// TEXT_DELTA accumulation
// ---------------------------------------------------------------------------

describe("StreamAccumulator — TEXT_DELTA", () => {
	it("accumulates TEXT_DELTA events into text", () => {
		const acc = new StreamAccumulator();

		acc.push({ type: "TEXT_DELTA", delta: "Hello" });
		acc.push({ type: "TEXT_DELTA", delta: " " });
		acc.push({ type: "TEXT_DELTA", delta: "world" });

		expect(acc.getText()).toBe("Hello world");
	});

	it("ignores TEXT_DELTA events with no delta", () => {
		const acc = new StreamAccumulator();

		acc.push({ type: "TEXT_DELTA" });
		acc.push({ type: "TEXT_DELTA", delta: "ok" });

		expect(acc.getText()).toBe("ok");
	});

	it("returns empty string when no TEXT_DELTA events received", () => {
		const acc = new StreamAccumulator();
		expect(acc.getText()).toBe("");
	});
});

// ---------------------------------------------------------------------------
// REASONING_DELTA accumulation
// ---------------------------------------------------------------------------

describe("StreamAccumulator — REASONING_DELTA", () => {
	it("accumulates REASONING_DELTA events into reasoning", () => {
		const acc = new StreamAccumulator();

		acc.push({ type: "REASONING_DELTA", reasoning_delta: "Step 1. " });
		acc.push({ type: "REASONING_DELTA", reasoning_delta: "Step 2." });

		expect(acc.getReasoning()).toBe("Step 1. Step 2.");
	});

	it("ignores REASONING_DELTA events with no reasoning_delta", () => {
		const acc = new StreamAccumulator();

		acc.push({ type: "REASONING_DELTA" });
		acc.push({ type: "REASONING_DELTA", reasoning_delta: "ok" });

		expect(acc.getReasoning()).toBe("ok");
	});

	it("returns undefined when no reasoning was accumulated", () => {
		const acc = new StreamAccumulator();
		expect(acc.getReasoning()).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Tool call accumulation (START + DELTA + END)
// ---------------------------------------------------------------------------

describe("StreamAccumulator — tool calls", () => {
	it("accumulates TOOL_CALL_START + TOOL_CALL_DELTA + TOOL_CALL_END into a tool call", () => {
		const acc = new StreamAccumulator();

		acc.push({
			type: "TOOL_CALL_START",
			tool_call: { id: "tc-1", name: "get_weather" },
		});
		acc.push({ type: "TOOL_CALL_DELTA", delta: '{"city"' });
		acc.push({ type: "TOOL_CALL_DELTA", delta: ':"Paris"}' });
		acc.push({ type: "TOOL_CALL_END" });

		const calls = acc.getToolCalls();
		expect(calls).toHaveLength(1);
		expect(calls[0].id).toBe("tc-1");
		expect(calls[0].name).toBe("get_weather");
		expect(calls[0].arguments).toEqual({ city: "Paris" });
		expect(calls[0].raw_arguments).toBe('{"city":"Paris"}');
	});

	it("handles multiple tool calls", () => {
		const acc = new StreamAccumulator();

		// First tool call
		acc.push({
			type: "TOOL_CALL_START",
			tool_call: { id: "tc-1", name: "search" },
		});
		acc.push({ type: "TOOL_CALL_DELTA", delta: '{"q":"hello"}' });
		acc.push({ type: "TOOL_CALL_END" });

		// Second tool call
		acc.push({
			type: "TOOL_CALL_START",
			tool_call: { id: "tc-2", name: "fetch" },
		});
		acc.push({ type: "TOOL_CALL_DELTA", delta: '{"url":"http://x.com"}' });
		acc.push({ type: "TOOL_CALL_END" });

		const calls = acc.getToolCalls();
		expect(calls).toHaveLength(2);
		expect(calls[0].name).toBe("search");
		expect(calls[0].arguments).toEqual({ q: "hello" });
		expect(calls[1].name).toBe("fetch");
		expect(calls[1].arguments).toEqual({ url: "http://x.com" });
	});

	it("uses tool_call_id on TOOL_CALL_DELTA when provided", () => {
		const acc = new StreamAccumulator();

		acc.push({
			type: "TOOL_CALL_START",
			tool_call: { id: "tc-1", name: "fn_a" },
		});
		// Explicitly reference the tool_call_id
		acc.push({ type: "TOOL_CALL_DELTA", tool_call_id: "tc-1", delta: '{"x":1}' });
		acc.push({ type: "TOOL_CALL_END" });

		const calls = acc.getToolCalls();
		expect(calls).toHaveLength(1);
		expect(calls[0].arguments).toEqual({ x: 1 });
	});

	it("handles malformed JSON in tool call arguments gracefully", () => {
		const acc = new StreamAccumulator();

		acc.push({
			type: "TOOL_CALL_START",
			tool_call: { id: "tc-1", name: "broken" },
		});
		acc.push({ type: "TOOL_CALL_DELTA", delta: "not valid json{{{" });
		acc.push({ type: "TOOL_CALL_END" });

		const calls = acc.getToolCalls();
		expect(calls).toHaveLength(1);
		expect(calls[0].id).toBe("tc-1");
		expect(calls[0].name).toBe("broken");
		// When JSON parsing fails, arguments should be an empty object
		expect(calls[0].arguments).toEqual({});
		// Raw arguments should preserve the original string
		expect(calls[0].raw_arguments).toBe("not valid json{{{");
	});

	it("returns empty array when no tool calls received", () => {
		const acc = new StreamAccumulator();
		expect(acc.getToolCalls()).toEqual([]);
	});

	it("ignores TOOL_CALL_START without an id", () => {
		const acc = new StreamAccumulator();

		acc.push({
			type: "TOOL_CALL_START",
			tool_call: { name: "no_id" },
		});
		acc.push({ type: "TOOL_CALL_DELTA", delta: '{"a":1}' });
		acc.push({ type: "TOOL_CALL_END" });

		// No tool call should be registered since no id was given
		expect(acc.getToolCalls()).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// FINISH event
// ---------------------------------------------------------------------------

describe("StreamAccumulator — FINISH", () => {
	it("sets finish_reason and usage from FINISH event", () => {
		const acc = new StreamAccumulator();

		acc.push({ type: "TEXT_DELTA", delta: "hello" });
		acc.push({
			type: "FINISH",
			finish_reason: { reason: "stop" },
			usage: makeUsage(10, 20),
		});

		const usage = acc.getUsage();
		expect(usage.input_tokens).toBe(10);
		expect(usage.output_tokens).toBe(20);
		expect(usage.total_tokens).toBe(30);
	});

	it("uses response usage when FINISH includes a response", () => {
		const acc = new StreamAccumulator();
		const finishResponse = makeFinishResponse();

		acc.push({
			type: "FINISH",
			finish_reason: { reason: "stop" },
			usage: makeUsage(10, 20),
			response: finishResponse,
		});

		// getUsage() prefers the response's usage
		const usage = acc.getUsage();
		expect(usage.input_tokens).toBe(50);
		expect(usage.output_tokens).toBe(100);
	});
});

// ---------------------------------------------------------------------------
// response() method
// ---------------------------------------------------------------------------

describe("StreamAccumulator — response()", () => {
	it("returns the FINISH event's response if available", () => {
		const acc = new StreamAccumulator();
		const finishResponse = makeFinishResponse();

		acc.push({ type: "TEXT_DELTA", delta: "ignored by response" });
		acc.push({
			type: "FINISH",
			finish_reason: { reason: "stop" },
			response: finishResponse,
		});

		const response = acc.response();
		expect(response).toBe(finishResponse);
		expect(response.id).toBe("resp-finish");
	});

	it("returns a constructed response with all accumulated data when no FINISH response", () => {
		const acc = new StreamAccumulator();

		// Reasoning
		acc.push({ type: "REASONING_DELTA", reasoning_delta: "thinking..." });

		// Text
		acc.push({ type: "TEXT_DELTA", delta: "Hello " });
		acc.push({ type: "TEXT_DELTA", delta: "world" });

		// Tool call
		acc.push({
			type: "TOOL_CALL_START",
			tool_call: { id: "tc-1", name: "my_tool" },
		});
		acc.push({ type: "TOOL_CALL_DELTA", delta: '{"key":"val"}' });
		acc.push({ type: "TOOL_CALL_END" });

		// Finish without response
		acc.push({
			type: "FINISH",
			finish_reason: { reason: "tool_calls" },
			usage: makeUsage(15, 25),
		});

		const response = acc.response();

		// It should construct one since no response was on the FINISH event
		expect(response.id).toBe("accumulated");
		expect(response.model).toBe("unknown");
		expect(response.provider).toBe("unknown");
		expect(response.finish_reason.reason).toBe("tool_calls");
		expect(response.usage.input_tokens).toBe(15);
		expect(response.usage.output_tokens).toBe(25);

		// Content should have thinking, text, and tool_call parts
		const content = response.message.content;
		expect(content).toHaveLength(3);

		expect(content[0].kind).toBe("thinking");
		expect(content[0].thinking?.text).toBe("thinking...");

		expect(content[1].kind).toBe("text");
		expect(content[1].text).toBe("Hello world");

		expect(content[2].kind).toBe("tool_call");
		expect(content[2].tool_call?.id).toBe("tc-1");
		expect(content[2].tool_call?.name).toBe("my_tool");
		expect(content[2].tool_call?.arguments).toEqual({ key: "val" });
	});

	it("returns a minimal response when no events are pushed", () => {
		const acc = new StreamAccumulator();
		const response = acc.response();

		expect(response.id).toBe("accumulated");
		expect(response.message.role).toBe("assistant");
		expect(response.message.content).toHaveLength(0);
		expect(response.finish_reason.reason).toBe("other");
	});

	it("omits reasoning and text parts when they are empty", () => {
		const acc = new StreamAccumulator();

		acc.push({
			type: "TOOL_CALL_START",
			tool_call: { id: "tc-1", name: "tool" },
		});
		acc.push({ type: "TOOL_CALL_DELTA", delta: "{}" });
		acc.push({ type: "TOOL_CALL_END" });

		const response = acc.response();
		const content = response.message.content;

		// Only the tool_call part should be present
		expect(content).toHaveLength(1);
		expect(content[0].kind).toBe("tool_call");
	});
});

// ---------------------------------------------------------------------------
// Accessor methods
// ---------------------------------------------------------------------------

describe("StreamAccumulator — getText(), getReasoning(), getToolCalls(), getUsage()", () => {
	it("getText() returns accumulated text", () => {
		const acc = new StreamAccumulator();
		acc.push({ type: "TEXT_DELTA", delta: "abc" });
		acc.push({ type: "TEXT_DELTA", delta: "def" });
		expect(acc.getText()).toBe("abcdef");
	});

	it("getReasoning() returns accumulated reasoning or undefined", () => {
		const acc = new StreamAccumulator();
		expect(acc.getReasoning()).toBeUndefined();

		acc.push({ type: "REASONING_DELTA", reasoning_delta: "reason" });
		expect(acc.getReasoning()).toBe("reason");
	});

	it("getToolCalls() returns parsed tool calls", () => {
		const acc = new StreamAccumulator();

		acc.push({
			type: "TOOL_CALL_START",
			tool_call: { id: "tc-1", name: "fn" },
		});
		acc.push({ type: "TOOL_CALL_DELTA", delta: '{"a":1}' });
		acc.push({ type: "TOOL_CALL_END" });

		const calls = acc.getToolCalls();
		expect(calls).toHaveLength(1);
		expect(calls[0]).toEqual({
			id: "tc-1",
			name: "fn",
			arguments: { a: 1 },
			raw_arguments: '{"a":1}',
		});
	});

	it("getUsage() returns usage from FINISH event", () => {
		const acc = new StreamAccumulator();

		acc.push({
			type: "FINISH",
			finish_reason: { reason: "stop" },
			usage: { input_tokens: 5, output_tokens: 10, total_tokens: 15 },
		});

		const usage = acc.getUsage();
		expect(usage.input_tokens).toBe(5);
		expect(usage.output_tokens).toBe(10);
		expect(usage.total_tokens).toBe(15);
	});

	it("getUsage() returns zero usage when no FINISH event", () => {
		const acc = new StreamAccumulator();
		const usage = acc.getUsage();
		expect(usage.input_tokens).toBe(0);
		expect(usage.output_tokens).toBe(0);
		expect(usage.total_tokens).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("StreamAccumulator — edge cases", () => {
	it("handles STREAM_START without error", () => {
		const acc = new StreamAccumulator();
		acc.push({ type: "STREAM_START" });
		expect(acc.getText()).toBe("");
	});

	it("handles ERROR event without crashing", () => {
		const acc = new StreamAccumulator();
		acc.push({ type: "ERROR", error: new Error("boom") });
		// Should not affect accumulated state
		expect(acc.getText()).toBe("");
	});

	it("handles unknown event types gracefully", () => {
		const acc = new StreamAccumulator();
		acc.push({ type: "PROVIDER_EVENT" as StreamEvent["type"], raw: { custom: true } });
		expect(acc.getText()).toBe("");
	});

	it("handles tool call with empty arguments string", () => {
		const acc = new StreamAccumulator();

		acc.push({
			type: "TOOL_CALL_START",
			tool_call: { id: "tc-1", name: "empty_args" },
		});
		// No TOOL_CALL_DELTA events — args remain ""
		acc.push({ type: "TOOL_CALL_END" });

		const calls = acc.getToolCalls();
		expect(calls).toHaveLength(1);
		// Empty string is not valid JSON, should produce empty args
		expect(calls[0].arguments).toEqual({});
		expect(calls[0].raw_arguments).toBe("");
	});
});
