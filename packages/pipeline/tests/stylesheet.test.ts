import { describe, expect, it } from "vitest";
import { applyStylesheet, parseStylesheet } from "../src/stylesheet.js";
import type { Graph, Node } from "../src/types.js";

function makeNode(id: string, attrs: Node["attributes"] = {}): Node {
	return { id, attributes: { ...attrs } };
}

function makeGraph(nodes: Node[]): Graph {
	const nodeMap = new Map<string, Node>();
	for (const n of nodes) {
		nodeMap.set(n.id, n);
	}
	return {
		name: "test",
		attributes: {},
		nodes: nodeMap,
		edges: [],
		subgraphs: [],
	};
}

describe("parseStylesheet", () => {
	it("parses universal selector *", () => {
		const rules = parseStylesheet("* { llm_model: gpt-4 }");
		expect(rules).toHaveLength(1);
		expect(rules[0].selector).toEqual({
			type: "universal",
			value: "*",
			specificity: 0,
		});
		expect(rules[0].declarations).toEqual({ llm_model: "gpt-4" });
	});

	it("parses ID selector #node_id", () => {
		const rules = parseStylesheet("#review { llm_model: claude-opus-4-20250514 }");
		expect(rules).toHaveLength(1);
		expect(rules[0].selector).toEqual({
			type: "id",
			value: "review",
			specificity: 3,
		});
	});

	it("parses class selector .classname", () => {
		const rules = parseStylesheet(".fast { reasoning_effort: low }");
		expect(rules).toHaveLength(1);
		expect(rules[0].selector).toEqual({
			type: "class",
			value: "fast",
			specificity: 2,
		});
	});

	it("parses shape selector (bare word)", () => {
		const rules = parseStylesheet("diamond { llm_provider: openai }");
		expect(rules).toHaveLength(1);
		expect(rules[0].selector).toEqual({
			type: "shape",
			value: "diamond",
			specificity: 1,
		});
	});

	it("parses multiple declarations separated by semicolons", () => {
		const rules = parseStylesheet(
			"* { llm_model: gpt-4; llm_provider: openai; reasoning_effort: high }",
		);
		expect(rules).toHaveLength(1);
		expect(rules[0].declarations).toEqual({
			llm_model: "gpt-4",
			llm_provider: "openai",
			reasoning_effort: "high",
		});
	});

	it("empty stylesheet returns empty rules", () => {
		expect(parseStylesheet("")).toEqual([]);
		expect(parseStylesheet("   ")).toEqual([]);
	});
});

describe("applyStylesheet", () => {
	it("applies universal rules to all nodes", () => {
		const graph = makeGraph([makeNode("a"), makeNode("b")]);
		const rules = parseStylesheet("* { llm_model: gpt-4 }");
		const result = applyStylesheet(graph, rules);

		for (const [, node] of result.nodes) {
			expect(node.attributes.llm_model).toBe("gpt-4");
		}
	});

	it("respects specificity (ID > class > shape > universal)", () => {
		const graph = makeGraph([makeNode("special", { class: "fast", shape: "diamond" })]);
		const rules = parseStylesheet(
			[
				"* { llm_model: universal-model }",
				"diamond { llm_model: shape-model }",
				".fast { llm_model: class-model }",
				"#special { llm_model: id-model }",
			].join("\n"),
		);
		const result = applyStylesheet(graph, rules);
		const node = result.nodes.get("special")!;
		expect(node.attributes.llm_model).toBe("id-model");
	});

	it("does not override explicit node attributes", () => {
		const graph = makeGraph([makeNode("a", { llm_model: "my-custom-model" })]);
		const rules = parseStylesheet("* { llm_model: gpt-4 }");
		const result = applyStylesheet(graph, rules);
		const node = result.nodes.get("a")!;
		expect(node.attributes.llm_model).toBe("my-custom-model");
	});
});
