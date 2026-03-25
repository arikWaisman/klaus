import { applyStylesheet, parseStylesheet } from "./stylesheet.js";
import type { Graph, Transform } from "./types.js";

/**
 * Variable expansion transform.
 * Replaces $goal in node prompt attributes with graph.goal value.
 */
export class VariableExpansionTransform implements Transform {
	apply(graph: Graph): Graph {
		const goal = graph.attributes.goal ?? "";
		for (const [, node] of graph.nodes) {
			if (node.attributes.prompt) {
				node.attributes.prompt = node.attributes.prompt.replace(/\$goal/g, goal);
			}
		}
		return graph;
	}
}

/**
 * Stylesheet application transform.
 * Parses graph.model_stylesheet and applies CSS-like rules to nodes.
 */
export class StylesheetTransform implements Transform {
	apply(graph: Graph): Graph {
		const stylesheet = graph.attributes.model_stylesheet;
		if (!stylesheet) return graph;
		const rules = parseStylesheet(stylesheet);
		return applyStylesheet(graph, rules);
	}
}
