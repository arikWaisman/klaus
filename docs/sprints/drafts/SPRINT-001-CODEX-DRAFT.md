# Sprint 001: Klaus Phase 1 — Unified LLM Client

## Overview

This sprint bootstraps the Klaus monorepo and delivers `@klaus/llm-client`, a provider-agnostic TypeScript library for calling Anthropic, OpenAI, and Gemini models through a unified interface. The library is the foundational layer upon which the agent loop and pipeline runner will be built.

The core value proposition is that application code writes provider-agnostic calls while each adapter speaks the provider's native protocol — Anthropic Messages API, OpenAI Responses API, and Gemini GenerateContent API. This avoids the lowest-common-denominator trap that loses access to reasoning tokens, extended thinking, prompt caching, and advanced tool features.

The sprint is structured as five implementation phases: monorepo scaffold, core types/errors, provider adapters, client/middleware/routing, and high-level API. Each phase builds on the previous and has clear verification criteria.

## Use Cases

1. **Simple text completion**: Call any provider with a text prompt and get a unified response with usage tracking.
2. **Multi-turn conversation**: Send message history and get contextual responses, with provider-specific message format handling (Anthropic alternation, OpenAI input array, Gemini role mapping).
3. **Tool-augmented generation**: Define tools with JSON Schema parameters, have the model call them, and auto-execute with the `generate()` loop.
4. **Streaming responses**: Get incremental text, reasoning, and tool call deltas via async iteration.
5. **Structured output**: Extract typed objects from LLM responses with schema validation via `generate_object()`.
6. **Cost tracking**: Track input/output/reasoning/cache tokens across all providers for billing and optimization.
7. **Error recovery**: Automatically retry transient failures (429, 5xx) with exponential backoff while immediately surfacing permanent errors (401, 403).
8. **Middleware composition**: Add logging, caching, or cost tracking as composable middleware without modifying core logic.

## Architecture

```
┌─────────────────────────────────────────────────┐
│              High-Level API (Layer 4)            │
│   generate() │ stream() │ generate_object()      │
│   Tool loop  │ Retry    │ Schema validation       │
├─────────────────────────────────────────────────┤
│              Client + Middleware (Layer 3)        │
│   Provider routing │ Middleware chain │ Config     │
├─────────────────────────────────────────────────┤
│              Provider Adapters (Layer 2)          │
│   Anthropic  │  OpenAI   │  Gemini               │
│   Messages   │  Responses│  GenerateContent       │
├─────────────────────────────────────────────────┤
│              Shared Foundation (Layer 1)          │
│   Types │ Errors │ SSE Parser │ Retry Utils       │
└─────────────────────────────────────────────────┘
```

### Data Flow

1. Caller constructs a `Request` with unified types
2. High-level API normalizes the request (prompt → messages, system extraction)
3. Middleware chain processes the request (onion model: M1 → M2 → ... → adapter)
4. Adapter translates to provider-native format and calls the API
5. Adapter translates the response back to unified types
6. Middleware chain processes the response (reverse order)
7. High-level API handles tool execution loop, retries, and schema validation

### Key Design Decisions

- **No HTTP client dependency**: Use native `fetch()` (Node 22+). SSE parsing is hand-rolled.
- **Adapters own translation entirely**: Each adapter converts both request and response independently. No shared "normalize" step.
- **Middleware is sync-capable**: Middleware receives request/response and can modify either. Async middleware is supported for I/O-bound operations.
- **Tool execution is concurrent**: When a model returns multiple tool calls, all are executed in parallel via `Promise.all()`. Results are sent back in a single continuation.

## Implementation

### Phase 1.1: Monorepo Scaffold (~10% of effort)

**Files:**
- `package.json` — Root package with workspace scripts
- `pnpm-workspace.yaml` — Workspace definition
- `tsconfig.json` — Shared base TypeScript config (strict, ESM)
- `tsconfig.build.json` — Build-specific config (excludes tests)
- `biome.json` — Linter and formatter configuration
- `vitest.config.ts` — Test runner configuration
- `packages/llm-client/package.json` — Package manifest
- `packages/llm-client/tsconfig.json` — Package-level TS config extending root
- `packages/llm-client/tsup.config.ts` — Build config (ESM + CJS dual output)

