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
	if (model.startsWith("claude")) return "anthropic";
	if (model.startsWith("gpt-") || model.startsWith("o1-") || model.startsWith("o3-")) {
		return "openai";
	}
	if (model.startsWith("gemini")) return "gemini";
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
	model?: string;
	cwd: string;
}

const SESSION_CONFIG = {
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
} as const;

/**
 * CodergenBackend that uses @klaus/agent-loop Sessions to execute prompts.
 *
 * Supports **thread continuity**: nodes sharing the same `thread_id` attribute
 * reuse the same Session, preserving the full conversation history across nodes.
 * Nodes without a `thread_id` get a fresh, ephemeral session each time.
 */
export function createSessionBackend(options: SessionBackendOptions): CodergenBackend {
	// Session registry — keyed by thread_id for multi-turn continuity.
	const sessions = new Map<string, { session: Session; env: LocalExecutionEnvironment }>();

	return {
		async run(node: Node, prompt: string, _context: PipelineContext): Promise<string> {
			const model = node.attributes.llm_model ?? options.model ?? options.client.getDefaultModel()!;
			const threadId = node.attributes.thread_id;

			let session: Session;
			let isEphemeral = false;

			if (threadId && sessions.has(threadId)) {
				// Reuse existing session for this thread.
				session = sessions.get(threadId)!.session;
			} else {
				// Create a new session.
				const profile = createProfile(model);
				const env = new LocalExecutionEnvironment(options.cwd);
				await env.initialize();

				session = new Session({
					profile,
					client: options.client,
					environment: env,
					config: SESSION_CONFIG,
				});

				if (threadId) {
					sessions.set(threadId, { session, env });
				} else {
					isEphemeral = true;
				}
			}

			// Listen for text output
			let output = "";
			const listener = (event: { kind: string; data?: Record<string, unknown> }) => {
				if (event.kind === "ASSISTANT_TEXT_DELTA" && event.data) {
					const delta = typeof event.data.text === "string" ? event.data.text : "";
					output += delta;
					process.stdout.write(delta);
				}
			};
			session.events.on(listener);

			await session.process_input(prompt);

			// Only close ephemeral sessions — threaded sessions persist.
			if (isEphemeral) {
				session.close();
			}

			return output;
		},
	};
}
