import { evaluateCondition } from "./conditions.js";
import { Context } from "./context.js";
import { HandlerRegistry } from "./handlers.js";
import { parseDOT } from "./parser.js";
import { StylesheetTransform, VariableExpansionTransform } from "./transforms.js";
import type {
	Answer,
	Checkpoint,
	CodergenBackend,
	Edge,
	Graph,
	Handler,
	HandlerContext,
	Interviewer,
	Node,
	Outcome,
	PipelineContext,
	PipelineEvent,
	PipelineEventKind,
	PipelineOptions,
	RetryPolicy,
} from "./types.js";
import { DEFAULT_RETRY_POLICY } from "./types.js";
import { validateOrThrow } from "./validation.js";

export class PipelineEngine {
	private graph: Graph;
	private context: Context;
	private registry: HandlerRegistry;
	private backend: CodergenBackend;
	private interviewer: Interviewer;
	private logs_root: string;
	private completed_nodes: Set<string> = new Set();
	private node_retries: Record<string, number> = {};
	private logs: string[] = [];
	private on_event?: (event: PipelineEvent) => void;

	constructor(options: PipelineOptions) {
		// 1. Parse DOT
		this.graph = parseDOT(options.dot);

		// 2. Apply transforms
		const transforms = [
			new VariableExpansionTransform(),
			new StylesheetTransform(),
			...(options.transforms ?? []),
		];
		for (const t of transforms) {
			this.graph = t.apply(this.graph);
		}

		// 3. Validate
		validateOrThrow(this.graph);

		// 4. Initialize context
		if (options.checkpoint) {
			this.context = Context.fromCheckpoint(options.checkpoint);
			this.completed_nodes = new Set(options.checkpoint.completed_nodes);
			this.node_retries = { ...options.checkpoint.node_retries };
			this.logs = [...options.checkpoint.logs];
		} else {
			this.context = new Context();
		}

		// Mirror graph.goal into context
		if (this.graph.attributes.goal) {
			this.context.set("graph.goal", this.graph.attributes.goal);
		}

		// Setup
		this.registry = new HandlerRegistry();
		if (options.custom_handlers) {
			for (const [type, handler] of Object.entries(options.custom_handlers)) {
				this.registry.register(type, handler);
			}
		}
		this.backend = options.backend;
		this.interviewer = options.interviewer ?? createAutoApproveInterviewer();
		this.logs_root = options.logs_root ?? "/tmp/pipeline-logs";
		this.on_event = options.on_event;

		// Store backend in context for codergen handler
		this.context.set("__backend", this.backend);
	}

	async run(): Promise<Outcome> {
		this.emitEvent("PipelineStarted", {
			name: this.graph.name,
			id: crypto.randomUUID(),
		});
		const startTime = Date.now();

		try {
			// Find start node
			const startNode = this.findStartNode();
			let currentNodeId = startNode.id;

			// If resuming from checkpoint, advance past completed nodes
			// (simplified: just start from the checkpoint's current_node)

			while (true) {
				const node = this.graph.nodes.get(currentNodeId);
				if (!node) {
					throw new Error(`Node "${currentNodeId}" not found in graph`);
				}

				this.context.set("current_node", currentNodeId);

				// Resolve handler
				const handlerType = this.registry.resolveType(node);
				const handler = this.registry.get(handlerType);
				if (!handler) {
					throw new Error(`No handler registered for type "${handlerType}"`);
				}

				// Execute with retry
				const outcome = await this.executeWithRetry(node, handler);

				// Mark completed
				this.completed_nodes.add(currentNodeId);

				// Apply context_updates
				if (outcome.context_updates) {
					this.context.merge(outcome.context_updates);
				}
				this.context.set("outcome", outcome.status);
				if (outcome.preferred_label) {
					this.context.set("preferred_label", outcome.preferred_label);
				}

				// Save checkpoint
				this.saveCheckpoint(currentNodeId);

				// Check if exit node
				if (this.isExitNode(node)) {
					// Check goal gates
					this.checkGoalGates();

					this.emitEvent("PipelineCompleted", {
						duration: Date.now() - startTime,
					});
					return outcome;
				}

				// Select next edge
				const nextEdge = this.selectEdge(node, outcome);
				if (!nextEdge) {
					// No matching edge — pipeline ends
					this.emitEvent("PipelineCompleted", {
						duration: Date.now() - startTime,
					});
					return outcome;
				}

				currentNodeId = nextEdge.to;
			}
		} catch (error) {
			this.emitEvent("PipelineFailed", {
				error: error instanceof Error ? error.message : String(error),
				duration: Date.now() - startTime,
			});
			throw error;
		}
	}

	getContext(): PipelineContext {
		return this.context;
	}

	getCheckpoint(): Checkpoint {
		return this.context.toCheckpoint(
			String(this.context.get("current_node") ?? ""),
			Array.from(this.completed_nodes),
			this.node_retries,
			this.logs,
		);
	}

