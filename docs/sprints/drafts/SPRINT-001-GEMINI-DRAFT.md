# Sprint 001 Draft: Klaus Phase 1 — Unified LLM Client

## Overview
This sprint focuses on building `@klaus/llm-client`, the foundational Phase 1 package of the Klaus project. Klaus is a TypeScript implementation of the Attractor software factory system. `@klaus/llm-client` is a zero-dependency, provider-agnostic LLM client library that unifies Anthropic, OpenAI, and Gemini under a single, well-typed interface. It leverages native provider APIs (Anthropic Messages, OpenAI Responses, Gemini Native) without lowest-common-denominator abstractions, providing support for advanced features like reasoning tokens, multimodal inputs, and prompt caching.

## Use Cases
1. **One-Shot Generation:** Generate a single text or tool-call response from an LLM given a model string and a history of messages.
2. **Streaming Generation:** Stream granular events (text chunks, tool calls, reasoning tokens) incrementally via an `AsyncIterableIterator`.
3. **Structured Output:** Generate strictly validated JSON payloads mapped to a provided Zod schema (`generate_object`).
4. **Autonomous Tool Execution:** Automatically invoke defined tools concurrently, submit their results back to the LLM, and loop until a final text response is produced or a maximum round limit is reached.
5. **Provider Interchangeability:** Switch between Anthropic, OpenAI, and Gemini seamlessly by changing the model identifier string (e.g., `"claude-3-5-sonnet-20241022"`, `"gpt-4o"`, `"gemini-2.5-pro"`), without altering application code.

## Architecture
The `@klaus/llm-client` architecture adheres to a 4-layer design:
1. **Layer 1: Data Model & Types:** Shared TypeScript interfaces and runtime Zod schemas defining `Message`, `Request`, `Response`, `Tool`, `StreamEvent`, etc.
2. **Layer 2: Provider Utilities:** Shared utilities including native HTTP `fetch` wrappers, Server-Sent Events (SSE) parsing, and retry logic.
3. **Layer 3: Core Client & Middleware:** A `Client` class orchestrating request routing to the correct adapter. It utilizes an onion-model middleware chain for intercepting requests/responses (e.g., for logging, caching, and cost tracking).
4. **Layer 4: High-Level API:** Ergonomic exported functions (`generate()`, `stream()`, `generate_object()`) handling orchestration, tool execution loops, and schema validations.

The package is compiled as an ESM-first module with CJS compatibility via `tsup`, strictly typed, and validates runtime data purely at system boundaries.

## Implementation

### Phase 1.1: Core Types and Data Model
Define the foundational TypeScript types and corresponding runtime validators.

**Key Signatures & Types:**
```typescript
export type Role = "SYSTEM" | "USER" | "ASSISTANT" | "TOOL" | "DEVELOPER";

export type ContentPart =
  | { type: "TEXT"; text: string }
  | { type: "IMAGE"; data: string | Buffer; mimeType: string }
  | { type: "AUDIO"; data: string | Buffer; mimeType: string }
  | { type: "DOCUMENT"; data: string | Buffer; mimeType: string }
  | { type: "TOOL_CALL"; id: string; name: string; arguments: Record<string, any> }
  | { type: "TOOL_RESULT"; id: string; result: any; isError?: boolean }
  | { type: "THINKING"; text: string }
  | { type: "REDACTED_THINKING"; data: string };

export interface Message {
  role: Role;
  content: ContentPart[];
}

export interface Request {
  model: string;
  messages: Message[];
  tools?: ToolDefinition[];
  toolChoice?: "auto" | "none" | { type: "tool"; name: string };
  responseFormat?: { type: "json_object" | "json_schema"; schema?: Record<string, any> };
  providerOptions?: Record<string, any>; // Provider-specific escape hatch
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

export interface Response {
  message: Message;
  finishReason: "STOP" | "MAX_TOKENS" | "TOOL_CALLS" | "CONTENT_FILTER" | "ERROR" | "UNKNOWN";
  usage: Usage;
  raw: any; // Raw provider response
}
```

