import { describe, expect, it, vi } from "vitest";
import { Context } from "../src/context.js";
import {
	HandlerRegistry,
	codergenHandler,
	conditionalHandler,
	exitHandler,
	extractAcceleratorKey,
	parseDuration,
	shapeToType,
	startHandler,
} from "../src/handlers.js";
import type { CodergenBackend, Graph, HandlerContext, Node } from "../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeHandlerContext(overrides: Partial<HandlerContext> = {}): HandlerContext {
	const context = new Context();
	return {
		node: { id: "test", attributes: {} },
		context,
		graph: { name: "test", attributes: {}, nodes: new Map(), edges: [], subgraphs: [] },
		logs_root: "/tmp/test",
		interviewer: { ask: vi.fn().mockResolvedValue({ value: "YES" }) },
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// HandlerRegistry
// ---------------------------------------------------------------------------

describe("HandlerRegistry", () => {
	it("registers and retrieves handlers", () => {
		const registry = new HandlerRegistry();
		const handler = vi.fn().mockResolvedValue({ status: "success" });

		registry.register("my_type", handler);

		expect(registry.get("my_type")).toBe(handler);
	});

	it("resolveType uses explicit type attribute", () => {
		const registry = new HandlerRegistry();
		const node: Node = { id: "n1", attributes: { type: "custom_type", shape: "box" } };

		const resolved = registry.resolveType(node);

		expect(resolved).toBe("custom_type");
	});

	it("resolveType falls back to shape inference", () => {
		const registry = new HandlerRegistry();
		const node: Node = { id: "n1", attributes: { shape: "diamond" } };

		const resolved = registry.resolveType(node);

		expect(resolved).toBe("conditional");
	});
});

// ---------------------------------------------------------------------------
// shapeToType
// ---------------------------------------------------------------------------

describe("shapeToType", () => {
	it("maps all shapes correctly", () => {
		expect(shapeToType("mdiamond")).toBe("start");
		expect(shapeToType("Mdiamond")).toBe("start");
		expect(shapeToType("msquare")).toBe("exit");
		expect(shapeToType("Msquare")).toBe("exit");
		expect(shapeToType("hexagon")).toBe("wait.human");
		expect(shapeToType("diamond")).toBe("conditional");
		expect(shapeToType("component")).toBe("parallel");
		expect(shapeToType("tripleoctagon")).toBe("parallel.fan_in");
		expect(shapeToType("parallelogram")).toBe("tool");
		expect(shapeToType("house")).toBe("stack.manager_loop");
		expect(shapeToType("box")).toBe("codergen");
		expect(shapeToType(undefined)).toBe("codergen");
		expect(shapeToType("unknown_shape")).toBe("codergen");
	});
});

// ---------------------------------------------------------------------------
// Built-in handlers
// ---------------------------------------------------------------------------

describe("startHandler", () => {
	it("returns success", async () => {
		const ctx = makeHandlerContext();
		const outcome = await startHandler(ctx);

		expect(outcome.status).toBe("success");
	});
});

describe("exitHandler", () => {
	it("returns success", async () => {
		const ctx = makeHandlerContext();
		const outcome = await exitHandler(ctx);

		expect(outcome.status).toBe("success");
	});
});

describe("conditionalHandler", () => {
	it("returns success (pass-through)", async () => {
		const ctx = makeHandlerContext();
		const outcome = await conditionalHandler(ctx);

		expect(outcome.status).toBe("success");
	});
});

// ---------------------------------------------------------------------------
// extractAcceleratorKey
// ---------------------------------------------------------------------------

describe("extractAcceleratorKey", () => {
	it("extracts [Y] pattern", () => {
		expect(extractAcceleratorKey("[Y] Yes")).toBe("Y");
		expect(extractAcceleratorKey("Choose [A] option")).toBe("A");
	});

	it("extracts Y) pattern", () => {
		expect(extractAcceleratorKey("Y) Yes, proceed")).toBe("Y");
		expect(extractAcceleratorKey("N) No, cancel")).toBe("N");
	});

	it("extracts Y - pattern", () => {
		expect(extractAcceleratorKey("Y - Yes")).toBe("Y");
		expect(extractAcceleratorKey("N - No")).toBe("N");
		expect(extractAcceleratorKey("A-Accept")).toBe("A");
	});

	it("returns null for no match", () => {
		expect(extractAcceleratorKey("No accelerator here")).toBeNull();
		expect(extractAcceleratorKey("")).toBeNull();
		expect(extractAcceleratorKey("Just a label")).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// parseDuration
// ---------------------------------------------------------------------------

describe("parseDuration", () => {
	it("parses seconds, minutes, milliseconds", () => {
		expect(parseDuration("5s")).toBe(5000);
		expect(parseDuration("2m")).toBe(120_000);
		expect(parseDuration("500ms")).toBe(500);
		expect(parseDuration("1h")).toBe(3_600_000);
		expect(parseDuration("1d")).toBe(86_400_000);
		expect(parseDuration("1.5s")).toBe(1500);
	});

	it("returns null for invalid input", () => {
		expect(parseDuration(undefined)).toBeNull();
		expect(parseDuration("")).toBeNull();
		expect(parseDuration("abc")).toBeNull();
		expect(parseDuration("10")).toBeNull();
		expect(parseDuration("10x")).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// codergenHandler
// ---------------------------------------------------------------------------

describe("codergenHandler", () => {
	it("calls backend and returns response", async () => {
		const mockBackend: CodergenBackend = {
			run: vi.fn().mockResolvedValue("Generated code output"),
		};
		const context = new Context();
		context.set("__backend", mockBackend);

		const ctx = makeHandlerContext({
			node: { id: "gen", attributes: { prompt: "Write code" } },
			context,
		});

		const outcome = await codergenHandler(ctx);

		expect(outcome.status).toBe("success");
		expect(outcome.notes).toBe("Generated code output");
		expect(outcome.context_updates).toEqual({ "gen.response": "Generated code output" });
		expect(mockBackend.run).toHaveBeenCalledWith(ctx.node, "Write code", context);
	});

	it("expands $goal in prompt", async () => {
		const mockBackend: CodergenBackend = {
			run: vi.fn().mockResolvedValue("OK"),
		};
		const context = new Context();
		context.set("__backend", mockBackend);
		context.set("graph.goal", "Build a REST API");

		const ctx = makeHandlerContext({
			node: { id: "work", attributes: { prompt: "Implement $goal with tests" } },
			context,
		});

		await codergenHandler(ctx);

		expect(mockBackend.run).toHaveBeenCalledWith(
			ctx.node,
			"Implement Build a REST API with tests",
			context,
		);
	});

	it("returns fail when no backend is configured", async () => {
		const context = new Context();
		// No __backend set

		const ctx = makeHandlerContext({
			node: { id: "work", attributes: { prompt: "Do something" } },
			context,
		});

		const outcome = await codergenHandler(ctx);

		expect(outcome.status).toBe("fail");
		expect(outcome.failure_reason).toBe("No CodergenBackend configured");
	});

	it("returns backend Outcome directly when backend returns Outcome", async () => {
		const backendOutcome = {
			status: "success" as const,
			notes: "Custom outcome",
			context_updates: { foo: "bar" },
		};
		const mockBackend: CodergenBackend = {
			run: vi.fn().mockResolvedValue(backendOutcome),
		};
		const context = new Context();
		context.set("__backend", mockBackend);

		const ctx = makeHandlerContext({
			node: { id: "work", attributes: { prompt: "Do it" } },
			context,
		});

		const outcome = await codergenHandler(ctx);

		expect(outcome).toBe(backendOutcome);
	});
});
