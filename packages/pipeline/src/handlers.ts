import { buildContextPreamble, findIncomingEdge, resolveFidelity } from "./fidelity.js";
import type { CodergenBackend, Handler, HandlerContext, Node, Option, Outcome } from "./types.js";

// ---------------------------------------------------------------------------
// Shape-to-Type Mapping
// ---------------------------------------------------------------------------

function shapeToType(shape?: string): string {
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
			return "codergen"; // box or unspecified
	}
}

// ---------------------------------------------------------------------------
// Handler Registry
// ---------------------------------------------------------------------------

export class HandlerRegistry {
	private handlers: Map<string, Handler> = new Map();

	constructor() {
		// Register built-in handlers
		this.handlers.set("start", startHandler);
		this.handlers.set("exit", exitHandler);
		this.handlers.set("codergen", codergenHandler);
		this.handlers.set("wait.human", waitHumanHandler);
		this.handlers.set("conditional", conditionalHandler);
		this.handlers.set("parallel", parallelHandler);
		this.handlers.set("parallel.fan_in", fanInHandler);
		this.handlers.set("tool", toolHandler);
		this.handlers.set("stack.manager_loop", managerLoopHandler);
	}

	register(type: string, handler: Handler): void {
		this.handlers.set(type, handler);
	}

	get(type: string): Handler | undefined {
		return this.handlers.get(type);
	}

	/**
	 * Resolve handler type from node attributes.
	 * Priority: explicit type attribute > shape inference
	 */
	resolveType(node: Node): string {
		if (node.attributes.type) return node.attributes.type;
		return shapeToType(node.attributes.shape);
	}
}

// ---------------------------------------------------------------------------
// Handler: start
// ---------------------------------------------------------------------------

const startHandler: Handler = async () => {
	return { status: "success" };
};

// ---------------------------------------------------------------------------
// Handler: exit
// ---------------------------------------------------------------------------

const exitHandler: Handler = async (ctx: HandlerContext) => {
	// Propagate the prior stage's status so that partial failures are visible.
	const prior = ctx.context.get("outcome") as string | undefined;
	if (prior === "partial_success" || prior === "fail") {
		return { status: prior as "partial_success" | "fail" };
	}
	return { status: "success" };
};

// ---------------------------------------------------------------------------
// Handler: codergen
// ---------------------------------------------------------------------------

const codergenHandler: Handler = async (ctx: HandlerContext): Promise<Outcome> => {
	// Resolve prompt
	let prompt = ctx.node.attributes.prompt ?? ctx.node.attributes.label ?? "";

	// Expand $goal
	const goal = ctx.context.get("graph.goal");
	if (typeof goal === "string") {
		prompt = prompt.replace(/\$goal/g, goal);
	}

	// Resolve fidelity and prepend prior context
	const incomingEdge = findIncomingEdge(ctx.graph, ctx.node.id);
	const fidelity = resolveFidelity(ctx.node, incomingEdge, ctx.graph.attributes.default_fidelity);
	const preamble = buildContextPreamble(ctx.context, fidelity, ctx.node.id);
	if (preamble) {
		prompt = `${preamble}\n${prompt}`;
	}

	// Get the backend from context
	const backend = ctx.context.get("__backend") as CodergenBackend | undefined;
	if (!backend) {
		return {
			status: "fail",
			failure_reason: "No CodergenBackend configured",
		};
	}

	// Call backend
	const result = await backend.run(ctx.node, prompt, ctx.context);

	if (typeof result === "string") {
		return {
			status: "success",
			context_updates: { [`${ctx.node.id}.response`]: result },
			notes: result,
		};
	}

	return result;
};

// ---------------------------------------------------------------------------
// Handler: wait.human
// ---------------------------------------------------------------------------

function extractAcceleratorKey(label: string): string | null {
	// Match [X], X), X - patterns
	const bracketMatch = label.match(/\[(\w)\]/);
	if (bracketMatch) return bracketMatch[1]!;
	const parenMatch = label.match(/^(\w)\)/);
	if (parenMatch) return parenMatch[1]!;
	const dashMatch = label.match(/^(\w)\s*-/);
	if (dashMatch) return dashMatch[1]!;
	return null;
}