**Tasks:**
- [ ] Initialize root `package.json` with pnpm workspace scripts (build, test, lint, format)
- [ ] Create `pnpm-workspace.yaml` listing `packages/*`
- [ ] Create shared `tsconfig.json` with strict mode, ESM, Node 22 target
- [ ] Configure Biome for TypeScript with reasonable defaults
- [ ] Configure Vitest with TypeScript support
- [ ] Scaffold `packages/llm-client/` with its own `package.json`, `tsconfig.json`, `tsup.config.ts`
- [ ] Add Zod as the only runtime dependency for llm-client
- [ ] Verify `pnpm install` and `pnpm build` work end-to-end

### Phase 1.2: Core Types and Error Hierarchy (~15% of effort)

**Files:**
- `packages/llm-client/src/types.ts` — All data model types
- `packages/llm-client/src/errors.ts` — SDKError hierarchy
- `packages/llm-client/src/schemas.ts` — Zod schemas for boundary validation

**Tasks:**
- [ ] Define `Role` enum: SYSTEM, USER, ASSISTANT, TOOL, DEVELOPER
- [ ] Define `ContentKind` enum: TEXT, IMAGE, AUDIO, DOCUMENT, TOOL_CALL, TOOL_RESULT, THINKING, REDACTED_THINKING
- [ ] Define `ContentPart` tagged union with discriminant on `kind`
- [ ] Define `Message` as `{ role: Role; content: ContentPart[] }`
- [ ] Define `ToolDefinition` with name validation (a-zA-Z, max 64), JSON Schema params, optional execute handler
- [ ] Define `ToolCall` with id, name, arguments (parsed object)
- [ ] Define `ToolResult` with call_id, output (string), is_error flag
- [ ] Define `ToolChoice`: auto | none | required | { type: 'named'; name: string }
- [ ] Define `Request` with all fields: model, messages, provider?, tools?, tool_choice?, response_format?, temperature?, top_p?, max_tokens?, stop_sequences?, reasoning_effort?, metadata?, provider_options?
- [ ] Define `Response` with: id, model, provider, message, finish_reason, usage, raw?, warnings?, rate_limit?
- [ ] Define `Usage` with: input_tokens, output_tokens, total_tokens, reasoning_tokens?, cache_read_tokens?, cache_write_tokens?
- [ ] Define `FinishReason`: stop | tool_calls | length | content_filter | error
- [ ] Define `StreamEvent` types: STREAM_START, TEXT_START/DELTA/END, REASONING_START/DELTA/END, TOOL_CALL_START/DELTA/END, FINISH, ERROR, PROVIDER_EVENT
- [ ] Define `ResponseFormat`: text | json | { type: 'json_schema'; schema: object; name?: string }
- [ ] Define `RetryPolicy` with defaults: max_retries=2, base_delay=1.0, max_delay=60.0, backoff_multiplier=2.0, jitter=true
- [ ] Define `RateLimitInfo` with limit, remaining, reset fields
- [ ] Implement `SDKError` class hierarchy:
  - `SDKError` (base)
  - `ProviderError` (with status_code, error_code, retryable, retry_after, raw)
  - `AuthenticationError`, `AccessDeniedError`, `NotFoundError`, `InvalidRequestError`
  - `RateLimitError` (retryable=true), `ServerError` (retryable=true)
  - `ContentFilterError`, `ContextLengthError`, `QuotaExceededError`
  - `RequestTimeoutError`, `AbortError`, `NetworkError` (retryable=true)
  - `StreamError` (retryable=true), `InvalidToolCallError`
  - `UnsupportedToolChoiceError`, `NoObjectGeneratedError`, `ConfigurationError`
- [ ] Create Zod schemas for Request validation and Response parsing at boundaries
- [ ] Unit tests for type construction and error hierarchy

### Phase 1.3: SSE Parser and HTTP Utilities (~10% of effort)

**Files:**
- `packages/llm-client/src/sse.ts` — Server-Sent Events parser
- `packages/llm-client/src/http.ts` — HTTP request helpers with error mapping

**Tasks:**
- [ ] Implement SSE line parser that handles: `data:`, `event:`, `id:`, empty lines as event boundaries
- [ ] Handle multi-line data fields (concatenated with newline)
- [ ] Handle `[DONE]` sentinel used by OpenAI
- [ ] Handle `:` comment lines (ignored)
- [ ] Implement `fetchJSON()` helper: makes fetch call, parses JSON, maps HTTP errors to typed errors
- [ ] Implement `fetchSSE()` helper: makes fetch call with `Accept: text/event-stream`, returns async iterable of parsed SSE events
- [ ] Map HTTP status codes to error types: 400→InvalidRequestError, 401→AuthenticationError, 403→AccessDeniedError, 404→NotFoundError, 429→RateLimitError (with retry_after), 500+→ServerError
- [ ] Extract rate limit headers (x-ratelimit-limit, x-ratelimit-remaining, x-ratelimit-reset)
- [ ] Support AbortSignal for request cancellation
- [ ] Unit tests for SSE parser with various edge cases
- [ ] Unit tests for HTTP error mapping

