import {
	applyPatchTool,
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
// Base prompt — codex-rs-aligned instructions
// ---------------------------------------------------------------------------

const OPENAI_BASE_PROMPT = `You are an AI coding assistant. You help with software engineering tasks \
including writing code, debugging, explaining code, and more.

When working with files:
- Always read files before modifying them
- Use apply_patch to make targeted edits to existing files
- Use write_file only for creating new files or complete rewrites
- Use shell for running commands, tests, and builds

When using apply_patch:
- Provide a unified diff patch with correct context lines
- Ensure the patch applies cleanly against the current file content
- Keep patches minimal — only include the lines that need to change

When running shell commands:
- Default timeout is 10 seconds
- Long-running commands should set an appropriate timeout
- Always check exit codes

Be concise and focused. Only make changes that are directly requested.`;

// ---------------------------------------------------------------------------
// Profile factory
// ---------------------------------------------------------------------------

export function createOpenAIProfile(model: string): ProviderProfile {
	const registry = new ToolRegistry();

	// Register all OpenAI tools — uses apply_patch instead of edit_file
	registry.register(readFileTool);
	registry.register(applyPatchTool);
	registry.register(writeFileTool);
	registry.register(shellTool); // 10s default timeout
	registry.register(grepTool);
	registry.register(globTool);

	return {
		id: "openai",
		provider: "openai",
		model,
		tool_executors: registry.executors,

		build_system_prompt(env, project_docs) {
			// Layer 1: Base instructions
			let prompt = OPENAI_BASE_PROMPT;
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
		context_window_size: 128_000,
	};
}
