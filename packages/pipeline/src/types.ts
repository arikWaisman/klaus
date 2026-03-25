// ---------------------------------------------------------------------------
// Graph Model
// ---------------------------------------------------------------------------

export interface GraphAttributes {
	goal?: string;
	label?: string;
	model_stylesheet?: string;
	default_max_retries?: number;
	retry_target?: string;
	default_fidelity?: FidelityMode;
}

export type FidelityMode =
	| "full"
	| "truncate"
	| "compact"
	| "summary:low"
	| "summary:medium"
	| "summary:high";

export interface NodeAttributes {
	label?: string;
	shape?: string;
	type?: string;
	prompt?: string;
	max_retries?: number;
	goal_gate?: boolean;
	fidelity?: FidelityMode;
	thread_id?: string;
	class?: string;
	timeout?: string;
	llm_model?: string;
	llm_provider?: string;
	reasoning_effort?: string;
	auto_status?: boolean;
	allow_partial?: boolean;
	tool_command?: string;
	max_parallel?: number;
}

export interface Node {
	id: string;
	attributes: NodeAttributes;
}

export interface EdgeAttributes {
	label?: string;
	condition?: string;
	weight?: number;
	fidelity?: FidelityMode;
	thread_id?: string;
	loop_restart?: boolean;
}

export interface Edge {
	from: string;
	to: string;
	attributes: EdgeAttributes;
}

export interface Graph {
	name: string;
	attributes: GraphAttributes;
	nodes: Map<string, Node>;
	edges: Edge[];
	subgraphs: Subgraph[];
}

export interface Subgraph {
	name?: string;
	defaults: Record<string, string>;
	node_ids: string[];
}

// ---------------------------------------------------------------------------
// Execution Model
// ---------------------------------------------------------------------------

export type StageStatus = "success" | "fail" | "partial_success" | "retry" | "skipped";

export interface Outcome {
	status: StageStatus;
	preferred_label?: string;
	suggested_next_ids?: string[];
	context_updates?: Record<string, unknown>;
	notes?: string;
	failure_reason?: string;
}

export interface RetryPolicy {
	max_attempts: number;
	initial_delay_ms: number;
	backoff_factor: number;
	max_delay_ms: number;
	jitter: boolean;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
	max_attempts: 1,
	initial_delay_ms: 200,
	backoff_factor: 2.0,
	max_delay_ms: 60_000,
	jitter: true,
};

// ---------------------------------------------------------------------------
// Checkpoint
// ---------------------------------------------------------------------------

export interface Checkpoint {
	timestamp: number;
	current_node: string;
	completed_nodes: string[];
	node_retries: Record<string, number>;
	context_values: Record<string, unknown>;
	logs: string[];
}

// ---------------------------------------------------------------------------
// Interviewer
// ---------------------------------------------------------------------------

export type QuestionType = "YES_NO" | "MULTIPLE_CHOICE" | "FREEFORM" | "CONFIRMATION";

export interface Option {
	key: string;
	label: string;
}

export interface Question {
	text: string;
	type: QuestionType;
	options: Option[];
	default_answer?: Answer;
	timeout_seconds?: number;
	stage: string;
	metadata?: Record<string, unknown>;
}

export type AnswerValue = "YES" | "NO" | "SKIPPED" | "TIMEOUT";

export interface Answer {
	value: string | AnswerValue;
	selected_option?: Option;
	text?: string;
}

export interface Interviewer {
	ask(question: Question): Promise<Answer>;
	ask_multiple?(questions: Question[]): Promise<Answer[]>;
	inform?(message: string, stage: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export interface HandlerContext {
	node: Node;
	context: PipelineContext;
	graph: Graph;
	logs_root: string;
	interviewer: Interviewer;
}

export type Handler = (ctx: HandlerContext) => Promise<Outcome>;

// ---------------------------------------------------------------------------
// Context interface (implemented in context.ts)
// ---------------------------------------------------------------------------

export interface PipelineContext {
	get(key: string): unknown;
	set(key: string, value: unknown): void;
	getAll(): Record<string, unknown>;
	merge(updates: Record<string, unknown>): void;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type PipelineEventKind =
	| "PipelineStarted"
	| "PipelineCompleted"
	| "PipelineFailed"
	| "StageStarted"
	| "StageCompleted"
	| "StageFailed"
	| "StageRetrying"
	| "ParallelStarted"
	| "ParallelBranchStarted"
	| "ParallelBranchCompleted"
	| "ParallelCompleted"
	| "InterviewStarted"
	| "InterviewCompleted"
	| "InterviewTimeout"
	| "CheckpointSaved";

export interface PipelineEvent {
	kind: PipelineEventKind;
	timestamp: number;
	data: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Diagnostic (validation)
// ---------------------------------------------------------------------------

export type DiagnosticSeverity = "error" | "warning";

export interface Diagnostic {
	severity: DiagnosticSeverity;
	message: string;
	node_id?: string;
}

// ---------------------------------------------------------------------------
// Transform
// ---------------------------------------------------------------------------

export interface Transform {
	apply(graph: Graph): Graph;
}

// ---------------------------------------------------------------------------
// Stylesheet
// ---------------------------------------------------------------------------

export interface StyleRule {
	selector: StyleSelector;
	declarations: Record<string, string>;
}

export interface StyleSelector {
	type: "universal" | "shape" | "class" | "id";
	value: string;
	specificity: number;
}

// ---------------------------------------------------------------------------
// CodergenBackend
// ---------------------------------------------------------------------------

export interface CodergenBackend {
	run(node: Node, prompt: string, context: PipelineContext): Promise<string | Outcome>;
}

// ---------------------------------------------------------------------------
// Pipeline Runner Options
// ---------------------------------------------------------------------------

export interface PipelineOptions {
	dot: string;
	backend: CodergenBackend;
	interviewer?: Interviewer;
	logs_root?: string;
	transforms?: Transform[];
	custom_handlers?: Record<string, Handler>;
	checkpoint?: Checkpoint;
	on_event?: (event: PipelineEvent) => void;
}