### Phase 1.4: Provider Adapters (~30% of effort)

**Files:**
- `packages/llm-client/src/adapters/adapter.ts` — ProviderAdapter interface
- `packages/llm-client/src/adapters/anthropic.ts` — Anthropic Messages API
- `packages/llm-client/src/adapters/openai.ts` — OpenAI Responses API
- `packages/llm-client/src/adapters/gemini.ts` — Gemini native API

**Tasks:**

**Adapter interface:**
- [ ] Define `ProviderAdapter` interface: `complete(request): Promise<Response>`, `stream(request): AsyncIterableIterator<StreamEvent>`, `provider: string`
- [ ] Define `AdapterConfig` with: apiKey, baseUrl?, defaultHeaders?, timeout?

**Anthropic adapter:**
- [ ] Implement request translation: extract system messages to `system` param, enforce user/assistant alternation (merge consecutive same-role messages), translate ContentPart to Anthropic content blocks
- [ ] Handle tool definitions → Anthropic `tools` format with `input_schema`
- [ ] Handle tool results: wrap in user message with `tool_result` content blocks
- [ ] Handle thinking blocks: pass `anthropic-beta` header, round-trip thinking blocks with signatures
- [ ] Handle prompt caching: support `cache_control` in provider_options, pass through breakpoints
- [ ] Implement `complete()`: POST to `/v1/messages`, translate response
- [ ] Implement `stream()`: POST to `/v1/messages` with `stream: true`, parse SSE, translate to StreamEvents
- [ ] Translate response: map `content` blocks to ContentParts, extract usage (including cache tokens), map stop_reason to FinishReason
- [ ] Map Anthropic errors (overloaded_error, invalid_request_error, etc.) to typed errors
- [ ] Unit tests with mocked responses for: text, tools, streaming, thinking, errors

**OpenAI adapter:**
- [ ] Implement request translation: system messages → `instructions`, messages → `input` array, tool definitions → `tools` with function format
- [ ] Handle tool results: `function_call_output` items in input array
- [ ] Handle reasoning: detect reasoning models, report reasoning_tokens from `output_tokens_details`
- [ ] Implement `complete()`: POST to `/v1/responses`, translate response
- [ ] Implement `stream()`: POST to `/v1/responses` with `stream: true`, parse SSE, translate to StreamEvents
- [ ] Translate response: map `output` items to ContentParts, extract usage with reasoning_tokens, map status to FinishReason
- [ ] Handle Responses API specific fields: `previous_response_id` for state, `store` option
- [ ] Map OpenAI errors to typed errors
- [ ] Unit tests with mocked responses for: text, tools, streaming, reasoning, errors

**Gemini adapter:**
- [ ] Implement request translation: system messages → `systemInstruction`, assistant → `model` role, tool definitions → `functionDeclarations`
- [ ] Handle tool results: `functionResponse` parts (keyed by function name, not call ID)
- [ ] Generate synthetic tool call IDs: maintain mapping between SDK IDs and Gemini function names
- [ ] Handle thinking: configure via `thinkingConfig` in `generationConfig`
- [ ] Handle safety settings: translate to Gemini safety categories
- [ ] Implement `complete()`: POST to `/v1beta/models/{model}:generateContent`, translate response
- [ ] Implement `stream()`: POST to `:streamGenerateContent?alt=sse`, parse SSE, translate to StreamEvents
- [ ] Translate response: map `candidates[0].content.parts` to ContentParts, extract usage (including thoughtsTokenCount), map finish_reason
- [ ] Map Gemini errors to typed errors
- [ ] Unit tests with mocked responses for: text, tools, streaming, thinking, errors

### Phase 1.5: Client, Middleware, and Routing (~15% of effort)

**Files:**
- `packages/llm-client/src/client.ts` — Core Client class
- `packages/llm-client/src/middleware.ts` — Middleware types and chain execution
- `packages/llm-client/src/catalog.ts` — Model catalog

