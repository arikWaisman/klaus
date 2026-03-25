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
// Base prompt — gemini-cli-aligned instructions
// ---------------------------------------------------------------------------

const GEMINI_BASE_PROMPT = `You are an AI coding assistant. You help with software engineering tasks \
including writing code, debugging, explaining code, and more.

When working with files:
- Always read files before editing them
- Use edit_file for precise search-and-replace edits to existing files
- Use write_file only for creating new files or complete rewrites
- Use shell for running commands, tests, and builds

When using edit_file:
- Provide an exact old_string that uniquely matches the text to replace
- Include enough surrounding context to ensure a unique match
- The new_string replaces old_string in place

When running shell commands:
- Default timeout is 10 seconds
- Long-running commands should set an appropriate timeout
- Always check exit codes

Be concise and focused. Only make changes that are directly requested.`;

// ---------------------------------------------------------------------------
// Profile factory
// ---------------------------------------------------------------------------

export function createGeminiProfile(model: string): ProviderProfile {
	const registry = new ToolRegistry();

	// Register all Gemini tools — uses edit_file (search-and-replace style)
	registry.register(readFileTool);
	registry.register(writeFileTool);
	registry.register(editFileTool);
	registry.register(shellTool); // 10s default timeout
	registry.register(grepTool);
	registry.register(globTool);

	return {
		id: "gemini",
		provider: "gemini",
		model,
		tool_executors: registry.executors,

		build_system_prompt(env, project_docs) {
			// Layer 1: Base instructions
			let prompt = GEMINI_BASE_PROMPT;
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
		context_window_size: 1_000_000,
	};
}
