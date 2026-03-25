import type { Client, Request, Response, Tool, Usage } from "@klaus/llm-client";

// ---------------------------------------------------------------------------
// Session State
// ---------------------------------------------------------------------------

export type SessionState = "IDLE" | "PROCESSING" | "AWAITING_INPUT" | "CLOSED";

// ---------------------------------------------------------------------------
// Session Config
// ---------------------------------------------------------------------------

export interface SessionConfig {
	max_turns: number;
	max_tool_rounds_per_input: number;
	default_command_timeout_ms: number;
	max_command_timeout_ms: number;
	reasoning_effort: "low" | "medium" | "high" | null;
	tool_output_limits: Record<string, number>;
	tool_line_limits: Record<string, number>;
	enable_loop_detection: boolean;
	loop_detection_window: number;
	max_subagent_depth: number;
}

export const DEFAULT_SESSION_CONFIG: SessionConfig = {
	max_turns: 0,
	max_tool_rounds_per_input: 0,
	default_command_timeout_ms: 10_000,
	max_command_timeout_ms: 600_000,
	reasoning_effort: null,
	tool_output_limits: {},
	tool_line_limits: {},
	enable_loop_detection: true,
	loop_detection_window: 10,
	max_subagent_depth: 1,
};

// ---------------------------------------------------------------------------
// Turns
// ---------------------------------------------------------------------------

export interface UserTurn {
	kind: "user";
	content: string;
	timestamp: number;
}

export interface AssistantTurn {
	kind: "assistant";
	content: string;
	tool_calls: ToolCallInfo[];
	reasoning?: string;
	usage?: Usage;
	response_id?: string;
	timestamp: number;
}

export interface ToolCallInfo {
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

export interface ToolResultInfo {
	tool_call_id: string;
	name: string;
	output: string;
	is_error: boolean;
}

export interface ToolResultsTurn {
	kind: "tool_results";
	results: ToolResultInfo[];
	timestamp: number;
}

export interface SystemTurn {
	kind: "system";
	content: string;
	timestamp: number;
}

export interface SteeringTurn {
	kind: "steering";
	content: string;
	timestamp: number;
}

export type Turn = UserTurn | AssistantTurn | ToolResultsTurn | SystemTurn | SteeringTurn;

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type EventKind =
	| "SESSION_START"
	| "SESSION_END"
	| "USER_INPUT"
	| "PROCESSING_END"
	| "ASSISTANT_TEXT_START"
	| "ASSISTANT_TEXT_DELTA"
	| "ASSISTANT_TEXT_END"
	| "TOOL_CALL_START"
	| "TOOL_CALL_OUTPUT_DELTA"
	| "TOOL_CALL_END"
	| "STEERING_INJECTED"
	| "TURN_LIMIT"
	| "LOOP_DETECTION"
	| "WARNING"
	| "ERROR";

export interface SessionEvent {
	kind: EventKind;
	session_id: string;
	timestamp: number;
	data?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Execution Environment
// ---------------------------------------------------------------------------

export interface DirEntry {
	name: string;
	is_directory: boolean;
	size?: number;
	modified?: number;
}

export interface ExecResult {
	stdout: string;
	stderr: string;
	exit_code: number;
	timed_out: boolean;
	duration_ms: number;
}

export interface ExecutionEnvironment {
	read_file(path: string, offset?: number, limit?: number): Promise<string>;
	write_file(path: string, content: string): Promise<void>;
	file_exists(path: string): Promise<boolean>;
	list_directory(path: string, depth?: number): Promise<DirEntry[]>;
	exec_command(
		command: string,
		timeout_ms: number,
		working_dir?: string,
		env_vars?: Record<string, string>,
	): Promise<ExecResult>;
	grep(pattern: string, path: string, options?: GrepOptions): Promise<string>;
	glob(pattern: string, path?: string): Promise<string[]>;
	initialize(): Promise<void>;
	cleanup(): Promise<void>;
	working_directory(): string;
	platform(): string;
	os_version(): string;
}

export interface GrepOptions {
	recursive?: boolean;
	case_insensitive?: boolean;
	glob_filter?: string;
	max_results?: number;
}

// ---------------------------------------------------------------------------
// Tool Registry
// ---------------------------------------------------------------------------

export interface ToolSchema {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
}

export interface ToolExecutor {
	schema: ToolSchema;
	execute(
		args: Record<string, unknown>,
		env: ExecutionEnvironment,
		config: SessionConfig,
	): Promise<string>;
}

// ---------------------------------------------------------------------------
// Provider Profile
// ---------------------------------------------------------------------------

export interface ProviderProfile {
	id: string;
	provider: "anthropic" | "openai" | "gemini";
	model: string;
	tool_executors: Map<string, ToolExecutor>;
	build_system_prompt(env: ExecutionEnvironment, project_docs: string): string;
	tools(): ToolSchema[];
	provider_options(): Record<string, unknown> | null;
	supports_reasoning: boolean;
	supports_streaming: boolean;
	supports_parallel_tool_calls: boolean;
	context_window_size: number;
}

// ---------------------------------------------------------------------------
// Subagent
// ---------------------------------------------------------------------------

export interface SubagentResult {
	output: string;
	success: boolean;
	turns_used: number;
}

export interface SubagentHandle {
	id: string;
	task: string;
	state: SessionState;
}

// ---------------------------------------------------------------------------
// Session Options (constructor)
// ---------------------------------------------------------------------------

export interface SessionOptions {
	profile: ProviderProfile;
	client: Client;
	environment: ExecutionEnvironment;
	config?: Partial<SessionConfig>;
	custom_instructions?: string;
	abort_signal?: AbortSignal;
}
