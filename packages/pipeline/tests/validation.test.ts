import { describe, it, expect } from "vitest";
import { validate, validateOrThrow } from "../src/validation.js";
import { parseDOT } from "../src/parser.js";

function buildDOT(body: string): string {
	return `digraph Test {\n${body}\n}`;
}

const VALID_PIPELINE = buildDOT(`
	start [shape=Mdiamond]
	code [shape=box, prompt="Write code"]
	end [shape=Msquare]
	start -> code -> end
`);

describe("validate", () => {
	it("valid pipeline passes with no errors", () => {
		const graph = parseDOT(VALID_PIPELINE);
		const diagnostics = validate(graph);
		const errors = diagnostics.filter((d) => d.severity === "error");

		expect(errors).toHaveLength(0);
	});

	it("missing start node produces error", () => {
		const dot = buildDOT(`
			code [shape=box, prompt="Write code"]
			end [shape=Msquare]
			code -> end
		`);
		const graph = parseDOT(dot);
		const diagnostics = validate(graph);
		const errors = diagnostics.filter((d) => d.severity === "error");

		expect(errors.length).toBeGreaterThanOrEqual(1);
		expect(errors.some((e) => e.message.toLowerCase().includes("start"))).toBe(true);
	});

	it("missing exit node produces error", () => {
		const dot = buildDOT(`
			start [shape=Mdiamond]
			code [shape=box, prompt="Write code"]
			start -> code
		`);
		const graph = parseDOT(dot);
		const diagnostics = validate(graph);
		const errors = diagnostics.filter((d) => d.severity === "error");

		expect(errors.length).toBeGreaterThanOrEqual(1);
		expect(errors.some((e) => e.message.toLowerCase().includes("exit"))).toBe(true);
	});

	it("multiple start nodes produces error", () => {
		const dot = buildDOT(`
			s1 [shape=Mdiamond]
			s2 [shape=Mdiamond]
			end [shape=Msquare]
			s1 -> end
			s2 -> end
		`);
		const graph = parseDOT(dot);
		const diagnostics = validate(graph);
		const errors = diagnostics.filter((d) => d.severity === "error");

		expect(errors.length).toBeGreaterThanOrEqual(1);
		expect(errors.some((e) => e.message.toLowerCase().includes("multiple start"))).toBe(true);
	});

	it("unreachable node produces error", () => {
		const dot = buildDOT(`
			start [shape=Mdiamond]
			code [shape=box, prompt="Write code"]
			orphan [shape=box, prompt="I am lost"]
			end [shape=Msquare]
			start -> code -> end
		`);
		const graph = parseDOT(dot);
		const diagnostics = validate(graph);
		const errors = diagnostics.filter((d) => d.severity === "error");

		expect(errors.length).toBeGreaterThanOrEqual(1);
		expect(errors.some((e) => e.message.includes("orphan") && e.message.includes("reachable"))).toBe(true);
	});

	it("edge referencing non-existent node produces error", () => {
		const graph = parseDOT(VALID_PIPELINE);

		// Manually inject an edge with a bogus target
		graph.edges.push({
			from: "code",
			to: "ghost",
			attributes: {},
		});

		const diagnostics = validate(graph);
		const errors = diagnostics.filter((d) => d.severity === "error");

		expect(errors.length).toBeGreaterThanOrEqual(1);
		expect(errors.some((e) => e.message.includes("ghost"))).toBe(true);
	});

	it("invalid condition expression produces error", () => {
		const dot = buildDOT(`
			start [shape=Mdiamond]
			code [shape=box, prompt="Do stuff"]
			end [shape=Msquare]
			start -> code [condition="missing_operator"]
			code -> end
		`);
		const graph = parseDOT(dot);
		const diagnostics = validate(graph);
		const errors = diagnostics.filter((d) => d.severity === "error");

		expect(errors.length).toBeGreaterThanOrEqual(1);
		expect(errors.some((e) => e.message.toLowerCase().includes("condition"))).toBe(true);
	});

	it("valid condition expression does not produce an error", () => {
		const dot = buildDOT(`
			start [shape=Mdiamond]
			code [shape=box, prompt="Do stuff"]
			end [shape=Msquare]
			start -> code [condition="preferred_label=Approve"]
			code -> end
		`);
		const graph = parseDOT(dot);
		const diagnostics = validate(graph);
		const conditionErrors = diagnostics.filter(
			(d) => d.severity === "error" && d.message.toLowerCase().includes("condition")
		);

		expect(conditionErrors).toHaveLength(0);
	});

	it("start node with incoming edges produces error", () => {
		const dot = buildDOT(`
			start [shape=Mdiamond]
			code [shape=box, prompt="Write code"]
			end [shape=Msquare]
			start -> code -> end
			code -> start
		`);
		const graph = parseDOT(dot);
		const diagnostics = validate(graph);
		const errors = diagnostics.filter((d) => d.severity === "error");

		expect(errors.length).toBeGreaterThanOrEqual(1);
		expect(errors.some((e) => e.message.includes("start") && e.message.includes("incoming"))).toBe(true);
	});

	it("exit node with outgoing edges produces error", () => {
		const dot = buildDOT(`
			start [shape=Mdiamond]
			code [shape=box, prompt="Write code"]
			end [shape=Msquare]
			start -> code -> end
			end -> code
		`);
		const graph = parseDOT(dot);
		const diagnostics = validate(graph);
		const errors = diagnostics.filter((d) => d.severity === "error");

		expect(errors.length).toBeGreaterThanOrEqual(1);
		expect(errors.some((e) => e.message.includes("end") && e.message.includes("outgoing"))).toBe(true);
	});

	it("codergen without prompt or label produces warning", () => {
		const dot = buildDOT(`
			start [shape=Mdiamond]
			bare [shape=box]
			end [shape=Msquare]
			start -> bare -> end
		`);
		const graph = parseDOT(dot);
		const diagnostics = validate(graph);
		const warnings = diagnostics.filter((d) => d.severity === "warning");

		expect(warnings.length).toBeGreaterThanOrEqual(1);
		expect(warnings.some((w) => w.message.includes("bare") && w.message.toLowerCase().includes("prompt"))).toBe(true);
	});

	it("codergen with a prompt does not produce a warning", () => {
		const graph = parseDOT(VALID_PIPELINE);
		const diagnostics = validate(graph);
		const warnings = diagnostics.filter(
			(d) => d.severity === "warning" && d.message.includes("code")
		);

		expect(warnings).toHaveLength(0);
	});
});