const waitHumanHandler: Handler = async (ctx: HandlerContext): Promise<Outcome> => {
	// Get outgoing edges to derive choices
	const outEdges = ctx.graph.edges.filter((e) => e.from === ctx.node.id);
	const options: Option[] = outEdges.map((edge, idx) => {
		const label = edge.attributes.label ?? edge.to;
		const key = extractAcceleratorKey(label) ?? String(idx + 1);
		return { key, label };
	});

	const question = {
		text: ctx.node.attributes.prompt ?? ctx.node.attributes.label ?? "Choose an option:",
		type: "MULTIPLE_CHOICE" as const,
		options,
		stage: ctx.node.id,
	};

	const answer = await ctx.interviewer.ask(question);

	// Find matching edge
	const selectedOption = answer.selected_option;
	const selectedLabel = selectedOption?.label ?? answer.value;
	const targetEdge = outEdges.find((e) => {
		const edgeLabel = e.attributes.label ?? e.to;
		return edgeLabel === selectedLabel || e.to === answer.value;
	});

	return {
		status: "success",
		preferred_label: typeof selectedLabel === "string" ? selectedLabel : undefined,
		suggested_next_ids: targetEdge ? [targetEdge.to] : undefined,
	};
};

// ---------------------------------------------------------------------------
// Handler: conditional
// ---------------------------------------------------------------------------

const conditionalHandler: Handler = async () => {
	// Pass-through — the engine evaluates edge conditions
	return { status: "success" };
};

// ---------------------------------------------------------------------------
// Handler: parallel
// ---------------------------------------------------------------------------

const parallelHandler: Handler = async (ctx: HandlerContext): Promise<Outcome> => {
	// Fan out to all target nodes
	// The actual parallel execution is handled by the engine
	const outEdges = ctx.graph.edges.filter((e) => e.from === ctx.node.id);
	const branches = outEdges.map((e) => e.to);

	return {
		status: "success",
		context_updates: {
			"parallel.branches": branches,
			"parallel.pending": branches.length,
		},
		suggested_next_ids: branches,
	};
};

// ---------------------------------------------------------------------------
// Handler: parallel.fan_in
// ---------------------------------------------------------------------------

const fanInHandler: Handler = async (ctx: HandlerContext): Promise<Outcome> => {
	// Consolidate parallel results
	const results = ctx.context.get("parallel.results") as Record<string, unknown>[] | undefined;
	const successCount =
		results?.filter((r) => (r as Record<string, unknown>)?.status === "success").length ?? 0;
	const totalCount = results?.length ?? 0;

	return {
		status: successCount === totalCount ? "success" : "partial_success",
		context_updates: {
			"parallel.success_count": successCount,
			"parallel.total_count": totalCount,
		},
	};
};

// ---------------------------------------------------------------------------
// Handler: tool
// ---------------------------------------------------------------------------

function parseDuration(duration?: string): number | null {
	if (!duration) return null;
	const match = duration.match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/);
	if (!match) return null;
	const val = Number.parseFloat(match[1]!);
	switch (match[2]) {
		case "ms":
			return val;
		case "s":
			return val * 1000;
		case "m":
			return val * 60_000;
		case "h":
			return val * 3_600_000;
		case "d":
			return val * 86_400_000;
		default:
			return null;
	}
}

const toolHandler: Handler = async (ctx: HandlerContext): Promise<Outcome> => {
	const command = ctx.node.attributes.tool_command;
	if (!command) {
		return {
			status: "fail",
			failure_reason: "No tool_command attribute on node",
		};
	}

	// Execute via context's execution environment or shell
	const { execSync } = await import("node:child_process");
	try {
		const timeout = parseDuration(ctx.node.attributes.timeout) ?? 30_000;
		const output = execSync(command, {
			timeout,
			encoding: "utf-8",
			cwd: ctx.logs_root,
		});
		return {
			status: "success",
			context_updates: { "tool.output": output },
			notes: output,
		};
	} catch (error) {
		return {
			status: "fail",
			failure_reason: error instanceof Error ? error.message : String(error),
		};
	}
};

// ---------------------------------------------------------------------------
// Handler: stack.manager_loop
// ---------------------------------------------------------------------------

const managerLoopHandler: Handler = async () => {
	// Supervisor pattern — for now, a simplified version
	// The full implementation would manage a child pipeline
	return {
		status: "success",
		notes: "Manager loop completed",
	};
};

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export {
	startHandler,
	exitHandler,
	codergenHandler,
	waitHumanHandler,
	conditionalHandler,
	parallelHandler,
	fanInHandler,
	toolHandler,
	managerLoopHandler,
	shapeToType,
	extractAcceleratorKey,
	parseDuration,
};
