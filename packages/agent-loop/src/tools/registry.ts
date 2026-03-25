import type { ExecutionEnvironment, SessionConfig, ToolExecutor, ToolSchema } from "../types.js";

export class ToolRegistry {
	readonly executors: Map<string, ToolExecutor> = new Map();

	register(executor: ToolExecutor): void {
		this.executors.set(executor.schema.name, executor);
	}

	get(name: string): ToolExecutor | undefined {
		return this.executors.get(name);
	}

	has(name: string): boolean {
		return this.executors.has(name);
	}

	schemas(): ToolSchema[] {
		return Array.from(this.executors.values()).map((e) => e.schema);
	}

	async execute(
		name: string,
		args: Record<string, unknown>,
		env: ExecutionEnvironment,
		config: SessionConfig,
	): Promise<{ output: string; is_error: boolean }> {
		const executor = this.executors.get(name);
		if (!executor) {
			return { output: `Error: Unknown tool "${name}"`, is_error: true };
		}
		try {
			const output = await executor.execute(args, env, config);
			return { output, is_error: false };
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			return { output: `Error executing ${name}: ${msg}`, is_error: true };
		}
	}
}
