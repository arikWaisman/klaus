import { describe, it, expect } from "vitest";
import { createAnthropicProfile } from "../src/profiles/anthropic.js";
import { createOpenAIProfile } from "../src/profiles/openai.js";
import { createGeminiProfile } from "../src/profiles/gemini.js";
import type { ExecutionEnvironment, ProviderProfile } from "../src/types.js";

const mockEnv = {
	working_directory: () => "/test/project",
	platform: () => "darwin",
	os_version: () => "24.0.0",
	read_file: async () => "",
	write_file: async () => {},
	file_exists: async () => false,
	list_directory: async () => [],
	exec_command: async () => ({
		stdout: "",
		stderr: "",
		exit_code: 0,
		timed_out: false,
		duration_ms: 0,
	}),
	grep: async () => "",
	glob: async () => [],
	initialize: async () => {},
	cleanup: async () => {},
} as unknown as ExecutionEnvironment;

// -------------------------------------------------------------------
// Anthropic
// -------------------------------------------------------------------

describe("Anthropic profile", () => {
	const profile = createAnthropicProfile("claude-sonnet-4-20250514");

	it("has correct id and provider", () => {
		expect(profile.id).toBe("anthropic");
		expect(profile.provider).toBe("anthropic");
	});

	it("registers correct tools", () => {
		const toolNames = Array.from(profile.tool_executors.keys());

		expect(toolNames).toContain("read_file");
		expect(toolNames).toContain("write_file");
		expect(toolNames).toContain("edit_file");
		expect(toolNames).toContain("shell");
		expect(toolNames).toContain("grep");
		expect(toolNames).toContain("glob");
	});

	it("does NOT have apply_patch", () => {
		const toolNames = Array.from(profile.tool_executors.keys());
		expect(toolNames).not.toContain("apply_patch");
	});

	it("supports_reasoning is true", () => {
		expect(profile.supports_reasoning).toBe(true);
	});

	it("context_window_size is 200_000", () => {
		expect(profile.context_window_size).toBe(200_000);
	});
});

// -------------------------------------------------------------------
// OpenAI
// -------------------------------------------------------------------

describe("OpenAI profile", () => {
	const profile = createOpenAIProfile("o3-mini");

	it("has correct id and provider", () => {
		expect(profile.id).toBe("openai");
		expect(profile.provider).toBe("openai");
	});

	it("registers apply_patch instead of edit_file", () => {
		const toolNames = Array.from(profile.tool_executors.keys());

		expect(toolNames).toContain("apply_patch");
		expect(toolNames).not.toContain("edit_file");
	});

	it("context_window_size is 128_000", () => {
		expect(profile.context_window_size).toBe(128_000);
	});
});

// -------------------------------------------------------------------
// Gemini
// -------------------------------------------------------------------

describe("Gemini profile", () => {
	const profile = createGeminiProfile("gemini-2.5-pro");

	it("has correct id and provider", () => {
		expect(profile.id).toBe("gemini");
		expect(profile.provider).toBe("gemini");
	});

	it("registers edit_file (not apply_patch)", () => {
		const toolNames = Array.from(profile.tool_executors.keys());

		expect(toolNames).toContain("edit_file");
		expect(toolNames).not.toContain("apply_patch");
	});

	it("context_window_size is 1_000_000", () => {
		expect(profile.context_window_size).toBe(1_000_000);
	});
});

// -------------------------------------------------------------------
// Cross-profile: system prompt
// -------------------------------------------------------------------

describe("All profiles build_system_prompt", () => {
	const profiles: [string, ProviderProfile][] = [
		["anthropic", createAnthropicProfile("claude-sonnet-4-20250514")],
		["openai", createOpenAIProfile("o3-mini")],
		["gemini", createGeminiProfile("gemini-2.5-pro")],
	];

	for (const [name, profile] of profiles) {
		it(`${name} system prompt includes environment block`, () => {
			const prompt = profile.build_system_prompt(mockEnv, "");

			expect(prompt).toContain("<environment>");
			expect(prompt).toContain("</environment>");
			expect(prompt).toContain("Working directory: /test/project");
			expect(prompt).toContain("Platform: darwin");
			expect(prompt).toContain("OS version: 24.0.0");
		});
	}
});

// -------------------------------------------------------------------
// Cross-profile: tools() returns ToolSchema[]
// -------------------------------------------------------------------

describe("All profiles tools() returns ToolSchema[]", () => {
	const profiles: [string, ProviderProfile][] = [
		["anthropic", createAnthropicProfile("claude-sonnet-4-20250514")],
		["openai", createOpenAIProfile("o3-mini")],
		["gemini", createGeminiProfile("gemini-2.5-pro")],
	];

	for (const [name, profile] of profiles) {
		it(`${name} tools() returns schemas matching registered tool names`, () => {
			const schemas = profile.tools();
			const schemaNames = schemas.map((s) => s.name).sort();
			const registeredNames = Array.from(profile.tool_executors.keys()).sort();

			expect(schemaNames).toEqual(registeredNames);

			// Each schema should have name, description, and parameters
			for (const schema of schemas) {
				expect(typeof schema.name).toBe("string");
				expect(schema.name.length).toBeGreaterThan(0);
				expect(typeof schema.description).toBe("string");
				expect(schema.description.length).toBeGreaterThan(0);
				expect(schema.parameters).toBeDefined();
				expect(typeof schema.parameters).toBe("object");
			}
		});
	}
});
