import type { Graph, Node, StyleRule, StyleSelector } from "./types.js";

/**
 * Parse a CSS-like model stylesheet string into rules.
 */
export function parseStylesheet(input: string): StyleRule[] {
	const rules: StyleRule[] = [];
	if (!input?.trim()) return rules;

	// Simple parser: find selector { declarations }
	const rulePattern = /([^{]+)\{([^}]*)\}/g;
	let match: RegExpExecArray | null = rulePattern.exec(input);

	while (match !== null) {
		const selectorStr = match[1]?.trim();
		const declStr = match[2]?.trim();

		const selector = parseSelector(selectorStr);
		const declarations = parseDeclarations(declStr);

		rules.push({ selector, declarations });
		match = rulePattern.exec(input);
	}

	return rules;
}

function parseSelector(s: string): StyleSelector {
	if (s === "*") {
		return { type: "universal", value: "*", specificity: 0 };
	}
	if (s.startsWith("#")) {
		return { type: "id", value: s.slice(1), specificity: 3 };
	}
	if (s.startsWith(".")) {
		return { type: "class", value: s.slice(1), specificity: 2 };
	}
	// Shape selector
	return { type: "shape", value: s, specificity: 1 };
}

function parseDeclarations(s: string): Record<string, string> {
	const decls: Record<string, string> = {};
	const parts = s
		.split(";")
		.map((p) => p.trim())
		.filter(Boolean);

	for (const part of parts) {
		const colonIdx = part.indexOf(":");
		if (colonIdx === -1) continue;
		const prop = part.slice(0, colonIdx).trim();
		const val = part.slice(colonIdx + 1).trim();
		decls[prop] = val;
	}

	return decls;
}

/**
 * Check if a rule's selector matches a node.
 */
function selectorMatches(selector: StyleSelector, node: Node): boolean {
	switch (selector.type) {
		case "universal":
			return true;
		case "id":
			return node.id === selector.value;
		case "class":
			return node.attributes.class === selector.value;
		case "shape":
			return (node.attributes.shape ?? "box").toLowerCase() === selector.value.toLowerCase();
		default:
			return false;
	}
}

/**
 * Apply stylesheet rules to all nodes in a graph.
 * Higher specificity wins. Explicit node attributes always override.
 */
export function applyStylesheet(graph: Graph, rules: StyleRule[]): Graph {
	// Sort rules by specificity (lowest first so higher overrides)
	const sorted = [...rules].sort((a, b) => a.selector.specificity - b.selector.specificity);

	for (const [, node] of graph.nodes) {
		const resolved: Record<string, string> = {};

		// Apply matching rules in specificity order
		for (const rule of sorted) {
			if (selectorMatches(rule.selector, node)) {
				Object.assign(resolved, rule.declarations);
			}
		}

		// Apply resolved properties to node (only if node doesn't already have them)
		if (resolved.llm_model && !node.attributes.llm_model) {
			node.attributes.llm_model = resolved.llm_model;
		}
		if (resolved.llm_provider && !node.attributes.llm_provider) {
			node.attributes.llm_provider = resolved.llm_provider;
		}
		if (resolved.reasoning_effort && !node.attributes.reasoning_effort) {
			node.attributes.reasoning_effort = resolved.reasoning_effort;
		}
	}

	return graph;
}
