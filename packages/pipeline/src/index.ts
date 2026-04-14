// @klaus/pipeline — DOT-based Pipeline Runner
// Public API barrel export

// Core types
export type {
	GraphAttributes,
	FidelityMode,
	NodeAttributes,
	Node,
	EdgeAttributes,
	Edge,
	Graph,
	Subgraph,
	StageStatus,
	Outcome,
	RetryPolicy,
	Checkpoint,
	QuestionType,
	Option,
	Question,
	AnswerValue,
	Answer,
	Interviewer,
	HandlerContext,
	Handler,
	PipelineContext,
	PipelineEventKind,
	PipelineEvent,
	DiagnosticSeverity,
	Diagnostic,
	Transform,
	StyleRule,
	StyleSelector,
	CodergenBackend,
	PipelineOptions,
} from "./types.js";

export { DEFAULT_RETRY_POLICY } from "./types.js";

// Parser
export { parseDOT } from "./parser.js";

// Context
export { Context } from "./context.js";

// Conditions
export { evaluateCondition, validateCondition } from "./conditions.js";

// Stylesheet
export { parseStylesheet, applyStylesheet } from "./stylesheet.js";

// Validation
export { validate, validateOrThrow } from "./validation.js";

// Transforms
export { VariableExpansionTransform, StylesheetTransform } from "./transforms.js";

// Handlers
export {
	HandlerRegistry,
	shapeToType,
	startHandler,
	exitHandler,
	codergenHandler,
	waitHumanHandler,
	conditionalHandler,
	parallelHandler,
	fanInHandler,
	toolHandler,
	managerLoopHandler,
	extractAcceleratorKey,
	parseDuration,
} from "./handlers.js";

// Fidelity
export { resolveFidelity, buildContextPreamble, findIncomingEdge } from "./fidelity.js";

// Engine
export { PipelineEngine, createAutoApproveInterviewer, QueueInterviewer } from "./engine.js";
