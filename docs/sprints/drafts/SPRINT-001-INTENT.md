# Sprint 001 Intent: Klaus Phase 1 — Unified LLM Client

## Seed

Implement the Klaus project as defined in SEED.md — a TypeScript implementation of the Attractor software factory system. This sprint focuses on **Phase 1: the Unified LLM Client (`@klaus/llm-client`)**, which is the foundation with zero internal dependencies.

The upstream specification is [unified-llm-spec.md](https://github.com/strongdm/attractor/blob/main/unified-llm-spec.md).

## Context

- **Greenfield project** — only `SEED.md` exists. No code, git repo, or configuration yet.
- **No recent work** — this is the initial implementation sprint.
- **Three packages planned** in a pnpm monorepo: `@klaus/llm-client` (this sprint), `@klaus/agent-loop` (Phase 2), `@klaus/pipeline` (Phase 3).
- **Tech stack locked**: TypeScript strict mode, Node.js >= 22, pnpm workspaces, tsup build, Vitest testing, Biome lint/format.
- **Design decisions made**: ESM-first, no classes for data, Zod at boundaries, real provider APIs (no LCD abstraction), AsyncIterator for streaming.

## Recent Sprint Context

None — this is Sprint 001.

## Relevant Codebase Areas

This sprint creates the entire `packages/llm-client/` directory from scratch:

```
packages/llm-client/
├── src/
│   ├── client.ts          — Core Client class (complete, stream, routing)
│   ├── types.ts           — All shared types (Message, Request, Response, etc.)
│   ├── adapters/
│   │   ├── adapter.ts     — ProviderAdapter interface
│   │   ├── anthropic.ts   — Anthropic Messages API adapter
│   │   ├── openai.ts      — OpenAI Responses API adapter
│   │   └── gemini.ts      — Gemini native API adapter
│   ├── middleware.ts       — Middleware/interceptor chain (onion model)
│   ├── generate.ts        — High-level generate(), stream(), generate_object()
│   ├── retry.ts           — Retry policy with exponential backoff + jitter
│   ├── errors.ts          — SDKError hierarchy
│   ├── catalog.ts         — Model catalog with ModelInfo records
│   └── index.ts           — Public API exports
├── tests/
└── package.json
```

Plus monorepo root configuration: `pnpm-workspace.yaml`, `tsconfig.json`, `biome.json`, `vitest.config.ts`.

## Constraints

- **Must use each provider's native API**: Anthropic Messages API, OpenAI Responses API (NOT Chat Completions), Gemini native API.
- **ESM-first** with CJS compatibility via tsup dual output. Internal imports use `.js` extensions.
- **No classes for data** — plain objects + TypeScript interfaces for Message, Request, Response, etc. Classes only for stateful things (Client, adapters).
- **Zod at boundaries** — validate API responses, tool arguments. Internal code trusts its own types.
- **Native fetch only** — no HTTP client dependencies. Streaming via ReadableStream/SSE parsing.
- **Strict TypeScript** — `strict: true` in tsconfig.

## Success Criteria

1. A working `Client` that routes requests to the correct provider adapter based on model name or explicit provider field.
2. All three provider adapters (Anthropic, OpenAI, Gemini) handle: simple text completion, tool use, streaming, and provider-specific features (thinking blocks, reasoning tokens, synthetic tool IDs).
3. High-level `generate()` with automatic tool execution loop works across all providers.
4. High-level `stream()` returns `StreamResult` with async iterable events.
5. `generate_object()` produces validated structured output.
6. Retry logic correctly retries 429/5xx and does not retry 400/401.
7. Complete error taxonomy maps HTTP status codes to typed errors.
8. Middleware chain works (logging middleware as proof).
9. Model catalog returns info for current models.
10. Unit tests pass for all adapters (mocked HTTP). Integration tests work with real API keys.

## Verification Strategy

- **Spec conformance**: Every item in the unified-llm-spec.md Definition of Done must be checked off.
- **Unit tests**: Each adapter tested with mocked HTTP responses for all supported operations (text, tools, streaming, errors).
- **Integration tests**: Real API calls gated behind `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY` env vars.
- **Edge cases**:
  - Anthropic strict message alternation enforcement
  - OpenAI Responses API format (NOT Chat Completions)
  - Gemini synthetic tool call ID generation
  - Thinking block round-tripping (Anthropic)
  - Prompt caching headers (Anthropic cache_control)
  - Reasoning token reporting (OpenAI via output_tokens_details)
  - Stream interruption and accumulation
  - Parallel tool execution (concurrent, all-or-nothing)
  - Abort signal cancellation
- **Testing approach**: Vitest with mocked fetch for unit tests. Separate integration test files that skip when API keys are absent.

## Uncertainty Assessment

- **Correctness uncertainty: Medium** — The spec is detailed but provider APIs have quirks not fully captured. Real API testing is essential.
- **Scope uncertainty: Low** — The SEED.md and upstream spec clearly bound what's needed. This is Phase 1 only.
- **Architecture uncertainty: Low** — The SEED.md makes explicit architecture decisions (4 layers, adapter pattern, middleware, etc.).

## Open Questions

1. **OpenAI Responses API specifics**: The Responses API is relatively new. What's the exact format for tool calls and results? Should we support both Responses API and Chat Completions as a fallback?
2. **Gemini API authentication**: Direct API key in URL vs. OAuth? The spec says native API — confirm the exact endpoint and auth pattern.
3. **Streaming SSE parsing**: Should we write a custom SSE parser or use a library like `eventsource-parser`? The spec says "no deps beyond HTTP and JSON" but an SSE parser is utility-level.
4. **Provider-specific model detection**: How should model name routing work? Prefix matching (e.g., `claude-*` → Anthropic, `gpt-*` → OpenAI, `gemini-*` → Gemini)?
5. **Cache control auto-injection**: The spec recommends auto-injecting Anthropic cache breakpoints. What's the right heuristic for breakpoint placement?
6. **Monorepo initial setup**: Should all three package directories be scaffolded in this sprint, or only `llm-client`?
