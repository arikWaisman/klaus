import { describe, expect, it } from "vitest";
import { buildContextPreamble, findIncomingEdge, resolveFidelity } from "../src/fidelity.js";
import type { Edge, FidelityMode, Graph, Node, PipelineContext } from "../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeNode(id: string, fidelity?: FidelityMode): Node {
	return { id, attributes: { fidelity } };
}

function makeEdge(from: string, to: string, fidelity?: FidelityMode): Edge {
	return { from, to, attributes: { fidelity } };
}

function makeContext(values: Record<string, unknown>): PipelineContext {
	const store = { ...values };
	return {
		get(key: string) {
			return store[key];
		},
		set(key: string, value: unknown) {
			store[key] = value;
		},
		getAll() {
			return { ...store };
		},
		merge(updates: Record<string, unknown>) {
			Object.assign(store, updates);
		},
	};
}

function makeGraph(edges: Edge[], defaultFidelity?: FidelityMode): Graph {
	return {
		name: "test",
		attributes: { default_fidelity: defaultFidelity },
		nodes: new Map(),
		edges,
		subgraphs: [],
	};
}

// ---------------------------------------------------------------------------
// resolveFidelity
// ---------------------------------------------------------------------------

describe("resolveFidelity", () => {
	it("uses edge fidelity when present", () => {
		const node = makeNode("A", "compact");
		const edge = makeEdge("X", "A", "full");
		expect(resolveFidelity(node, edge, "truncate")).toBe("full");
	});

	it("falls back to node fidelity when edge has none", () => {
		const node = makeNode("A", "summary:high");
		const edge = makeEdge("X", "A");
		expect(resolveFidelity(node, edge, "truncate")).toBe("summary:high");
	});

	it("falls back to graph default when node has none", () => {
		const node = makeNode("A");
		const edge = makeEdge("X", "A");
		expect(resolveFidelity(node, edge, "summary:low")).toBe("summary:low");
	});

	it("falls back to compact when nothing is set", () => {
		const node = makeNode("A");
		expect(resolveFidelity(node, undefined, undefined)).toBe("compact");
	});
});

// ---------------------------------------------------------------------------
// buildContextPreamble
// ---------------------------------------------------------------------------

describe("buildContextPreamble", () => {
	it("returns empty string when no prior responses exist", () => {
		const ctx = makeContext({ someKey: "value" });
		expect(buildContextPreamble(ctx, "full", "A")).toBe("");
	});

	it("excludes current node's response", () => {
		const ctx = makeContext({ "A.response": "my output" });
		expect(buildContextPreamble(ctx, "full", "A")).toBe("");
	});

	it("includes other nodes' responses in full mode without truncation", () => {
		const longText = "x".repeat(50000);
		const ctx = makeContext({ "B.response": longText });
		const result = buildContextPreamble(ctx, "full", "A");
		expect(result).toContain("## Prior context");
		expect(result).toContain("### B");
		expect(result).toContain(longText);
		expect(result).not.toContain("...");
	});

	it("truncates responses in truncate mode (400 char budget)", () => {
		const longText = "y".repeat(1000);
		const ctx = makeContext({ "B.response": longText });
		const result = buildContextPreamble(ctx, "truncate", "A");
		expect(result).toContain("### B");
		expect(result).toContain("...");
		// The section text should be at most ~400 chars (397 + "...")
		const section = result.split("### B\n")[1]!.trim();
		expect(section.length).toBeLessThanOrEqual(400);
	});

	it("splits budget across multiple entries", () => {
		const text = "z".repeat(500);
		const ctx = makeContext({
			"B.response": text,
			"C.response": text,
		});
		const result = buildContextPreamble(ctx, "truncate", "A");
		expect(result).toContain("### B");
		expect(result).toContain("### C");
		// Each gets 200 chars of the 400 budget
		const parts = result.split("###").filter(Boolean);
		for (const part of parts) {
			const content = part.split("\n").slice(1).join("\n").trim();
			expect(content.length).toBeLessThanOrEqual(200);
		}
	});

	it("does not truncate short responses even in truncate mode", () => {
		const ctx = makeContext({ "B.response": "short" });
		const result = buildContextPreamble(ctx, "truncate", "A");
		expect(result).toContain("short");
		expect(result).not.toContain("...");
	});

	it("uses compact budget (3200 chars) by default mode", () => {
		const longText = "a".repeat(5000);
		const ctx = makeContext({ "B.response": longText });
		const result = buildContextPreamble(ctx, "compact", "A");
		const section = result.split("### B\n")[1]!.trim();
		expect(section.length).toBeLessThanOrEqual(3200);
	});

	it("formats preamble with markdown headers", () => {
		const ctx = makeContext({
			"B.response": "hello",
			"C.response": "world",
		});
		const result = buildContextPreamble(ctx, "full", "A");
		expect(result).toMatch(/^## Prior context\n\n### B\nhello\n\n### C\nworld\n$/);
	});

	it("ignores non-string response values", () => {
		const ctx = makeContext({
			"B.response": 42,
			"C.response": "valid",
		});
		const result = buildContextPreamble(ctx, "full", "A");
		expect(result).not.toContain("### B");
		expect(result).toContain("### C");
	});
});

// ---------------------------------------------------------------------------
// findIncomingEdge
// ---------------------------------------------------------------------------

describe("findIncomingEdge", () => {
	it("returns the first incoming edge for a node", () => {
		const edges = [makeEdge("A", "B"), makeEdge("C", "B")];
		const graph = makeGraph(edges);
		const result = findIncomingEdge(graph, "B");
		expect(result).toBe(edges[0]);
	});

	it("returns undefined when no incoming edges exist", () => {
		const graph = makeGraph([makeEdge("A", "B")]);
		expect(findIncomingEdge(graph, "A")).toBeUndefined();
	});
});
