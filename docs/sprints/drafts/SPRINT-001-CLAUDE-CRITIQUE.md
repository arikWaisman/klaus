# Sprint 001 Critique: Codex Draft vs. Gemini Draft

This critique evaluates both sprint drafts against the SPRINT-001-INTENT.md and the project's stated constraints (SEED.md, upstream unified-llm-spec.md). Each draft is assessed on: strengths, weaknesses, gaps in risk analysis, missing edge cases, and Definition of Done completeness.

---

## Codex Draft Critique

### Strengths

1. **Exceptional detail in type definitions.** The Codex draft enumerates every type, enum value, and interface field explicitly. The task lists in Phases 1.2–1.6 read like a near-complete implementation checklist — an implementer could work from them with minimal ambiguity.

2. **Provider-specific nuance is well-captured.** The Anthropic adapter section covers thinking block round-tripping with signatures, cache_control breakpoints, beta headers, and strict message alternation. The OpenAI section correctly identifies `output_tokens_details.reasoning_tokens` and the Responses API's `input` array format. The Gemini section handles synthetic tool call IDs and `functionResponse` keyed by name (not ID).

3. **Architecture diagram and data flow are clear.** The 4-layer ASCII diagram and the 7-step data flow description make the request lifecycle easy to follow. The "Key Design Decisions" section (no HTTP client dep, adapters own translation, concurrent tool execution) is concise and useful.

4. **SSE parser is given its own phase.** Separating SSE/HTTP utilities into Phase 1.3 prevents them from being an afterthought buried inside adapter code. The explicit task list for the SSE parser (multi-line data, `[DONE]` sentinel, comment lines) shows awareness of real-world parsing complexity.

5. **Comprehensive error hierarchy.** Lists 16+ error subtypes with clear retryability classification. The error mapping table (HTTP status → error type) is explicit and complete.

6. **Model catalog includes `getLatestModel()`.** A useful convenience absent from the Gemini draft.

7. **Good use case coverage.** Eight use cases covering cost tracking and middleware composition in addition to the core generation/streaming/tool patterns.

### Weaknesses

1. **Includes model-name-based routing, contradicting the spec.** Phase 1.5 specifies prefix matching (`claude-*` → anthropic, `gpt-*` → openai, `gemini-*` → gemini). The INTENT document says "the Client never guesses" and the upstream spec rejects model-name inference as fragile. The Claude draft correctly identifies this as a spec contradiction and recommends explicit-only routing. The Codex draft should follow the spec and drop or demote this to an optional opt-in behavior.

2. **No explicit `schemas.ts` content.** Phase 1.2 mentions creating `schemas.ts` with Zod schemas but never specifies what those schemas validate — just "Request validation and Response parsing at boundaries." The Gemini draft doesn't even mention a separate schemas file. Neither draft details which adapter response shapes get Zod schemas or how granular the validation should be.

3. **Phase effort estimates may be misleading.** Percentages (10%, 15%, 30%, etc.) sum to 100% but the adapter phase at 30% is likely underestimated given three complex adapters each with streaming, tool use, thinking blocks, and error mapping. The SSE parser at 10% may also be underestimated given the "open question" about whether to write a custom parser.

4. **No `stream_object()` in Definition of Done.** The Implementation section (Phase 1.6) describes `stream_object()` but the Definition of Done checklist doesn't mention it. If it's in scope, it must be in DoD; if it's deferred, it should be called out explicitly.

5. **Tool execution is "all-or-nothing" without defining failure behavior.** The draft says `Promise.all()` for parallel execution but doesn't specify what happens when one tool throws. Does the entire generation fail? Are partial results returned? The `is_error` flag on `ToolResult` suggests individual failures are possible, but the generate() pseudocode doesn't show error handling within the tool loop.

6. **Missing `ToolChoice.required` mode.** The draft defines `auto | none | required | { type: 'named'; name: string }` but the per-provider translation tables don't show how `required` maps to each provider (Anthropic uses `any`, OpenAI uses `required`, Gemini uses `ANY`).

7. **`stream()` tool pause/resume is specified without enough detail.** "Pause streaming during tool execution, resume after" is hand-waved. This is one of the hardest parts of the streaming API — how does the consumer know the stream is paused? Is a new stream started? What events are emitted during the tool execution gap?

