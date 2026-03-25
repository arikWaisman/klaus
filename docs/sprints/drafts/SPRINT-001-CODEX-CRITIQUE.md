# Sprint 001 Cross-Critique (Codex Perspective)

## Critique of Claude Draft

### Strengths

1. **Exceptional detail on provider quirks.** The quirks tables for each adapter (Phase 1.3–1.5) are outstanding. Having a row-by-row mapping of Anthropic alternation rules, OpenAI Responses API format, and Gemini synthetic IDs provides clear implementation guidance. This is the most thorough provider-specific documentation across all drafts.

2. **Complete type definitions.** Including full TypeScript type definitions in the draft (not just signatures but field-by-field breakdowns) significantly reduces ambiguity during implementation. The `ContentPart`, `Request`, `Response`, `StreamEvent`, and error hierarchy are all well-specified.

3. **SSE parser implementation included.** Providing the actual `parseSSEStream` implementation with buffer handling, line splitting, and event boundary detection is valuable. This is non-trivial code and having it in the sprint document eliminates a design decision.

4. **Clear middleware type design.** The separation of `CompleteMiddleware` and `StreamMiddleware` is well-reasoned. The onion model is correctly described.

5. **Strong Definition of Done.** 60+ checkboxes organized by category. Very thorough and verifiable.

### Weaknesses

1. **Routing decision contradicts SEED.md.** The Claude draft says "No model-name guessing — the client never infers provider from model string" citing the spec. But SEED.md Section 1.3 explicitly says: "Client class that routes requests to the correct adapter based on request.provider or model name inference." The SEED.md is the project's architecture document and should be followed. Model-name inference (prefix matching) should be included.

2. **Missing `stream_object()`.** SEED.md Section 1.5 calls for `stream_object()` — "streaming structured output with partial object updates." The Claude draft doesn't mention this function at all.

3. **Phase numbering is confusing.** Phases 1.0–1.10 within a sprint called "Phase 1" creates a naming collision with the overall project phases. Should use sub-phase naming like "Step 1.0" or "Task 1.0."

4. **No explicit file for schemas.** Types and Zod schemas are mentioned for the same `types.ts` file. Given the SEED.md decision to use "Zod at boundaries," a separate `schemas.ts` file would be cleaner to separate type definitions from runtime validation.

5. **Test file organization.** All adapter tests are in `packages/llm-client/tests/` flat. For 15 test files, a flat structure is manageable, but the integration tests are in a subdirectory while unit tests aren't. Consider consistent organization.

6. **`stream-accumulator.ts` naming.** SEED.md doesn't mention a separate file for this — it could live in `generate.ts`. Having a separate file is fine but adds a file not in the SEED.md structure.

### Gaps in Risk Analysis

- **No mention of Node.js version compatibility risk.** Node 22 is required for native fetch, but many CI systems and deployment environments may not have Node 22 yet.
- **No risk around dual ESM/CJS output.** This is historically one of the most painful aspects of TypeScript library development. The draft assumes tsup handles it cleanly, but there are known issues with Zod imports in CJS contexts.
- **No risk around `provider_options` type safety.** The escape hatch is `Record<string, unknown>`, which means provider-specific options get no type checking. This is a conscious tradeoff but should be documented as a risk.

### Missing Edge Cases

- **Anthropic: What happens when thinking blocks are present but the model switches?** The spec says "strip signatures and optionally convert the thinking text to a user-visible context message." This cross-model scenario isn't addressed.
- **Tool call with invalid JSON arguments.** What happens when the LLM returns malformed JSON in tool call arguments? Should be caught and surfaced as `InvalidToolCallError`.
- **Empty tool results.** What if a tool's execute handler returns undefined or null?
- **Concurrent tool call failures.** If one of several parallel tool calls fails, does `Promise.all` reject immediately? Should we use `Promise.allSettled` and report mixed results?

### Definition of Done Completeness

Very thorough. Missing:
- [ ] `stream_object()` works with partial object updates
- [ ] Model-name-based routing works (prefix matching)
- [ ] Tool call argument validation (malformed JSON handling)
- [ ] Cross-model thinking block handling

---

## Critique of Gemini Draft

### Strengths

1. **Concise and well-structured.** The draft is significantly shorter than the others but still covers all the essential sections. Good signal-to-noise ratio.

2. **Pragmatic approach.** The draft doesn't over-engineer. It identifies the core work without excessive detail on hypothetical edge cases.

3. **Good use of TypeScript discriminated unions.** The `ContentPart` type uses `{ type: "TEXT" }` discriminant pattern correctly.

4. **Clear phase breakdown.** Four implementation phases (Types, Adapters, Client/Middleware/Errors, High-Level API) is a clean division.

### Weaknesses

1. **Significantly less detailed than other drafts.** The adapter implementation tasks are described in 2-3 bullet points each. For a sprint document that will guide implementation, this is insufficient. The Anthropic adapter alone has 8+ quirks that need explicit handling — the Gemini draft mentions only 4.

2. **Type naming uses UPPER_CASE enums.** The draft uses `"SYSTEM"`, `"USER"`, `"TEXT"`, etc. The SEED.md and upstream spec don't mandate this convention. The Claude and Codex drafts use lowercase strings (`"system"`, `"user"`, `"text"`), which is more idiomatic in TypeScript and avoids the need for an actual enum type.

3. **Missing SSE parser details.** No mention of how SSE parsing will be implemented. This is a critical piece of infrastructure that all three adapters depend on.

4. **Missing `stream_object()`.** Same as the Claude draft — SEED.md calls for this but it's not mentioned.

5. **Incomplete error hierarchy.** The draft mentions `SDKError`, `ProviderError`, `TransientError`, and `ClientError` but doesn't list the full taxonomy (AuthenticationError, AccessDeniedError, RateLimitError, etc.). The upstream spec defines 13+ error types.

6. **No monorepo scaffolding phase.** The draft jumps straight into types without addressing the pnpm workspace, tsconfig, biome, vitest, and tsup configuration that must come first.

7. **Missing model catalog details.** The `catalog.ts` file is mentioned in the Files Summary but no implementation details or catalog entries are described.

8. **`ToolChoice` type is too simplified.** The draft uses `"auto" | "none" | { type: "tool"; name: string }` but misses `"required"` mode, which forces the model to make a tool call (any tool). This is specified in the upstream spec.

### Gaps in Risk Analysis

- **Only 3 risks identified** vs 7 in the Claude draft and 6 in the Codex draft. Missing: API version pinning, abort signal handling, cache breakpoint strategy, model catalog staleness, dual ESM/CJS issues.
- **No likelihood/impact assessment.** The risks are described qualitatively without the structured table format.
- **No mention of Gemini API being in beta.** The `v1beta` endpoint is explicitly a beta, which carries stability risk.

### Missing Edge Cases

- All the same edge cases missing from the Claude draft, plus:
- **No mention of Gemini safety settings.** The Gemini adapter must handle `safetySettings` configuration, but this isn't mentioned.
- **No mention of `reasoning_effort` mapping** for any provider.
- **No mention of `cache_read_tokens`/`cache_write_tokens`** in the Usage type.
- **No `RetryPolicy` type definition** with configurable parameters.

### Definition of Done Completeness

The DoD has 14 items which is significantly fewer than the Claude draft's 60+. Missing categories:
- Individual error type mapping verification
- Retry logic specific tests
- Middleware chain verification
- Model catalog verification
- Build and CI verification
- Streaming lifecycle (start/delta/end) verification
- Prompt normalization verification
- Abort signal verification
