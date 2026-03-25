// @klaus/agent-loop — Coding Agent Loop
// Public API barrel export

// Core types
export type {
	SessionState,
	SessionConfig,
	UserTurn,
	AssistantTurn,
	ToolCallInfo,
	ToolResultInfo,
	ToolResultsTurn,
	SystemTurn,
	SteeringTurn,
	Turn,
	EventKind,
	SessionEvent,
	DirEntry,
	ExecResult,
	ExecutionEnvironment,
	GrepOptions,
	ToolSchema,
	ToolExecutor,
	ProviderProfile,
	SubagentResult,
	SubagentHandle,
	SessionOptions,
} from "./types.js";

export { DEFAULT_SESSION_CONFIG } from "./types.js";

// Session
export { Session } from "./session.js";

// Events
export { EventEmitter } from "./events.js";

// Execution Environment
export { LocalExecutionEnvironment } from "./environment.js";

// Tool Registry
export { ToolRegistry } from "./tools/registry.js";

// Core Tools
export {
	readFileTool,
	writeFileTool,
	editFileTool,
	shellTool,
	grepTool,
	globTool,
	applyPatchTool,
} from "./tools/core.js";

// Provider Profiles
export { createAnthropicProfile } from "./profiles/anthropic.js";
export { createOpenAIProfile } from "./profiles/openai.js";
export { createGeminiProfile } from "./profiles/gemini.js";

// Truncation
export {
	truncateToolOutput,
	truncateChars,
	truncateLines,
	DEFAULT_CHAR_LIMITS,
	DEFAULT_LINE_LIMITS,
	TRUNCATION_MODES,
} from "./truncation.js";

// Loop Detection
export { detectLoop, loopWarningMessage } from "./loop-detection.js";

// Steering
export { MessageQueue } from "./steering.js";
