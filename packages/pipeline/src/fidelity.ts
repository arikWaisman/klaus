import type { Edge, FidelityMode, Graph, Node, PipelineContext } from "./types.js";

// ---------------------------------------------------------------------------
// Fidelity Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve effective fidelity for a node.
 * Priority: incoming edge fidelity > node fidelity > graph default > "compact"
 */
export function resolveFidelity(
	node: Node,
	incomingEdge: Edge | undefined,
	graphDefault: FidelityMode | undefined,
): FidelityMode {
	return incomingEdge?.attributes.fidelity ?? node.attributes.fidelity ?? graphDefault ?? "compact";
}

// ---------------------------------------------------------------------------
// Character Budgets
// ---------------------------------------------------------------------------

const CHAR_BUDGETS: Record<FidelityMode, number> = {
	full: Number.POSITIVE_INFINITY,
	truncate: 400,
	compact: 3200,
	"summary:low": 2400,
	"summary:medium": 6000,
	"summary:high": 12000,
};

// ---------------------------------------------------------------------------
// Context Preamble Builder
// ---------------------------------------------------------------------------

/**
 * Build a text preamble summarising prior node outputs from the pipeline
 * context, respecting the fidelity budget.
 *
 * Only keys matching `*.response` are included. The current node's own
 * response (if any) is excluded.
 */
export function buildContextPreamble(
	context: PipelineContext,
	fidelity: FidelityMode,
	currentNodeId: string,
): string {
	const all = context.getAll();
	const responseEntries: [string, string][] = [];

	for (const [key, value] of Object.entries(all)) {
		if (!key.endsWith(".response")) continue;
		if (typeof value !== "string") continue;
		const nodeId = key.slice(0, -".response".length);
		if (nodeId === currentNodeId) continue;
		responseEntries.push([nodeId, value]);
	}

	if (responseEntries.length === 0) return "";

	const budget = CHAR_BUDGETS[fidelity];
	let sections: string[];

	if (budget === Number.POSITIVE_INFINITY) {
		sections = responseEntries.map(([nodeId, text]) => `### ${nodeId}\n${text}`);
	} else {
		const perEntry = Math.max(1, Math.floor(budget / responseEntries.length));
		sections = responseEntries.map(([nodeId, text]) => {
			const truncated = text.length > perEntry ? `${text.slice(0, perEntry - 3)}...` : text;
			return `### ${nodeId}\n${truncated}`;
		});
	}

	return `## Prior context\n\n${sections.join("\n\n")}\n`;
}

// ---------------------------------------------------------------------------
// Helper: find incoming edge for a node
// ---------------------------------------------------------------------------

export function findIncomingEdge(graph: Graph, nodeId: string): Edge | undefined {
	return graph.edges.find((e) => e.to === nodeId);
}
