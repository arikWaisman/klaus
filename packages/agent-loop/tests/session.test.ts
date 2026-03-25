import { describe, it, expect, vi, beforeEach } from "vitest";
import { Session } from "../src/session.js";
import type {
	ProviderProfile,
	ExecutionEnvironment,
	ToolSchema,
	ToolExecutor,
	SessionConfig,
	SessionEvent,
} from "../src/types.js";
import type { Client, Response } from "@klaus/llm-client";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTextResponse(text: string, id = "resp_1"): Response {
	return {
		id,
		model: "test-model",
		provider: "anthropic",
		message: {
			role: "assistant",
			content: [{ kind: "text", text }],
		},
		finish_reason: { reason: "stop", raw: "end_turn" },
		usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
		warnings: [],
	};
}

function makeToolCallResponse(
	toolName: string,
	args: Record<string, unknown>,
	callId = "call_1",
	id = "resp_2",
): Response {
	return {
		id,
		model: "test-model",
		provider: "anthropic",
		message: {
			role: "assistant",
			content: [
				{
					kind: "tool_call",
					tool_call: { id: callId, name: toolName, arguments: args },
				},
			],
		},
		finish_reason: { reason: "tool_calls", raw: "tool_use" },
		usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
		warnings: [],
	};
}

function createMockClient(responses: Response[]): Client {
	let callIndex = 0;
	return {
		complete: vi.fn(async () => {
			const response = responses[callIndex];
			if (!response) {
				throw new Error(`No more mock responses (called ${callIndex + 1} times)`);
			}
			callIndex++;
			return response;
		}),
		stream: vi.fn(),
		registerAdapter: vi.fn(),
		use: vi.fn(),
	} as unknown as Client;
}

function createMockEnvironment(): ExecutionEnvironment {
	return {
		read_file: vi.fn().mockResolvedValue("file content"),
		write_file: vi.fn().mockResolvedValue(undefined),
		exec_command: vi.fn().mockResolvedValue({
			stdout: "output",
			stderr: "",
			exit_code: 0,
			timed_out: false,
			duration_ms: 100,
		}),
		grep: vi.fn().mockResolvedValue("match:1:found"),
		glob: vi.fn().mockResolvedValue(["a.ts", "b.ts"]),
		file_exists: vi.fn().mockResolvedValue(true),
		list_directory: vi.fn().mockResolvedValue([]),
		working_directory: vi.fn().mockReturnValue("/test"),
		platform: vi.fn().mockReturnValue("darwin"),
		os_version: vi.fn().mockReturnValue("24.0.0"),
		initialize: vi.fn().mockResolvedValue(undefined),
		cleanup: vi.fn().mockResolvedValue(undefined),
	} as unknown as ExecutionEnvironment;
}

function createMockToolExecutor(name: string, output = "tool output"): ToolExecutor {
	return {
		schema: {
			name,
			description: `Mock ${name} tool`,
			parameters: { type: "object", properties: {}, required: [] },
		},
		execute: vi.fn().mockResolvedValue(output),
	};
}

function createMockProfile(executors?: Map<string, ToolExecutor>): ProviderProfile {
	const defaultExecutors =
		executors ??
		new Map<string, ToolExecutor>([
			["read_file", createMockToolExecutor("read_file", "file content here")],
			["write_file", createMockToolExecutor("write_file", "Wrote 10 bytes")],
			["shell", createMockToolExecutor("shell", "Exit code: 0\nstdout\n")],
		]);

	return {
		id: "test-profile",
		provider: "anthropic",
		model: "test-model",
		tool_executors: defaultExecutors,
		build_system_prompt: vi.fn().mockReturnValue("You are a helpful assistant."),
		tools: vi.fn().mockReturnValue(
			Array.from(defaultExecutors.values()).map((e) => e.schema),
		),
		provider_options: vi.fn().mockReturnValue(null),
		supports_reasoning: false,
		supports_streaming: false,
		supports_parallel_tool_calls: false,
		context_window_size: 200_000,
	};
}