**Tasks:**
- [ ] Define `Middleware` interface: `{ name: string; before?(req): req | Promise<req>; after?(res): res | Promise<res>; onStream?(event): event | null | Promise<event | null> }`
- [ ] Implement middleware chain execution with onion model ordering
- [ ] Implement `Client` class with:
  - Constructor accepting adapters map and middleware array
  - `complete(request)`: route to adapter, execute through middleware
  - `stream(request)`: route to adapter, wrap stream through middleware
  - `register(provider, adapter)`: add adapter
  - `use(middleware)`: add middleware
- [ ] Implement `Client.fromEnv()` static factory: detect `*_API_KEY` env vars, auto-register corresponding adapters
- [ ] Implement model-name-based routing: prefix matching (`claude-*` → anthropic, `gpt-*`/`o1-*`/`o3-*` → openai, `gemini-*` → gemini)
- [ ] Implement explicit `provider` field override on Request
- [ ] Implement `ModelInfo` record type and model catalog with:
  - `getModelInfo(modelId)`: lookup by ID or alias
  - `listModels(provider?)`: list all or filtered by provider
  - `getLatestModel(provider, capability?)`: get latest model with optional capability filter
  - Populate with current models: Claude Opus 4.6, Claude Sonnet 4.5, GPT-5.2, GPT-5.2-mini, GPT-5.3-codex, Gemini 3.1 Pro, Gemini 3 Flash
- [ ] Implement a logging middleware as proof of middleware system
- [ ] Unit tests for routing, middleware chain, and catalog

### Phase 1.6: High-Level API (~20% of effort)

**Files:**
- `packages/llm-client/src/generate.ts` — generate(), stream(), generate_object(), stream_object()
- `packages/llm-client/src/retry.ts` — Retry logic with exponential backoff
- `packages/llm-client/src/accumulator.ts` — StreamAccumulator utility
- `packages/llm-client/src/index.ts` — Public API exports

**Tasks:**

**Retry:**
- [ ] Implement `withRetry(fn, policy)` helper: exponential backoff with jitter formula `MIN(base * multiplier^n, max) * RANDOM(0.5, 1.5)`
- [ ] Respect `Retry-After` header (use provider value if ≤ max_delay, else raise)
- [ ] Classify retryability: RateLimitError, ServerError, NetworkError, StreamError → retryable; all others → not retryable
- [ ] Retry applies to individual LLM calls, not entire multi-step operations
- [ ] Stream retries only before streaming has begun

**generate():**
- [ ] Accept: model, prompt (string shorthand) OR messages, tools, system, max_tool_rounds (default 1), retry policy, abort signal
- [ ] Normalize input: string prompt → single user message, separate system message
- [ ] Call `client.complete()` with retry
- [ ] If response has tool calls AND active tools (with execute handlers) AND rounds remaining:
  - Execute all tool calls concurrently via `Promise.all()`
  - Append tool results to message history
  - Decrement round counter
  - Loop back to complete()
- [ ] Return `GenerateResult`: { response, steps (array of StepResults), total_usage }
- [ ] `StepResult`: { request, response, tool_calls?, tool_results? }

**stream():**
- [ ] Same tool loop logic as generate() but yields StreamEvents incrementally
- [ ] Return `StreamResult` with: `events` (async iterable), `text_stream` (convenience async iterable of just text deltas), `response` (promise that resolves to final Response)
- [ ] Pause streaming during tool execution, resume after

**generate_object():**
- [ ] Accept schema (Zod or JSON Schema), plus all generate() params
- [ ] Set response_format based on provider:
  - OpenAI: `{ type: 'json_schema', schema }` (native)
  - Gemini: `responseSchema` in generationConfig (native)
  - Anthropic: tool-based extraction (define a tool whose schema matches, force tool_choice to that tool)
- [ ] Validate response against schema
- [ ] Throw `NoObjectGeneratedError` if validation fails after all retries

**stream_object():**
- [ ] Streaming equivalent of generate_object()
- [ ] Yield partial objects as they're assembled from stream deltas

**StreamAccumulator:**
- [ ] Collects StreamEvents into a complete Response
- [ ] Handles text concatenation, tool call assembly, usage aggregation

**Exports:**
- [ ] Create `index.ts` that exports all public API: Client, generate, stream, generate_object, all types, all errors, catalog functions, middleware types