	private async executeWithRetry(node: Node, handler: Handler): Promise<Outcome> {
		const maxRetries =
			node.attributes.max_retries ?? this.graph.attributes.default_max_retries ?? 0;
		const policy: RetryPolicy = {
			...DEFAULT_RETRY_POLICY,
			max_attempts: 1 + maxRetries,
		};

		for (let attempt = 0; attempt < policy.max_attempts; attempt++) {
			this.emitEvent("StageStarted", { name: node.id, index: attempt });
			const startTime = Date.now();

			try {
				const ctx: HandlerContext = {
					node,
					context: this.context,
					graph: this.graph,
					logs_root: this.logs_root,
					interviewer: this.interviewer,
				};

				const outcome = await handler(ctx);

				if (outcome.status === "retry" && attempt < policy.max_attempts - 1) {
					const delay = this.computeRetryDelay(attempt, policy);
					this.emitEvent("StageRetrying", {
						name: node.id,
						index: attempt,
						attempt: attempt + 1,
						delay,
					});
					await sleep(delay);
					this.node_retries[node.id] = (this.node_retries[node.id] ?? 0) + 1;
					continue;
				}

				if (outcome.status === "fail" && attempt < policy.max_attempts - 1) {
					const delay = this.computeRetryDelay(attempt, policy);
					this.emitEvent("StageFailed", {
						name: node.id,
						index: attempt,
						error: outcome.failure_reason,
						will_retry: true,
					});
					this.emitEvent("StageRetrying", {
						name: node.id,
						index: attempt,
						attempt: attempt + 1,
						delay,
					});
					await sleep(delay);
					this.node_retries[node.id] = (this.node_retries[node.id] ?? 0) + 1;
					continue;
				}

				this.emitEvent("StageCompleted", {
					name: node.id,
					index: attempt,
					duration: Date.now() - startTime,
				});
				return outcome;
			} catch (error) {
				if (attempt < policy.max_attempts - 1) {
					this.emitEvent("StageFailed", {
						name: node.id,
						index: attempt,
						error: error instanceof Error ? error.message : String(error),
						will_retry: true,
					});
					const delay = this.computeRetryDelay(attempt, policy);
					await sleep(delay);
					continue;
				}
				throw error;
			}
		}

		// Shouldn't reach here
		return { status: "fail", failure_reason: "Max retries exceeded" };
	}

	/**
	 * 5-step edge selection algorithm.
	 */
	private selectEdge(node: Node, outcome: Outcome): Edge | null {
		const outEdges = this.graph.edges.filter((e) => e.from === node.id);
		if (outEdges.length === 0) return null;

		// Step 1: Condition matching
		const conditionMatches = outEdges.filter((e) => {
			if (!e.attributes.condition) return false;
			return evaluateCondition(e.attributes.condition, this.context, outcome);
		});
		if (conditionMatches.length > 0) return conditionMatches[0]!;

		// Filter to unconditional edges
		const unconditional = outEdges.filter((e) => !e.attributes.condition);

		// Step 2: Preferred label matching
		if (outcome.preferred_label) {
			const normalized = outcome.preferred_label.toLowerCase().trim();
			const labelMatch = unconditional.find((e) => {
				const edgeLabel = (e.attributes.label ?? "")
					.toLowerCase()
					.trim()
					.replace(/\[\w\]\s*/g, "")
					.replace(/^\w\)\s*/, "")
					.replace(/^\w\s*-\s*/, "");
				return edgeLabel === normalized;
			});
			if (labelMatch) return labelMatch;
		}

		// Step 3: Suggested next IDs
		if (outcome.suggested_next_ids?.length) {
			for (const id of outcome.suggested_next_ids) {
				const match = unconditional.find((e) => e.to === id);
				if (match) return match;
			}
		}

		// Step 4: Weight tiebreak
		const maxWeight = Math.max(...unconditional.map((e) => e.attributes.weight ?? 0));
		const weightMatches = unconditional.filter((e) => (e.attributes.weight ?? 0) === maxWeight);

		// Step 5: Lexical tiebreak
		weightMatches.sort((a, b) => a.to.localeCompare(b.to));
		return weightMatches[0] ?? null;
	}

	private computeRetryDelay(attempt: number, policy: RetryPolicy): number {
		let delay = policy.initial_delay_ms * policy.backoff_factor ** attempt;
		delay = Math.min(delay, policy.max_delay_ms);
		if (policy.jitter) {
			delay *= 0.5 + Math.random();
		}
		return delay;
	}

	private findStartNode(): Node {
		for (const [, node] of this.graph.nodes) {
			if (
				node.attributes.shape?.toLowerCase() === "mdiamond" ||
				node.id.toLowerCase() === "start"
			) {
				return node;
			}
		}
		throw new Error("No start node found");
	}

	private isExitNode(node: Node): boolean {
		return (
			node.attributes.shape?.toLowerCase() === "msquare" ||
			node.id.toLowerCase() === "exit" ||
			node.id.toLowerCase() === "end"
		);
	}

	private checkGoalGates(): void {
		for (const [, node] of this.graph.nodes) {
			if (!node.attributes.goal_gate) continue;
			if (!this.completed_nodes.has(node.id)) {
				throw new Error(`Goal gate node "${node.id}" was not completed`);
			}
			// Check status in context
			// Note: simplified — in full impl we'd track per-node outcomes
		}
	}

	private saveCheckpoint(currentNodeId: string): void {
		this.emitEvent("CheckpointSaved", { node_id: currentNodeId });
	}

	private emitEvent(kind: string, data: Record<string, unknown>): void {
		if (!this.on_event) return;
		this.on_event({
			kind: kind as PipelineEventKind,
			timestamp: Date.now(),
			data,
		});
	}
}

function createAutoApproveInterviewer(): Interviewer {
	return {
		async ask(question) {
			if (question.type === "YES_NO") {
				return { value: "YES" };
			}
			if (question.options.length > 0) {
				return {
					value: question.options[0]?.key,
					selected_option: question.options[0]!,
				};
			}
			return { value: "approved" };
		},
	};
}

export class QueueInterviewer implements Interviewer {
	private answers: Answer[];
	private index = 0;

	constructor(answers: Answer[]) {
		this.answers = answers;
	}

	async ask(): Promise<Answer> {
		if (this.index >= this.answers.length) {
			return { value: "TIMEOUT" };
		}
		return this.answers[this.index++]!;
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// Re-export the Interviewer helpers
export { createAutoApproveInterviewer };