8. **Security: missing Gemini API key in URL concern.** The Codex draft says "HTTPS only" and "keys never logged" but doesn't address Gemini's query-parameter auth pattern, which means the API key appears in the URL and could leak through URL-level logging, error messages, or browser DevTools. The Claude draft correctly flags this.

9. **`tsconfig.build.json` is listed but not detailed.** Root `tsconfig.json` is described but the build-specific config is just mentioned by filename. What does it exclude? Tests? Examples?

10. **No mention of `close()` or `initialize()` on adapters.** The adapter interface only defines `complete()`, `stream()`, and `provider`. The Claude draft's adapter interface includes optional `close()` and `initialize()` methods, and `supports_tool_choice()`. These may be needed for connection pooling or cleanup.

### Gaps in Risk Analysis

1. **No risk around `Promise.all()` tool execution.** If one tool hangs or takes very long, all tool results are blocked. No timeout or individual tool abort is mentioned.

2. **No risk around streaming memory pressure.** If a consumer is slow to read from the async iterator, buffered events could grow unboundedly. The draft mentions "pull-based consumption" under "streaming backpressure" but doesn't address the scenario where the SSE parser is producing events faster than the consumer processes them.

3. **No risk around concurrent `generate()` calls sharing state.** If the Client instance is shared, are there any thread-safety (or async reentrancy) concerns with the middleware chain or adapter state?

4. **Missing risk: Gemini API auth (API key in query param).** This is an open question in the draft but not a risk entry. Query-param auth has security implications (URL logging, server access logs, browser history).

5. **Missing risk: Zod performance at scale.** Validating large responses (e.g., many tool calls, large streaming payloads) with Zod could add latency. The Claude draft flags this as a risk; the Codex draft does not.

### Missing Edge Cases

1. **Empty message content arrays.** What if a provider returns a message with zero content parts?
2. **Interleaved thinking and text blocks in streaming.** Anthropic can interleave thinking and text blocks. The stream event ordering needs to handle this.
3. **Tool call with malformed JSON arguments.** What if the LLM returns syntactically invalid JSON in tool call arguments? `raw_arguments` is mentioned in the Claude draft but absent from the Codex draft.
4. **Provider returning unknown finish reasons.** What maps to `other`? The Codex draft doesn't have an `other` category (only stop/tool_calls/length/content_filter/error).
5. **Gemini returning zero candidates.** The draft assumes `candidates[0]` exists but Gemini can return empty candidates when safety filters trigger.
6. **Anthropic overloaded_error (529).** This is a retryable error specific to Anthropic that doesn't fit the standard 5xx mapping cleanly.
7. **Stream interruption mid-tool-call-delta.** What if the stream dies while assembling a tool call? The StreamAccumulator needs to handle partial state.

### Definition of Done Completeness

The Codex DoD is reasonably comprehensive but has gaps:

- **Missing:** `stream_object()` (mentioned in implementation, absent from DoD)
- **Missing:** `close()`/`initialize()` lifecycle on adapters
- **Missing:** Specific build verification (e.g., "both ESM and CJS imports work in a test consumer")
- **Missing:** API key redaction in logging middleware
- **Missing:** Abort signal end-to-end verification
- **Missing:** Package.json `exports` field configuration verification
- **Vague:** "Unit tests for every module" — no coverage threshold or specific scenario count
- **Present but untestable:** "Integration tests with real API keys" — how is this verified in CI without keys?

---

## Gemini Draft Critique

### Strengths

1. **Concise and readable.** At ~160 lines, it's roughly one-third the length of the Codex draft. For a sprint planning document that needs to be reviewed by humans, brevity has real value. The core architecture and responsibilities are quickly understandable.

2. **Correct identification of Responses API as the target.** Avoids the Chat Completions trap. Mentions `input` arrays and `function_call_output` items.

3. **Key type signatures are included inline.** Showing actual TypeScript interfaces for `ContentPart`, `Request`, `Usage`, `Response`, and `ProviderAdapter` gives concrete, unambiguous definitions.

4. **Security section flags middleware redaction.** "Default middlewares (like logging) must be programmed to automatically redact headers such as `Authorization`, `x-api-key`, and `api-key`" is a good callout.

5. **Correct high-level API signatures.** The `generate()`, `stream()`, and `generate_object()` signatures correctly show the Client as an explicit parameter rather than hidden singleton state.

### Weaknesses

