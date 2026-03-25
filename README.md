# Klaus

A TypeScript implementation of the [Attractor](https://github.com/strongdm/attractor) software factory system.

## Packages

| Package | Description | Status |
|---------|-------------|--------|
| [`@klaus/llm-client`](packages/llm-client) | Unified LLM client for Anthropic, OpenAI, and Gemini | Done |
| [`@klaus/agent-loop`](packages/agent-loop) | Coding agent loop | Done |
| [`@klaus/pipeline`](packages/pipeline) | DOT-based pipeline runner | Done |

## Quick Start

```bash
pnpm install
pnpm build
pnpm test
```

## @klaus/llm-client

Provider-agnostic LLM client supporting Anthropic Messages API, OpenAI Responses API, and Gemini native API through a unified interface.

### Setup

```bash
export ANTHROPIC_API_KEY=sk-ant-...
export OPENAI_API_KEY=sk-...
export GEMINI_API_KEY=AI...
```

### Usage

```ts
import { Client, generate, stream } from "@klaus/llm-client";

// Auto-detect providers from environment variables
const client = Client.fromEnv();

// Simple completion
const response = await client.complete({
  model: "claude-sonnet-4-5-20250929",
  messages: [{ role: "user", content: [{ kind: "text", text: "Hello" }] }],
});

// High-level generate with tool execution loop
const result = await generate({
  client,
  model: "claude-sonnet-4-5-20250929",
  prompt: "What's the weather in SF?",
  tools: [{
    name: "get_weather",
    description: "Get weather for a location",
    parameters: {
      type: "object",
      properties: { location: { type: "string" } },
      required: ["location"],
    },
    execute: async (args) => JSON.stringify({ temp: 72, condition: "sunny" }),
  }],
});

// Streaming
const s = stream({ client, model: "gemini-2.0-flash", prompt: "Count to 5" });
for await (const text of s.text_stream) {
  process.stdout.write(text);
}

// Structured output with Zod validation
import { generate_object } from "@klaus/llm-client";
import { z } from "zod";

const obj = await generate_object({
  client,
  model: "gpt-4o-mini",
  prompt: "Extract: John is 30 years old",
  schema: z.object({ name: z.string(), age: z.number() }),
});
console.log(obj.output); // { name: "John", age: 30 }
```

### Features

- **Three providers**: Anthropic, OpenAI, Gemini — each using their native API
- **Unified types**: Single `Request`/`Response`/`StreamEvent` model across all providers
- **Tool execution**: Automatic tool call loop with `Promise.allSettled` concurrency
- **Structured output**: `generate_object()` and `stream_object()` with Zod validation
- **Streaming**: `AsyncIterableIterator<StreamEvent>` with `text_stream` convenience
- **Retry**: Exponential backoff with jitter, Retry-After header support
- **Middleware**: Composable onion-model middleware (logging, caching, etc.)
- **Model catalog**: Built-in model info with `registerModel()` for custom entries
- **Dual output**: ESM + CJS with TypeScript declarations

### Provider Routing

The client routes requests automatically based on model name:

- `claude-*` → Anthropic
- `gpt-*`, `o1-*`, `o3-*` → OpenAI
- `gemini-*` → Gemini

Or set `provider` explicitly on any request.

## @klaus/agent-loop

Provider-aligned coding agent loop with tool execution, output truncation, loop detection, and steering.

### Usage

```ts
import { Session, LocalExecutionEnvironment, anthropicProfile } from "@klaus/agent-loop";
import { Client } from "@klaus/llm-client";

const client = Client.fromEnv();
const env = new LocalExecutionEnvironment("/path/to/project");
await env.initialize();

const session = new Session({
  profile: anthropicProfile(),
  client,
  environment: env,
  config: { max_turns: 10 },
});

const outcome = await session.process_input("Add error handling to the API routes");
console.log(outcome.response); // Assistant's response
```

### Features

- **Provider-aligned profiles**: Anthropic (Claude Code), OpenAI (codex-rs), and Gemini (gemini-cli)
- **7 built-in tools**: read_file, write_file, edit_file, shell, grep, glob, apply_patch
- **Output truncation**: Character-first then line-based, per-tool defaults
- **Loop detection**: Detects repeating tool call patterns (window of 10)
- **Steering & follow-up**: Inject messages into the conversation mid-turn
- **Event system**: Typed events with async iterator support
- **Execution environment**: Sandboxed file I/O and command execution with process groups

## @klaus/pipeline

DOT-based pipeline runner for defining and executing multi-stage workflows.

### Usage

```ts
import { PipelineEngine } from "@klaus/pipeline";

const dot = `
  digraph deploy {
    goal = "Deploy the service"
    Start [shape=Mdiamond]
    Build [prompt="Build the project"]
    Test [prompt="Run test suite"]
    Deploy [prompt="Deploy to production"]
    End [shape=Msquare]

    Start -> Build -> Test -> Deploy -> End
  }
`;

const engine = new PipelineEngine({
  dot,
  backend: myCodergenBackend,
});

const outcome = await engine.run();
```

### Features

- **DOT parser**: Full digraph parsing with attributes, subgraphs, and chained edges
- **9 built-in handlers**: start, exit, codergen, wait.human, conditional, parallel, fan_in, tool, manager_loop
- **5-step edge selection**: condition → preferred label → suggested IDs → weight → lexical
- **Model stylesheets**: CSS-like selectors for node LLM configuration
- **Condition expressions**: `outcome=success`, `context.key!=value`, `&&` conjunction
- **Retry with backoff**: Exponential backoff with jitter, per-node or graph-level config
- **Checkpoints**: Serialize/resume pipeline state
- **Interviewer abstraction**: Human-in-the-loop decision points
- **Graph validation**: Start/exit nodes, reachability, condition syntax

## Development

```bash
pnpm install       # Install dependencies
pnpm build         # Build all packages
pnpm test          # Run unit tests
pnpm lint          # Lint with Biome
pnpm format        # Format with Biome
```

Requires Node >= 22 and pnpm.

## Architecture

```
┌─────────────────────────────────────────────────┐
│  Layer 4: High-Level API                        │
│  generate() | stream() | generate_object()      │
├─────────────────────────────────────────────────┤
│  Layer 3: Core Client + Middleware              │
│  Client class | Provider routing | Middleware   │
├─────────────────────────────────────────────────┤
│  Layer 2: Provider Utilities                    │
│  SSE parser | HTTP helpers | Error mapping      │
├─────────────────────────────────────────────────┤
│  Layer 1: Provider Adapters                     │
│  AnthropicAdapter | OpenAIAdapter | GeminiAdapter│
└─────────────────────────────────────────────────┘
```
