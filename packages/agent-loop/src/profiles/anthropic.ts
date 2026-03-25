import {
	editFileTool,
	globTool,
	grepTool,
	readFileTool,
	shellTool,
	writeFileTool,
} from "../tools/core.js";
import { ToolRegistry } from "../tools/registry.js";
import type { ProviderProfile } from "../types.js";
import { buildEnvironmentBlock } from "./common.js";

// ---------------------------------------------------------------------------
// Base prompt — Claude Code-aligned instructions
// ---------------------------------------------------------------------------

const ANTHROPIC_BASE_PROMPT = `You are an AI coding assistant. You help with software engineering tasks \
including writing code, debugging, explaining code, and more.

When working with files:
- Always read files before editing them
- Use edit_file for precise changes (old_string/new_string matching)
- Use write_file only for new files or complete rewrites
- Use shell for running commands, tests, and builds

When running shell commands:
- Default timeout is 120 seconds
- Long-running commands should set an appropriate timeout
- Always check exit codes

Be concise and focused. Only make changes that are directly requested.`;

// ---------------------------------------------------------------------------
// Profile factory
// ---------------------------------------------------------------------------

export function createAnthropicProfile(model: string): ProviderProfile {
	const registry = new ToolRegistry();

	// Register all Anthropic tools
	registry.register(readFileTool);
	registry.register(writeFileTool);
	registry.register(editFileTool); // old_string/new_string native format
	registry.register(shellTool); // 120s default timeout for Claude Code
	registry.register(grepTool);
	registry.register(globTool);

	return {
		id: "anthropic",
		provider: "anthropic",
		model,
		tool_executors: registry.executors, // expose the Map

		build_system_prompt(env, project_docs) {
			// Layer 1: Base instructions
			let prompt = ANTHROPIC_BASE_PROMPT;
			// Layer 2: Environment context
			prompt += buildEnvironmentBlock(env, model);
			// Layer 3: Tool descriptions (auto from schemas)
			// Layer 4: Project docs
			if (project_docs) prompt += `\n\n${project_docs}`;
			return prompt;
		},

		tools() {
			return registry.schemas();
		},

		provider_options() {
			return null;
		},

		supports_reasoning: true,
		supports_streaming: true,
		supports_parallel_tool_calls: true,
		context_window_size: 200_000,
	};
}
