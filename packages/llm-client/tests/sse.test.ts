import { describe, expect, it } from "vitest";
import { parseSSEStream } from "../src/sse.js";
import type { SSEEvent } from "../src/sse.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a ReadableStream<Uint8Array> from one or more string chunks.
 * Each string is encoded as a separate chunk, simulating network delivery.
 */
function streamFromChunks(...chunks: string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	let index = 0;
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			if (index < chunks.length) {
				controller.enqueue(encoder.encode(chunks[index]));
				index++;
			} else {
				controller.close();
			}
		},
	});
}

/** Convenience: single chunk containing the entire SSE payload. */
function streamFrom(text: string): ReadableStream<Uint8Array> {
	return streamFromChunks(text);
}

/** Collect all events from the async iterator into an array. */
async function collectEvents(
	body: ReadableStream<Uint8Array>,
	signal?: AbortSignal,
): Promise<SSEEvent[]> {
	const events: SSEEvent[] = [];
	for await (const event of parseSSEStream(body, signal)) {
		events.push(event);
	}
	return events;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("parseSSEStream", () => {
	it("parses basic data events", async () => {
		const stream = streamFrom("data: hello\n\ndata: world\n\n");
		const events = await collectEvents(stream);

		expect(events).toHaveLength(2);
		expect(events[0].data).toBe("hello");
		expect(events[1].data).toBe("world");
	});

	it("parses events with event type", async () => {
		const stream = streamFrom("event: message\ndata: payload\n\n");
		const events = await collectEvents(stream);

		expect(events).toHaveLength(1);
		expect(events[0].event).toBe("message");
		expect(events[0].data).toBe("payload");
	});

	it("parses events with id field", async () => {
		const stream = streamFrom("id: 42\ndata: hello\n\n");
		const events = await collectEvents(stream);

		expect(events).toHaveLength(1);
		expect(events[0].id).toBe("42");
		expect(events[0].data).toBe("hello");
	});

	it("parses events with retry field", async () => {
		const stream = streamFrom("retry: 5000\ndata: hello\n\n");
		const events = await collectEvents(stream);

		expect(events).toHaveLength(1);
		expect(events[0].retry).toBe(5000);
		expect(events[0].data).toBe("hello");
	});

	it("handles multi-line data", async () => {
		const stream = streamFrom("data: line one\ndata: line two\ndata: line three\n\n");
		const events = await collectEvents(stream);

		expect(events).toHaveLength(1);
		expect(events[0].data).toBe("line one\nline two\nline three");
	});

	it("handles [DONE] sentinel and stops iteration", async () => {
		const stream = streamFrom("data: first\n\ndata: [DONE]\n\ndata: should not appear\n\n");
		const events = await collectEvents(stream);

		expect(events).toHaveLength(1);
		expect(events[0].data).toBe("first");
	});

	it("handles comment lines (lines starting with :)", async () => {
		const stream = streamFrom(": this is a comment\ndata: visible\n\n");
		const events = await collectEvents(stream);

		expect(events).toHaveLength(1);
		expect(events[0].data).toBe("visible");
	});

	it("handles data: with space after colon", async () => {
		const stream = streamFrom("data: with space\n\n");
		const events = await collectEvents(stream);

		expect(events).toHaveLength(1);
		expect(events[0].data).toBe("with space");
	});

	it("handles data: without space after colon", async () => {
		const stream = streamFrom("data:no space\n\n");
		const events = await collectEvents(stream);

		expect(events).toHaveLength(1);
		expect(events[0].data).toBe("no space");
	});

	it("handles event: with and without space after colon", async () => {
		const stream = streamFrom("event: spaced\ndata: a\n\nevent:nospace\ndata: b\n\n");
		const events = await collectEvents(stream);

		expect(events).toHaveLength(2);
		expect(events[0].event).toBe("spaced");
		expect(events[1].event).toBe("nospace");
	});

	it("handles empty lines between events gracefully", async () => {
		const stream = streamFrom("\n\ndata: first\n\n\n\ndata: second\n\n");
		const events = await collectEvents(stream);

		expect(events).toHaveLength(2);
		expect(events[0].data).toBe("first");
		expect(events[1].data).toBe("second");
	});

	it("handles stream abort via signal", async () => {
		const controller = new AbortController();

		// Create a stream that will produce events slowly
		let pullCount = 0;
		const encoder = new TextEncoder();
		const stream = new ReadableStream<Uint8Array>({
			pull(streamController) {
				pullCount++;
				if (pullCount === 1) {
					streamController.enqueue(encoder.encode("data: first\n\n"));
					// Abort after the first chunk
					controller.abort();
				} else if (pullCount === 2) {
					streamController.enqueue(encoder.encode("data: second\n\n"));
				} else {
					streamController.close();
				}
			},
		});

		const events = await collectEvents(stream, controller.signal);

		// Should have received the first event, but iteration should stop
		// after abort before processing more
		expect(events).toHaveLength(1);
		expect(events[0].data).toBe("first");
	});

	it("handles data split across multiple chunks", async () => {
		const stream = streamFromChunks("data: hel", "lo\n\ndata: wor", "ld\n\n");
		const events = await collectEvents(stream);

		expect(events).toHaveLength(2);
		expect(events[0].data).toBe("hello");
		expect(events[1].data).toBe("world");
	});

	it("handles empty stream", async () => {
		const stream = streamFrom("");
		const events = await collectEvents(stream);

		expect(events).toHaveLength(0);
	});

	it("resets event/id/retry between dispatched events", async () => {
		const stream = streamFrom("event: alpha\nid: 1\ndata: first\n\ndata: second\n\n");
		const events = await collectEvents(stream);

		expect(events).toHaveLength(2);
		expect(events[0].event).toBe("alpha");
		expect(events[0].id).toBe("1");
		expect(events[1].event).toBeUndefined();
		expect(events[1].id).toBeUndefined();
	});

	it("handles JSON data payloads", async () => {
		const json = JSON.stringify({ choices: [{ delta: { content: "hi" } }] });
		const stream = streamFrom(`data: ${json}\n\n`);
		const events = await collectEvents(stream);

		expect(events).toHaveLength(1);
		const parsed = JSON.parse(events[0].data);
		expect(parsed.choices[0].delta.content).toBe("hi");
	});

	it("handles trailing data without final newline", async () => {
		// Data that's in the buffer when the stream closes, not terminated by \n\n
		const stream = streamFrom("data: trailing");
		const events = await collectEvents(stream);

		// The trailing data should still be yielded
		expect(events).toHaveLength(1);
		expect(events[0].data).toBe("trailing");
	});

	it("ignores trailing [DONE] without newline", async () => {
		const stream = streamFrom("data: first\n\ndata: [DONE]");
		const events = await collectEvents(stream);

		expect(events).toHaveLength(1);
		expect(events[0].data).toBe("first");
	});
});
