import type { Checkpoint, PipelineContext } from "./types.js";

export class Context implements PipelineContext {
	private store: Map<string, unknown> = new Map();

	get(key: string): unknown {
		return this.store.get(key);
	}

	set(key: string, value: unknown): void {
		this.store.set(key, value);
	}

	getAll(): Record<string, unknown> {
		const result: Record<string, unknown> = {};
		for (const [k, v] of this.store) {
			result[k] = v;
		}
		return result;
	}

	merge(updates: Record<string, unknown>): void {
		for (const [k, v] of Object.entries(updates)) {
			this.store.set(k, v);
		}
	}

	toCheckpoint(
		currentNode: string,
		completedNodes: string[],
		nodeRetries: Record<string, number>,
		logs: string[],
	): Checkpoint {
		return {
			timestamp: Date.now(),
			current_node: currentNode,
			completed_nodes: completedNodes,
			node_retries: nodeRetries,
			context_values: this.getAll(),
			logs,
		};
	}

	static fromCheckpoint(cp: Checkpoint): Context {
		const ctx = new Context();
		ctx.merge(cp.context_values);
		return ctx;
	}
}
