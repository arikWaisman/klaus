import { describe, expect, it } from "vitest";
import { evaluateCondition, validateCondition } from "../src/conditions.js";
import { Context } from "../src/context.js";
import type { Outcome } from "../src/types.js";

function makeOutcome(overrides: Partial<Outcome> = {}): Outcome {
	return { status: "success", ...overrides };
}

describe("evaluateCondition", () => {
	it("returns true for an empty condition", () => {
		const ctx = new Context();
		const outcome = makeOutcome();
		expect(evaluateCondition("", ctx, outcome)).toBe(true);
		expect(evaluateCondition("   ", ctx, outcome)).toBe(true);
	});

	it("outcome=success matches when status is success", () => {
		const ctx = new Context();
		const outcome = makeOutcome({ status: "success" });
		expect(evaluateCondition("outcome=success", ctx, outcome)).toBe(true);
	});

	it("outcome=fail does not match when status is success", () => {
		const ctx = new Context();
		const outcome = makeOutcome({ status: "success" });
		expect(evaluateCondition("outcome=fail", ctx, outcome)).toBe(false);
	});

	it("outcome!=fail returns true when status is success", () => {
		const ctx = new Context();
		const outcome = makeOutcome({ status: "success" });
		expect(evaluateCondition("outcome!=fail", ctx, outcome)).toBe(true);
	});

	it("preferred_label=Fix matches the preferred_label", () => {
		const ctx = new Context();
		const outcome = makeOutcome({ preferred_label: "Fix" });
		expect(evaluateCondition("preferred_label=Fix", ctx, outcome)).toBe(true);
	});

	it("context.key=value looks up key in context", () => {
		const ctx = new Context();
		ctx.set("env", "production");
		const outcome = makeOutcome();
		expect(evaluateCondition("context.env=production", ctx, outcome)).toBe(true);
		expect(evaluateCondition("context.env=staging", ctx, outcome)).toBe(false);
	});

	it("&& conjunction — both clauses must be true", () => {
		const ctx = new Context();
		ctx.set("env", "production");
		const outcome = makeOutcome({ status: "success" });
		expect(evaluateCondition("outcome=success && context.env=production", ctx, outcome)).toBe(true);
	});

	it("&& conjunction — fails if one clause is false", () => {
		const ctx = new Context();
		ctx.set("env", "staging");
		const outcome = makeOutcome({ status: "success" });
		expect(evaluateCondition("outcome=success && context.env=production", ctx, outcome)).toBe(
			false,
		);
	});

	it("missing context key resolves to empty string", () => {
		const ctx = new Context();
		const outcome = makeOutcome();
		expect(evaluateCondition("context.missing=", ctx, outcome)).toBe(true);
		expect(evaluateCondition("context.missing=something", ctx, outcome)).toBe(false);
	});

	it("quoted string literals are compared correctly", () => {
		const ctx = new Context();
		ctx.set("greeting", "hello world");
		const outcome = makeOutcome();
		expect(evaluateCondition('context.greeting="hello world"', ctx, outcome)).toBe(true);
		expect(evaluateCondition('context.greeting="goodbye"', ctx, outcome)).toBe(false);
	});

	it("~= (contains) matches substring", () => {
		const ctx = new Context();
		ctx.set("response", "Everything looks good. CONSENSUS_REACHED. Done.");
		const outcome = makeOutcome();
		expect(evaluateCondition("context.response~=CONSENSUS_REACHED", ctx, outcome)).toBe(true);
		expect(evaluateCondition("context.response~=NOPE", ctx, outcome)).toBe(false);
	});

	it("!~= (not contains) matches absence of substring", () => {
		const ctx = new Context();
		ctx.set("response", "There are issues to fix.");
		const outcome = makeOutcome();
		expect(evaluateCondition("context.response!~=CONSENSUS_REACHED", ctx, outcome)).toBe(true);
		expect(evaluateCondition("context.response!~=issues", ctx, outcome)).toBe(false);
	});

	it("~= works with && clauses", () => {
		const ctx = new Context();
		ctx.set("result", "CONSENSUS_REACHED");
		const outcome = makeOutcome({ status: "success" });
		expect(
			evaluateCondition("outcome=success && context.result~=CONSENSUS", ctx, outcome),
		).toBe(true);
		expect(
			evaluateCondition("outcome=fail && context.result~=CONSENSUS", ctx, outcome),
		).toBe(false);
	});
});

describe("validateCondition", () => {
	it("returns null for valid conditions", () => {
		expect(validateCondition("outcome=success")).toBeNull();
		expect(validateCondition("outcome=success && context.x=y")).toBeNull();
		expect(validateCondition("")).toBeNull();
	});

	it("returns error message for invalid conditions (missing operator)", () => {
		const result = validateCondition("outcome");
		expect(result).toBeTypeOf("string");
		expect(result).toContain("missing operator");
	});
});
