import { describe, it, expect } from "vitest";
import { MessageQueue } from "../src/steering.js";

describe("MessageQueue", () => {
	it("push adds messages to queue", () => {
		const queue = new MessageQueue();
		queue.push("hello");
		expect(queue.length).toBe(1);
		queue.push("world");
		expect(queue.length).toBe(2);
	});

	it("drain returns all messages and empties the queue", () => {
		const queue = new MessageQueue();
		queue.push("first");
		queue.push("second");
		queue.push("third");

		const messages = queue.drain();

		expect(messages).toEqual(["first", "second", "third"]);
		expect(queue.length).toBe(0);
		expect(queue.isEmpty()).toBe(true);
	});

	it("drain returns empty array when queue is empty", () => {
		const queue = new MessageQueue();
		const messages = queue.drain();

		expect(messages).toEqual([]);
	});

	it("isEmpty returns true for empty queue", () => {
		const queue = new MessageQueue();
		expect(queue.isEmpty()).toBe(true);
	});

	it("isEmpty returns false for non-empty queue", () => {
		const queue = new MessageQueue();
		queue.push("message");
		expect(queue.isEmpty()).toBe(false);
	});

	it("length returns current queue size", () => {
		const queue = new MessageQueue();
		expect(queue.length).toBe(0);

		queue.push("a");
		expect(queue.length).toBe(1);

		queue.push("b");
		queue.push("c");
		expect(queue.length).toBe(3);

		queue.drain();
		expect(queue.length).toBe(0);
	});

	it("multiple push then drain preserves FIFO order", () => {
		const queue = new MessageQueue();
		queue.push("alpha");
		queue.push("beta");
		queue.push("gamma");
		queue.push("delta");
		queue.push("epsilon");

		const messages = queue.drain();

		expect(messages).toEqual(["alpha", "beta", "gamma", "delta", "epsilon"]);

		// Queue is now empty, further drain returns empty
		expect(queue.drain()).toEqual([]);
	});
});