### Phase 1.2: Provider Adapters
Implement the `ProviderAdapter` interface for each LLM provider, interacting exclusively via the native Node.js `fetch` API.

**Key Signatures:**
```typescript
export interface ProviderAdapter {
  complete(request: Request): Promise<Response>;
  stream(request: Request): AsyncIterableIterator<StreamEvent>;
}
```

**Tasks:**
- **Anthropic Adapter:** Implement via the Messages API (`/v1/messages`). Map the `DEVELOPER` role to `SYSTEM`. Enforce strict user/assistant message alternation. Handle `cache_control` breakpoints for prompt caching and round-trip `THINKING` blocks. Translate streaming SSE into unified `StreamEvent` objects.
- **OpenAI Adapter:** Implement via the Responses API (`/v1/responses`, avoiding Chat Completions). Map `instructions` to system prompts and handle `input` arrays. Capture reasoning tokens exposed via `output_tokens_details`. Handle server-side state.
- **Gemini Adapter:** Implement via the native Gemini API. Map `systemInstruction`, use the `model` role for assistant, and process `functionResponse` for tool results. Generate deterministic synthetic tool call IDs, as Gemini natively lacks them. Manage `thinkingConfig` and safety settings.

### Phase 1.3: Core Client, Middleware, and Errors
Develop the central router, extensible middleware, and typed error hierarchy.

**Tasks:**
- Implement the `SDKError` taxonomy: `ProviderError`, `TransientError` (retryable: 429, 5xx), and `ClientError` (non-retryable: 400, 401, 403, 404).
- Create the `Client` class with support for an onion-model middleware chain.
- Route requests to adapters based on `request.provider` or by inferring from `request.model` prefix heuristics.
- Implement a `RetryPolicy` utilizing exponential backoff with jitter and `Retry-After` header respect.

### Phase 1.4: High-Level API
Expose ergonomic driver functions that utilize the `Client` internally.

**Key Signatures:**
```typescript
export async function generate(client: Client, request: Request, options?: GenerateOptions): Promise<GenerateResult>;
export async function stream(client: Client, request: Request, options?: GenerateOptions): Promise<StreamResult>;
export async function generate_object<T>(client: Client, request: Request, schema: z.ZodType<T>): Promise<T>;
```

**Tasks:**
- **`generate()`:** Execute an autonomous tool loop. If a call returns `TOOL_CALL`s, execute active tools concurrently. Construct a `TOOL_RESULT` message and re-invoke the LLM. Stop on final text or upon reaching `max_tool_rounds`. Apply retry logic here, not at the adapter layer.
- **`stream()`:** Yield an `AsyncIterableIterator<StreamEvent>` for the top-level request, integrating tool execution gracefully. Include a `StreamAccumulator` utility for generating a final `Response`.
- **`generate_object()`:** Configure provider-native JSON modes, injecting schemas into `responseFormat`, and returning a strictly Zod-validated generic payload.

## Files Summary
- `packages/llm-client/src/types.ts`: Core interfaces, unions, and runtime Zod schemas.
- `packages/llm-client/src/adapters/adapter.ts`: `ProviderAdapter` contract.
- `packages/llm-client/src/adapters/anthropic.ts`: Anthropic adapter logic.
- `packages/llm-client/src/adapters/openai.ts`: OpenAI Responses API logic.
- `packages/llm-client/src/adapters/gemini.ts`: Gemini adapter logic.
- `packages/llm-client/src/client.ts`: Main client, adapter registration, and model routing.
- `packages/llm-client/src/middleware.ts`: Onion middleware dispatcher.
- `packages/llm-client/src/retry.ts`: Exponential backoff implementation.
- `packages/llm-client/src/errors.ts`: Unified `SDKError` classes.
- `packages/llm-client/src/catalog.ts`: Registry for known models and their capabilities/costs.
- `packages/llm-client/src/generate.ts`: High-level `generate()`, `stream()`, and `generate_object()` logic.
- `packages/llm-client/src/index.ts`: Barrel file for public API exports.
- `packages/llm-client/tests/**/*.test.ts`: Vitest unit tests utilizing mocked HTTP fetches.
- `packages/llm-client/tests/integration/**/*.test.ts`: Live E2E tests skipping conditionally based on environment variables.

