# Sprint 001: Klaus Phase 1 — Unified LLM Client (`@klaus/llm-client`)

## Overview

This sprint bootstraps the Klaus monorepo and delivers `@klaus/llm-client`, a provider-agnostic TypeScript library for calling Anthropic, OpenAI, and Gemini models through a unified interface. It is the foundational package upon which the agent loop (Phase 2) and pipeline runner (Phase 3) will be built.

The core value proposition: application code writes provider-agnostic calls while each adapter speaks the provider's native protocol — Anthropic Messages API, OpenAI Responses API, and Gemini GenerateContent API. This avoids lowest-common-denominator abstractions that lose access to reasoning tokens, extended thinking, prompt caching, and advanced tool features.

The implementation follows the [Attractor Unified LLM Client Spec](https://github.com/strongdm/attractor/blob/main/unified-llm-spec.md) as the behavioral source of truth, and [SEED.md](../../SEED.md) for architecture and tech stack decisions.

## Use Cases

1. **Simple text completion**: Send a prompt to any provider and get a unified `Response` with text, usage, and finish reason.
2. **Multi-turn conversation**: Send message history with provider-specific format handling (Anthropic alternation, OpenAI input arrays, Gemini role mapping).
3. **Tool-augmented generation**: Define tools, have the model call them, and auto-execute via the `generate()` loop with concurrent execution.
4. **Streaming responses**: Get incremental text, reasoning, and tool call deltas via `AsyncIterableIterator<StreamEvent>`.
5. **Structured output**: Extract typed objects from LLM responses with Zod schema validation via `generate_object()`.
6. **Streaming structured output**: Get partial object updates as they stream in via `stream_object()`.
7. **Cost tracking**: Track input/output/reasoning/cache tokens across all providers.
8. **Error recovery**: Auto-retry transient failures (429, 5xx) with exponential backoff; immediately surface permanent errors (401, 403).
9. **Middleware composition**: Add logging, caching, or cost tracking as composable middleware without modifying core logic.

## Architecture

### Four-Layer Design

```
┌─────────────────────────────────────────────────┐
│  Layer 4: High-Level API                         │
│  generate() │ stream() │ generate_object()       │
│  stream_object() │ Tool loop │ Retry             │
├─────────────────────────────────────────────────┤
│  Layer 3: Core Client + Middleware               │
│  Client class │ Provider routing │ Middleware     │
├─────────────────────────────────────────────────┤
│  Layer 2: Provider Utilities                     │
│  SSE parser │ HTTP helpers │ Error mapping        │
├─────────────────────────────────────────────────┤
│  Layer 1: Provider Adapters                      │
│  AnthropicAdapter │ OpenAIAdapter │ GeminiAdapter │
│  (ProviderAdapter interface)                     │
└─────────────────────────────────────────────────┘
```

### Data Flow

1. Caller constructs a `Request` with unified types
2. High-level API normalizes the request (prompt → messages, system extraction)
3. Middleware chain processes the request (onion model: M1 → M2 → adapter → M2 → M1)
4. Client routes to the correct adapter (via explicit `provider`, model-name inference, or `default_provider`)
5. Adapter translates to provider-native format and calls the API via native `fetch()`
6. Adapter translates the response back to unified types
7. Middleware chain processes the response (reverse order)
8. High-level API handles tool execution loop, retries, and schema validation

### Key Design Decisions

- **No HTTP client dependency**: Native `fetch()` (Node 22+). Custom SSE parser (~50 lines).
- **Adapters own translation entirely**: Each adapter converts request and response independently.
- **Tool execution is concurrent**: Multiple tool calls run via `Promise.all()` with per-tool error handling.
- **`kind` discriminant on ContentPart**: Avoids collision with TypeScript `type` keyword.
- **Zod with `.passthrough()`**: Validate structure at boundaries but don't break on unknown fields from provider API additions.

---

## Implementation

### Step 1: Monorepo Scaffold (~10% of effort)

**Goal:** Set up the pnpm monorepo with all configuration before writing any library code.

**Files:**
- `package.json` — Root workspace package
- `pnpm-workspace.yaml` — `packages/*` workspace definition
- `tsconfig.json` — Shared base (strict, ESM, ES2023 target, Node16 module resolution)
- `biome.json` — Lint + format config
- `vitest.config.ts` — Test runner config
- `.gitignore` — Standard Node/TS ignores
- `packages/llm-client/package.json` — Package manifest with `zod` dependency
- `packages/llm-client/tsconfig.json` — Extends root
- `packages/llm-client/tsup.config.ts` — ESM + CJS dual output
- `packages/agent-loop/package.json` — Minimal placeholder
- `packages/pipeline/package.json` — Minimal placeholder

**Tasks:**
- [ ] Initialize git repo
- [ ] Create root `package.json` with workspace scripts (build, test, lint, format)
- [ ] Create `pnpm-workspace.yaml` listing `packages/*`
- [ ] Create shared `tsconfig.json`: `strict: true`, `target: "ES2023"`, `module: "Node16"`, `moduleResolution: "Node16"`, `verbatimModuleSyntax: true`
- [ ] Configure Biome for TypeScript
- [ ] Configure Vitest with TypeScript support
- [ ] Scaffold `packages/llm-client/` with package.json, tsconfig.json, tsup.config.ts
- [ ] Scaffold minimal `packages/agent-loop/package.json` and `packages/pipeline/package.json` (empty placeholders)
- [ ] Add `zod` as runtime dependency for llm-client
- [ ] Verify `pnpm install` and `pnpm build` work end-to-end

---

### Step 2: Core Types, Errors, and Schemas (~15% of effort)

**Goal:** Define every shared type, interface, and error the rest of the package depends on.

**Files:**
- `packages/llm-client/src/types.ts` — All data model types
- `packages/llm-client/src/errors.ts` — SDKError hierarchy
- `packages/llm-client/src/schemas.ts` — Zod schemas for boundary validation

**Core Types (types.ts):**

```ts
export type Role = "system" | "user" | "assistant" | "tool" | "developer";

export type ContentKind = "text" | "image" | "audio" | "document"
  | "tool_call" | "tool_result" | "thinking" | "redacted_thinking";

export interface ContentPart {
  kind: ContentKind;
  text?: string;
  image?: ImageData;
  audio?: AudioData;
  document?: DocumentData;
  tool_call?: ToolCallData;
  tool_result?: ToolResultData;
  thinking?: ThinkingData;
}

export interface Message {
  role: Role;
  content: ContentPart[];
}

export interface Request {
  model: string;
  messages: Message[];
  provider?: string;
  tools?: ToolDefinition[];
  tool_choice?: ToolChoice;
  response_format?: ResponseFormat;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stop_sequences?: string[];
  reasoning_effort?: "low" | "medium" | "high";
  metadata?: Record<string, string>;
  provider_options?: Record<string, unknown>;
}

export interface Response {
  id: string;
  model: string;
  provider: string;
  message: Message;
  finish_reason: FinishReason;
  usage: Usage;
  raw?: Record<string, unknown>;
  warnings: Warning[];
  rate_limit?: RateLimitInfo;
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  reasoning_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
}

export interface FinishReason {
  reason: "stop" | "length" | "tool_calls" | "content_filter" | "error" | "other";
  raw?: string; // Provider's original value
}

export interface ToolDefinition {
  name: string;          // [a-zA-Z][a-zA-Z0-9_]*, max 64
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  raw_arguments?: string; // For malformed JSON recovery
}

export interface ToolChoice {
  mode: "auto" | "none" | "required" | "named";
  tool_name?: string;    // Required when mode is "named"
}

export type ToolExecuteFn = (
  args: Record<string, unknown>,
  context?: { abort_signal?: AbortSignal }
) => Promise<string | Record<string, unknown>>;

export interface Tool extends ToolDefinition {
  execute?: ToolExecuteFn;
}

export type StreamEventType =
  | "STREAM_START" | "TEXT_START" | "TEXT_DELTA" | "TEXT_END"
  | "REASONING_START" | "REASONING_DELTA" | "REASONING_END"
  | "TOOL_CALL_START" | "TOOL_CALL_DELTA" | "TOOL_CALL_END"
  | "FINISH" | "ERROR" | "PROVIDER_EVENT";

export interface StreamEvent {
  type: StreamEventType;
  delta?: string;
  text_id?: string;
  tool_call?: ToolCall;
  finish_reason?: FinishReason;
  usage?: Usage;
  response?: Response;
  error?: Error;
  raw?: Record<string, unknown>;
}

export interface RetryPolicy {
  max_retries: number;        // default: 2
  base_delay: number;         // default: 1.0 (seconds)
  max_delay: number;          // default: 60.0
  backoff_multiplier: number; // default: 2.0
  jitter: boolean;            // default: true
  on_retry?: (error: Error, attempt: number, delay: number) => void;
}

export interface GenerateResult { /* text, reasoning, tool_calls, tool_results, steps, usage, total_usage, response, output? */ }
export interface StepResult { /* text, reasoning, tool_calls, tool_results, finish_reason, usage, response */ }
export interface StreamResult extends AsyncIterable<StreamEvent> {
  response(): Promise<Response>;
  text_stream: AsyncIterableIterator<string>;
}
```

**Error Hierarchy (errors.ts):**

```
SDKError
├── ProviderError (status_code, error_code, retryable, retry_after, raw)
│   ├── AuthenticationError      (401, non-retryable)
│   ├── AccessDeniedError        (403, non-retryable)
│   ├── NotFoundError            (404, non-retryable)
│   ├── InvalidRequestError      (400/422, non-retryable)
│   ├── ContextLengthError       (413, non-retryable)
│   ├── ContentFilterError       (non-retryable)
│   ├── QuotaExceededError       (non-retryable)
│   ├── RateLimitError           (429, retryable)
│   └── ServerError              (500+, retryable)
├── RequestTimeoutError
├── AbortError
├── NetworkError                 (retryable)
├── StreamError                  (retryable)
├── InvalidToolCallError
├── UnsupportedToolChoiceError
├── NoObjectGeneratedError
└── ConfigurationError
```

**Tasks:**
- [ ] Define all types listed above with full field specifications
- [ ] Define convenience functions: `responseText()`, `responseToolCalls()`, `responseReasoning()`
- [ ] Implement complete SDKError class hierarchy
- [ ] Implement `errorFromStatus(provider, status, body, headers)` mapping function
- [ ] Create Zod schemas for provider API response validation (use `.passthrough()` for forward compatibility)
- [ ] Unit tests for type construction, error hierarchy, and error mapping

---

### Step 3: SSE Parser and HTTP Utilities (~10% of effort)

**Goal:** Build shared infrastructure for HTTP calls and SSE stream parsing that all adapters use.

**Files:**
- `packages/llm-client/src/sse.ts` — Custom SSE parser
- `packages/llm-client/src/http.ts` — HTTP request helpers with error mapping

**Tasks:**
- [ ] Implement SSE line parser handling: `data:`, `event:`, `id:`, empty-line event boundaries, multi-line data (concatenated with newline), `[DONE]` sentinel, `:` comment lines
- [ ] Implement `fetchJSON(url, options)`: fetch + JSON parse + HTTP error mapping to typed errors
- [ ] Implement `fetchSSE(url, options)`: fetch with `Accept: text/event-stream`, returns `AsyncIterableIterator<SSEEvent>`
- [ ] Extract rate limit headers (`x-ratelimit-limit`, `x-ratelimit-remaining`, `x-ratelimit-reset`)
- [ ] Parse `Retry-After` header (supports both integer seconds AND HTTP date format)
- [ ] Support `AbortSignal` for request cancellation
- [ ] Ensure `reader.releaseLock()` in finally blocks to prevent resource leaks
- [ ] Unit tests for SSE parser edge cases, HTTP error mapping, rate limit extraction

---

### Step 4: Provider Adapters (~30% of effort)

**Goal:** Implement all three provider adapters with full request/response/streaming/error translation.

**Files:**
- `packages/llm-client/src/adapters/adapter.ts` — ProviderAdapter interface
- `packages/llm-client/src/adapters/anthropic.ts` — Anthropic Messages API
- `packages/llm-client/src/adapters/openai.ts` — OpenAI Responses API
- `packages/llm-client/src/adapters/gemini.ts` — Gemini native API

**ProviderAdapter interface:**
```ts
export interface ProviderAdapter {
  readonly name: string;
  complete(request: Request): Promise<Response>;
  stream(request: Request): AsyncIterableIterator<StreamEvent>;
  close?(): Promise<void>;
  initialize?(): Promise<void>;
  supports_tool_choice?(mode: ToolChoiceMode): boolean;
}
```

#### Anthropic Adapter

**Endpoint:** `POST https://api.anthropic.com/v1/messages`
**Auth:** `x-api-key` header + `anthropic-version: 2023-06-01`

| Quirk | Implementation |
|-------|---------------|
| Strict message alternation | Merge consecutive same-role messages by concatenating content arrays |
| System extraction | System/developer messages → `system` parameter (array of content blocks) |
| `max_tokens` required | Default to 4096 if `request.max_tokens` is undefined |
| Tool results in user messages | `tool_result` content blocks must be in user-role messages |
| Thinking block round-trip | Preserve `signature` field exactly; include thinking blocks in subsequent requests |
| `cache_control` injection | Add `cache_control: { type: "ephemeral" }` to system message and last tool definition |
| Beta headers | `anthropic-beta` header from `provider_options.anthropic.beta_headers` |
| `reasoning_effort` mapping | Map to `thinking.budget_tokens` parameter |
| `tool_choice` mapping | auto→auto, none→omit tools, required→any, named→{type:"tool", name} |
| Streaming SSE events | `message_start`, `content_block_start`, `content_block_delta`, `content_block_stop`, `message_delta`, `message_stop` |
| Usage with caching | Extract `cache_creation_input_tokens` → `cache_write_tokens`, `cache_read_input_tokens` → `cache_read_tokens` |
| Stop reason mapping | `end_turn`→stop, `tool_use`→tool_calls, `max_tokens`→length |
| Overloaded error (529) | Map to ServerError (retryable) |

**Tasks:**
- [ ] Request translation with all quirks above
- [ ] Response translation (content blocks → ContentParts, usage, finish_reason)
- [ ] Streaming with SSE event mapping to unified StreamEvents
- [ ] Error translation (parse Anthropic error body, map to typed errors)
- [ ] Unit tests: text, tools, streaming, thinking blocks, cache headers, errors

#### OpenAI Adapter

**Endpoint:** `POST https://api.openai.com/v1/responses` (NOT Chat Completions)
**Auth:** `Authorization: Bearer <key>`

| Quirk | Implementation |
|-------|---------------|
| Responses API format | System → `instructions`, messages → `input` array |
| `input` item types | `{type: "message", role, content}`, `{type: "function_call"}`, `{type: "function_call_output", call_id, output}` |
| Reasoning tokens | Read from `usage.output_tokens_details.reasoning_tokens` |
| `reasoning_effort` | Map to `reasoning: { effort: "low" \| "medium" \| "high" }` |
| `tool_choice` mapping | auto→auto, none→none, required→required, named→{type:"function", name} |
| Streaming events | `response.output_text.delta`, `response.function_call_arguments.delta`, `response.completed` |
| Status mapping | `completed`→stop, `incomplete`→length, needs_action→tool_calls |
| Automatic caching | Report cache_read_tokens from usage if present |

**Tasks:**
- [ ] Request translation (instructions, input array format)
- [ ] Response translation (output items → ContentParts, usage with reasoning tokens)
- [ ] Streaming with Responses API event format
- [ ] Error translation
- [ ] Unit tests: text, tools, streaming, reasoning tokens, errors

#### Gemini Adapter

**Endpoint:** `POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`
**Streaming:** `:streamGenerateContent?alt=sse`
**Auth:** `?key=<API_KEY>` query parameter (SECURITY: never log URLs containing the key)

| Quirk | Implementation |
|-------|---------------|
| `systemInstruction` field | System messages extracted to top-level, not in `contents` |
| `model` role | Translate `assistant` → `model` in request, `model` → `assistant` in response |
| Synthetic tool call IDs | Generate `call_<crypto.randomUUID()>` for each `functionCall` part |
| `functionResponse` uses name | Map synthetic IDs back to function names when sending results |
| String results wrapped | Wrap string tool results as `{ result: "..." }` dict |
| `?alt=sse` for streaming | Each SSE event is a complete chunk (function calls arrive whole, not as deltas) |
| Safety settings | Pass through via `provider_options.gemini.safety_settings` |
| `tool_choice` mapping | auto→AUTO, none→NONE, required→ANY, named→use `allowedFunctionNames` |
| Thinking config | Map `reasoning_effort` → `thinkingConfig.thinkingBudget` |
| Usage | Extract from `usageMetadata`, `thoughtsTokenCount` → `reasoning_tokens` |
| Zero candidates | Handle empty candidates array (safety filter triggered) → ContentFilterError |

**Tasks:**
- [ ] Request translation with all quirks above
- [ ] Response translation (candidates[0].content.parts → ContentParts, synthetic IDs, usage)
- [ ] Streaming via `?alt=sse`
- [ ] Error translation
- [ ] Unit tests: text, tools, streaming, synthetic IDs, safety settings, zero candidates, errors

---

### Step 5: Client, Routing, and Middleware (~15% of effort)

**Goal:** Client class that routes requests to adapters through a middleware chain.

**Files:**
- `packages/llm-client/src/client.ts` — Core Client class
- `packages/llm-client/src/middleware.ts` — Middleware types and chain execution
- `packages/llm-client/src/catalog.ts` — Model catalog

**Client:**
```ts
export class Client {
  static fromEnv(config?: Partial<ClientConfig>): Client;
  constructor(config: ClientConfig);
  registerAdapter(name: string, adapter: ProviderAdapter): void;
  use(middleware: Middleware): void;
  complete(request: Request): Promise<Response>;
  stream(request: Request): AsyncIterableIterator<StreamEvent>;
}
```

**Routing priority:**
1. `request.provider` (explicit)
2. Model-name inference: `claude-*`/`claude*` → anthropic, `gpt-*`/`o1-*`/`o3-*` → openai, `gemini-*` → gemini
3. `default_provider` from config
4. Throw `ConfigurationError` if none resolved

**Middleware (onion model):**
```ts
export interface Middleware {
  name: string;
  complete?: (request: Request, next: (req: Request) => Promise<Response>) => Promise<Response>;
  stream?: (request: Request, next: (req: Request) => AsyncIterableIterator<StreamEvent>) => AsyncIterableIterator<StreamEvent>;
}
```

**Model Catalog:**
```ts
export interface ModelInfo {
  id: string;
  provider: string;
  display_name: string;
  context_window: number;
  max_output: number;
  supports_tools: boolean;
  supports_vision: boolean;
  supports_reasoning: boolean;
  input_cost_per_million: number;
  output_cost_per_million: number;
  aliases: string[];
}

export function getModelInfo(modelId: string): ModelInfo | undefined;
export function listModels(provider?: string): ModelInfo[];
export function getLatestModel(provider: string, capability?: string): ModelInfo | undefined;
```

Populate with current models: Claude Opus 4.6, Claude Sonnet 4.5, GPT-5.2, GPT-5.2-mini, GPT-5.3-codex, Gemini 3.1 Pro, Gemini 3 Flash.

**Tasks:**
- [ ] Implement Client with routing (explicit → model-name → default → error)
- [ ] Implement `Client.fromEnv()` auto-detecting `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`
- [ ] Implement middleware chain composition (onion model)
- [ ] Implement logging middleware as proof (with URL/header redaction for security)
- [ ] Implement model catalog with lookup functions
- [ ] Unit tests: routing, middleware chain ordering, catalog lookup

---

### Step 6: High-Level API and Retry (~20% of effort)

**Goal:** Convenience functions with tool loops, retries, structured output, and streaming.

**Files:**
- `packages/llm-client/src/generate.ts` — generate(), stream(), generate_object(), stream_object()
- `packages/llm-client/src/retry.ts` — Retry policy with exponential backoff + jitter
- `packages/llm-client/src/accumulator.ts` — StreamAccumulator utility
- `packages/llm-client/src/index.ts` — Public API exports

**Retry:**
- Backoff formula: `delay = MIN(base * multiplier^attempt, max_delay)`
- Jitter: `delay = delay * RANDOM(0.5, 1.5)`
- Retry-After: use provider value if ≤ max_delay (parse both seconds and HTTP date)
- Retryable: RateLimitError, ServerError, NetworkError, StreamError
- Non-retryable: all others
- Retry applies to individual LLM calls within multi-step, not entire operations
- Stream retries only before streaming has begun
- Abort signal stops retry loop

**generate():**
```ts
export async function generate(options: {
  client: Client;
  model: string;
  prompt?: string;
  messages?: Message[];
  system?: string;
  tools?: Tool[];
  tool_choice?: ToolChoice;
  max_tool_rounds?: number; // default: 1
  // ... temperature, max_tokens, reasoning_effort, provider_options, abort_signal
}): Promise<GenerateResult>;
```

Tool execution loop:
1. Normalize input (string prompt → user message, system extraction)
2. Call `client.complete()` with retry
3. If response has tool_calls AND active tools (with execute handlers) AND rounds remaining:
   - Execute all tool calls concurrently: `Promise.allSettled()` with per-tool try/catch
   - Failed tools return `ToolResult` with `is_error: true`
   - Append assistant message (tool_calls) + tool message (results) to history
   - Loop back
4. Return `GenerateResult` with steps, total_usage

**stream():** Same tool loop but yields `StreamEvent`s incrementally. Returns `StreamResult`.

**generate_object():** Sets `response_format` per provider:
- OpenAI: native `{ type: "json_schema", schema }`
- Gemini: native `responseSchema` in generationConfig
- Anthropic: tool-based extraction (define tool matching schema, force `tool_choice: named`)
- Validate with Zod; throw `NoObjectGeneratedError` on failure

**stream_object():** Streaming version of generate_object() yielding partial objects.

**StreamAccumulator:** Collects StreamEvents into a complete Response (text concatenation, tool call assembly, usage aggregation).

**Tasks:**
- [ ] Implement `withRetry()` with backoff formula, jitter, Retry-After parsing, abort support
- [ ] Implement `generate()` with tool execution loop (Promise.allSettled, per-tool error handling)
- [ ] Implement `stream()` returning `StreamResult` with `text_stream` convenience
- [ ] Implement `generate_object()` with per-provider JSON mode strategy + Zod validation
- [ ] Implement `stream_object()` with partial object updates
- [ ] Implement `StreamAccumulator`
- [ ] Create `index.ts` exporting all public API
- [ ] Configure `package.json` exports field for ESM + CJS
- [ ] Unit tests: retry logic, generate() tool loop, stream event sequence, generate_object() validation, StreamAccumulator

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `package.json` | Create | Root workspace package |
| `pnpm-workspace.yaml` | Create | Workspace definition |
| `tsconfig.json` | Create | Shared strict TypeScript config |
| `biome.json` | Create | Linter + formatter config |
| `vitest.config.ts` | Create | Test runner config |
| `.gitignore` | Create | Standard Node/TS ignores |
| `packages/llm-client/package.json` | Create | Package manifest with Zod dep |
| `packages/llm-client/tsconfig.json` | Create | Extends root tsconfig |
| `packages/llm-client/tsup.config.ts` | Create | ESM + CJS dual build |
| `packages/llm-client/src/types.ts` | Create | All shared types and interfaces |
| `packages/llm-client/src/errors.ts` | Create | SDKError hierarchy |
| `packages/llm-client/src/schemas.ts` | Create | Zod boundary validators |
| `packages/llm-client/src/sse.ts` | Create | Custom SSE parser |
| `packages/llm-client/src/http.ts` | Create | HTTP utilities + error mapping |
| `packages/llm-client/src/adapters/adapter.ts` | Create | ProviderAdapter interface |
| `packages/llm-client/src/adapters/anthropic.ts` | Create | Anthropic Messages API adapter |
| `packages/llm-client/src/adapters/openai.ts` | Create | OpenAI Responses API adapter |
| `packages/llm-client/src/adapters/gemini.ts` | Create | Gemini native API adapter |
| `packages/llm-client/src/client.ts` | Create | Client class with routing |
| `packages/llm-client/src/middleware.ts` | Create | Middleware chain |
| `packages/llm-client/src/catalog.ts` | Create | Model catalog |
| `packages/llm-client/src/generate.ts` | Create | High-level API (generate/stream/generate_object/stream_object) |
| `packages/llm-client/src/retry.ts` | Create | Retry logic |
| `packages/llm-client/src/accumulator.ts` | Create | StreamAccumulator |
| `packages/llm-client/src/index.ts` | Create | Public API barrel export |
| `packages/llm-client/tests/*.test.ts` | Create | Unit tests (~12 test files) |
| `packages/llm-client/tests/integration/*.test.ts` | Create | Integration tests (3 files, gated on API keys) |
| `packages/agent-loop/package.json` | Create | Placeholder |
| `packages/pipeline/package.json` | Create | Placeholder |

---

## Definition of Done

### Monorepo & Build
- [ ] `pnpm install` succeeds
- [ ] `pnpm build` produces ESM and CJS outputs
- [ ] `pnpm test` runs all unit tests and they pass
- [ ] `pnpm lint` (Biome) passes with no errors
- [ ] TypeScript strict mode compiles without errors
- [ ] Package `exports` field configured correctly in package.json

### Types and Data Model
- [ ] All types defined and exported from `index.ts`
- [ ] `ContentPart` uses `kind` discriminant, supports all 8 content kinds
- [ ] `Usage` includes reasoning_tokens, cache_read_tokens, cache_write_tokens
- [ ] `FinishReason` preserves provider's raw value
- [ ] `ToolCall` includes `raw_arguments` for malformed JSON recovery
- [ ] Convenience functions work: `responseText()`, `responseToolCalls()`, `responseReasoning()`
- [ ] Zod schemas validate at boundaries with `.passthrough()` for forward compatibility

### Anthropic Adapter
- [ ] Simple text completion works
- [ ] Strict message alternation enforced (consecutive same-role merged)
- [ ] System/developer messages extracted to `system` parameter
- [ ] `max_tokens` defaulted to 4096 when unspecified
- [ ] Tool use: definitions sent, calls parsed, results formatted as `tool_result` blocks in user messages
- [ ] Streaming: SSE events mapped to unified StreamEvent types
- [ ] Thinking blocks preserved with `signature` for round-tripping
- [ ] `cache_control` breakpoints injected for prompt caching
- [ ] Beta headers passed via `anthropic-beta`
- [ ] Usage reports cache_read_tokens and cache_write_tokens
- [ ] `tool_choice` modes translated correctly (auto, none→omit, required→any, named→tool)
- [ ] Error responses mapped to correct typed errors (including 529→ServerError)

### OpenAI Adapter
- [ ] Uses Responses API (`/v1/responses`), NOT Chat Completions
- [ ] System/developer messages extracted to `instructions`
- [ ] Messages formatted as `input` array with proper item types
- [ ] Tool calls/results use `function_call`/`function_call_output` format
- [ ] Reasoning tokens extracted from `usage.output_tokens_details.reasoning_tokens`
- [ ] `reasoning_effort` mapped to `reasoning.effort`
- [ ] Streaming works with Responses API event format
- [ ] Error responses mapped to correct typed errors

### Gemini Adapter
- [ ] Uses native Gemini API (`v1beta`)
- [ ] System messages extracted to `systemInstruction`
- [ ] `assistant`↔`model` role mapping
- [ ] Synthetic tool call IDs generated (`crypto.randomUUID()`) and mapped
- [ ] Tool results use function name (not ID) in `functionResponse`
- [ ] String results wrapped as `{ result: "..." }`
- [ ] Streaming via `?alt=sse`
- [ ] Usage reports `reasoning_tokens` from `thoughtsTokenCount`
- [ ] Zero candidates → ContentFilterError
- [ ] Safety settings pass-through via provider_options
- [ ] API key NEVER appears in logs (URL redaction)
- [ ] Error responses mapped to correct typed errors

### Client and Middleware
- [ ] Routes to correct adapter: explicit provider → model-name inference → default_provider
- [ ] `ConfigurationError` thrown when no provider resolved
- [ ] `Client.fromEnv()` auto-discovers adapters from env vars
- [ ] Middleware chain executes in onion model order
- [ ] Logging middleware works with URL/header redaction (especially Gemini API key in URL)
- [ ] Both `complete()` and `stream()` pass through middleware

### Retry Logic
- [ ] Retries on 429 (RateLimitError) with exponential backoff + jitter
- [ ] Retries on 5xx (ServerError) with exponential backoff + jitter
- [ ] Retries on NetworkError and StreamError
- [ ] Does NOT retry on 400, 401, 403, 404
- [ ] Respects `Retry-After` header (both integer seconds and HTTP date)
- [ ] `on_retry` callback invoked on each retry
- [ ] Abort signal cancels retry loop

### High-Level API
- [ ] `generate()` normalizes string prompt → user message
- [ ] `generate()` tool loop: auto-executes tools with `execute` handlers
- [ ] Tool calls run concurrently via `Promise.allSettled()` with per-tool error handling
- [ ] Failed tools return `ToolResult` with `is_error: true`
- [ ] `max_tool_rounds` limits iterations
- [ ] `generate()` accumulates `StepResult[]` and `total_usage`
- [ ] `stream()` returns `StreamResult` with `text_stream` convenience
- [ ] `generate_object()` uses per-provider JSON mode strategy
- [ ] `generate_object()` validates output against Zod schema
- [ ] `generate_object()` throws `NoObjectGeneratedError` on invalid output
- [ ] `stream_object()` yields partial object updates
- [ ] `StreamAccumulator` builds complete Response from stream events
- [ ] Abort signal works end-to-end

### Error Handling
- [ ] Complete SDKError hierarchy (16+ types)
- [ ] HTTP 400 → InvalidRequestError, 401 → AuthenticationError, 403 → AccessDeniedError
- [ ] HTTP 404 → NotFoundError, 413 → ContextLengthError
- [ ] HTTP 429 → RateLimitError (retryable), 5xx → ServerError (retryable)

### Model Catalog
- [ ] `getModelInfo()` returns correct info for known models (including aliases)
- [ ] `listModels()` filters by provider
- [ ] `getLatestModel()` returns latest for a provider/capability
- [ ] Catalog includes current models for all three providers

### Tests
- [ ] Unit tests for each adapter (mocked HTTP): text, tools, streaming, errors, provider-specific quirks
- [ ] Unit tests for Client routing and middleware composition
- [ ] Unit tests for retry logic (retryable vs non-retryable, backoff timing, Retry-After)
- [ ] Unit tests for generate() tool execution loop (including failure handling)
- [ ] Unit tests for generate_object() schema validation
- [ ] Unit tests for stream_object()
- [ ] Unit tests for StreamAccumulator
- [ ] Unit tests for SSE parser edge cases
- [ ] Unit tests for model catalog
- [ ] Integration tests for Anthropic (gated behind `ANTHROPIC_API_KEY`)
- [ ] Integration tests for OpenAI (gated behind `OPENAI_API_KEY`)
- [ ] Integration tests for Gemini (gated behind `GEMINI_API_KEY`)

---

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| **OpenAI Responses API surface instability** | Medium | Medium | Write integration tests early; pin to documented v1 format; add response schema validation |
| **Gemini API beta breakage** | Medium | Medium | Pin to `v1beta`; extensive mocked tests; abstract version in adapter config |
| **SSE parser edge cases** | Medium | Low | Comprehensive test suite with real provider response fixtures; fallback to `eventsource-parser` if fragile |
| **Anthropic thinking block signature corruption** | Low | High | Treat signatures as opaque bytes; round-trip without modification; test with real responses |
| **Streaming + AbortSignal resource leaks** | Medium | Medium | `reader.releaseLock()` in finally blocks; test abort mid-stream scenarios |
| **Dual ESM/CJS output issues** | Low | Medium | Verify both formats work with test consumer; check Zod import compatibility |
| **Promise.all tool execution blocking** | Low | Medium | Use `Promise.allSettled` with per-tool timeout; individual failures don't block others |
| **Zod validation breaking on API additions** | Low | Medium | Use `.passthrough()` at boundaries; don't validate fields we don't use |
| **Model catalog staleness** | High | Low | Informational only; provide `registerModel()` for overrides; document as best-effort |

---

## Security Considerations

1. **API key handling**: Keys via constructor or env vars. Never logged, never in error messages.
2. **Gemini API key in URL**: The `?key=` query parameter MUST be redacted in all logging. Middleware implementations must sanitize URLs.
3. **Middleware header redaction**: Logging middleware must automatically redact `Authorization`, `x-api-key`, and other auth headers.
4. **No credential leakage in errors**: `ProviderError.raw` stores response body only, never request headers.
5. **Input validation**: Zod validates API responses at boundaries. Tool argument schemas validated before execution.
6. **HTTPS only**: All provider URLs use HTTPS. Base URL overrides are for testing only.
7. **AbortSignal propagation**: Passed to `fetch()` and stream readers to prevent resource leaks.
8. **No eval**: All JSON parsing via `JSON.parse()`. No dynamic code execution.

---

## Dependencies

**Runtime:** `zod ^3.23` (only runtime dependency)

**Dev:** `typescript ^5.6`, `tsup ^8.0`, `vitest ^2.0`, `@biomejs/biome ^1.9`

**External (integration tests):** Anthropic API, OpenAI API, Gemini API (gated on env vars; tests skip when keys absent)

**Internal:** None — `@klaus/llm-client` is the leaf package with zero internal deps.

---

## Open Questions

1. **Anthropic cache_control auto-injection heuristic**: Default to system message + last tool definition. Configurable via `provider_options.anthropic.auto_cache`. Revisit based on real-world usage patterns.

2. **Tool execution timeout**: Individual tool `execute()` calls have no timeout currently. Consider adding per-tool timeout configuration in a follow-up.

3. **Model catalog data freshness**: Static snapshot. Provide `registerModel()` for consumer overrides. Consider a fetch-from-provider option later.

4. **Cross-model thinking block handling**: When switching providers, strip thinking block signatures and optionally convert thinking text to visible context. Implement as adapter responsibility during request translation.
