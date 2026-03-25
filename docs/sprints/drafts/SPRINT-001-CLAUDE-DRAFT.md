# Sprint 001: Unified LLM Client (`@klaus/llm-client`) — Phase 1

## Overview

This sprint implements the `@klaus/llm-client` package — a provider-agnostic TypeScript library for calling Anthropic, OpenAI, and Gemini LLMs through a unified interface. It is the foundational package in the Klaus monorepo with zero internal dependencies. Everything in Phase 2 (agent-loop) and Phase 3 (pipeline) builds on top of this.

The implementation follows the [Attractor Unified LLM Client Spec](https://github.com/strongdm/attractor/blob/main/unified-llm-spec.md) as the behavioral source of truth.

**Key architectural decisions (from SEED.md):**
- ESM-first with CJS compatibility via tsup dual output
- No classes for data — plain objects + TypeScript interfaces; classes only for stateful entities (Client, adapters)
- Zod at boundaries — validate API responses, tool arguments; internal code trusts its own types
- Native fetch only — no HTTP client dependencies; streaming via ReadableStream/SSE parsing
- Each adapter uses the provider's native, preferred API (no LCD abstraction)
- AsyncIterableIterator for streaming

---

## Use Cases

### UC-1: Simple Text Completion
A caller creates a `Client`, sends a `Request` with a model string and messages, and receives a typed `Response` with text, usage, and finish reason. The client routes to the correct provider adapter based on the `provider` field or falls back to `default_provider`.

### UC-2: Streaming Text Completion
A caller uses `Client.stream()` to receive an `AsyncIterableIterator<StreamEvent>`. Events arrive as TEXT_DELTA, REASONING_DELTA, TOOL_CALL_DELTA, FINISH, etc. A `StreamAccumulator` utility can collect the stream into a complete `Response`.

### UC-3: Tool Use / Function Calling
A caller provides `ToolDefinition[]` in the request. The provider returns `ToolCall` content parts. At the low level (`Client.complete()`), the caller handles tool execution. At the high level (`generate()`), tools with `execute` handlers are auto-invoked in a loop up to `max_tool_rounds`.

### UC-4: Structured Output
`generate_object()` sends a JSON schema to the provider, receives JSON output, validates it with Zod, and returns the parsed object. Raises `NoObjectGeneratedError` on parse/validation failure.

### UC-5: Middleware Pipeline
A caller registers middleware functions (logging, cost tracking, caching) that wrap every `complete()` and `stream()` call in an onion model. Request middleware runs in registration order; response middleware runs in reverse.

### UC-6: Retry with Backoff
`generate()` automatically retries on 429/5xx errors with exponential backoff + jitter, respecting `Retry-After` headers. Non-retryable errors (400, 401, 403, 404) throw immediately.

### UC-7: Provider-Specific Features
Anthropic thinking blocks, prompt caching (`cache_control`), beta headers. OpenAI reasoning tokens via Responses API. Gemini safety settings, thinking config. All accessed via `provider_options` escape hatch.

---

## Architecture

### Four-Layer Design

```
┌─────────────────────────────────────────────┐
│  Layer 4: High-Level API                     │
│  generate(), stream(), generate_object()     │
│  Tool execution loop, retry, prompt norm     │
├─────────────────────────────────────────────┤
│  Layer 3: Core Client                        │
│  Client class, routing, middleware chain     │
├─────────────────────────────────────────────┤
│  Layer 2: Provider Utilities                 │
│  SSE parser, HTTP helpers, retry logic       │
├─────────────────────────────────────────────┤
│  Layer 1: Provider Adapters                  │
│  AnthropicAdapter, OpenAIAdapter,            │
│  GeminiAdapter (ProviderAdapter interface)   │
└─────────────────────────────────────────────┘
```

### Module Dependency Graph

```
index.ts (public API re-exports)
  ├── generate.ts (high-level API)
  │   ├── client.ts (Client class, routing, middleware)
  │   │   ├── adapters/adapter.ts (ProviderAdapter interface)
  │   │   ├── adapters/anthropic.ts
  │   │   ├── adapters/openai.ts
  │   │   └── adapters/gemini.ts
  │   ├── retry.ts (RetryPolicy, exponential backoff)
  │   └── stream-accumulator.ts (StreamAccumulator)
  ├── types.ts (all shared types)
  ├── errors.ts (SDKError hierarchy)
  ├── middleware.ts (Middleware type, compose helper)
  └── catalog.ts (ModelInfo records, lookup)
```

### Key Design Patterns

1. **Adapter Pattern**: Each provider implements `ProviderAdapter` with `complete()` and `stream()`. Request/response translation is fully encapsulated in the adapter.
2. **Onion Middleware**: Middleware wraps the `next` function. Request flows in → response flows out in reverse order. Streaming middleware wraps the event iterator.
3. **Tagged Union for ContentPart**: A `kind` discriminant field enables type narrowing across TEXT, IMAGE, TOOL_CALL, TOOL_RESULT, THINKING, etc.
4. **Error Hierarchy**: `SDKError` base with `ProviderError` subtree. Each error carries `retryable` flag for retry logic.

---

## Implementation

### Phase 1.0: Monorepo Scaffolding

**Goal:** Set up the pnpm monorepo with all configuration before writing any library code.

**Tasks:**
1. Initialize git repo, create `.gitignore`
2. Create `pnpm-workspace.yaml` with `packages/*` glob
3. Create root `package.json` with workspace scripts
4. Create root `tsconfig.json` (strict mode, ESM, Node 22 target)
5. Create `biome.json` (lint + format config)
6. Create root `vitest.config.ts`
7. Scaffold `packages/llm-client/package.json` with dependencies (zod) and dev dependencies (tsup, vitest, typescript)
8. Create `packages/llm-client/tsconfig.json` extending root
9. Create `packages/llm-client/tsup.config.ts` for dual ESM/CJS output

**Files:**
- `pnpm-workspace.yaml`
- `package.json` (root)
- `tsconfig.json` (root)
- `biome.json`
- `vitest.config.ts` (root)
- `.gitignore`
- `packages/llm-client/package.json`
- `packages/llm-client/tsconfig.json`
- `packages/llm-client/tsup.config.ts`

**Key configuration details:**

Root `tsconfig.json`:
```jsonc
{
  "compilerOptions": {
    "strict": true,
    "target": "ES2023",
    "module": "Node16",
    "moduleResolution": "Node16",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true
  }
}
```

`packages/llm-client/tsup.config.ts`:
```ts
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
});
```

---

### Phase 1.1: Core Types and Data Model (`types.ts`, `errors.ts`)

**Goal:** Define every shared type, interface, and enum the rest of the package depends on. Export Zod schemas for boundary validation.

**Tasks:**
1. Define `Role` type — `"system" | "user" | "assistant" | "tool" | "developer"`
2. Define `ContentKind` type — `"text" | "image" | "audio" | "document" | "tool_call" | "tool_result" | "thinking" | "redacted_thinking"`
3. Define `ContentPart` tagged union with all variant data types
4. Define `Message` interface
5. Define `ToolDefinition`, `ToolCall`, `ToolResult`, `Tool` (with optional `execute`)
6. Define `ToolChoice` — `{ mode: "auto" | "none" | "required" | "named"; tool_name?: string }`
7. Define `Request` interface with all fields
8. Define `Usage` interface (including `reasoning_tokens`, `cache_read_tokens`, `cache_write_tokens`)
9. Define `FinishReason` — `{ reason: "stop" | "length" | "tool_calls" | "content_filter" | "error" | "other"; raw?: string }`
10. Define `RateLimitInfo`, `Warning` types
11. Define `Response` interface with convenience accessors
12. Define `ResponseFormat` — `{ type: "json_object" | "json_schema" | "text"; json_schema?: Record<string, unknown>; strict?: boolean }`
13. Define `StreamEventType` enum and `StreamEvent` interface
14. Define `GenerateResult`, `StepResult`, `StreamResult` types
15. Define `RetryPolicy` interface
16. Define `ImageData`, `AudioData`, `DocumentData`, `ThinkingData` interfaces
17. Define SDKError hierarchy in `errors.ts`
18. Create Zod schemas for API response validation

**Files:**
- `packages/llm-client/src/types.ts`
- `packages/llm-client/src/errors.ts`

**Type definitions (TypeScript):**

```ts
// === types.ts ===

export type Role = "system" | "user" | "assistant" | "tool" | "developer";

export type ContentKind =
  | "text"
  | "image"
  | "audio"
  | "document"
  | "tool_call"
  | "tool_result"
  | "thinking"
  | "redacted_thinking";

export interface ImageData {
  url?: string;
  data?: Uint8Array;
  media_type?: string;
  detail?: string; // "auto" | "low" | "high"
}

export interface AudioData {
  url?: string;
  data?: Uint8Array;
  media_type?: string;
}

export interface DocumentData {
  url?: string;
  data?: Uint8Array;
  media_type?: string;
  file_name?: string;
}

export interface ThinkingData {
  text: string;
  signature?: string;
  redacted: boolean;
}

export interface ToolCallData {
  id: string;
  name: string;
  arguments: Record<string, unknown> | string;
  type?: string;
}

export interface ToolResultData {
  tool_call_id: string;
  content: string | Record<string, unknown> | unknown[];
  is_error: boolean;
  image_data?: Uint8Array;
  image_media_type?: string;
}

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
  name?: string;
  tool_call_id?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  raw_arguments?: string;
}

export interface ToolResult {
  tool_call_id: string;
  content: string | Record<string, unknown> | unknown[];
  is_error: boolean;
}

export type ToolChoiceMode = "auto" | "none" | "required" | "named";

export interface ToolChoice {
  mode: ToolChoiceMode;
  tool_name?: string;
}

export type ToolExecuteFn = (
  args: Record<string, unknown>,
  context?: { abort_signal?: AbortSignal }
) => Promise<string | Record<string, unknown>>;

export interface Tool extends ToolDefinition {
  execute?: ToolExecuteFn;
}

export interface ResponseFormat {
  type: "json_object" | "json_schema" | "text";
  json_schema?: Record<string, unknown>;
  strict?: boolean;
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

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  reasoning_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  raw?: Record<string, unknown>;
}

export type FinishReasonValue =
  | "stop"
  | "length"
  | "tool_calls"
  | "content_filter"
  | "error"
  | "other";

export interface FinishReason {
  reason: FinishReasonValue;
  raw?: string;
}

export interface Warning {
  message: string;
  code?: string;
}

export interface RateLimitInfo {
  requests_remaining?: number;
  requests_limit?: number;
  tokens_remaining?: number;
  tokens_limit?: number;
  reset_at?: Date;
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

// Convenience functions (not methods — no classes for data)
export function responseText(response: Response): string { /* ... */ }
export function responseToolCalls(response: Response): ToolCall[] { /* ... */ }
export function responseReasoning(response: Response): string | undefined { /* ... */ }

export type StreamEventType =
  | "STREAM_START"
  | "TEXT_START"
  | "TEXT_DELTA"
  | "TEXT_END"
  | "REASONING_START"
  | "REASONING_DELTA"
  | "REASONING_END"
  | "TOOL_CALL_START"
  | "TOOL_CALL_DELTA"
  | "TOOL_CALL_END"
  | "FINISH"
  | "ERROR"
  | "PROVIDER_EVENT";

export interface StreamEvent {
  type: StreamEventType;
  delta?: string;
  text_id?: string;
  reasoning_delta?: string;
  tool_call?: ToolCall;
  finish_reason?: FinishReason;
  usage?: Usage;
  response?: Response;
  error?: Error;
  raw?: Record<string, unknown>;
}

export interface StepResult {
  text: string;
  reasoning?: string;
  tool_calls: ToolCall[];
  tool_results: ToolResult[];
  finish_reason: FinishReason;
  usage: Usage;
  response: Response;
  warnings: Warning[];
}

export interface GenerateResult {
  text: string;
  reasoning?: string;
  tool_calls: ToolCall[];
  tool_results: ToolResult[];
  finish_reason: FinishReason;
  usage: Usage;
  total_usage: Usage;
  steps: StepResult[];
  response: Response;
  output?: unknown; // For generate_object()
}

export interface StreamResult extends AsyncIterable<StreamEvent> {
  response(): Promise<Response>;
  text_stream: AsyncIterableIterator<string>;
  partial_response: Response | undefined;
}

export interface RetryPolicy {
  max_retries: number;   // default: 2
  base_delay: number;    // default: 1.0 (seconds)
  max_delay: number;     // default: 60.0
  backoff_multiplier: number; // default: 2.0
  jitter: boolean;       // default: true
  on_retry?: (error: Error, attempt: number, delay: number) => void;
}
```

**Error hierarchy (`errors.ts`):**

```ts
export class SDKError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SDKError";
  }
}

export class ProviderError extends SDKError {
  readonly provider: string;
  readonly status_code: number;
  readonly error_code?: string;
  readonly retryable: boolean;
  readonly retry_after?: number;
  readonly raw?: Record<string, unknown>;

  constructor(
    message: string,
    opts: {
      provider: string;
      status_code: number;
      error_code?: string;
      retryable: boolean;
      retry_after?: number;
      raw?: Record<string, unknown>;
      cause?: unknown;
    }
  ) { /* ... */ }
}

// Non-retryable errors
export class AuthenticationError extends ProviderError {}   // 401
export class AccessDeniedError extends ProviderError {}     // 403
export class NotFoundError extends ProviderError {}         // 404
export class InvalidRequestError extends ProviderError {}   // 400, 422
export class ContextLengthError extends ProviderError {}    // 413
export class ContentFilterError extends ProviderError {}    // various
export class QuotaExceededError extends ProviderError {}    // various

// Retryable errors
export class RateLimitError extends ProviderError {}        // 429
export class ServerError extends ProviderError {}           // 500-599

// Non-provider errors
export class RequestTimeoutError extends SDKError {}
export class AbortError extends SDKError {}
export class NetworkError extends SDKError { readonly retryable = true; }
export class StreamError extends SDKError { readonly retryable = true; }
export class InvalidToolCallError extends SDKError {}
export class UnsupportedToolChoiceError extends SDKError {}
export class NoObjectGeneratedError extends SDKError {}
export class ConfigurationError extends SDKError {}
```

**HTTP status → error mapping function:**

```ts
export function errorFromStatus(
  provider: string,
  status: number,
  body: Record<string, unknown>,
  headers?: Headers
): ProviderError {
  const retry_after = parseRetryAfter(headers);
  switch (status) {
    case 400: case 422: return new InvalidRequestError(/*...*/);
    case 401: return new AuthenticationError(/*...*/);
    case 403: return new AccessDeniedError(/*...*/);
    case 404: return new NotFoundError(/*...*/);
    case 408: throw new RequestTimeoutError(/*...*/);
    case 413: return new ContextLengthError(/*...*/);
    case 429: return new RateLimitError(/*..., retryable: true, retry_after */);
    default:
      if (status >= 500) return new ServerError(/*..., retryable: true */);
      return new ProviderError(/*..., retryable: true */); // unknown → retryable
  }
}
```

---

### Phase 1.2: Provider Adapter Interface and SSE Utilities

**Goal:** Define the `ProviderAdapter` interface and build shared utilities for HTTP calls and SSE stream parsing.

**Tasks:**
1. Define `ProviderAdapter` interface with `name`, `complete()`, `stream()`, optional `close()`, `initialize()`
2. Implement SSE line parser — parse `data:`, `event:`, handle `[DONE]` sentinel
3. Implement shared `fetchJSON()` helper for non-streaming provider calls
4. Implement shared `fetchSSE()` helper that returns `AsyncIterableIterator<SSEEvent>`

**Files:**
- `packages/llm-client/src/adapters/adapter.ts`
- `packages/llm-client/src/adapters/sse.ts`
- `packages/llm-client/src/adapters/http.ts`

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

export interface ProviderAdapterConfig {
  api_key: string;
  base_url?: string;
  default_headers?: Record<string, string>;
  timeout?: number;
}
```

**SSE parser (key logic):**

```ts
export interface SSEEvent {
  event?: string;
  data: string;
  id?: string;
  retry?: number;
}

export async function* parseSSEStream(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal
): AsyncIterableIterator<SSEEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      if (signal?.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      let currentEvent: Partial<SSEEvent> = {};
      for (const line of lines) {
        if (line === "") {
          if (currentEvent.data !== undefined) {
            yield currentEvent as SSEEvent;
          }
          currentEvent = {};
        } else if (line.startsWith("data: ")) {
          currentEvent.data = (currentEvent.data ?? "") + line.slice(6);
        } else if (line.startsWith("event: ")) {
          currentEvent.event = line.slice(7);
        } else if (line.startsWith("id: ")) {
          currentEvent.id = line.slice(4);
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
```

---

### Phase 1.3: Anthropic Adapter

**Goal:** Implement the Anthropic Messages API adapter with all its quirks.

**Tasks:**
1. Translate unified `Request` → Anthropic Messages API body
   - Extract system/developer messages to top-level `system` parameter
   - Enforce strict user/assistant alternation — merge consecutive same-role messages
   - Map tool_result content parts into user-role messages with `tool_result` blocks
   - Always set `max_tokens` (default 4096 if unspecified)
   - Map `ToolDefinition[]` → Anthropic `tools` format
   - Map `tool_choice` modes → Anthropic `tool_choice` (`auto`, `none`, `any`, `{type: "tool", name: "..."}`)
   - Pass `provider_options.anthropic.beta_headers` → `anthropic-beta` header
   - Inject `cache_control` breakpoints for prompt caching when `provider_options.anthropic.auto_cache !== false`
2. Translate Anthropic API response → unified `Response`
   - Map `content` blocks (text, tool_use, thinking, redacted_thinking) → `ContentPart[]`
   - Preserve `thinking` block `signature` field for round-tripping
   - Map `stop_reason` → `FinishReason` (`end_turn` → `stop`, `tool_use` → `tool_calls`, `max_tokens` → `length`)
   - Extract `usage` (including `cache_creation_input_tokens`, `cache_read_input_tokens`)
3. Implement streaming via `/v1/messages` with `stream: true`
   - Parse SSE events: `message_start`, `content_block_start`, `content_block_delta`, `content_block_stop`, `message_delta`, `message_stop`
   - Map to unified `StreamEvent` types
   - Handle thinking block streaming (REASONING_START/DELTA/END)
4. Implement error translation — parse Anthropic error response body, map to typed errors

**Files:**
- `packages/llm-client/src/adapters/anthropic.ts`

**Provider quirks to handle:**

| Quirk | Implementation |
|-------|---------------|
| Strict message alternation | Merge consecutive same-role messages by concatenating content arrays |
| System extraction | System/developer role messages → `system` parameter (array of content blocks) |
| `max_tokens` required | Default to 4096 if `request.max_tokens` is undefined |
| Tool results in user messages | `tool_result` content blocks must be in user-role messages |
| Thinking block round-trip | Preserve `signature` field; include thinking blocks in subsequent requests |
| `cache_control` injection | Add `cache_control: { type: "ephemeral" }` to system message and last tool definition |
| Beta headers | `anthropic-beta` header from `provider_options.anthropic.beta_headers` |
| `reasoning_effort` mapping | Map to `thinking.budget_tokens` parameter |

**API endpoint:** `POST https://api.anthropic.com/v1/messages`

**Required headers:**
```
x-api-key: <API_KEY>
anthropic-version: 2023-06-01
content-type: application/json
```

---

### Phase 1.4: OpenAI Adapter

**Goal:** Implement the OpenAI Responses API adapter (NOT Chat Completions).

**Tasks:**
1. Translate unified `Request` → OpenAI Responses API body
   - Extract system/developer messages → `instructions` parameter
   - Map messages → `input` array with `{ type: "message", role, content }` items
   - Tool calls → top-level `input` items with `type: "function_call"`
   - Tool results → `{ type: "function_call_output", call_id, output }` items
   - Map `ToolDefinition[]` → `tools` with `{ type: "function", name, description, parameters }`
   - Map `tool_choice` → Responses API format
   - Map `reasoning_effort` → `reasoning.effort` parameter
2. Translate OpenAI Responses API response → unified `Response`
   - Parse `output` array items by type (`message`, `function_call`)
   - Extract reasoning token count from `usage.output_tokens_details.reasoning_tokens`
   - Map `status` → `FinishReason`
3. Implement streaming via Responses API streaming
   - SSE events: `response.output_text.delta`, `response.function_call_arguments.delta`, `response.completed`
   - Map to unified `StreamEvent` types
   - Extract final usage from `response.completed` event
4. Implement error translation

**Files:**
- `packages/llm-client/src/adapters/openai.ts`

**Provider quirks to handle:**

| Quirk | Implementation |
|-------|---------------|
| Responses API, NOT Chat Completions | Endpoint: `POST /v1/responses` |
| `instructions` for system | System/developer messages extracted to `instructions` string |
| `input` array format | Messages as `{type: "message", role, content}`, tool calls as `{type: "function_call"}`, results as `{type: "function_call_output"}` |
| Reasoning tokens | Read from `usage.output_tokens_details.reasoning_tokens` |
| `reasoning_effort` | Map to `reasoning: { effort: "low" | "medium" | "high" }` |
| No cache token fields | OpenAI handles caching automatically; no cache metrics in response |

**API endpoint:** `POST https://api.openai.com/v1/responses`

**Required headers:**
```
Authorization: Bearer <API_KEY>
Content-Type: application/json
```

---

### Phase 1.5: Gemini Adapter

**Goal:** Implement the Gemini native API adapter.

**Tasks:**
1. Translate unified `Request` → Gemini API body
   - Extract system messages → `systemInstruction` field
   - Map `assistant` role → `model` role
   - Map messages → `contents` array with `{ role, parts }` items
   - Tool results → `functionResponse` parts with function *name* (not ID) and `{ result: "..." }` dict
   - Map `ToolDefinition[]` → `functionDeclarations`
   - Map `tool_choice` → `toolConfig.functionCallingConfig` (`AUTO`, `NONE`, `ANY`)
   - Map `reasoning_effort` → `thinkingConfig.thinkingBudget`
   - Map `response_format` → `generationConfig.responseMimeType` + `responseSchema`
2. Translate Gemini API response → unified `Response`
   - Parse `candidates[0].content.parts` → `ContentPart[]`
   - Generate synthetic tool call IDs (`call_<uuid>`) for `functionCall` parts
   - Maintain synthetic ID → function name mapping for result correlation
   - Extract usage from `usageMetadata` (including `thoughtsTokenCount`)
   - Map `finishReason` → unified `FinishReason`
3. Implement streaming via `?alt=sse` query parameter
   - Each SSE event is a complete `GenerateContentResponse` chunk
   - Function calls arrive as complete objects (not deltas)
   - Map to unified `StreamEvent` types
4. Implement error translation

**Files:**
- `packages/llm-client/src/adapters/gemini.ts`

**Provider quirks to handle:**

| Quirk | Implementation |
|-------|---------------|
| `systemInstruction` field | System messages extracted to top-level field, not in `contents` |
| `model` role (not `assistant`) | Translate `assistant` → `model` in request, `model` → `assistant` in response |
| Synthetic tool call IDs | Generate `call_<crypto.randomUUID()>` for each `functionCall` part |
| `functionResponse` uses name | Map synthetic IDs back to function names when sending results |
| String results wrapped | Wrap string tool results as `{ result: "..." }` dict |
| `?alt=sse` for streaming | Append query param to URL, parse SSE; each event is a full chunk |
| Safety settings | Pass through via `provider_options.gemini.safety_settings` |

**API endpoint:** `POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`
**Streaming endpoint:** `POST https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent?alt=sse`

**Auth:** API key as `?key=<API_KEY>` query parameter.

---

### Phase 1.6: Client, Routing, and Middleware

**Goal:** Implement the `Client` class that routes requests to adapters through a middleware chain.

**Tasks:**
1. Implement `Client` class
   - Constructor accepts adapters map, default_provider, middleware list, default retry policy
   - `Client.from_env()` static factory reads `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY` from env
   - `register_adapter(name, adapter)` — add/replace adapter
   - `complete(request)` — route to adapter through middleware, return `Response`
   - `stream(request)` — route to adapter through middleware, return `AsyncIterableIterator<StreamEvent>`
2. Implement provider routing
   - If `request.provider` is set, use that adapter
   - Else use `default_provider`
   - If neither, throw `ConfigurationError`
   - No model-name guessing — the client never infers provider from model string
3. Implement middleware composition
   - `Middleware` type: `(request, next) => Promise<Response>` for complete, `(request, next) => AsyncIterableIterator<StreamEvent>` for stream
   - Compose middleware in onion model
   - Provide `loggingMiddleware()` as proof-of-concept

**Files:**
- `packages/llm-client/src/client.ts`
- `packages/llm-client/src/middleware.ts`

**Client interface:**

```ts
export interface ClientConfig {
  adapters?: Record<string, ProviderAdapter>;
  default_provider?: string;
  middleware?: Middleware[];
  retry?: Partial<RetryPolicy>;
}

export class Client {
  static from_env(config?: Partial<ClientConfig>): Client;

  constructor(config: ClientConfig);

  register_adapter(name: string, adapter: ProviderAdapter): void;

  complete(request: Request): Promise<Response>;
  stream(request: Request): AsyncIterableIterator<StreamEvent>;
}
```

**Middleware type:**

```ts
export type CompleteMiddleware = (
  request: Request,
  next: (request: Request) => Promise<Response>
) => Promise<Response>;

export type StreamMiddleware = (
  request: Request,
  next: (request: Request) => AsyncIterableIterator<StreamEvent>
) => AsyncIterableIterator<StreamEvent>;

export interface Middleware {
  complete?: CompleteMiddleware;
  stream?: StreamMiddleware;
}
```

---

### Phase 1.7: Retry Logic

**Goal:** Implement retry with exponential backoff + jitter.

**Tasks:**
1. Implement `withRetry()` wrapper function
   - Takes an async operation and a `RetryPolicy`
   - On retryable error: wait (backoff + jitter), retry up to `max_retries`
   - On non-retryable error: throw immediately
   - Respect `Retry-After` header (parsed from `RateLimitError.retry_after`)
   - Call `on_retry` callback if provided
   - Abort-signal aware — stop retrying if signal is aborted
2. Implement `parseRetryAfter(headers)` utility
3. Implement `isRetryable(error)` utility
4. Default retry policy: `{ max_retries: 2, base_delay: 1.0, max_delay: 60.0, backoff_multiplier: 2.0, jitter: true }`

**Files:**
- `packages/llm-client/src/retry.ts`

**Retry logic is applied at the `generate()` layer, NOT at `Client.complete()`/`stream()`.**

**Backoff formula:**
```
delay = min(base_delay * backoff_multiplier^attempt, max_delay)
if jitter: delay = delay * random(0.5, 1.5)
if retry_after > delay: delay = retry_after
```

---

### Phase 1.8: High-Level API (`generate`, `stream`, `generate_object`)

**Goal:** Implement the convenience functions that handle tool loops, retries, and structured output.

**Tasks:**
1. Implement `generate()` function
   - Accept prompt string or messages, system, tools, etc.
   - Normalize prompt string → single user message
   - Build `Request`, call `Client.complete()`
   - If response has tool calls AND tools have `execute` handlers: execute tools, append results, loop (up to `max_tool_rounds`)
   - Parallel tool execution: run all tool calls concurrently via `Promise.all()`
   - Wrap with retry logic
   - Accumulate `StepResult[]` for each round
   - Return `GenerateResult`
   - Support `abort_signal` for cancellation
2. Implement `stream()` (high-level)
   - Same parameter signature as `generate()`
   - Return `StreamResult` — async iterable of `StreamEvent`, plus `.response()` and `.text_stream`
   - No automatic tool execution in stream (tools are executed by caller or via generate)
3. Implement `generate_object()`
   - Same as `generate()` but with `schema` parameter
   - Set `response_format` to JSON mode
   - Parse response text as JSON
   - Validate against schema using Zod
   - Return `GenerateResult` with `output` field populated
   - Throw `NoObjectGeneratedError` on parse/validation failure
4. Implement `StreamAccumulator`
   - Process `StreamEvent`s into a complete `Response`
   - Accumulate text deltas, reasoning deltas, tool call deltas
   - Finalize on FINISH event with usage

**Files:**
- `packages/llm-client/src/generate.ts`
- `packages/llm-client/src/stream-accumulator.ts`

**generate() signature:**

```ts
export async function generate(options: {
  model: string;
  prompt?: string;
  messages?: Message[];
  system?: string;
  tools?: Tool[];
  tool_choice?: ToolChoice;
  max_tool_rounds?: number; // default: 1
  response_format?: ResponseFormat;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stop_sequences?: string[];
  reasoning_effort?: "low" | "medium" | "high";
  provider?: string;
  provider_options?: Record<string, unknown>;
  max_retries?: number;
  timeout?: number;
  abort_signal?: AbortSignal;
  client?: Client;
}): Promise<GenerateResult>;
```

**Tool execution loop pseudocode:**

```
steps = []
messages = normalize(options.messages, options.prompt, options.system)
for round in 0..max_tool_rounds:
    response = withRetry(() => client.complete(request), retryPolicy)
    step = buildStepResult(response)
    steps.push(step)
    if response has no tool_calls: break
    tool_results = await Promise.all(
      response.tool_calls.map(call => executeToolCall(call, tools))
    )
    append assistant message (with tool_calls) to messages
    append user message (with tool_results) to messages
return buildGenerateResult(steps)
```

---

### Phase 1.9: Model Catalog

**Goal:** Provide `ModelInfo` records for known models with capabilities, context windows, and costs.

**Tasks:**
1. Define `ModelInfo` interface (already in types)
2. Populate catalog with current models per provider
3. Implement `getModelInfo(model_id)` lookup
4. Implement `listModels(provider?)` filter

**Files:**
- `packages/llm-client/src/catalog.ts`

**Model entries (representative subset — full list at implementation time):**

```ts
const CATALOG: ModelInfo[] = [
  // Anthropic
  {
    id: "claude-opus-4-6",
    provider: "anthropic",
    display_name: "Claude Opus 4.6",
    context_window: 200_000,
    max_output: 32_000,
    supports_tools: true,
    supports_vision: true,
    supports_reasoning: true,
    input_cost_per_million: 15,
    output_cost_per_million: 75,
    aliases: ["claude-opus-4-6-20250814"],
  },
  {
    id: "claude-sonnet-4-5-20250929",
    provider: "anthropic",
    display_name: "Claude Sonnet 4.5",
    context_window: 200_000,
    max_output: 16_000,
    supports_tools: true,
    supports_vision: true,
    supports_reasoning: true,
    input_cost_per_million: 3,
    output_cost_per_million: 15,
    aliases: ["claude-sonnet-4-5"],
  },
  // OpenAI
  {
    id: "gpt-5.2",
    provider: "openai",
    display_name: "GPT-5.2",
    context_window: 256_000,
    max_output: 16_384,
    supports_tools: true,
    supports_vision: true,
    supports_reasoning: true,
    input_cost_per_million: 2.5,
    output_cost_per_million: 10,
    aliases: [],
  },
  // Gemini
  {
    id: "gemini-3.1-pro-preview",
    provider: "gemini",
    display_name: "Gemini 3.1 Pro Preview",
    context_window: 2_000_000,
    max_output: 65_536,
    supports_tools: true,
    supports_vision: true,
    supports_reasoning: true,
    input_cost_per_million: 1.25,
    output_cost_per_million: 10,
    aliases: [],
  },
  {
    id: "gemini-3-flash",
    provider: "gemini",
    display_name: "Gemini 3 Flash",
    context_window: 1_000_000,
    max_output: 65_536,
    supports_tools: true,
    supports_vision: true,
    supports_reasoning: false,
    input_cost_per_million: 0.15,
    output_cost_per_million: 0.6,
    aliases: [],
  },
];
```

---

### Phase 1.10: Public API Surface and Tests

**Goal:** Create the barrel export file and comprehensive tests.

**Tasks:**
1. Create `index.ts` with all public exports
2. Write unit tests for each adapter (mocked fetch)
   - Text completion request/response translation
   - Tool call request/response translation
   - Streaming event translation
   - Error translation (each HTTP status code)
   - Provider-specific quirks (alternation, synthetic IDs, thinking blocks, etc.)
3. Write unit tests for Client routing and middleware
4. Write unit tests for retry logic
5. Write unit tests for `generate()` tool execution loop
6. Write unit tests for `generate_object()` schema validation
7. Write unit tests for `StreamAccumulator`
8. Write integration tests (gated behind API key env vars)
   - Simple text completion per provider
   - Tool use per provider
   - Streaming per provider
   - Structured output per provider

**Files:**
- `packages/llm-client/src/index.ts`
- `packages/llm-client/tests/types.test.ts`
- `packages/llm-client/tests/errors.test.ts`
- `packages/llm-client/tests/anthropic.test.ts`
- `packages/llm-client/tests/openai.test.ts`
- `packages/llm-client/tests/gemini.test.ts`
- `packages/llm-client/tests/client.test.ts`
- `packages/llm-client/tests/middleware.test.ts`
- `packages/llm-client/tests/retry.test.ts`
- `packages/llm-client/tests/generate.test.ts`
- `packages/llm-client/tests/stream-accumulator.test.ts`
- `packages/llm-client/tests/catalog.test.ts`
- `packages/llm-client/tests/integration/anthropic.integration.test.ts`
- `packages/llm-client/tests/integration/openai.integration.test.ts`
- `packages/llm-client/tests/integration/gemini.integration.test.ts`

**Testing strategy:**
- Unit tests: mock `globalThis.fetch` using Vitest's `vi.fn()` to return canned provider responses
- Integration tests: use `describe.skipIf(!process.env.ANTHROPIC_API_KEY)` pattern
- Each adapter test covers: simple text, tool use, streaming, error mapping, provider-specific features

---

## Files Summary

### New Files (40 total)

| File | Purpose |
|------|---------|
| `pnpm-workspace.yaml` | Monorepo workspace config |
| `package.json` (root) | Root package with workspace scripts |
| `tsconfig.json` (root) | Shared TypeScript base config |
| `biome.json` | Lint + format config |
| `vitest.config.ts` (root) | Test runner config |
| `.gitignore` | Git ignore rules |
| `packages/llm-client/package.json` | Package manifest with deps |
| `packages/llm-client/tsconfig.json` | Package-level TS config |
| `packages/llm-client/tsup.config.ts` | Dual ESM/CJS build config |
| `packages/llm-client/src/index.ts` | Public API barrel export |
| `packages/llm-client/src/types.ts` | All shared types and interfaces |
| `packages/llm-client/src/errors.ts` | SDKError hierarchy |
| `packages/llm-client/src/client.ts` | Client class, routing |
| `packages/llm-client/src/middleware.ts` | Middleware types and compose |
| `packages/llm-client/src/generate.ts` | High-level generate/stream/generate_object |
| `packages/llm-client/src/retry.ts` | Retry policy with backoff + jitter |
| `packages/llm-client/src/catalog.ts` | Model catalog with ModelInfo |
| `packages/llm-client/src/stream-accumulator.ts` | StreamAccumulator utility |
| `packages/llm-client/src/adapters/adapter.ts` | ProviderAdapter interface |
| `packages/llm-client/src/adapters/sse.ts` | SSE stream parser |
| `packages/llm-client/src/adapters/http.ts` | Shared HTTP helpers |
| `packages/llm-client/src/adapters/anthropic.ts` | Anthropic Messages API adapter |
| `packages/llm-client/src/adapters/openai.ts` | OpenAI Responses API adapter |
| `packages/llm-client/src/adapters/gemini.ts` | Gemini native API adapter |
| `packages/llm-client/tests/types.test.ts` | Type construction tests |
| `packages/llm-client/tests/errors.test.ts` | Error hierarchy tests |
| `packages/llm-client/tests/anthropic.test.ts` | Anthropic adapter unit tests |
| `packages/llm-client/tests/openai.test.ts` | OpenAI adapter unit tests |
| `packages/llm-client/tests/gemini.test.ts` | Gemini adapter unit tests |
| `packages/llm-client/tests/client.test.ts` | Client routing + middleware tests |
| `packages/llm-client/tests/middleware.test.ts` | Middleware composition tests |
| `packages/llm-client/tests/retry.test.ts` | Retry logic tests |
| `packages/llm-client/tests/generate.test.ts` | generate/generate_object tests |
| `packages/llm-client/tests/stream-accumulator.test.ts` | StreamAccumulator tests |
| `packages/llm-client/tests/catalog.test.ts` | Model catalog tests |
| `packages/llm-client/tests/integration/anthropic.integration.test.ts` | Anthropic real API tests |
| `packages/llm-client/tests/integration/openai.integration.test.ts` | OpenAI real API tests |
| `packages/llm-client/tests/integration/gemini.integration.test.ts` | Gemini real API tests |

### Modified Files

None — this is a greenfield sprint.

---

## Definition of Done

Every item must be checked off before the sprint is complete.

### Types and Data Model
- [ ] All types defined in `types.ts` and exported from `index.ts`
- [ ] Zod schemas exist for API response validation at adapter boundaries
- [ ] `ContentPart` tagged union supports all 8 content kinds
- [ ] `Response` convenience functions (`responseText`, `responseToolCalls`, `responseReasoning`) work correctly

### Anthropic Adapter
- [ ] Simple text completion works (request → Anthropic API → response)
- [ ] Strict message alternation enforced (consecutive same-role merged)
- [ ] System/developer messages extracted to `system` parameter
- [ ] `max_tokens` defaulted to 4096 when unspecified
- [ ] Tool use works: tool definitions sent, tool calls parsed, tool results formatted as `tool_result` blocks
- [ ] Streaming works: SSE events mapped to unified `StreamEvent` types
- [ ] Thinking blocks preserved with `signature` for round-tripping
- [ ] `cache_control` breakpoints injected for prompt caching
- [ ] Beta headers passed via `anthropic-beta` header
- [ ] Usage reports `cache_read_tokens` and `cache_write_tokens`
- [ ] Error responses mapped to correct typed errors

### OpenAI Adapter
- [ ] Uses Responses API (`/v1/responses`), NOT Chat Completions
- [ ] System/developer messages extracted to `instructions` parameter
- [ ] Messages formatted as `input` array with proper item types
- [ ] Tool calls formatted as `function_call` items
- [ ] Tool results formatted as `function_call_output` items
- [ ] Reasoning tokens extracted from `usage.output_tokens_details.reasoning_tokens`
- [ ] `reasoning_effort` mapped to `reasoning.effort` parameter
- [ ] Streaming works with Responses API event format
- [ ] Error responses mapped to correct typed errors

### Gemini Adapter
- [ ] Uses native Gemini API (not OpenAI-compatible)
- [ ] System messages extracted to `systemInstruction`
- [ ] `assistant` role mapped to `model` role (and back)
- [ ] Synthetic tool call IDs generated and mapped
- [ ] Tool results use function *name* (not ID) in `functionResponse`
- [ ] String results wrapped as `{ result: "..." }`
- [ ] Streaming works via `?alt=sse` query parameter
- [ ] Usage reports `reasoning_tokens` from `thoughtsTokenCount`
- [ ] Error responses mapped to correct typed errors

### Client and Middleware
- [ ] `Client` routes to correct adapter based on `request.provider`
- [ ] `Client` falls back to `default_provider` when no provider specified
- [ ] `ConfigurationError` thrown when no provider can be resolved
- [ ] `Client.from_env()` auto-discovers adapters from `*_API_KEY` env vars
- [ ] Middleware chain executes in correct order (onion model)
- [ ] Logging middleware works as proof-of-concept
- [ ] Both `complete()` and `stream()` pass through middleware

### Retry Logic
- [ ] Retries on 429 (RateLimitError) with backoff
- [ ] Retries on 5xx (ServerError) with backoff
- [ ] Does NOT retry on 400 (InvalidRequestError)
- [ ] Does NOT retry on 401 (AuthenticationError)
- [ ] Does NOT retry on 403 (AccessDeniedError)
- [ ] Respects `Retry-After` header
- [ ] Jitter applied to prevent thundering herd
- [ ] `on_retry` callback invoked on each retry
- [ ] Abort signal cancels retry loop

### High-Level API
- [ ] `generate()` with prompt string works (auto-normalized to user message)
- [ ] `generate()` with tool execution loop works (auto-executes tools with `execute` handlers)
- [ ] Parallel tool execution: multiple tool calls run concurrently via `Promise.all()`
- [ ] `max_tool_rounds` limits tool execution iterations
- [ ] `generate()` accumulates `StepResult[]` and `total_usage`
- [ ] `stream()` returns `StreamResult` with async iterable, `.response()`, `.text_stream`
- [ ] `generate_object()` validates output against Zod schema
- [ ] `generate_object()` throws `NoObjectGeneratedError` on invalid JSON
- [ ] `StreamAccumulator` correctly builds `Response` from stream events
- [ ] Abort signal support works end-to-end

### Error Handling
- [ ] Complete error hierarchy defined (SDKError tree)
- [ ] HTTP 400 → InvalidRequestError (non-retryable)
- [ ] HTTP 401 → AuthenticationError (non-retryable)
- [ ] HTTP 403 → AccessDeniedError (non-retryable)
- [ ] HTTP 404 → NotFoundError (non-retryable)
- [ ] HTTP 413 → ContextLengthError (non-retryable)
- [ ] HTTP 429 → RateLimitError (retryable)
- [ ] HTTP 5xx → ServerError (retryable)
- [ ] Unknown status codes → default retryable

### Model Catalog
- [ ] `getModelInfo()` returns correct info for known models
- [ ] `listModels()` filters by provider
- [ ] Catalog includes current models for all three providers
- [ ] `aliases` field enables lookup by alternative model IDs

### Build and CI
- [ ] `pnpm build` produces ESM and CJS outputs
- [ ] `pnpm test` runs all unit tests and they pass
- [ ] `pnpm lint` (Biome) passes with no errors
- [ ] TypeScript strict mode compiles without errors
- [ ] Package exports configured correctly in `package.json`

### Tests
- [ ] Unit tests for each adapter (mocked HTTP) — text, tools, streaming, errors, quirks
- [ ] Unit tests for Client routing and middleware composition
- [ ] Unit tests for retry logic (retryable vs non-retryable, backoff timing)
- [ ] Unit tests for `generate()` tool execution loop
- [ ] Unit tests for `generate_object()` schema validation
- [ ] Unit tests for `StreamAccumulator`
- [ ] Unit tests for model catalog lookup
- [ ] Integration tests for Anthropic (gated behind `ANTHROPIC_API_KEY`)
- [ ] Integration tests for OpenAI (gated behind `OPENAI_API_KEY`)
- [ ] Integration tests for Gemini (gated behind `GEMINI_API_KEY`)

---

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| **OpenAI Responses API surface instability** — The Responses API is newer than Chat Completions and may have undocumented quirks | Medium | Medium | Write integration tests early; keep Chat Completions as a documented fallback path (not implemented, but adaptable) |
| **Gemini API inconsistencies** — Gemini's function calling differs significantly from Anthropic/OpenAI | Medium | Medium | Extensive mocked unit tests covering edge cases; synthetic ID mapping tested thoroughly |
| **SSE parser edge cases** — Custom SSE parser may miss edge cases (multi-line data, empty events, reconnection) | Medium | Low | Test with real provider stream recordings; consider `eventsource-parser` as fallback if custom parser proves fragile |
| **Streaming + abort interaction** — AbortSignal handling during active streams can leak resources | Medium | Medium | Ensure reader.releaseLock() in finally blocks; test abort mid-stream |
| **Anthropic cache_control injection heuristic** — Wrong breakpoint placement wastes cache tokens | Low | Low | Default to conservative strategy (system + last tool def); make fully configurable via `provider_options` |
| **Provider API breaking changes** — Providers may change API format between now and completion | Low | High | Pin to specific API versions (Anthropic `anthropic-version`, OpenAI via URL, Gemini `v1beta`) |
| **Zod schema overhead** — Runtime validation at every boundary could impact performance | Low | Low | Only validate at adapter boundaries (incoming API responses), not internal paths |

---

## Security Considerations

1. **API Key Handling**: API keys are passed via constructor config or environment variables. Never log, serialize, or include API keys in error messages. The `Client.from_env()` factory reads keys from standard env vars (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`) and does not persist them.

2. **No Key in URLs**: Gemini's API key is passed as a query parameter — ensure it is never logged in URL-level logging middleware. Middleware implementations must sanitize URLs before logging.

3. **Input Validation**: Zod validates all provider API responses at the adapter boundary. This prevents malformed provider responses from propagating invalid data through the system. Tool arguments from LLM responses should be validated by the caller (or by `generate_object()`'s schema validation).

4. **No Credential Leakage in Errors**: Error objects include `raw` response data but must strip any request headers containing API keys. The `ProviderError` class stores `raw` from the response body only, not request metadata.

5. **Abort Signal Propagation**: AbortSignal is passed to `fetch()` calls and stream readers. This ensures that cancellation immediately closes HTTP connections and prevents resource leaks.

6. **HTTPS Only**: All provider API calls use HTTPS. Base URLs can be overridden (for testing), but production defaults are always HTTPS endpoints.

---

## Dependencies

### Runtime Dependencies
| Package | Version | Purpose |
|---------|---------|---------|
| `zod` | `^3.23` | Schema validation at boundaries |

### Dev Dependencies
| Package | Version | Purpose |
|---------|---------|---------|
| `typescript` | `^5.6` | Language and type checker |
| `tsup` | `^8.0` | Bundler for ESM/CJS dual output |
| `vitest` | `^2.0` | Test runner |
| `@biomejs/biome` | `^1.9` | Lint + format |

### External Services
| Service | Required For |
|---------|-------------|
| Anthropic Messages API | Anthropic adapter (integration tests require `ANTHROPIC_API_KEY`) |
| OpenAI Responses API | OpenAI adapter (integration tests require `OPENAI_API_KEY`) |
| Gemini API | Gemini adapter (integration tests require `GEMINI_API_KEY`) |

### Internal Dependencies
None — `@klaus/llm-client` is the leaf package with zero internal deps.

---

## Open Questions

1. **SSE parser: custom vs library?** The spec says "no deps beyond HTTP and JSON" but an SSE parser is utility-level. **Recommendation:** Start with a custom parser (it's ~50 lines). If edge cases emerge in integration testing, consider adding `eventsource-parser` as a dependency.

2. **OpenAI Chat Completions fallback?** The spec mandates Responses API, but some models may only be available via Chat Completions. **Recommendation:** Implement Responses API only for Sprint 001. Document how to add a Chat Completions adapter if needed later.

3. **Gemini API auth: API key vs OAuth?** The spec says "native API" which supports both. **Recommendation:** API key auth (query parameter) for Sprint 001. OAuth/service account support can be added later via `ProviderAdapterConfig` extension.

4. **Anthropic cache_control auto-injection strategy?** Where exactly to place breakpoints for agentic workloads? **Recommendation:** System message and the last tool definition get `cache_control: { type: "ephemeral" }`. Configurable via `provider_options.anthropic.auto_cache`.

5. **Model catalog freshness:** Model pricing and context windows change frequently. **Recommendation:** The catalog is a best-effort snapshot. Provide `registerModel()` for consumers to add/override entries. Document that the catalog may lag behind provider announcements.

6. **Monorepo scaffolding scope:** Should we scaffold empty `packages/agent-loop/` and `packages/pipeline/` directories now? **Recommendation:** Yes — create minimal `package.json` files for them so the workspace is complete, but do not implement any code. This prevents workspace resolution issues later.

7. **Provider routing: explicit only or also model-name inference?** The spec says "the Client never guesses" — provider must be explicit or fall back to `default_provider`. But SEED.md mentions "routes requests to the correct adapter based on model name or explicit provider field." **Recommendation:** Follow the spec — require explicit `provider` field or `default_provider`. Model-name inference is fragile and the spec explicitly rejects it.