1. **Severely underspecified.** The Gemini draft reads like an executive summary, not an implementation plan. Critical details are missing:
   - No SSE parser specification (not even mentioned as a file)
   - No HTTP utility layer
   - No streaming event types enumerated
   - No middleware type definition
   - No retry policy details (just "exponential backoff with jitter")
   - No `StreamAccumulator` specification
   - No stream event lifecycle (START/DELTA/END patterns)
   - No discussion of prompt normalization (string → messages)
   - No discussion of how `generate_object()` adapts per provider (tool-based extraction for Anthropic vs native JSON mode for OpenAI/Gemini)

2. **Error hierarchy is too coarse.** Only three categories: `ProviderError`, `TransientError`, and `ClientError`. Missing: `ContextLengthError`, `ContentFilterError`, `QuotaExceededError`, `StreamError`, `InvalidToolCallError`, `UnsupportedToolChoiceError`, `NoObjectGeneratedError`, `ConfigurationError`, `AbortError`, `NetworkError`. The Codex and Claude drafts have 16+ error types for good reason — different errors require different handling strategies.

3. **`ContentPart` uses `type` instead of `kind`.** The INTENT document and Claude draft use `kind` as the discriminant field (matching SEED.md convention). The Gemini draft uses `type`, which will collide with TypeScript utility types and is inconsistent with the upstream spec. This seems like a minor naming issue but affects every type guard and switch statement in the codebase.

4. **`Usage` type is incomplete.** Missing `total_tokens`, `cache_read_tokens`, `cache_write_tokens`, and `raw` fields. The Codex and Claude drafts include these. Prompt caching token tracking is an explicit requirement from the INTENT.

5. **`ToolChoice` is missing `required` mode.** The Gemini draft defines `"auto" | "none" | { type: "tool"; name: string }` but omits `required` (force any tool). This is supported by all three providers and is needed for `generate_object()` with Anthropic's tool-based extraction.

6. **No `ResponseFormat.text` option.** Only `json_object` and `json_schema` — missing the default `text` mode. Also missing the `strict` field for OpenAI's strict schema validation.

7. **`FinishReason` is a flat union instead of an object.** The Codex draft uses a flat string union; the Claude draft uses `{ reason, raw? }` to preserve the provider's original value. The Gemini draft uses a flat union but with UPPER_CASE values (e.g., `"STOP"`, `"MAX_TOKENS"`) which is inconsistent with the rest of the types (which use snake_case/lowercase).

8. **No monorepo scaffolding phase.** Jumps straight to "Core Types and Data Model" without specifying root `package.json`, `pnpm-workspace.yaml`, `tsconfig.json`, `biome.json`, or `vitest.config.ts`. The INTENT explicitly requires scaffolding as a prerequisite.

9. **`Response.raw` typed as `any`.** Should be `Record<string, unknown>` for type safety. The Codex and Claude drafts use the latter.

10. **Files Summary is incomplete.** Lists only 12 source files and mentions tests generically. Missing: `sse.ts`, `http.ts`, `accumulator.ts`/`stream-accumulator.ts`, `schemas.ts`, individual test files. The Codex draft lists 38 files; the Claude draft lists 38 files. The Gemini draft lists 14.

11. **Retry section says "Apply retry logic here [in generate()], not at the adapter layer" but provides no implementation detail.** No backoff formula, no jitter formula, no `Retry-After` handling, no abort signal integration.

12. **No model catalog detail.** `catalog.ts` is listed as a file but no tasks, no model entries, no lookup functions.

13. **"Deterministic synthetic tool call IDs" for Gemini.** The Claude draft uses `crypto.randomUUID()`. The Gemini draft says "deterministic" but doesn't define the algorithm. If they're truly deterministic (e.g., hash-based), there's a collision risk. If they mean "stable per invocation," they should use UUIDs like the Claude draft.

### Gaps in Risk Analysis

1. **Only three risks listed.** Compare to the Codex draft's six and the Claude draft's seven. Major missing risks:
   - No risk around thinking block round-tripping (Anthropic signatures are opaque and must be preserved exactly)
   - No risk around model catalog staleness
   - No risk around streaming backpressure
   - No risk around AbortSignal + streaming interaction (resource leaks)
   - No risk around Zod performance overhead
   - No risk around dual ESM/CJS output compatibility
   - No risk around `Promise.all()` tool execution (one tool blocking all)

2. **Risk likelihoods are not quantified.** No likelihood/impact ratings, making prioritization harder.

