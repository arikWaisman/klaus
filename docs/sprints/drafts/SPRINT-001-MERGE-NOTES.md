# Sprint 001 Merge Notes

## Draft Strengths

### Claude Draft
- Exceptional provider quirks tables (per-adapter, row-by-row)
- Complete TypeScript type definitions with field-by-field breakdown
- SSE parser implementation provided
- Explicit-only routing (follows spec) — but overridden by user preference for model-name inference
- `kind` discriminant on ContentPart (avoids collision with `type`)
- `FinishReason` as `{ reason, raw? }` object preserving provider's original
- `raw_arguments` on ToolCall for malformed JSON recovery
- Optional `close()`/`initialize()`/`supports_tool_choice()` on ProviderAdapter
- Per-provider quirks tables (excellent implementation reference)
- 60+ DoD checkboxes — most thorough

### Codex Draft
- Best architecture diagram and data flow description
- Clear phase structure with effort estimates
- 8 use cases covering cost tracking and middleware
- Separate SSE/HTTP utilities phase (prevents being buried in adapters)
- `getLatestModel()` in catalog
- Most complete file listing (38 files)
- Good security section covering HTTPS, abort propagation, input validation

### Gemini Draft
- Concise and readable (good signal-to-noise)
- Middleware redaction security requirement (unique contribution)
- Explicit `Client` parameter in high-level API signatures
- Correct identification of core architecture

## Valid Critiques Accepted

1. **Model-name routing**: SEED.md says "model name inference" so we include it (overriding Claude draft's spec-strict position). User confirmed.
2. **`stream_object()` must be included**: SEED.md lists it. All critiques flagged its absence. User confirmed.
3. **Custom SSE parser**: All drafts agree this is ~50 lines and avoids deps. User confirmed.
4. **Scaffold all 3 packages**: Prevents workspace resolution issues. User confirmed.
5. **`kind` discriminant over `type`**: Claude draft's recommendation. Avoids collision with TypeScript utility types.
6. **`FinishReason` as object with `raw`**: Preserves provider's original value. Claude draft's design.
7. **Full error hierarchy (16+ types)**: Gemini draft's 3-type hierarchy is too coarse. Codex/Claude approach adopted.
8. **Middleware redaction**: Gemini draft's unique security contribution. Added to DoD.
9. **`raw_arguments` on ToolCall**: For malformed JSON recovery. Claude draft's contribution.
10. **Gemini API key URL security**: Claude critique flagged this. Added to security section.
11. **Tool execution error handling**: Per-tool try/catch returning `is_error` flag. Critiques flagged missing policy.
12. **Zod `.passthrough()` for flexibility**: Gemini critique flagged brittleness risk. Added as implementation note.
13. **`Retry-After` can be integer seconds OR HTTP date**: Codex critique. Added to retry implementation.

## Valid Critiques Rejected

1. **"Over-specification constrains developers"** (Gemini critique of Claude draft): Disagree — for a greenfield project with 3 complex provider APIs, more specification reduces ambiguity and rework. The types can be refactored during implementation.
2. **"Require JSDoc and README in this sprint"** (Gemini critique): Deferred. This sprint focuses on correct implementation. Documentation can follow once the API stabilizes.
3. **Phase effort estimates are misleading** (Claude critique of Codex): Acknowledged but kept as rough guidance. They're not commitments.

## Interview Refinements

- User confirmed: model-name inference for routing
- User confirmed: include `stream_object()` in scope
- User confirmed: custom SSE parser (zero deps beyond Zod)
- User confirmed: scaffold all three package directories
- User clarified: all three LLM providers are first-class; the library supports all simultaneously

## Final Sprint Structure

Based on the merge, the final sprint uses:
- **Codex draft** as the structural base (phasing, use cases, architecture, file organization)
- **Claude draft** for type definitions, provider quirks tables, and detailed adapter specifications
- **Gemini draft** for middleware redaction security and concise high-level API signatures
- **All critiques** for edge cases, missing DoD items, and risk additions
