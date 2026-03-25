# Klaus — A TypeScript Implementation of Attractor

Klaus is a full-platform implementation of the [Attractor](https://github.com/strongdm/attractor) software factory system. It provides both a **DOT-based pipeline runner** for orchestrating multi-stage AI workflows and a **programmable coding agent loop** for autonomous code generation — all backed by a **unified LLM client** supporting Anthropic, OpenAI, and Gemini.

## Upstream Specifications

Klaus implements three NLSpecs from the Attractor project. These are the source of truth for behavior:

1. **[Unified LLM Client Spec](https://github.com/strongdm/attractor/blob/main/unified-llm-spec.md)** — Provider-agnostic LLM client library
2. **[Coding Agent Loop Spec](https://github.com/strongdm/attractor/blob/main/coding-agent-loop-spec.md)** — Programmable agentic loop with provider-aligned toolsets
3. **[Attractor Spec](https://github.com/strongdm/attractor/blob/main/attractor-spec.md)** — DOT-based pipeline runner for AI workflow orchestration

Each spec includes a comprehensive Definition of Done. An implementation phase is complete when every item in the relevant spec's DoD is checked off.

---

## Tech Stack

| Concern | Choice | Rationale |
|---------|--------|-----------|
| Language | TypeScript (strict mode) | Strong typing, rich async/await, large ecosystem |
| Runtime | Node.js >= 22 | Native fetch, stable async iterators, test runner |
| Package manager | pnpm | Fast, disk-efficient, workspace support |
| Monorepo structure | pnpm workspaces | Three packages map 1:1 to the three specs |
| Build | tsup | Fast, zero-config ESM + CJS bundling |
| Test | Vitest | Fast, native TypeScript, good mocking |
| Lint/Format | Biome | Single tool for lint + format, fast |
| HTTP client | Native fetch | No deps, streaming support via ReadableStream |
| DOT parsing | ts-graphviz or custom | Parse Graphviz DOT syntax for pipeline definitions |
| Schema validation | Zod | Runtime validation of tool args, configs, LLM responses |
| CLI (optional) | Commander + ink | For optional CLI wrapper over the library |

---

## Repository Structure

```
klaus/
├── packages/
│   ├── llm-client/           # Phase 1: Unified LLM Client
│   │   ├── src/
│   │   │   ├── client.ts             # Core Client class (complete, stream)
│   │   │   ├── types.ts              # Request, Response, Message, ContentPart, etc.
│   │   │   ├── adapters/
│   │   │   │   ├── adapter.ts        # ProviderAdapter interface
│   │   │   │   ├── anthropic.ts      # Anthropic Messages API adapter
│   │   │   │   ├── openai.ts         # OpenAI Responses API adapter
│   │   │   │   └── gemini.ts         # Gemini native API adapter
│   │   │   ├── middleware.ts          # Middleware/interceptor pattern
│   │   │   ├── generate.ts           # High-level generate(), stream(), generate_object()
│   │   │   ├── retry.ts              # Retry policy with exponential backoff + jitter
│   │   │   ├── errors.ts             # Error taxonomy (SDKError tree)
│   │   │   ├── catalog.ts            # Model catalog (known models + metadata)
│   │   │   └── index.ts
│   │   ├── tests/
│   │   └── package.json
│   │
│   ├── agent-loop/            # Phase 2: Coding Agent Loop
│   │   ├── src/
│   │   │   ├── session.ts             # Session orchestrator
│   │   │   ├── loop.ts               # Core agentic loop (process_input)
│   │   │   ├── profiles/
│   │   │   │   ├── profile.ts         # ProviderProfile interface
│   │   │   │   ├── anthropic.ts       # Claude Code-aligned profile
│   │   │   │   ├── openai.ts          # codex-rs-aligned profile
│   │   │   │   └── gemini.ts          # gemini-cli-aligned profile
│   │   │   ├── tools/
│   │   │   │   ├── registry.ts        # ToolRegistry
│   │   │   │   ├── read-file.ts
│   │   │   │   ├── write-file.ts
│   │   │   │   ├── edit-file.ts
│   │   │   │   ├── shell.ts
│   │   │   │   ├── grep.ts
│   │   │   │   ├── glob.ts
│   │   │   │   └── apply-patch.ts     # OpenAI v4a format
│   │   │   ├── execution/
│   │   │   │   ├── environment.ts     # ExecutionEnvironment interface
│   │   │   │   └── local.ts           # LocalExecutionEnvironment
│   │   │   ├── truncation.ts          # Output truncation (char + line)
│   │   │   ├── events.ts             # Event system (SessionEvent, EventKind)
│   │   │   ├── steering.ts           # Steering + follow-up queues
│   │   │   ├── subagent.ts           # Subagent spawning and management
│   │   │   ├── system-prompt.ts      # Layered system prompt construction
│   │   │   ├── loop-detection.ts     # Repeating pattern detection
│   │   │   └── index.ts
│   │   ├── tests/
│   │   └── package.json
│   │
│   └── pipeline/              # Phase 3: Attractor Pipeline Runner
│       ├── src/
│       │   ├── parser.ts              # DOT DSL parsing + validation
│       │   ├── engine.ts              # Execution engine (traversal, edge selection)
│       │   ├── handlers/
│       │   │   ├── registry.ts        # Handler registry
│       │   │   ├── start.ts
│       │   │   ├── exit.ts
│       │   │   ├── codergen.ts        # LLM code generation handler
│       │   │   ├── human.ts           # wait.human handler
│       │   │   ├── conditional.ts
│       │   │   ├── parallel.ts        # Parallel fan-out
│       │   │   ├── fan-in.ts
│       │   │   ├── tool.ts
│       │   │   └── manager-loop.ts
│       │   ├── context.ts             # Shared key-value context
│       │   ├── checkpoint.ts          # Serializable checkpoint/resume
│       │   ├── interviewer.ts         # Human-in-the-loop abstraction
│       │   ├── conditions.ts          # Condition expression language
│       │   ├── stylesheet.ts          # Model stylesheet for LLM config
│       │   ├── transforms.ts          # Post-parse graph transforms
│       │   ├── observability.ts       # Event streams + hooks
│       │   ├── server.ts              # Optional HTTP server mode
│       │   └── index.ts
│       ├── tests/
│       └── package.json
│
├── pnpm-workspace.yaml
├── tsconfig.json               # Shared base config
├── biome.json
├── vitest.config.ts
└── SEED.md
```

---

## Implementation Phases

### Phase 1: Unified LLM Client (`@klaus/llm-client`)

**Goal:** A provider-agnostic TypeScript library that can call Anthropic, OpenAI, and Gemini models with a unified interface. This is the foundation everything else builds on.

**Spec:** [unified-llm-spec.md](https://github.com/strongdm/attractor/blob/main/unified-llm-spec.md)

#### 1.1 — Core Types and Data Model

Define all shared types that the rest of the system depends on:

- `Message`, `Role`, `ContentPart`, `ContentKind`
- `Request`, `Response`, `FinishReason`, `Usage`
- `Tool`, `ToolDefinition`, `ToolCall`, `ToolResult`, `ToolChoice`
- `StreamEvent`, `StreamEventType`
- `ImageData`, `AudioData`, `DocumentData`, `ThinkingData`
- `SDKError` hierarchy: `ProviderError`, `AuthenticationError`, `RateLimitError`, `ServerError`, `InvalidRequestError`, `ContextLengthError`, etc.
- `RetryPolicy`, `RateLimitInfo`, `Warning`
- `ResponseFormat`, `GenerateResult`, `StepResult`, `StreamResult`

Use Zod schemas for runtime validation where appropriate. Export both types and runtime validators.

#### 1.2 — Provider Adapters

Implement the `ProviderAdapter` interface for each provider. Each adapter MUST use the provider's native, preferred API:

- **Anthropic adapter** — Messages API. Handle strict message alternation, `tool_result` blocks in user messages, thinking block round-tripping, `max_tokens` requirement, `anthropic-beta` header passthrough, prompt caching with `cache_control` breakpoints.
- **OpenAI adapter** — Responses API (NOT Chat Completions). Handle `instructions` for system messages, `input` array format, `function_call_output` for tool results, reasoning token reporting via `output_tokens_details`, server-side state.
- **Gemini adapter** — Native Gemini API. Handle `systemInstruction`, `model` role for assistant, `functionResponse` for tool results, synthetic tool call ID generation/mapping, `thinkingConfig`, safety settings.

Each adapter implements:
- `complete(request: Request): Promise<Response>` — non-streaming
- `stream(request: Request): AsyncIterableIterator<StreamEvent>` — streaming via SSE parsing
- Request translation (SDK types to provider-native format)
- Response translation (provider-native to SDK types)
- Error translation (HTTP status codes to typed errors)
- Streaming event translation (provider SSE to unified `StreamEvent`)

#### 1.3 — Client, Middleware, and Routing

- `Client` class that routes requests to the correct adapter based on `request.provider` or model name inference
- Middleware/interceptor chain (onion model) for logging, caching, cost tracking
- Adapter registration (programmatic + environment-based auto-discovery via `*_API_KEY` env vars)
- Model catalog with `ModelInfo` records for known models (context window, costs, capabilities)

#### 1.4 — Retry and Error Handling

- `RetryPolicy` with exponential backoff + jitter
- Retryability classification: 429/5xx are retryable; 400/401/403/404 are not
- `Retry-After` header respect
- Retry applies at the high-level `generate()` layer, NOT at `Client.complete()`/`stream()`

#### 1.5 — High-Level API

- `generate()` — wraps `complete()` with tool execution loop, retries, prompt normalization
- `stream()` (high-level) — streaming equivalent with `StreamResult`
- `generate_object()` — structured output with schema validation (JSON mode per provider)
- `stream_object()` — streaming structured output with partial object updates
- `StreamAccumulator` utility for collecting stream into complete `Response`
- Tool execution loop: active tools auto-execute up to `max_tool_rounds`
- Parallel tool execution: when model returns multiple calls, execute concurrently
- Abort signal support via `AbortController`

#### Phase 1 Definition of Done

Per the spec's DoD plus:
- [ ] All types defined and exported
- [ ] Anthropic adapter passes: simple text, tool use, streaming, thinking blocks, prompt caching headers
- [ ] OpenAI adapter passes: simple text, tool use, streaming, reasoning tokens, Responses API format
- [ ] Gemini adapter passes: simple text, tool use, streaming, synthetic tool IDs, safety settings
- [ ] Client routes to correct adapter
- [ ] Middleware chain works (at least a logging middleware as proof)
- [ ] `generate()` with tool loop works across all three providers
- [ ] `stream()` high-level works with `StreamResult` and `text_stream`
- [ ] `generate_object()` produces validated structured output
- [ ] Retry logic: retries on 429/5xx, no retry on 400/401
- [ ] Error taxonomy: correct error types thrown for each HTTP status
- [ ] Usage tracking: input/output/reasoning/cache tokens reported correctly
- [ ] Model catalog returns info for current models
- [ ] Unit tests for each adapter (mock HTTP), integration test with real API keys

---

### Phase 2: Coding Agent Loop (`@klaus/agent-loop`)

**Goal:** A programmable agentic loop library that a host application controls at every step. NOT a CLI — a library. The host submits input, observes events, steers mid-task, and composes agents.

**Spec:** [coding-agent-loop-spec.md](https://github.com/strongdm/attractor/blob/main/coding-agent-loop-spec.md)

**Depends on:** `@klaus/llm-client`

#### 2.1 — Session and Core Loop

- `Session` record: id, provider profile, execution env, history, event emitter, config, state, LLM client, steering queue, follow-up queue, subagents map
- `SessionConfig`: max_turns, max_tool_rounds_per_input, default_command_timeout_ms (10s), max_command_timeout_ms (10min), reasoning_effort, tool_output_limits, tool_line_limits, loop detection settings, max_subagent_depth
- `SessionState` enum: IDLE, PROCESSING, AWAITING_INPUT, CLOSED
- Turn types: `UserTurn`, `AssistantTurn`, `ToolResultsTurn`, `SystemTurn`, `SteeringTurn`
- `process_input()` — the core agentic loop as specified: check limits, build request, call LLM via `Client.complete()` (NOT `generate()`), record assistant turn, if no tool calls break, execute tools, drain steering, check loop detection, repeat
- Stop conditions: natural completion, round limit, turn limit, abort signal, unrecoverable error

#### 2.2 — Provider Profiles

Each profile provides provider-aligned tools and system prompts. Start from the provider's native agent's tools and prompt structure:

- **Anthropic profile (Claude Code-aligned):**
  - Tools: `read_file`, `write_file`, `edit_file` (old_string/new_string), `shell` (120s default timeout), `grep`, `glob`
  - System prompt mirrors Claude Code structure
  - Loads `AGENTS.md` + `CLAUDE.md` for project docs

- **OpenAI profile (codex-rs-aligned):**
  - Tools: `read_file`, `apply_patch` (v4a format), `write_file`, `shell` (10s default timeout), `grep`, `glob`
  - System prompt mirrors codex-rs structure
  - Loads `AGENTS.md` + `.codex/instructions.md` for project docs

- **Gemini profile (gemini-cli-aligned):**
  - Tools: `read_file`, `read_many_files`, `write_file`, `edit_file`, `shell` (10s default timeout), `grep`, `glob`, `list_dir`, optional `web_search`/`web_fetch`
  - System prompt mirrors gemini-cli structure
  - Loads `AGENTS.md` + `GEMINI.md` for project docs

Custom tools can be registered on top of any profile. Name collisions: latest-wins.

#### 2.3 — Tool Implementation

Implement all shared core tools:

- **read_file** — line-numbered output (`NNN | content`), offset/limit support, image support for multimodal
- **write_file** — create file + parent dirs, return bytes written
- **edit_file** — exact string match replace, optional `replace_all`, fuzzy matching fallback
- **shell** — spawn in process group, enforce timeout (SIGTERM, wait 2s, SIGKILL), capture stdout/stderr, env var filtering (exclude `*_API_KEY`, `*_SECRET`, `*_TOKEN`, `*_PASSWORD`)
- **grep** — ripgrep-backed, regex, glob filter, case sensitivity, max results
- **glob** — file pattern matching, sorted by mtime (newest first)
- **apply_patch** — v4a format parser (Add/Delete/Update/Rename files, multi-hunk, context-based matching, fuzzy fallback)

Each tool executes through the `ExecutionEnvironment` abstraction, not directly on the filesystem.

#### 2.4 — Execution Environment

- `ExecutionEnvironment` interface: `read_file`, `write_file`, `file_exists`, `list_directory`, `exec_command`, `grep`, `glob`, `initialize`, `cleanup`, `working_directory`, `platform`, `os_version`
- `LocalExecutionEnvironment` — the required default implementation
  - File ops: direct filesystem, paths relative to working_directory
  - Command exec: new process group, platform shell (`/bin/bash -c` on macOS/Linux), timeout enforcement, stdout/stderr capture
  - Env var filtering: exclude sensitive patterns by default, always include PATH/HOME/USER/SHELL/LANG/TERM + language paths
- The interface is designed so consumers can implement Docker, K8s, SSH, WASM environments later

#### 2.5 — Output Truncation

Two-pass truncation on every tool output:

1. **Character-based (always first):** head/tail split with explicit warning marker. Defaults: read_file 50k, shell 30k, grep 20k, glob 20k, edit_file 10k, apply_patch 10k, write_file 1k, spawn_agent 20k
2. **Line-based (second pass):** head/tail split by lines. Defaults: shell 256, grep 200, glob 500

Full untruncated output always available via the `TOOL_CALL_END` event. The truncation marker explicitly tells the model what happened and how much was removed.

#### 2.6 — Events, Steering, and Loop Detection

- **Event system:** All `EventKind` values emitted at correct times via async iterator. `TOOL_CALL_END` carries full untruncated output.
- **Steering:** `session.steer(msg)` injects between tool rounds. `session.follow_up(msg)` queues for after current input completes. SteeringTurns become user-role messages for the LLM.
- **Loop detection:** Track tool call signatures (name + args hash). If last N calls (default 10) show repeating patterns of length 1, 2, or 3, inject warning SteeringTurn.

#### 2.7 — System Prompts

Layered construction (later = higher priority):
1. Provider-specific base instructions (from profile)
2. Environment context block (platform, git, working dir, date, model)
3. Tool descriptions (from active profile)
4. Project docs (AGENTS.md + provider-specific files, discovered by walking git root to cwd, 32KB budget)
5. User instruction overrides

#### 2.8 — Subagents

- `spawn_agent` tool: create child session with scoped task, optional working_dir/model/max_turns override
- `send_input`, `wait`, `close_agent` tools
- Subagents share parent's execution environment but have independent history
- Depth limiting: default max depth 1 (no sub-sub-agents)

#### Phase 2 Definition of Done

Per the spec's full DoD (Sections 9.1-9.12) plus:
- [ ] Session lifecycle works: IDLE to PROCESSING to IDLE, abort to CLOSED
- [ ] Core agentic loop: LLM call, tool exec, loop, natural completion
- [ ] All three provider profiles produce correct tool definitions and system prompts
- [ ] All shared core tools work through LocalExecutionEnvironment
- [ ] apply_patch v4a parser handles Add/Delete/Update/Rename + multi-hunk
- [ ] Shell timeout: SIGTERM, wait 2s, SIGKILL
- [ ] Env var filtering excludes sensitive vars
- [ ] Output truncation: char-first, then line, with explicit markers
- [ ] Event stream delivers all EventKind values
- [ ] Steering and follow-up injection works mid-task
- [ ] Loop detection triggers warning after repeating patterns
- [ ] Subagent spawn/wait/close lifecycle works
- [ ] System prompt layers compose correctly with project doc discovery
- [ ] Cross-provider parity matrix passes (all 15 test cases x 3 providers)
- [ ] Integration smoke test (Section 9.13 of coding-agent-loop-spec) passes for all providers

---

### Phase 3: Pipeline Runner (`@klaus/pipeline`)

**Goal:** A DOT-based pipeline runner that orchestrates multi-stage AI workflows. Nodes represent tasks, edges define transitions, handlers execute the work.

**Spec:** [attractor-spec.md](https://github.com/strongdm/attractor/blob/main/attractor-spec.md)

**Depends on:** `@klaus/llm-client`, `@klaus/agent-loop`

#### 3.1 — DOT Parser and Validator

- Parse Graphviz DOT `digraph` syntax into an internal graph representation
- Extract node attributes (shape, handler type, label, goal gate, retry config, etc.)
- Extract edge attributes (conditions, labels, weights, suggested IDs)
- Subgraph scoping for defaults and stylesheet classes
- Validation / lint rules:
  - Exactly one start node (Mdiamond shape) and one exit node
  - All nodes reachable from start
  - All edges reference valid nodes
  - Conditions use valid syntax
  - Handler types are registered in the registry

Use ts-graphviz for DOT parsing if it handles the attribute schema well; otherwise implement a focused parser for the subset of DOT that Attractor uses.

#### 3.2 — Execution Engine

- Single-threaded graph traversal starting from the start node
- Execute the handler registered for each node's type
- Edge selection with 5-step priority: condition, label, suggested IDs, weight, lexical
- Goal gates: enforce that critical nodes have succeeded before allowing exit
- Retry logic per-node (configurable attempts, backoff)
- Fidelity modes controlling LLM session reuse and context carryover between nodes

#### 3.3 — Built-in Handlers

Implement all handlers defined in the spec:

- **start** — entry point, initializes context
- **exit** — checks goal gates, terminates pipeline
- **codergen** — LLM code generation (uses `@klaus/agent-loop` Session for the actual agentic work)
- **wait.human** — blocks for human input via the Interviewer abstraction
- **conditional** — evaluates condition expression, routes to matching edge
- **parallel** — fan-out to multiple nodes concurrently
- **fan-in** — wait for parallel branches to complete, merge results
- **tool** — execute a specific tool/command
- **manager_loop** — iterative refinement loop with a managing LLM

Handler registry is pluggable: custom handlers can be registered by consumers.

#### 3.4 — Context and State

- **Context** — shared key-value store accessible to all handlers during execution. Handlers read inputs and write outputs.
- **Checkpoint** — serializable snapshot of execution state (current node, context, handler states). Enables pause/resume of long-running pipelines.
- **Artifacts** — large outputs stored separately from context (generated code, test results, etc.)

#### 3.5 — Human-in-the-Loop (Interviewer)

- `Interviewer` interface abstraction for human interaction
- Implementations: CLI (stdin/stdout), callback-based, queue-based (for web UIs)
- Timeout + default handling for when humans don't respond
- Used by `wait.human` handler and optionally by `codergen` for review gates

#### 3.6 — Condition Expressions

- Expression language for edge routing (variable references, comparisons, logical operators)
- Evaluate against the current Context
- Used by conditional handler and edge selection

#### 3.7 — Model Stylesheet

- Centralized LLM configuration per pipeline
- Maps node groups/classes to model settings (provider, model, temperature, reasoning effort)
- Applied via subgraph scoping or node attributes

#### 3.8 — Transforms and Observability

- **Transforms** — functions that modify the parsed graph before execution (macro expansion, validation injection, etc.)
- **Observability** — event stream for pipeline-level events (node start/end, edge taken, handler output, checkpoint created, errors)
- Optional HTTP server mode for web-based pipeline monitoring and human interaction

#### Phase 3 Definition of Done

Per the attractor spec's full DoD (Section 11) plus:
- [ ] DOT files parse into valid internal graph representation
- [ ] Lint rules catch all specified invalid graph patterns
- [ ] Execution engine traverses from start to exit correctly
- [ ] Edge selection follows 5-step priority
- [ ] All built-in handlers work (start, exit, codergen, wait.human, conditional, parallel, fan-in, tool, manager_loop)
- [ ] codergen handler uses `@klaus/agent-loop` Session for LLM work
- [ ] Goal gates prevent premature exit
- [ ] Retry logic works per-node with configurable backoff
- [ ] Context is shared across handlers within a pipeline run
- [ ] Checkpoint serialization enables pause/resume
- [ ] Interviewer abstraction works for CLI interaction
- [ ] Condition expressions evaluate correctly against context
- [ ] Model stylesheet applies per-node LLM configuration
- [ ] Transforms can modify graphs post-parse
- [ ] Event stream emits pipeline-level observability events
- [ ] Custom handlers can be registered and invoked
- [ ] End-to-end smoke test: a DOT pipeline that reads code, generates edits with codergen, runs tests, and gates on human approval

---

## Design Decisions

These decisions are made upfront to avoid ambiguity during implementation:

1. **ESM-first.** Publish as ESM with CJS compatibility via tsup dual output. All internal imports use `.js` extensions.

2. **No classes for data.** Use plain objects + TypeScript interfaces for data records (Message, Request, Response, etc.). Use classes only for stateful things (Client, Session, ProviderAdapter implementations).

3. **Zod at boundaries.** Validate with Zod at system boundaries (API responses, tool arguments, config files). Internal code trusts its own types.

4. **Real provider APIs.** Anthropic uses Messages API. OpenAI uses Responses API. Gemini uses native API. No compatibility layers, no lowest-common-denominator abstractions.

5. **AsyncIterator for events and streams.** Use `AsyncIterableIterator<T>` as the standard streaming primitive. This is the native async iteration protocol in JS/TS.

6. **Process groups for shell.** Always spawn commands in a new process group so SIGTERM/SIGKILL can clean up the entire tree.

7. **Character truncation first.** Always truncate by character count before line count. A 2-line file where each line is 10MB must be caught by character truncation.

8. **No automatic context compaction.** Emit warnings at 80% context usage. Leave compaction strategy to the host application.

9. **Test with real APIs.** Unit tests use mocked HTTP. Integration tests call real provider APIs (gated behind env vars). Both are required for the DoD.

10. **Monorepo with clear dependency direction.** `llm-client` has zero internal deps. `agent-loop` depends on `llm-client`. `pipeline` depends on both. No circular dependencies.

---

## Getting Started

To begin implementation, a coding agent should:

1. Initialize the monorepo: `pnpm init`, workspace config, shared tsconfig, biome config, vitest config
2. Create the three package directories with their own `package.json` files
3. Start with Phase 1 (`@klaus/llm-client`) — define types first, then build one adapter at a time
4. After each phase, run the Definition of Done checklist before moving to the next
5. Consult the upstream specs (linked above) for detailed behavioral requirements — this SEED.md provides architecture and tech decisions, the specs provide behavioral truth