describe("validateOrThrow", () => {
	it("throws on errors", () => {
		const dot = buildDOT(`
			code [shape=box, prompt="Write code"]
			end [shape=Msquare]
			code -> end
		`);
		const graph = parseDOT(dot);

		expect(() => validateOrThrow(graph)).toThrow("Pipeline validation failed");
	});

	it("does not throw on warnings only", () => {
		const dot = buildDOT(`
			start [shape=Mdiamond]
			bare [shape=box]
			end [shape=Msquare]
			start -> bare -> end
		`);
		const graph = parseDOT(dot);

		// Should have a warning (bare codergen without prompt/label) but no errors
		const diagnostics = validate(graph);
		const errors = diagnostics.filter((d) => d.severity === "error");
		const warnings = diagnostics.filter((d) => d.severity === "warning");

		expect(errors).toHaveLength(0);
		expect(warnings.length).toBeGreaterThanOrEqual(1);

		// validateOrThrow should NOT throw
		expect(() => validateOrThrow(graph)).not.toThrow();
	});

	it("includes all error messages in the thrown error", () => {
		const dot = buildDOT(`
			code [shape=box]
		`);
		const graph = parseDOT(dot);

		try {
			validateOrThrow(graph);
			expect.unreachable("should have thrown");
		} catch (err) {
			const message = (err as Error).message;
			// Should mention both missing start and missing exit
			expect(message).toContain("start");
			expect(message).toContain("exit");
		}
	});
});