**Tasks:**
- [ ] Unit tests for retry logic (mock timing, verify backoff)
- [ ] Unit tests for generate() tool loop (mock client, verify multi-round execution)
- [ ] Unit tests for stream() event sequence
- [ ] Unit tests for generate_object() with valid and invalid schemas
- [ ] Unit tests for StreamAccumulator
- [ ] Integration tests (gated on API keys) for basic generate() across all three providers

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `package.json` | Create | Root workspace package |
| `pnpm-workspace.yaml` | Create | Workspace definition |
| `tsconfig.json` | Create | Shared strict TypeScript config |
| `tsconfig.build.json` | Create | Build config excluding tests |
| `biome.json` | Create | Linter + formatter config |
| `vitest.config.ts` | Create | Test runner config |
| `.gitignore` | Create | Standard Node/TS ignores |
| `packages/llm-client/package.json` | Create | Package manifest with Zod dep |
| `packages/llm-client/tsconfig.json` | Create | Extends root tsconfig |
| `packages/llm-client/tsup.config.ts` | Create | ESM + CJS dual build |
| `packages/llm-client/src/types.ts` | Create | All shared types |
| `packages/llm-client/src/errors.ts` | Create | SDKError hierarchy |
| `packages/llm-client/src/schemas.ts` | Create | Zod boundary validators |
| `packages/llm-client/src/sse.ts` | Create | SSE parser |
| `packages/llm-client/src/http.ts` | Create | HTTP utilities + error mapping |
| `packages/llm-client/src/adapters/adapter.ts` | Create | ProviderAdapter interface |
| `packages/llm-client/src/adapters/anthropic.ts` | Create | Anthropic Messages API adapter |
| `packages/llm-client/src/adapters/openai.ts` | Create | OpenAI Responses API adapter |
| `packages/llm-client/src/adapters/gemini.ts` | Create | Gemini native API adapter |
| `packages/llm-client/src/client.ts` | Create | Client class with routing |
| `packages/llm-client/src/middleware.ts` | Create | Middleware chain |
| `packages/llm-client/src/catalog.ts` | Create | Model catalog |
| `packages/llm-client/src/generate.ts` | Create | High-level API |
| `packages/llm-client/src/retry.ts` | Create | Retry logic |
| `packages/llm-client/src/accumulator.ts` | Create | StreamAccumulator |
| `packages/llm-client/src/index.ts` | Create | Public exports |
| `packages/llm-client/tests/types.test.ts` | Create | Type construction tests |
| `packages/llm-client/tests/errors.test.ts` | Create | Error hierarchy tests |
| `packages/llm-client/tests/sse.test.ts` | Create | SSE parser tests |
| `packages/llm-client/tests/http.test.ts` | Create | HTTP utility tests |
| `packages/llm-client/tests/anthropic.test.ts` | Create | Anthropic adapter unit tests |
| `packages/llm-client/tests/openai.test.ts` | Create | OpenAI adapter unit tests |
| `packages/llm-client/tests/gemini.test.ts` | Create | Gemini adapter unit tests |
| `packages/llm-client/tests/client.test.ts` | Create | Client routing/middleware tests |
| `packages/llm-client/tests/generate.test.ts` | Create | High-level API tests |
| `packages/llm-client/tests/retry.test.ts` | Create | Retry logic tests |
| `packages/llm-client/tests/catalog.test.ts` | Create | Model catalog tests |
| `packages/llm-client/tests/integration.test.ts` | Create | Real API integration tests |

## Definition of Done

### Core Architecture
- [ ] Layer 1: ProviderAdapter interface with complete(), stream()
- [ ] Layer 2: HTTP utilities, SSE parser, error mapping
- [ ] Layer 3: Client with provider routing and middleware chain
- [ ] Layer 4: generate(), stream(), generate_object() high-level functions

### Data Model
- [ ] All types defined and exported: Message, ContentPart, ContentKind, Role
- [ ] Request, Response, Usage, FinishReason, RateLimitInfo
- [ ] StreamEvent and all StreamEventType values
- [ ] Tool, ToolCall, ToolResult, ToolChoice definitions
- [ ] GenerateResult, StepResult, StreamResult

### Provider Adapters
- [ ] Anthropic adapter: text, tool use, streaming, thinking blocks, prompt caching headers
- [ ] OpenAI adapter: text, tool use, streaming, reasoning tokens, Responses API format
- [ ] Gemini adapter: text, tool use, streaming, synthetic tool IDs, safety settings
- [ ] Each adapter translates request, response, errors, and streaming independently

