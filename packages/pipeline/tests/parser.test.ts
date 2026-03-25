import { describe, it, expect } from "vitest";
import { parseDOT } from "../src/parser.js";

const SAMPLE_DOT = `
digraph Pipeline {
	graph [goal="Build the app", label="My Pipeline"]

	start [shape=Mdiamond, label="Begin"]
	code [shape=box, prompt="Write code for $goal"]
	review [shape=hexagon, label="Review code?"]
	end [shape=Msquare, label="Done"]

	start -> code [label="next"]
	code -> review [label="done"]
	review -> code [label="Reject", condition="preferred_label=Reject"]
	review -> end [label="Approve"]
}
`;

describe("parseDOT", () => {
	it("parses a minimal digraph with start and exit nodes", () => {
		const dot = `
			digraph Minimal {
				s [shape=Mdiamond]
				e [shape=Msquare]
				s -> e
			}
		`;
		const graph = parseDOT(dot);

		expect(graph.name).toBe("Minimal");
		expect(graph.nodes.size).toBe(2);
		expect(graph.nodes.has("s")).toBe(true);
		expect(graph.nodes.has("e")).toBe(true);
		expect(graph.edges).toHaveLength(1);
		expect(graph.edges[0].from).toBe("s");
		expect(graph.edges[0].to).toBe("e");
	});

	it("parses node attributes (label, shape, type, prompt, max_retries, goal_gate)", () => {
		const dot = `
			digraph Attrs {
				s [shape=Mdiamond]
				worker [shape=box, label="Do work", prompt="Execute task", max_retries=3, goal_gate=true]
				e [shape=Msquare]
				s -> worker -> e
			}
		`;
		const graph = parseDOT(dot);
		const worker = graph.nodes.get("worker");

		expect(worker).toBeDefined();
		expect(worker!.attributes.label).toBe("Do work");
		expect(worker!.attributes.shape).toBe("box");
		expect(worker!.attributes.prompt).toBe("Execute task");
		expect(worker!.attributes.max_retries).toBe(3);
		expect(worker!.attributes.goal_gate).toBe(true);
	});

	it("parses edge attributes (label, condition, weight)", () => {
		const graph = parseDOT(SAMPLE_DOT);

		const rejectEdge = graph.edges.find(
			(e) => e.from === "review" && e.to === "code"
		);
		expect(rejectEdge).toBeDefined();
		expect(rejectEdge!.attributes.label).toBe("Reject");
		expect(rejectEdge!.attributes.condition).toBe("preferred_label=Reject");

		const dot = `
			digraph W {
				a [shape=Mdiamond]
				b [shape=Msquare]
				a -> b [weight=0.75, label="weighted"]
			}
		`;
		const g2 = parseDOT(dot);
		expect(g2.edges[0].attributes.weight).toBe(0.75);
		expect(g2.edges[0].attributes.label).toBe("weighted");
	});

	it("handles chained edges: A -> B -> C produces two separate edges", () => {
		const dot = `
			digraph Chain {
				A [shape=Mdiamond]
				B [shape=box]
				C [shape=Msquare]
				A -> B -> C [label="chained"]
			}
		`;
		const graph = parseDOT(dot);

		expect(graph.edges).toHaveLength(2);
		expect(graph.edges[0].from).toBe("A");
		expect(graph.edges[0].to).toBe("B");
		expect(graph.edges[1].from).toBe("B");
		expect(graph.edges[1].to).toBe("C");

		// Both edges share the same attributes
		expect(graph.edges[0].attributes.label).toBe("chained");
		expect(graph.edges[1].attributes.label).toBe("chained");
	});

	it("parses graph-level attributes (goal, label, model_stylesheet)", () => {
		const dot = `
			digraph G {
				graph [goal="Ship it", label="Release Pipeline", model_stylesheet="fancy.css"]
				s [shape=Mdiamond]
				e [shape=Msquare]
				s -> e
			}
		`;
		const graph = parseDOT(dot);

		expect(graph.attributes.goal).toBe("Ship it");
		expect(graph.attributes.label).toBe("Release Pipeline");
		expect(graph.attributes.model_stylesheet).toBe("fancy.css");
	});

	it("parses graph-level attributes from the sample DOT", () => {
		const graph = parseDOT(SAMPLE_DOT);

		expect(graph.attributes.goal).toBe("Build the app");
		expect(graph.attributes.label).toBe("My Pipeline");
	});

	it("strips line comments (//) and block comments (/* */)", () => {
		const dot = `
			digraph Comments {
				// This is a line comment
				s [shape=Mdiamond] // inline comment
				e [shape=Msquare]
				/* This is a block comment */
				s -> e /* another block comment */
			}
		`;
		const graph = parseDOT(dot);

		expect(graph.nodes.size).toBe(2);
		expect(graph.edges).toHaveLength(1);
		expect(graph.nodes.has("s")).toBe(true);
		expect(graph.nodes.has("e")).toBe(true);
	});

	it("preserves quoted strings that contain comment-like characters", () => {
		const dot = `
			digraph Q {
				s [shape=Mdiamond]
				worker [shape=box, label="Do // this /* stuff */"]
				e [shape=Msquare]
				s -> worker -> e
			}
		`;
		const graph = parseDOT(dot);
		const worker = graph.nodes.get("worker");

		expect(worker!.attributes.label).toBe("Do // this /* stuff */");
	});

	it("parses quoted string attributes with escape sequences", () => {
		const dot = `
			digraph Esc {
				s [shape=Mdiamond]
				node1 [shape=box, label="line1\\nline2", prompt="say \\"hello\\""]
				e [shape=Msquare]
				s -> node1 -> e
			}
		`;
		const graph = parseDOT(dot);
		const node1 = graph.nodes.get("node1");

		expect(node1!.attributes.label).toBe("line1\nline2");
		expect(node1!.attributes.prompt).toBe('say "hello"');
	});

	it("parses boolean attributes (true/false)", () => {
		const dot = `
			digraph Bool {
				s [shape=Mdiamond]
				worker [shape=box, goal_gate=true, auto_status=false]
				e [shape=Msquare]
				s -> worker -> e
			}
		`;
		const graph = parseDOT(dot);
		const worker = graph.nodes.get("worker");

		expect(worker!.attributes.goal_gate).toBe(true);
		expect(worker!.attributes.auto_status).toBe(false);
	});

	it("parses integer and float attributes", () => {
		const dot = `
			digraph Nums {
				s [shape=Mdiamond]
				worker [shape=box, max_retries=5, max_parallel=3]
				e [shape=Msquare]
				s -> worker -> e [weight=1.5]
			}
		`;
		const graph = parseDOT(dot);
		const worker = graph.nodes.get("worker");

		expect(worker!.attributes.max_retries).toBe(5);
		expect(worker!.attributes.max_parallel).toBe(3);
		expect(graph.edges[1].attributes.weight).toBe(1.5);
	});

	it("handles subgraph declarations", () => {
		const dot = `
			digraph Sub {
				s [shape=Mdiamond]
				e [shape=Msquare]

				subgraph cluster_work {
					a [shape=box, label="A"]
					b [shape=box, label="B"]
					a -> b
				}

				s -> a
				b -> e
			}
		`;
		const graph = parseDOT(dot);

		expect(graph.subgraphs).toHaveLength(1);
		expect(graph.subgraphs[0].name).toBe("cluster_work");
		expect(graph.subgraphs[0].node_ids).toContain("a");
		expect(graph.subgraphs[0].node_ids).toContain("b");

		// Subgraph nodes are also in the top-level nodes map
		expect(graph.nodes.has("a")).toBe(true);
		expect(graph.nodes.has("b")).toBe(true);
	});

	it("infers handler type from shape (Mdiamond->start, Msquare->exit, box->codergen, hexagon->wait.human, diamond->conditional)", () => {
		const dot = `
			digraph Types {
				s [shape=Mdiamond]
				coder [shape=box]
				waiter [shape=hexagon]
				cond [shape=diamond]
				e [shape=Msquare]
				s -> coder -> waiter -> cond -> e
			}
		`;
		const graph = parseDOT(dot);

		expect(graph.nodes.get("s")!.attributes.type).toBe("start");
		expect(graph.nodes.get("coder")!.attributes.type).toBe("codergen");
		expect(graph.nodes.get("waiter")!.attributes.type).toBe("wait.human");
		expect(graph.nodes.get("cond")!.attributes.type).toBe("conditional");
		expect(graph.nodes.get("e")!.attributes.type).toBe("exit");
	});

	it("infers additional handler types (component->parallel, tripleoctagon->parallel.fan_in, parallelogram->tool, house->stack.manager_loop)", () => {
		const dot = `
			digraph More {
				s [shape=Mdiamond]
				par [shape=component]
				fan [shape=tripleoctagon]
				tool [shape=parallelogram]
				mgr [shape=house]
				e [shape=Msquare]
				s -> par -> fan -> tool -> mgr -> e
			}
		`;
		const graph = parseDOT(dot);

		expect(graph.nodes.get("par")!.attributes.type).toBe("parallel");
		expect(graph.nodes.get("fan")!.attributes.type).toBe("parallel.fan_in");
		expect(graph.nodes.get("tool")!.attributes.type).toBe("tool");
		expect(graph.nodes.get("mgr")!.attributes.type).toBe("stack.manager_loop");
	});

	it("explicit type attribute overrides shape inference", () => {
		const dot = `
			digraph Override {
				s [shape=Mdiamond]
				worker [shape=box, type="custom_handler"]
				e [shape=Msquare]
				s -> worker -> e
			}
		`;
		const graph = parseDOT(dot);
		const worker = graph.nodes.get("worker");

		// type should remain "custom_handler" instead of being overwritten to "codergen"
		expect(worker!.attributes.type).toBe("custom_handler");
	});

	it("parses the sample DOT with correct node count and edge count", () => {
		const graph = parseDOT(SAMPLE_DOT);

		expect(graph.name).toBe("Pipeline");
		expect(graph.nodes.size).toBe(4);
		expect(graph.edges).toHaveLength(4);

		// Verify all nodes
		expect(graph.nodes.has("start")).toBe(true);
		expect(graph.nodes.has("code")).toBe(true);
		expect(graph.nodes.has("review")).toBe(true);
		expect(graph.nodes.has("end")).toBe(true);

		// Verify node types inferred from shape
		expect(graph.nodes.get("start")!.attributes.type).toBe("start");
		expect(graph.nodes.get("code")!.attributes.type).toBe("codergen");
		expect(graph.nodes.get("review")!.attributes.type).toBe("wait.human");
		expect(graph.nodes.get("end")!.attributes.type).toBe("exit");
	});

	it("parses nodes created implicitly by edges", () => {
		const dot = `
			digraph Implicit {
				a -> b -> c
			}
		`;
		const graph = parseDOT(dot);

		expect(graph.nodes.size).toBe(3);
		expect(graph.nodes.has("a")).toBe(true);
		expect(graph.nodes.has("b")).toBe(true);
		expect(graph.nodes.has("c")).toBe(true);
	});

	it("handles shape case-insensitivity", () => {
		const dot = `
			digraph CaseTest {
				s [shape=MDIAMOND]
				e [shape=msquare]
				s -> e
			}
		`;
		const graph = parseDOT(dot);

		expect(graph.nodes.get("s")!.attributes.shape).toBe("mdiamond");
		expect(graph.nodes.get("s")!.attributes.type).toBe("start");
		expect(graph.nodes.get("e")!.attributes.shape).toBe("msquare");
		expect(graph.nodes.get("e")!.attributes.type).toBe("exit");
	});
});
