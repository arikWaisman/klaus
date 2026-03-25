import { describe, it, expect, vi } from "vitest";
import { PipelineEngine, QueueInterviewer, createAutoApproveInterviewer } from "../src/engine.js";
import type { CodergenBackend, PipelineEvent, Outcome } from "../src/types.js";

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
		const stageNames = events
			.filter((e) => e.kind === "StageStarted")
			.map((e) => e.data.name);
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
});
