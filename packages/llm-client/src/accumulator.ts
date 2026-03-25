import type {
	ContentPart,
	FinishReason,
	Message,
	Response,
	StreamEvent,
	ToolCall,
	Usage,
	Warning,
} from "./types.js";
import { emptyUsage, mergeUsage } from "./types.js";

// ---------------------------------------------------------------------------
// StreamAccumulator — builds a complete Response from StreamEvents
// ---------------------------------------------------------------------------

/**
 * Accumulates `StreamEvent`s into a complete `Response`.
 *
 * Usage:
 * ```ts
 * const acc = new StreamAccumulator();
 * for await (const event of stream) {
 *   acc.push(event);
 * }
 * const response = acc.response();
 * ```
 */
export class StreamAccumulator {
	private text = "";
	private reasoning = "";
	private tool_calls: Map<string, { id: string; name: string; args: string }> = new Map();
	private current_tool_id: string | undefined;
	private usage: Usage = emptyUsage();
	private finish_reason: FinishReason = { reason: "other" };
	private response_id = "";
	private response_model = "";
	private response_provider = "";
	private warnings: Warning[] = [];
	private raw: Record<string, unknown> | undefined;
	private _response: Response | undefined;

	/**
	 * Process a single stream event.
	 */
	push(event: StreamEvent): void {
		switch (event.type) {
			case "STREAM_START":
				// Reset for a new stream.
				break;

			case "TEXT_DELTA":
				if (event.delta) {
					this.text += event.delta;
				}
				break;

			case "REASONING_DELTA":
				if (event.reasoning_delta) {
					this.reasoning += event.reasoning_delta;
				}
				break;

			case "TOOL_CALL_START":
				if (event.tool_call?.id) {
					this.current_tool_id = event.tool_call.id;
					this.tool_calls.set(event.tool_call.id, {
						id: event.tool_call.id,
						name: event.tool_call.name ?? "",
						args: "",
					});
				}
				break;

			case "TOOL_CALL_DELTA":
				if (event.delta) {
					const id = event.tool_call_id ?? this.current_tool_id;
					if (id) {
						const tc = this.tool_calls.get(id);
						if (tc) {
							tc.args += event.delta;
						}
					}
				}
				break;

			case "TOOL_CALL_END":
				this.current_tool_id = undefined;
				break;

			case "FINISH":
				if (event.finish_reason) {
					this.finish_reason = event.finish_reason;
				}
				if (event.usage) {
					this.usage = mergeUsage(this.usage, event.usage);
				}
				if (event.response) {
					this._response = event.response;
				}
				break;

			case "ERROR":
				break;

			default:
				break;
		}
	}

	/**
	 * Get the accumulated text content.
	 */
	getText(): string {
		return this.text;
	}

	/**
	 * Get the accumulated reasoning content.
	 */
	getReasoning(): string | undefined {
		return this.reasoning.length > 0 ? this.reasoning : undefined;
	}

	/**
	 * Get the accumulated tool calls.
	 */
	getToolCalls(): ToolCall[] {
		const calls: ToolCall[] = [];
		for (const tc of this.tool_calls.values()) {
			let args: Record<string, unknown> = {};
			try {
				args = JSON.parse(tc.args) as Record<string, unknown>;
			} catch {
				// If JSON parsing fails, return empty args but keep raw_arguments.
			}
			calls.push({
				id: tc.id,
				name: tc.name,
				arguments: args,
				raw_arguments: tc.args,
			});
		}
		return calls;
	}

	/**
	 * Get the accumulated usage.
	 */
	getUsage(): Usage {
		return this._response?.usage ?? this.usage;
	}

	/**
	 * Build a complete Response from the accumulated events.
	 *
	 * If a FINISH event included a complete Response, returns that.
	 * Otherwise, constructs one from accumulated data.
	 */
	response(): Response {
		if (this._response) {
			return this._response;
		}

		const content: ContentPart[] = [];

		if (this.reasoning.length > 0) {
			content.push({
				kind: "thinking",
				thinking: { text: this.reasoning, redacted: false },
			});
		}

		if (this.text.length > 0) {
			content.push({ kind: "text", text: this.text });
		}

		for (const tc of this.tool_calls.values()) {
			let args: Record<string, unknown> = {};
			try {
				args = JSON.parse(tc.args) as Record<string, unknown>;
			} catch {
				// Keep empty args
			}
			content.push({
				kind: "tool_call",
				tool_call: { id: tc.id, name: tc.name, arguments: args },
			});
		}

		const message: Message = { role: "assistant", content };

		return {
			id: this.response_id || "accumulated",
			model: this.response_model || "unknown",
			provider: this.response_provider || "unknown",
			message,
			finish_reason: this.finish_reason,
			usage: this.usage,
			warnings: this.warnings,
			raw: this.raw,
		};
	}
}