### Generation
- [ ] Client.complete() basic request/response
- [ ] Client.stream() with proper async iteration
- [ ] generate() with tool loop (max_tool_rounds, concurrent execution)
- [ ] stream() with incremental events and text_stream convenience
- [ ] generate_object() with schema validation (provider-appropriate JSON mode)
- [ ] Prompt normalization (string → messages, system extraction)

### Tool Calling
- [ ] Tool definition validation (name format, schema shape)
- [ ] Parallel tool execution (Promise.all, all-or-nothing)
- [ ] Tool choice mode translation per provider
- [ ] Synthetic tool call IDs for Gemini
- [ ] Thinking block round-tripping for Anthropic

### Streaming
- [ ] SSE parser handles all provider formats
- [ ] start/delta/end lifecycle for text, reasoning, tool calls
- [ ] StreamAccumulator builds complete Response from events
- [ ] Tool execution pause/resume during stream

### Error Handling
- [ ] Complete SDKError hierarchy with all specified subtypes
- [ ] HTTP status code → error type mapping
- [ ] Retryability classification (429, 5xx, network → retry; 400, 401, 403 → no retry)
- [ ] Exponential backoff with jitter
- [ ] Retry-After header respect

### Middleware & Configuration
- [ ] Client.fromEnv() auto-detection from environment variables
- [ ] Programmatic adapter registration
- [ ] Middleware chain in onion model (forward → adapter → reverse)
- [ ] Logging middleware as proof
- [ ] provider_options pass-through

### Cost & Usage
- [ ] Usage tracking: input/output/reasoning/cache tokens
- [ ] Model catalog with current model info and costs
- [ ] getModelInfo(), listModels(), getLatestModel()

### Testing
- [ ] Unit tests for every module (mocked HTTP)
- [ ] Integration tests with real API keys (gated on env vars)
- [ ] All tests pass with `pnpm test`

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| OpenAI Responses API format drift | Medium | High | Pin to documented v1 format, add response schema validation |
| Gemini API breaking changes (beta) | Medium | Medium | Use `v1beta` endpoint, abstract version in adapter config |
| SSE parsing edge cases | Low | Medium | Comprehensive test suite with real provider response fixtures |
| Anthropic thinking block signature format | Low | High | Treat signatures as opaque bytes, round-trip without modification |
| Model catalog staleness | High | Low | Catalog is informational, not blocking; easy to update |
| Streaming backpressure | Low | Medium | Use async generators with pull-based consumption |

## Security Considerations

- **API key handling**: Keys passed via constructor config or environment variables. Never logged, never included in error messages or serialized objects.
- **No eval or dynamic code execution**: All JSON parsing uses `JSON.parse()`, no `eval()`.
- **Input validation**: Zod schemas validate at boundaries. Tool argument schemas validated before execution.
- **HTTPS only**: All provider URLs enforce HTTPS. No HTTP fallback.
- **Abort signal propagation**: Clean cancellation to prevent dangling connections.

## Dependencies

**Runtime:**
- `zod` — Schema validation (only runtime dep)

**Dev:**
- `typescript` ~5.7
- `tsup` — Build
- `vitest` — Test
- `@biomejs/biome` — Lint/format
- `pnpm` — Package manager

**External services (for integration tests):**
- Anthropic API (ANTHROPIC_API_KEY)
- OpenAI API (OPENAI_API_KEY)
- Gemini API (GEMINI_API_KEY)

## Open Questions

1. **Responses API tool format**: OpenAI's Responses API represents tool calls and results differently from Chat Completions. Need to verify the exact `function_call` vs `function` item format in the `output` array and `function_call_output` in the `input` array.

2. **Gemini streaming format**: The Gemini streaming endpoint returns SSE but the event structure may differ from OpenAI/Anthropic conventions. Need to verify whether it uses `data:` fields with JSON or a different format.

3. **SSE parser dependency**: The spec says "no deps beyond HTTP and JSON" but SSE parsing is non-trivial. Writing a custom parser is preferred to keep deps at zero (beyond Zod), but we should consider `eventsource-parser` if our implementation proves brittle.

4. **Anthropic cache breakpoint auto-injection**: The spec recommends this but the heuristic is undefined. Defer to manual `cache_control` in `provider_options` for this sprint; auto-injection can be a follow-up.

5. **Dual ESM/CJS output verification**: tsup handles this, but we should verify that both output formats work correctly, especially with Zod imports and async generators.

6. **Model catalog data source**: Currently hardcoded. Should we fetch from provider APIs or maintain a static list? Static is simpler and avoids runtime API calls; recommended for this sprint.