## Definition of Done
- [ ] Zod schemas and TypeScript types are cleanly defined and exported without circular dependencies.
- [ ] `AnthropicAdapter` passes tests for basic generation, tool usage, streaming, thinking blocks, and prompt caching.
- [ ] `OpenAIAdapter` passes tests using the specific Responses API, yielding correct reasoning tokens.
- [ ] `GeminiAdapter` passes tests for basic generation, tool use, streaming, safety settings, and properly maps synthetic tool IDs.
- [ ] `Client` seamlessly routes traffic to the correct adapter using configuration or model string heuristics.
- [ ] A sample logging middleware is verified working against the middleware chain abstraction.
- [ ] `generate()` effectively runs the tool-calling loop (concurrent where applicable) across all 3 providers without infinite looping.
- [ ] `stream()` returns an accurate async iterator, emitting standardized `StreamEvent` payloads.
- [ ] `generate_object()` produces properly validated objects against supplied JSON schemas.
- [ ] The Retry subsystem effectively traps 429/5xx status codes, backing off exponentially, while throwing immediately on 4xx codes.
- [ ] The full error taxonomy properly scopes specific HTTP errors.
- [ ] Usage data (including reasoning and cache tokens) accurately propagates to the unified `Response` object.
- [ ] Mock-backed unit tests exist for all core logic, yielding high coverage on data translation paths.
- [ ] Real integration tests succeed utilizing `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and `GEMINI_API_KEY`.

## Risks & Mitigations
- **Risk:** Streaming payloads (SSE) vary vastly between providers and can be brittle to parse.
  - **Mitigation:** Rely on discrete, thoroughly unit-tested parsing state machines for each adapter. If custom parsing proves fragile, introduce a minimal, robust parsing utility.
- **Risk:** The OpenAI Responses API differs from Chat Completions, carrying unknown quirks.
  - **Mitigation:** Base the implementation explicitly on the newest spec documentation and construct heavily audited integration tests to capture exact edge-case payloads.
- **Risk:** Gemini's lack of native tool IDs breaks standard mapping logic where models return calls mapping to responses.
  - **Mitigation:** The `GeminiAdapter` will transparently inject and track stable synthetic identifiers (e.g. UUIDs) during the inbound/outbound mapping cycle.

## Security Considerations
- **Credentials:** API keys must be isolated to memory and strictly omitted from logs.
- **Middleware Safety:** Default middlewares (like logging) must be programmed to automatically redact headers such as `Authorization`, `x-api-key`, and `api-key`.
- **Injection:** Tool execution mechanisms are arbitrary execution interfaces. Ensure the `llm-client` restricts execution strictly to supplied handlers without evaluating arbitrary JS.

## Dependencies
- **Runtime:** Built-in `fetch` for HTTP. `zod` for type-safe boundary parsing.
- **Build & Test:** `typescript`, `tsup` (bundling), `vitest` (testing), `@biomejs/biome` (formatting/linting).

## Open Questions
1. **SSE Parse Utility:** Is writing a custom SSE implementation mandated by the "no dependency" rule, or is an isolated micro-library like `eventsource-parser` permissible?
2. **Gemini Auth Header:** What is the precise authentication standard for the intended native API? Standard bearer tokens or query parameter keys?
3. **Model String Heuristics:** To what extent should `Client` depend on prefix matching vs explicit provider settings in the Request?
4. **Cache Control Injection:** What is the desired heuristic algorithm for automatically placing Anthropic `cache_control` breakpoints, if any?
