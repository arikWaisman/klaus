import type { ExecutionEnvironment } from "../types.js";

/**
 * Build an `<environment>` block for inclusion in the system prompt.
 * Shared across all provider profiles.
 */
export function buildEnvironmentBlock(env: ExecutionEnvironment, model: string): string {
	return `\n\n<environment>
Working directory: ${env.working_directory()}
Platform: ${env.platform()}
OS version: ${env.os_version()}
Today's date: ${new Date().toISOString().slice(0, 10)}
Model: ${model}
</environment>`;
}