3. **Mitigation for SSE risk is too vague.** "Rely on discrete, thoroughly unit-tested parsing state machines for each adapter" doesn't address what happens when tests pass but production SSE format differs from test fixtures.

### Missing Edge Cases

All the edge cases missing from the Codex draft (listed above) are also missing here, plus:

1. **No mention of Anthropic `max_tokens` being required.** Other providers have defaults; Anthropic errors if it's missing.
2. **No mention of Anthropic message alternation enforcement.** Listed as an intent edge case but not addressed in implementation tasks.
3. **No `stream_object()` mentioned at all.** The Codex draft at least describes it even if it's missing from DoD.
4. **No mention of AbortSignal anywhere in the draft.**
5. **No mention of rate limit header extraction.** The Codex draft includes `x-ratelimit-*` header parsing.
6. **No discussion of `provider_options` pass-through mechanism.**

### Definition of Done Completeness

The Gemini DoD is the weakest of the three drafts:

- **Missing:** Monorepo scaffolding verification (`pnpm install`, `pnpm build`)
- **Missing:** TypeScript strict compilation passing
- **Missing:** Biome lint passing
- **Missing:** Package `exports` configuration
- **Missing:** Abort signal support
- **Missing:** Rate limit info extraction
- **Missing:** `stream_object()` support
- **Missing:** `StreamAccumulator` verification
- **Missing:** Tool choice mode translation per provider
- **Missing:** Prompt normalization (string → messages)
- **Missing:** Model catalog lookup functions
- **Missing:** Provider-specific features in adapter DoD (thinking blocks, cache tokens, reasoning_effort mapping)
- **Vague:** "Mock-backed unit tests exist for all core logic" — no specifics on what scenarios must be tested
- **Vague:** "Usage data (including reasoning and cache tokens) accurately propagates" — but `Usage` type doesn't even include cache tokens

---

## Head-to-Head Comparison

| Dimension | Codex Draft | Gemini Draft |
|-----------|-------------|--------------|
| **Completeness** | High — near-exhaustive type and task enumeration | Low — executive summary level, many gaps |
| **Accuracy** | High with one notable error (model-name routing contradicts spec) | Medium — several type inconsistencies and missing fields |
| **Implementability** | An implementer could start coding immediately from this | An implementer would need to constantly reference external specs |
| **Risk Analysis** | Good (6 risks with likelihood/impact) but missing some | Minimal (3 risks, no quantification) |
| **Edge Case Coverage** | Good for provider-specific quirks, weak on failure modes | Weak across the board |
| **DoD Quality** | Comprehensive but has gaps (stream_object, abort, build verification) | Too sparse to serve as a completion gate |
| **Readability** | Dense but well-organized; scannable tables and checklists | Concise and approachable but insufficient for implementation |
| **Type Safety** | Good — consistent naming, proper discriminants | Several issues — `type` vs `kind`, `any` types, missing fields |
| **Security** | Good but misses Gemini URL-key concern | Flags middleware redaction (unique strength) |

---

## Recommendations

### For a Final Sprint Document

1. **Use the Codex draft as the structural base** — its phasing, task granularity, and file organization are strongest.

2. **Incorporate from the Gemini draft:**
   - Middleware redaction security requirement
   - Explicit `Client` parameter in high-level API signatures (rather than implicit)

3. **Incorporate from the Claude draft:**
   - Explicit-only provider routing (no model-name guessing)
   - `kind` discriminant on `ContentPart` (not `type`)
   - `FinishReason` as `{ reason, raw? }` object
   - `raw_arguments` on `ToolCall` for malformed JSON recovery
   - Gemini API key URL-logging security concern
   - Optional `close()`/`initialize()`/`supports_tool_choice()` on ProviderAdapter
   - `on_retry` callback in RetryPolicy
   - Per-provider quirks tables (excellent reference during implementation)

4. **Add to any final draft:**
   - Tool execution error handling policy (per-tool try/catch → `is_error` flag)
   - `stream_object()` either in DoD or explicitly deferred
   - Abort signal verification in DoD
   - Build output verification in DoD (ESM/CJS import test)
   - Streaming pause/resume behavior during tool execution — specify exact event sequence
   - Gemini zero-candidates handling
   - `Promise.all()` timeout / individual tool failure behavior
   - CI strategy for integration tests (skip when keys absent, but document manual verification)
