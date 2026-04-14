---
"@klaus/llm-client": minor
"@klaus/agent-loop": minor
"@klaus/pipeline": minor
"@klaus/cli": minor
---

## v0.2.0

- Remove fixed model catalog in favor of per-provider default models with runtime override
- Any model string is passed through to the provider API — no validation against a fixed list
- Add `default_model` to `ProviderAdapter` interface, configurable via `ProviderAdapterConfig`
- Add `Client.getDefaultModel()` for querying provider defaults
- Make `GenerateOptions.model` optional (falls back to provider default)
- Implement real parallel branch execution with isolated contexts and fan-in
- Add fidelity system for controlling context passing between pipeline nodes
- Add concurrency control (`max_parallel`) for parallel branches
- Add `~=` (contains) and `!~=` (not contains) condition operators
- Add thread continuity via session registry (nodes sharing `thread_id` reuse sessions)
- Add consensus-loop pipeline example (multi-model debate until unanimous agreement)
- Set up changesets for versioning and release management
