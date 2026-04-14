import { describe, expect, it } from "vitest";
import { Context } from "../src/context.js";

describe("Context", () => {
	it("get/set basic key-value", () => {
		const ctx = new Context();
		ctx.set("name", "klaus");
		expect(ctx.get("name")).toBe("klaus");
	});

	it("getAll returns all stored values", () => {
		const ctx = new Context();
		ctx.set("a", 1);
		ctx.set("b", "two");
		ctx.set("c", true);
		expect(ctx.getAll()).toEqual({ a: 1, b: "two", c: true });
	});

	it("merge merges multiple values", () => {
		const ctx = new Context();
		ctx.set("existing", "keep");
		ctx.merge({ x: 10, y: 20 });
		expect(ctx.get("existing")).toBe("keep");
		expect(ctx.get("x")).toBe(10);
		expect(ctx.get("y")).toBe(20);
	});

	it("toCheckpoint creates correct checkpoint structure", () => {
		const ctx = new Context();
		ctx.set("key", "value");

		const cp = ctx.toCheckpoint("node_1", ["node_0"], { node_0: 1 }, ["log entry"]);

		expect(cp.current_node).toBe("node_1");
		expect(cp.completed_nodes).toEqual(["node_0"]);
		expect(cp.node_retries).toEqual({ node_0: 1 });
		expect(cp.context_values).toEqual({ key: "value" });
		expect(cp.logs).toEqual(["log entry"]);
		expect(cp.timestamp).toBeTypeOf("number");
	});

	it("fromCheckpoint restores context values", () => {
		const original = new Context();
		original.set("lang", "typescript");
		original.set("version", 5);

		const cp = original.toCheckpoint("n", [], {}, []);
		const restored = Context.fromCheckpoint(cp);

		expect(restored.get("lang")).toBe("typescript");
		expect(restored.get("version")).toBe(5);
		expect(restored.getAll()).toEqual({ lang: "typescript", version: 5 });
	});

	it("overwriting a key updates the value", () => {
		const ctx = new Context();
		ctx.set("count", 1);
		expect(ctx.get("count")).toBe(1);
		ctx.set("count", 2);
		expect(ctx.get("count")).toBe(2);
	});
});
