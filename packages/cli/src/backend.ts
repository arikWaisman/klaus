import {
	LocalExecutionEnvironment,
	Session,
	createAnthropicProfile,
	createGeminiProfile,
	createOpenAIProfile,
} from "@klaus/agent-loop";
import type { Client } from "@klaus/llm-client";
import type { CodergenBackend, Node, PipelineContext } from "@klaus/pipeline";

/**
 * Infer provider from model name, matching llm-client's routing logic.
 */
function inferProvider(model: string): "anthropic" | "openai" | "gemini" {
	if (model.startsWith("claude-")) return "anthropic";
	if (model.startsWith("gpt-") || model.startsWith("o1-") || model.startsWith("o3-")) {
		return "openai";
	}
	if (model.startsWith("gemini-")) return "gemini";
	return "anthropic";
}

function createProfile(model: string) {
	const provider = inferProvider(model);
	switch (provider) {
		case "anthropic":
			return createAnthropicProfile(model);
		case "openai":
			return createOpenAIProfile(model);
		case "gemini":
			return createGeminiProfile(model);
	}
}

export interface SessionBackendOptions {
	client: Client;
	model: string;
	cwd: string;
}

/**
 * CodergenBackend that uses an @klaus/agent-loop Session to execute prompts.
 * Each codergen node gets a fresh Session with the appropriate provider profile.
 */
export function createSessionBackend(options: SessionBackendOptions): CodergenBackend {
	return {
		async run(node: Node, prompt: string, _context: PipelineContext): Promise<string> {
			const model = node.attributes.llm_model ?? options.model;
			const profile = createProfile(model);

			const env = new LocalExecutionEnvironment(options.cwd);
			await env.initialize();

			const session = new Session({
				profile,
				client: options.client,
				environment: env,
				config: {
					max_turns: 20,
					max_tool_rounds_per_input: 15,
					default_command_timeout_ms: 120_000,
					max_command_timeout_ms: 600_000,
					reasoning_effort: null,
					tool_output_limits: {},
					tool_line_limits: {},
					enable_loop_detection: true,
					loop_detection_window: 10,
					max_subagent_depth: 1,
				},
			});

			// Listen for text output
			let output = "";
			session.events.on((event) => {
				if (event.kind === "ASSISTANT_TEXT_DELTA" && event.data) {
					const delta = typeof event.data.text === "string" ? event.data.text : "";
					output += delta;
					process.stdout.write(delta);
				}
			});

			await session.process_input(prompt);
			session.close();

			return output;
		},
	};
}