function collectEvents(session: Session): SessionEvent[] {
	const events: SessionEvent[] = [];
	session.events.on((event) => events.push(event));
	return events;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Session", () => {
	let mockEnv: ExecutionEnvironment;
	let mockProfile: ProviderProfile;

	beforeEach(() => {
		vi.restoreAllMocks();
		mockEnv = createMockEnvironment();
		mockProfile = createMockProfile();
	});

	// 1. Session starts in IDLE state
	it("starts in IDLE state", () => {
		const client = createMockClient([]);
		const session = new Session({
			profile: mockProfile,
			client,
			environment: mockEnv,
		});

		expect(session.state).toBe("IDLE");
	});

	// 2. Session emits SESSION_START on construction
	it("emits SESSION_START on construction", () => {
		const client = createMockClient([]);
		const events: SessionEvent[] = [];

		// We need to register the listener before constructing to capture
		// the SESSION_START event -- but the emitter is created in the
		// constructor.  Instead, read from the event buffer after creation.
		const session = new Session({
			profile: mockProfile,
			client,
			environment: mockEnv,
		});

		const history = session.events.getHistory();
		expect(history.length).toBeGreaterThanOrEqual(1);
		expect(history[0]!.kind).toBe("SESSION_START");
		expect(history[0]!.data).toEqual({
			profile: "test-profile",
			model: "test-model",
		});
	});

	// 3. process_input transitions to PROCESSING then back to IDLE
	it("process_input transitions to PROCESSING then back to IDLE", async () => {
		const client = createMockClient([makeTextResponse("Hello!")]);
		const session = new Session({
			profile: mockProfile,
			client,
			environment: mockEnv,
		});

		const statesObserved: string[] = [];
		session.events.on((event) => {
			if (event.kind === "USER_INPUT") {
				statesObserved.push(session.state);
			}
			if (event.kind === "PROCESSING_END") {
				statesObserved.push(session.state);
			}
		});

		await session.process_input("Hi");

		expect(statesObserved).toContain("PROCESSING");
		expect(session.state).toBe("IDLE");
	});

	// 4. process_input with text-only response -- natural completion
	it("process_input with text-only response completes naturally", async () => {
		const client = createMockClient([makeTextResponse("Hello there!")]);
		const session = new Session({
			profile: mockProfile,
			client,
			environment: mockEnv,
		});

		await session.process_input("Greet me");

		const history = session.getHistory();
		expect(history).toHaveLength(2);
		expect(history[0]!.kind).toBe("user");
		expect(history[1]!.kind).toBe("assistant");

		if (history[1]!.kind === "assistant") {
			expect(history[1]!.content).toBe("Hello there!");
			expect(history[1]!.tool_calls).toHaveLength(0);
		}

		expect(session.state).toBe("IDLE");
		expect(client.complete).toHaveBeenCalledTimes(1);
	});

	// 5. process_input with tool calls -- executes tools and loops
	it("process_input with tool calls executes tools and loops", async () => {
		const client = createMockClient([
			makeToolCallResponse("read_file", { file_path: "test.ts" }),
			makeTextResponse("Done reading the file!"),
		]);
		const session = new Session({
			profile: mockProfile,
			client,
			environment: mockEnv,
		});

		await session.process_input("Read test.ts");

		const history = session.getHistory();
		// user -> assistant (tool call) -> tool_results -> assistant (text)
		expect(history).toHaveLength(4);
		expect(history[0]!.kind).toBe("user");
		expect(history[1]!.kind).toBe("assistant");
		expect(history[2]!.kind).toBe("tool_results");
		expect(history[3]!.kind).toBe("assistant");

		if (history[1]!.kind === "assistant") {
			expect(history[1]!.tool_calls).toHaveLength(1);
			expect(history[1]!.tool_calls[0]!.name).toBe("read_file");
		}

		expect(client.complete).toHaveBeenCalledTimes(2);
	});

	// 6. process_input respects max_tool_rounds_per_input
	it("respects max_tool_rounds_per_input", async () => {
		// Create a client that always returns tool calls
		const client = createMockClient([
			makeToolCallResponse("read_file", { file_path: "a.ts" }, "call_1", "resp_1"),
			makeToolCallResponse("read_file", { file_path: "b.ts" }, "call_2", "resp_2"),
			makeToolCallResponse("read_file", { file_path: "c.ts" }, "call_3", "resp_3"),
			makeTextResponse("final", "resp_4"),
		]);
		const session = new Session({
			profile: mockProfile,
			client,
			environment: mockEnv,
			config: { max_tool_rounds_per_input: 2 },
		});

		const events = collectEvents(session);
		await session.process_input("Read everything");

		// Should have stopped after 2 rounds of tool use
		// Round 0: tool call -> tool result -> round++
		// Round 1: tool call -> tool result -> round++
		// Round 2: max_tool_rounds_per_input hit, break
		expect(client.complete).toHaveBeenCalledTimes(2);

		const turnLimitEvents = events.filter((e) => e.kind === "TURN_LIMIT");
		expect(turnLimitEvents).toHaveLength(1);
	});

	// 7. process_input respects max_turns
	it("respects max_turns", async () => {
		const client = createMockClient([
			makeToolCallResponse("read_file", { file_path: "a.ts" }, "call_1", "resp_1"),
			makeToolCallResponse("read_file", { file_path: "b.ts" }, "call_2", "resp_2"),
			makeTextResponse("final", "resp_3"),
		]);
		// max_turns = 3: user turn (1) + assistant turn (2) + assistant turn (3) = hits limit
		const session = new Session({
			profile: mockProfile,
			client,
			environment: mockEnv,
			config: { max_turns: 3 },
		});

		const events = collectEvents(session);
		await session.process_input("Read everything");

		// user turn (count=1), first assistant (count=2), second loop check:
		// turn_count=2 < 3 so continues, assistant turn (count=3), then
		// next loop iteration turn_count=3 >= 3 so emits TURN_LIMIT
		const turnLimitEvents = events.filter((e) => e.kind === "TURN_LIMIT");
		expect(turnLimitEvents).toHaveLength(1);
	});

	// 8. steer() injects steering message into history
	it("steer() injects steering message into history", async () => {
		const client = createMockClient([
			makeToolCallResponse("read_file", { file_path: "a.ts" }, "call_1", "resp_1"),
			makeTextResponse("Done!", "resp_2"),
		]);
		const session = new Session({
			profile: mockProfile,
			client,
			environment: mockEnv,
		});

		// Inject steering before processing starts -- it will be drained
		// before the first LLM call
		session.steer("Focus on error handling");

		await session.process_input("Do something");

		const history = session.getHistory();
		const steeringTurns = history.filter((t) => t.kind === "steering");
		expect(steeringTurns.length).toBeGreaterThanOrEqual(1);
		expect(steeringTurns[0]!.content).toBe("Focus on error handling");
	});

	// 9. follow_up() processes after main input completes
	it("follow_up() processes after main input completes", async () => {
		const client = createMockClient([
			makeTextResponse("First response"),
			makeTextResponse("Follow-up response"),
		]);
		const session = new Session({
			profile: mockProfile,
			client,
			environment: mockEnv,
		});

		// Queue a follow-up before calling process_input
		session.follow_up("Now summarize");

		await session.process_input("Hello");

		const history = session.getHistory();
		// First: user + assistant (for "Hello")
		// Then follow-up: user + assistant (for "Now summarize")
		const userTurns = history.filter((t) => t.kind === "user");
		const assistantTurns = history.filter((t) => t.kind === "assistant");

		expect(userTurns).toHaveLength(2);
		expect(assistantTurns).toHaveLength(2);
		expect(userTurns[1]!.content).toBe("Now summarize");
		expect(client.complete).toHaveBeenCalledTimes(2);
	});

	// 10. close() sets state to CLOSED
	it("close() sets state to CLOSED", () => {
		const client = createMockClient([]);
		const session = new Session({
			profile: mockProfile,
			client,
			environment: mockEnv,
		});

		session.close();

		expect(session.state).toBe("CLOSED");
	});

	// 11. process_input on closed session throws
	it("process_input on closed session throws", async () => {
		const client = createMockClient([]);
		const session = new Session({
			profile: mockProfile,
			client,
			environment: mockEnv,
		});

		session.close();

		await expect(session.process_input("Hello")).rejects.toThrow(
			"Session is closed",
		);
	});

	// 12. Unknown tool returns error result (not exception)
	it("unknown tool returns error result, not exception", async () => {
		const client = createMockClient([
			makeToolCallResponse("nonexistent_tool", { arg: "val" }),
			makeTextResponse("I see the error"),
		]);
		const session = new Session({
			profile: mockProfile,
			client,
			environment: mockEnv,
		});

		await session.process_input("Use a fake tool");

		const history = session.getHistory();
		const toolResultsTurn = history.find((t) => t.kind === "tool_results");
		expect(toolResultsTurn).toBeDefined();

		if (toolResultsTurn?.kind === "tool_results") {
			expect(toolResultsTurn.results).toHaveLength(1);
			expect(toolResultsTurn.results[0]!.is_error).toBe(true);
			expect(toolResultsTurn.results[0]!.output).toContain("Unknown tool");
			expect(toolResultsTurn.results[0]!.output).toContain("nonexistent_tool");
		}

		// Session should still be running -- not thrown
		expect(session.state).toBe("IDLE");
	});

	// 13. Tool execution error is caught and returned as error result
	it("tool execution error is caught and returned as error result", async () => {
		const failingExecutor = createMockToolExecutor("read_file");
		(failingExecutor.execute as ReturnType<typeof vi.fn>).mockRejectedValue(
			new Error("Permission denied"),
		);
		const executors = new Map<string, ToolExecutor>([
			["read_file", failingExecutor],
		]);
		const profile = createMockProfile(executors);

		const client = createMockClient([
			makeToolCallResponse("read_file", { file_path: "/secret" }),
			makeTextResponse("Got the error"),
		]);
		const session = new Session({
			profile,
			client,
			environment: mockEnv,
		});

		await session.process_input("Read a protected file");

		const history = session.getHistory();
		const toolResultsTurn = history.find((t) => t.kind === "tool_results");
		expect(toolResultsTurn).toBeDefined();

		if (toolResultsTurn?.kind === "tool_results") {
			expect(toolResultsTurn.results[0]!.is_error).toBe(true);
			expect(toolResultsTurn.results[0]!.output).toContain("Permission denied");
		}

		expect(session.state).toBe("IDLE");
	});

	// 14. History records UserTurn, AssistantTurn, ToolResultsTurn
	it("history records UserTurn, AssistantTurn, ToolResultsTurn", async () => {
		const client = createMockClient([
			makeToolCallResponse("shell", { command: "ls" }, "call_shell"),
			makeTextResponse("Here are the files"),
		]);
		const session = new Session({
			profile: mockProfile,
			client,
			environment: mockEnv,
		});

		await session.process_input("List files");

		const history = session.getHistory();
		expect(history[0]!.kind).toBe("user");
		expect(history[0]!.content).toBe("List files");

		expect(history[1]!.kind).toBe("assistant");
		if (history[1]!.kind === "assistant") {
			expect(history[1]!.tool_calls[0]!.id).toBe("call_shell");
			expect(history[1]!.tool_calls[0]!.name).toBe("shell");
		}

		expect(history[2]!.kind).toBe("tool_results");
		if (history[2]!.kind === "tool_results") {
			expect(history[2]!.results[0]!.tool_call_id).toBe("call_shell");
			expect(history[2]!.results[0]!.name).toBe("shell");
		}

		expect(history[3]!.kind).toBe("assistant");
		if (history[3]!.kind === "assistant") {
			expect(history[3]!.content).toBe("Here are the files");
		}
	});

	// 15. Events are emitted for USER_INPUT, text start/delta/end, tool calls
	it("emits events for USER_INPUT, text lifecycle, and tool calls", async () => {
		const client = createMockClient([
			makeToolCallResponse("read_file", { file_path: "a.ts" }),
			makeTextResponse("Done"),
		]);
		const session = new Session({
			profile: mockProfile,
			client,
			environment: mockEnv,
		});

		const events = collectEvents(session);
		await session.process_input("Read a.ts");

		const kinds = events.map((e) => e.kind);

		expect(kinds).toContain("USER_INPUT");
		expect(kinds).toContain("TOOL_CALL_START");
		expect(kinds).toContain("TOOL_CALL_END");
		expect(kinds).toContain("ASSISTANT_TEXT_START");
		expect(kinds).toContain("ASSISTANT_TEXT_DELTA");
		expect(kinds).toContain("ASSISTANT_TEXT_END");
		expect(kinds).toContain("PROCESSING_END");

		// USER_INPUT should have the correct content
		const userInputEvent = events.find((e) => e.kind === "USER_INPUT");
		expect(userInputEvent!.data).toEqual({ content: "Read a.ts" });
	});

	// 16. Abort signal stops processing
	it("abort signal stops processing", async () => {
		const controller = new AbortController();

		// Abort immediately
		controller.abort();

		const client = createMockClient([makeTextResponse("Should not appear")]);
		const session = new Session({
			profile: mockProfile,
			client,
			environment: mockEnv,
			abort_signal: controller.signal,
		});

		await session.process_input("Hello");

		// The session should be closed due to abort
		expect(session.state).toBe("CLOSED");

		// Client should never have been called because abort check happens
		// at the top of the loop
		expect(client.complete).not.toHaveBeenCalled();

		const eventHistory = session.events.getHistory();
		const endEvents = eventHistory.filter((e) => e.kind === "SESSION_END");
		expect(endEvents).toHaveLength(1);
		expect(endEvents[0]!.data).toEqual({ reason: "aborted" });
	});

	// Additional: getTotalUsage accumulates across turns
	it("getTotalUsage accumulates usage across assistant turns", async () => {
		const client = createMockClient([
			makeToolCallResponse("read_file", { file_path: "a.ts" }),
			makeTextResponse("Done"),
		]);
		const session = new Session({
			profile: mockProfile,
			client,
			environment: mockEnv,
		});

		await session.process_input("Read a.ts");

		const usage = session.getTotalUsage();
		// Two assistant turns, each with 10 input, 5 output, 15 total
		expect(usage.input_tokens).toBe(20);
		expect(usage.output_tokens).toBe(10);
		expect(usage.total_tokens).toBe(30);
	});

	// Additional: LLM client error closes session
	it("LLM client error closes the session", async () => {
		const client = {
			complete: vi.fn().mockRejectedValue(new Error("API rate limited")),
			stream: vi.fn(),
			registerAdapter: vi.fn(),
			use: vi.fn(),
		} as unknown as Client;

		const session = new Session({
			profile: mockProfile,
			client,
			environment: mockEnv,
		});

		const events = collectEvents(session);
		await session.process_input("Hello");

		expect(session.state).toBe("CLOSED");

		const errorEvents = events.filter((e) => e.kind === "ERROR");
		expect(errorEvents).toHaveLength(1);

		const endEvents = events.filter((e) => e.kind === "SESSION_END");
		expect(endEvents).toHaveLength(1);
		expect(endEvents[0]!.data).toEqual({ reason: "error" });
	});
});
