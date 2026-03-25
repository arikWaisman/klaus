import { validateCondition } from "./conditions.js";
import type { Diagnostic, Graph } from "./types.js";

export function validate(graph: Graph): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];

	// 1. Exactly one start node (shape=Mdiamond or id starts with "start")
	const startNodes = findNodesByShapeOrId(graph, ["mdiamond"], ["start"]);
	if (startNodes.length === 0) {
		diagnostics.push({
			severity: "error",
			message: 'No start node found (shape=Mdiamond or id="start")',
		});
	} else if (startNodes.length > 1) {
		diagnostics.push({
			severity: "error",
			message: `Multiple start nodes found: ${startNodes.map((n) => n.id).join(", ")}`,
		});
	}

	// 2. Exactly one exit node (shape=Msquare or id is "exit"/"end")
	const exitNodes = findNodesByShapeOrId(graph, ["msquare"], ["exit", "end"]);
	if (exitNodes.length === 0) {
		diagnostics.push({
			severity: "error",
			message: 'No exit node found (shape=Msquare or id="exit"/"end")',
		});
	} else if (exitNodes.length > 1) {
		diagnostics.push({
			severity: "error",
			message: `Multiple exit nodes found: ${exitNodes.map((n) => n.id).join(", ")}`,
		});
	}

	// 3. Start has no incoming edges
	if (startNodes.length === 1) {
		const startId = startNodes[0]?.id;
		const incomingToStart = graph.edges.filter((e) => e.to === startId);
		if (incomingToStart.length > 0) {
			diagnostics.push({
				severity: "error",
				message: `Start node "${startId}" has incoming edges`,
				node_id: startId,
			});
		}
	}

	// 4. Exit has no outgoing edges
	if (exitNodes.length === 1) {
		const exitId = exitNodes[0]?.id;
		const outgoingFromExit = graph.edges.filter((e) => e.from === exitId);
		if (outgoingFromExit.length > 0) {
			diagnostics.push({
				severity: "error",
				message: `Exit node "${exitId}" has outgoing edges`,
				node_id: exitId,
			});
		}
	}

	// 5. All nodes reachable from start
	if (startNodes.length === 1) {
		const reachable = findReachable(graph, startNodes[0]?.id);
		for (const [nodeId] of graph.nodes) {
			if (!reachable.has(nodeId)) {
				diagnostics.push({
					severity: "error",
					message: `Node "${nodeId}" is not reachable from start`,
					node_id: nodeId,
				});
			}
		}
	}

	// 6. Edge targets reference valid nodes
	for (const edge of graph.edges) {
		if (!graph.nodes.has(edge.from)) {
			diagnostics.push({ severity: "error", message: `Edge source "${edge.from}" does not exist` });
		}
		if (!graph.nodes.has(edge.to)) {
			diagnostics.push({ severity: "error", message: `Edge target "${edge.to}" does not exist` });
		}
	}

	// 7. Conditions parse without error
	for (const edge of graph.edges) {
		if (edge.attributes.condition) {
			const err = validateCondition(edge.attributes.condition);
			if (err) {
				diagnostics.push({
					severity: "error",
					message: `Invalid condition on edge ${edge.from}->${edge.to}: ${err}`,
				});
			}
		}
	}

	// Warnings
	for (const [, node] of graph.nodes) {
		// Codergen without prompt or label
		const type = node.attributes.type ?? inferTypeFromShape(node.attributes.shape);
		if (type === "codergen" && !node.attributes.prompt && !node.attributes.label) {
			diagnostics.push({
				severity: "warning",
				message: `Codergen node "${node.id}" has no prompt or label`,
				node_id: node.id,
			});
		}
	}

	return diagnostics;
}

export function validateOrThrow(graph: Graph): void {
	const diagnostics = validate(graph);
	const errors = diagnostics.filter((d) => d.severity === "error");
	if (errors.length > 0) {
		throw new Error(
			`Pipeline validation failed:\n${errors.map((e) => `  - ${e.message}`).join("\n")}`,
		);
	}
}

function findNodesByShapeOrId(graph: Graph, shapes: string[], ids: string[]) {
	const result = [];
	for (const [, node] of graph.nodes) {
		const shape = (node.attributes.shape ?? "").toLowerCase();
		const id = node.id.toLowerCase();
		if (shapes.includes(shape) || ids.includes(id)) {
			result.push(node);
		}
	}
	return result;
}

function findReachable(graph: Graph, startId: string): Set<string> {
	const visited = new Set<string>();
	const queue = [startId];
	while (queue.length > 0) {
		const current = queue.shift()!;
		if (visited.has(current)) continue;
		visited.add(current);
		for (const edge of graph.edges) {
			if (edge.from === current && !visited.has(edge.to)) {
				queue.push(edge.to);
			}
		}
	}
	return visited;
}

function inferTypeFromShape(shape?: string): string {
	switch (shape?.toLowerCase()) {
		case "mdiamond":
			return "start";
		case "msquare":
			return "exit";
		case "hexagon":
			return "wait.human";
		case "diamond":
			return "conditional";
		case "component":
			return "parallel";
		case "tripleoctagon":
			return "parallel.fan_in";
		case "parallelogram":
			return "tool";
		case "house":
			return "stack.manager_loop";
		default:
			return "codergen";
	}
}
