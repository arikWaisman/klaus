import type { Client, ContentPart, Message, Request, Response, Usage } from "@klaus/llm-client";
import { emptyUsage, mergeUsage, responseText, responseToolCalls } from "@klaus/llm-client";
import { EventEmitter } from "./events.js";
import { detectLoop, loopWarningMessage } from "./loop-detection.js";
import { MessageQueue } from "./steering.js";
import { truncateToolOutput } from "./truncation.js";
import type {
	AssistantTurn,
	ExecutionEnvironment,
	ProviderProfile,
	SessionConfig,
	SessionOptions,
	SessionState,
	SteeringTurn,
	SubagentHandle,
	SubagentResult,
	ToolCallInfo,
	ToolResultInfo,
	ToolResultsTurn,
	Turn,
	UserTurn,
} from "./types.js";
import { DEFAULT_SESSION_CONFIG } from "./types.js";

export class Session {
	readonly id: string;
	readonly profile: ProviderProfile;
	readonly client: Client;
	readonly environment: ExecutionEnvironment;
	readonly config: SessionConfig;
	readonly events: EventEmitter;

	private _state: SessionState = "IDLE";
	private history: Turn[] = [];
	private steering_queue: MessageQueue = new MessageQueue();
	private followup_queue: MessageQueue = new MessageQueue();
	private subagents: Map<string, SubagentHandle> = new Map();
	private turn_count = 0;
	private abort_signal?: AbortSignal;
	private custom_instructions?: string;
	private current_depth: number;

	get state(): SessionState {
		return this._state;
	}

	constructor(options: SessionOptions & { depth?: number }) {
		this.id = `session_${crypto.randomUUID()}`;
		this.profile = options.profile;
		this.client = options.client;
		this.environment = options.environment;
		this.config = { ...DEFAULT_SESSION_CONFIG, ...options.config };
		this.events = new EventEmitter(this.id);
		this.abort_signal = options.abort_signal;
		this.custom_instructions = options.custom_instructions;
		this.current_depth = options.depth ?? 0;

		this.events.emit("SESSION_START", {
			profile: this.profile.id,
			model: this.profile.model,
		});
	}

	// -- Public API --

	/**
	 * Process user input through the agentic loop.
	 * This is the core algorithm (Section 2.5 of the spec).
	 */
	async process_input(input: string): Promise<void> {
		if (this._state === "CLOSED") {
			throw new Error("Session is closed");
		}

		this._state = "PROCESSING";

		// 1. Append UserTurn
		const userTurn: UserTurn = {
			kind: "user",
			content: input,
			timestamp: Date.now(),
		};
		this.history.push(userTurn);
		this.turn_count++;
		this.events.emit("USER_INPUT", { content: input });

		// 2. Drain steering queue before first LLM call
		this.drainSteering();

		// 3. Agentic loop
		let round = 0;

		while (true) {
			// Check abort signal
			if (this.abort_signal?.aborted) {
				this._state = "CLOSED";
				this.events.emit("SESSION_END", { reason: "aborted" });
				return;
			}

			// Check turn limits
			if (this.config.max_turns > 0 && this.turn_count >= this.config.max_turns) {
				this.events.emit("TURN_LIMIT", {
					turns: this.turn_count,
					max: this.config.max_turns,
				});
				break;
			}

			// Check round limits
			if (
				this.config.max_tool_rounds_per_input > 0 &&
				round >= this.config.max_tool_rounds_per_input
			) {
				this.events.emit("TURN_LIMIT", {
					rounds: round,
					max: this.config.max_tool_rounds_per_input,
				});
				break;
			}

			// Build LLM request
			const request = this.buildRequest();

			// Call LLM via Client.complete() (NOT generate())
			let response: Response;
			try {
				response = await this.client.complete(request);
			} catch (error) {
				this.events.emitError(error);
				this._state = "CLOSED";
				this.events.emit("SESSION_END", { reason: "error" });
				return;
			}

			// Extract content from response
			const text = responseText(response);
			const toolCalls = responseToolCalls(response);

			// Record AssistantTurn
			const assistantTurn: AssistantTurn = {
				kind: "assistant",
				content: text,
				tool_calls: toolCalls.map((tc) => ({
					id: tc.id,
					name: tc.name,
					arguments: tc.arguments,
				})),
				reasoning:
					response.message.content
						.filter((p) => p.kind === "thinking" && p.thinking)
						.map((p) => p.thinking?.text)
						.join("\n") || undefined,
				usage: response.usage,
				response_id: response.id,
				timestamp: Date.now(),
			};
			this.history.push(assistantTurn);
			this.turn_count++;

			// Emit text events
			if (text) {
				this.events.emitTextStart();
				this.events.emitTextDelta(text);
				this.events.emitTextEnd(text);
			}

			// If no tool calls, natural completion -- break
			if (assistantTurn.tool_calls.length === 0) {
				break;
			}

			// Execute tool calls
			const results = await this.executeToolCalls(assistantTurn.tool_calls);

			// Append ToolResultsTurn
			const toolResultsTurn: ToolResultsTurn = {
				kind: "tool_results",
				results,
				timestamp: Date.now(),
			};
			this.history.push(toolResultsTurn);

			// Drain steering queue after tool round
			this.drainSteering();

			// Loop detection
			if (this.config.enable_loop_detection) {
				this.checkLoopDetection();
			}

			round++;
		}

		// Process follow-up queue
		this._state = "IDLE";
		this.events.emit("PROCESSING_END");

		const followups = this.followup_queue.drain();
		for (const msg of followups) {
			await this.process_input(msg);
		}
	}

	/**
	 * Inject a steering message after the current tool round.
	 */
	steer(message: string): void {
		this.steering_queue.push(message);
	}

