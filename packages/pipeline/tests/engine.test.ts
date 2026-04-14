import { describe, expect, it, vi } from "vitest";
import { PipelineEngine, QueueInterviewer, createAutoApproveInterviewer } from "../src/engine.js";
import type { CodergenBackend, Outcome, PipelineEvent } from "../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockBackend(output: string | Outcome = "Done"): CodergenBackend {
	return {
		run: vi.fn().mockResolvedValue(output),
	};
}

const SIMPLE_DOT = `
digraph Test {
  graph [goal="Test pipeline"]
  start [shape=Mdiamond]
  work [shape=box, prompt="Do work"]
  finish [shape=Msquare]
  start -> work
  work -> finish
}
`;

const CONDITIONAL_DOT = `
digraph Cond {
  graph [goal="Test"]
  start [shape=Mdiamond]
  check [shape=diamond]
  pass [shape=box, prompt="Pass"]
  fail_node [shape=box, prompt="Fail"]
  end [shape=Msquare]
  start -> check
  check -> pass [condition="context.ready=true"]
  check -> fail_node [condition="context.ready=false"]
  pass -> end
  fail_node -> end
}
`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PipelineEngine", () => {
	it("runs a simple 3-node pipeline (start -> work -> finish)", async () => {
		const backend = createMockBackend("Done");
		const engine = new PipelineEngine({ dot: SIMPLE_DOT, backend });

		const outcome = await engine.run();

		expect(outcome).toBeDefined();
		expect(outcome.status).toBe("success");
	});

	it("returns success outcome for completed pipeline", async () => {
		const backend = createMockBackend("All good");
		const engine = new PipelineEngine({ dot: SIMPLE_DOT, backend });

		const outcome = await engine.run();

		expect(outcome.status).toBe("success");
	});

	it("context has graph.goal set", async () => {
		const backend = createMockBackend("Done");
		const engine = new PipelineEngine({ dot: SIMPLE_DOT, backend });

		const ctx = engine.getContext();

		expect(ctx.get("graph.goal")).toBe("Test pipeline");
	});

	it("events are emitted (PipelineStarted, StageStarted, StageCompleted, PipelineCompleted)", async () => {
		const backend = createMockBackend("Done");
		const events: PipelineEvent[] = [];
		const engine = new PipelineEngine({
			dot: SIMPLE_DOT,
			backend,
			on_event: (e) => events.push(e),
		});

		await engine.run();

		const kinds = events.map((e) => e.kind);
		expect(kinds).toContain("PipelineStarted");
		expect(kinds).toContain("StageStarted");
		expect(kinds).toContain("StageCompleted");
		expect(kinds).toContain("PipelineCompleted");
	});

	it("CodergenBackend.run is called for box nodes", async () => {
		const backend = createMockBackend("result");
		const engine = new PipelineEngine({ dot: SIMPLE_DOT, backend });

		await engine.run();

		expect(backend.run).toHaveBeenCalled();
		const call = vi.mocked(backend.run).mock.calls[0];
		expect(call).toBeDefined();
		// The first argument is the node object
		expect(call![0].id).toBe("work");
	});

	it("conditional routing works (diamond node with condition edges)", async () => {
		const backend = createMockBackend({
			status: "success",
			context_updates: { ready: "true" },
		});
		const events: PipelineEvent[] = [];
		const engine = new PipelineEngine({
			dot: CONDITIONAL_DOT,
			backend,
			on_event: (e) => events.push(e),
		});

		// Set ready=true before running so the condition on check->pass fires
		engine.getContext().set("ready", "true");

		const outcome = await engine.run();

		expect(outcome.status).toBe("success");
		// The "pass" node should have been visited
		const stageNames = events.filter((e) => e.kind === "StageStarted").map((e) => e.data.name);
		expect(stageNames).toContain("pass");
		expect(stageNames).not.toContain("fail_node");
	});

	it("custom handler is registered and called", async () => {
		const customHandler = vi.fn().mockResolvedValue({ status: "success" });
		const customDot = `
digraph Custom {
  graph [goal="Custom"]
  start [shape=Mdiamond]
  mynode [type="custom_type", prompt="hello"]
  finish [shape=Msquare]
  start -> mynode
  mynode -> finish
}
`;
		const backend = createMockBackend("Done");
		const engine = new PipelineEngine({
			dot: customDot,
			backend,
			custom_handlers: { custom_type: customHandler },
		});

		await engine.run();

		expect(customHandler).toHaveBeenCalled();
		const ctx = customHandler.mock.calls[0]![0];
		expect(ctx.node.id).toBe("mynode");
	});

	it("QueueInterviewer returns pre-configured answers", async () => {
		const interviewer = new QueueInterviewer([
			{ value: "YES" },
			{ value: "NO" },
			{ value: "maybe" },
		]);

		const a1 = await interviewer.ask({
			text: "Q1",
			type: "YES_NO",
			options: [],
			stage: "s1",
		});
		const a2 = await interviewer.ask({
			text: "Q2",
			type: "YES_NO",
			options: [],
			stage: "s2",
		});
		const a3 = await interviewer.ask({
			text: "Q3",
			type: "FREEFORM",
			options: [],
			stage: "s3",
		});
		const a4 = await interviewer.ask({
			text: "Q4",
			type: "YES_NO",
			options: [],
			stage: "s4",
		});

		expect(a1.value).toBe("YES");
		expect(a2.value).toBe("NO");
		expect(a3.value).toBe("maybe");
		// Exhausted queue returns TIMEOUT
		expect(a4.value).toBe("TIMEOUT");
	});

	it("createAutoApproveInterviewer returns YES for yes/no questions", async () => {
		const interviewer = createAutoApproveInterviewer();

		const answer = await interviewer.ask({
			text: "Proceed?",
			type: "YES_NO",
			options: [],
			stage: "test",
		});

		expect(answer.value).toBe("YES");
	});

	it("pipeline with retry (node returns fail, retries once, then succeeds)", async () => {
		let callCount = 0;
		const backend: CodergenBackend = {
			run: vi.fn().mockImplementation(async () => {
				callCount++;
				if (callCount === 1) {
					return { status: "fail", failure_reason: "transient error" } as Outcome;
				}
				return "OK";
			}),
		};

		const retryDot = `
digraph Retry {
  graph [goal="Retry test"]
  start [shape=Mdiamond]
  flaky [shape=box, prompt="Flaky task", max_retries=1]
  finish [shape=Msquare]
  start -> flaky
  flaky -> finish
}
`;
		const events: PipelineEvent[] = [];
		const engine = new PipelineEngine({
			dot: retryDot,
			backend,
			on_event: (e) => events.push(e),
		});

		const outcome = await engine.run();

		expect(outcome.status).toBe("success");
		expect(backend.run).toHaveBeenCalledTimes(2);

		const retryEvents = events.filter((e) => e.kind === "StageRetrying");
		expect(retryEvents.length).toBeGreaterThanOrEqual(1);
	});

	it("getContext() returns the pipeline context", () => {
		const backend = createMockBackend("Done");
		const engine = new PipelineEngine({ dot: SIMPLE_DOT, backend });

		const ctx = engine.getContext();

		expect(ctx).toBeDefined();
		expect(typeof ctx.get).toBe("function");
		expect(typeof ctx.set).toBe("function");
		expect(ctx.get("graph.goal")).toBe("Test pipeline");
	});

	it("getCheckpoint() returns checkpoint data", async () => {
		const backend = createMockBackend("Done");
		const engine = new PipelineEngine({ dot: SIMPLE_DOT, backend });

		await engine.run();

		const checkpoint = engine.getCheckpoint();

		expect(checkpoint).toBeDefined();
		expect(checkpoint.timestamp).toBeGreaterThan(0);
		expect(Array.isArray(checkpoint.completed_nodes)).toBe(true);
		expect(checkpoint.completed_nodes.length).toBeGreaterThan(0);
		expect(typeof checkpoint.context_values).toBe("object");
		expect(typeof checkpoint.node_retries).toBe("object");
		expect(Array.isArray(checkpoint.logs)).toBe(true);
	});

	// -----------------------------------------------------------------------
	// Parallel fanout
	// -----------------------------------------------------------------------

	it("parallel fanout executes all branches and collects results", async () => {
		const PARALLEL_DOT = `
digraph Parallel {
  graph [goal="Test parallel"]
  Start [shape=Mdiamond]
  Fan [shape=component]
  BranchA [shape=box, prompt="Do A", llm_model="claude-opus-4-6"]
  BranchB [shape=box, prompt="Do B", llm_model="gpt-4o"]
  BranchC [shape=box, prompt="Do C", llm_model="gemini-2.0-flash"]
  Join [shape=tripleoctagon]
  End [shape=Msquare]
  Start -> Fan
  Fan -> BranchA
  Fan -> BranchB
  Fan -> BranchC
  BranchA -> Join
  BranchB -> Join
  BranchC -> Join
  Join -> End
}
`;
		const calledNodes: string[] = [];
		const calledModels: string[] = [];
		const backend: CodergenBackend = {
			run: vi.fn().mockImplementation(async (node) => {
				calledNodes.push(node.id);
				calledModels.push(node.attributes.llm_model ?? "default");
				return `Result from ${node.id}`;
			}),
		};

		const events: PipelineEvent[] = [];
		const engine = new PipelineEngine({
			dot: PARALLEL_DOT,
			backend,
			on_event: (e) => events.push(e),
		});

		const outcome = await engine.run();

		expect(outcome.status).toBe("success");

		// All three branches should have been called.
		expect(calledNodes).toContain("BranchA");
		expect(calledNodes).toContain("BranchB");
		expect(calledNodes).toContain("BranchC");
		expect(calledNodes).toHaveLength(3);

		// Each branch used its per-node model.
		expect(calledModels).toContain("claude-opus-4-6");
		expect(calledModels).toContain("gpt-4o");
		expect(calledModels).toContain("gemini-2.0-flash");

		// Per-branch responses should be in context.
		const ctx = engine.getContext();
		expect(ctx.get("BranchA.response")).toBe("Result from BranchA");
		expect(ctx.get("BranchB.response")).toBe("Result from BranchB");
		expect(ctx.get("BranchC.response")).toBe("Result from BranchC");

		// parallel.results should exist for the fan-in.
		const results = ctx.get("parallel.results") as Array<Record<string, unknown>>;
		expect(results).toHaveLength(3);
		expect(results.every((r) => r.status === "success")).toBe(true);

		// Events should include parallel lifecycle.
		const kinds = events.map((e) => e.kind);
		expect(kinds).toContain("ParallelStarted");
		expect(kinds).toContain("ParallelBranchStarted");
		expect(kinds).toContain("ParallelBranchCompleted");
		expect(kinds).toContain("ParallelCompleted");
	});

	it("parallel fanout respects max_parallel concurrency limit", async () => {
		const PARALLEL_LIMITED_DOT = `
digraph ParallelLimited {
  graph [goal="Test concurrency"]
  Start [shape=Mdiamond]
  Fan [shape=component, max_parallel=1]
  A [shape=box, prompt="A"]
  B [shape=box, prompt="B"]
  C [shape=box, prompt="C"]
  Join [shape=tripleoctagon]
  End [shape=Msquare]
  Start -> Fan
  Fan -> A
  Fan -> B
  Fan -> C
  A -> Join
  B -> Join
  C -> Join
  Join -> End
}
`;
		let currentConcurrency = 0;
		let maxObservedConcurrency = 0;
		const backend: CodergenBackend = {
			run: vi.fn().mockImplementation(async () => {
				currentConcurrency++;
				if (currentConcurrency > maxObservedConcurrency) {
					maxObservedConcurrency = currentConcurrency;
				}
				// Simulate async work so overlapping calls would be detected
				await new Promise((r) => setTimeout(r, 50));
				currentConcurrency--;
				return "OK";
			}),
		};

		const engine = new PipelineEngine({
			dot: PARALLEL_LIMITED_DOT,
			backend,
		});

		const outcome = await engine.run();

		expect(outcome.status).toBe("success");
		// With max_parallel=1, branches must run one at a time.
		expect(maxObservedConcurrency).toBe(1);
		// All three branches still ran.
		expect(backend.run).toHaveBeenCalledTimes(3);
	});

	it("parallel fanout with branch failure yields partial_success", async () => {
		const PARALLEL_FAIL_DOT = `
digraph ParallelFail {
  graph [goal="Test partial"]
  Start [shape=Mdiamond]
  Fan [shape=component]
  Good [shape=box, prompt="OK"]
  Bad [shape=box, prompt="Fail"]
  Join [shape=tripleoctagon]
  End [shape=Msquare]
  Start -> Fan
  Fan -> Good
  Fan -> Bad
  Good -> Join
  Bad -> Join
  Join -> End
}
`;
		const backend: CodergenBackend = {
			run: vi.fn().mockImplementation(async (node) => {
				if (node.id === "Bad") {
					return { status: "fail", failure_reason: "intentional" } as Outcome;
				}
				return "OK";
			}),
		};

		const engine = new PipelineEngine({ dot: PARALLEL_FAIL_DOT, backend });
		const outcome = await engine.run();

		// Fan-in should report partial_success since one branch failed.
		expect(outcome.status).toBe("partial_success");

		const results = engine.getContext().get("parallel.results") as Array<Record<string, unknown>>;
		expect(results).toHaveLength(2);
		const statuses = results.map((r) => r.status);
		expect(statuses).toContain("success");
		expect(statuses).toContain("fail");
	});
});
