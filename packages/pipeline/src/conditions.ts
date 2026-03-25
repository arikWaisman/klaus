import type { Outcome, PipelineContext } from "./types.js";

/**
 * Evaluate a condition expression against the current context and outcome.
 * Empty conditions always return true.
 */
export function evaluateCondition(
	condition: string,
	context: PipelineContext,
	outcome: Outcome,
): boolean {
	const trimmed = condition.trim();
	if (!trimmed) return true;

	// Split on '&&'
	const clauses = trimmed.split("&&").map((c) => c.trim());

	return clauses.every((clause) => evaluateClause(clause, context, outcome));
}

function evaluateClause(clause: string, context: PipelineContext, outcome: Outcome): boolean {
	// Try to parse: key operator literal
	let operator: "=" | "!=";
	let parts: [string, string];

	if (clause.includes("!=")) {
		operator = "!=";
		const idx = clause.indexOf("!=");
		parts = [clause.slice(0, idx).trim(), clause.slice(idx + 2).trim()];
	} else if (clause.includes("=")) {
		operator = "=";
		const idx = clause.indexOf("=");
		parts = [clause.slice(0, idx).trim(), clause.slice(idx + 1).trim()];
	} else {
		// No operator — treat as truthy check
		return Boolean(resolveKey(clause.trim(), context, outcome));
	}

	const [key, literal] = parts;
	const actual = String(resolveKey(key, context, outcome) ?? "");
	const expected = parseLiteral(literal);

	if (operator === "=") return actual === expected;
	return actual !== expected;
}

function resolveKey(key: string, context: PipelineContext, outcome: Outcome): unknown {
	if (key === "outcome") return outcome.status;
	if (key === "preferred_label") return outcome.preferred_label ?? "";
	if (key.startsWith("context.")) return context.get(key.slice(8));
	// Bare key → context lookup
	return context.get(key);
}

function parseLiteral(literal: string): string {
	// Remove quotes if present
	if (literal.startsWith('"') && literal.endsWith('"')) {
		return literal.slice(1, -1);
	}
	return literal;
}

/**
 * Parse a condition expression and check for syntax errors.
 * Returns null if valid, error message if invalid.
 */
export function validateCondition(condition: string): string | null {
	const trimmed = condition.trim();
	if (!trimmed) return null;

	const clauses = trimmed.split("&&").map((c) => c.trim());

	for (const clause of clauses) {
		if (!clause) return `Empty clause in condition: "${condition}"`;
		// Must contain = or !=
		if (!clause.includes("=")) {
			return `Clause missing operator (= or !=): "${clause}"`;
		}
	}

	return null;
}