	/**
	 * Queue a follow-up message for after current input completes.
	 */
	follow_up(message: string): void {
		this.followup_queue.push(message);
	}

	/**
	 * Abort the session.
	 */
	close(): void {
		this._state = "CLOSED";
		this.events.emit("SESSION_END", { reason: "closed" });
		this.events.close();
	}

	/**
	 * Get the conversation history.
	 */
	getHistory(): Turn[] {
		return [...this.history];
	}

	/**
	 * Get accumulated usage across all turns.
	 */
	getTotalUsage(): Usage {
		let total = emptyUsage();
		for (const turn of this.history) {
			if (turn.kind === "assistant" && turn.usage) {
				total = mergeUsage(total, turn.usage);
			}
		}
		return total;
	}

	// -- Private methods --

	private drainSteering(): void {
		const messages = this.steering_queue.drain();
		for (const msg of messages) {
			const steeringTurn: SteeringTurn = {
				kind: "steering",
				content: msg,
				timestamp: Date.now(),
			};
			this.history.push(steeringTurn);
			this.events.emit("STEERING_INJECTED", { content: msg });
		}
	}

	private buildRequest(): Request {
		const systemPrompt = this.buildSystemPrompt();
		const messages = this.historyToMessages();

		const request: Request = {
			model: this.profile.model,
			provider: this.profile.provider,
			messages: [
				{
					role: "system",
					content: [{ kind: "text", text: systemPrompt }],
				},
				...messages,
			],
			tools: this.profile.tools().map((s) => ({
				name: s.name,
				description: s.description,
				parameters: s.parameters,
			})),
		};

		if (this.config.reasoning_effort) {
			request.reasoning_effort = this.config.reasoning_effort;
		}

		return request;
	}

	private buildSystemPrompt(): string {
		// Collect project docs (placeholder -- real implementation would
		// scan for AGENTS.md, CLAUDE.md, etc.)
		const projectDocs = this.custom_instructions ?? "";
		return this.profile.build_system_prompt(this.environment, projectDocs);
	}

	private historyToMessages(): Message[] {
		const messages: Message[] = [];

		for (const turn of this.history) {
			switch (turn.kind) {
				case "user":
					messages.push({
						role: "user",
						content: [{ kind: "text", text: turn.content }],
					});
					break;
				case "assistant": {
					const parts: ContentPart[] = [];
					if (turn.content) {
						parts.push({ kind: "text", text: turn.content });
					}
					for (const tc of turn.tool_calls) {
						parts.push({
							kind: "tool_call",
							tool_call: {
								id: tc.id,
								name: tc.name,
								arguments: tc.arguments,
							},
						});
					}
					messages.push({ role: "assistant", content: parts });
					break;
				}
				case "tool_results": {
					const parts: ContentPart[] = turn.results.map((r) => ({
						kind: "tool_result" as const,
						tool_result: {
							tool_call_id: r.tool_call_id,
							content: r.output,
							is_error: r.is_error,
						},
					}));
					messages.push({ role: "tool", content: parts });
					break;
				}
				case "steering":
				case "system":
					// Steering and system turns become user messages
					// for the LLM
					messages.push({
						role: "user",
						content: [{ kind: "text", text: turn.content }],
					});
					break;
			}
		}

		return messages;
	}

	private async executeToolCalls(calls: ToolCallInfo[]): Promise<ToolResultInfo[]> {
		const results: ToolResultInfo[] = [];

		// Execute tool calls -- could be parallel if profile supports it
		const executeOne = async (call: ToolCallInfo): Promise<ToolResultInfo> => {
			this.events.emitToolCallStart(call.name, call.id, call.arguments);

			const executor = this.profile.tool_executors.get(call.name);
			let output: string;
			let is_error: boolean;

			if (!executor) {
				output = `Error: Unknown tool "${call.name}"`;
				is_error = true;
			} else {
				try {
					output = await executor.execute(call.arguments, this.environment, this.config);
					is_error = false;
				} catch (error) {
					output = `Error executing ${call.name}: ${
						error instanceof Error ? error.message : String(error)
					}`;
					is_error = true;
				}
			}

			// Truncate output for LLM (full output goes in event)
			const truncatedOutput = truncateToolOutput(
				call.name,
				output,
				this.config.tool_output_limits,
				this.config.tool_line_limits,
			);

			this.events.emitToolCallEnd(call.id, output, truncatedOutput, is_error);

			return {
				tool_call_id: call.id,
				name: call.name,
				output: truncatedOutput, // LLM sees truncated version
				is_error,
			};
		};

		if (this.profile.supports_parallel_tool_calls && calls.length > 1) {
			const settled = await Promise.allSettled(calls.map(executeOne));
			for (let i = 0; i < settled.length; i++) {
				const result = settled[i]!;
				if (result.status === "fulfilled") {
					results.push(result.value);
				} else {
					results.push({
						tool_call_id: calls[i]?.id,
						name: calls[i]?.name,
						output: `Internal error: ${result.reason}`,
						is_error: true,
					});
				}
			}
		} else {
			for (const call of calls) {
				results.push(await executeOne(call));
			}
		}

		return results;
	}

	private checkLoopDetection(): void {
		// Collect recent tool calls from history
		const recentCalls: ToolCallInfo[] = [];
		for (const turn of this.history) {
			if (turn.kind === "assistant") {
				recentCalls.push(...turn.tool_calls);
			}
		}

		const patternLen = detectLoop(recentCalls, this.config.loop_detection_window);
		if (patternLen > 0) {
			const warning = loopWarningMessage(patternLen, this.config.loop_detection_window);
			this.events.emit("LOOP_DETECTION", {
				pattern_length: patternLen,
				message: warning,
			});
			// Inject as steering
			this.steering_queue.push(warning);
		}
	}
}
