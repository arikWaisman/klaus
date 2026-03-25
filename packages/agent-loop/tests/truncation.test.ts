import { describe, it, expect } from "vitest";
import {
	truncateChars,
	truncateLines,
	truncateToolOutput,
	DEFAULT_CHAR_LIMITS,
	DEFAULT_LINE_LIMITS,
	TRUNCATION_MODES,
} from "../src/truncation.js";

describe("truncateChars", () => {
	describe("head_tail mode", () => {
		it("returns output unchanged when shorter than limit", () => {
			const output = "short output";
			const result = truncateChars(output, 100, "head_tail");
			expect(result).toBe("short output");
		});

		it("splits at half with warning marker when output exceeds limit", () => {
			const output = "A".repeat(100);
			const result = truncateChars(output, 40, "head_tail");

			// Head half = 20 chars, tail half = 20 chars, 60 removed
			expect(result).toContain("A".repeat(20));
			expect(result).toContain("[WARNING: Tool output was truncated. 60 characters were removed from the middle. Full output available in events.]");
			expect(result.startsWith("A".repeat(20))).toBe(true);
			expect(result.endsWith("A".repeat(20))).toBe(true);
		});
	});

	describe("tail mode", () => {
		it("returns output unchanged when shorter than limit", () => {
			const output = "hello world";
			const result = truncateChars(output, 100, "tail");
			expect(result).toBe("hello world");
		});

		it("keeps tail with warning prefix when output exceeds limit", () => {
			const output = "A".repeat(50) + "B".repeat(50);
			const result = truncateChars(output, 60, "tail");

			// 40 chars removed from the front, last 60 chars kept
			expect(result).toContain("[WARNING: Tool output was truncated. First 40 characters were removed.]");
			expect(result.endsWith("B".repeat(50))).toBe(true);
		});
	});
});

describe("truncateLines", () => {
	it("returns output unchanged when fewer lines than limit", () => {
		const output = "line1\nline2\nline3";
		const result = truncateLines(output, 10);
		expect(result).toBe("line1\nline2\nline3");
	});

	it("splits head/tail with omission marker when more lines than limit", () => {
		const lines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`);
		const output = lines.join("\n");
		const result = truncateLines(output, 6);

		// headCount = 3, tailCount = 3, omitted = 14
		expect(result).toContain("line1");
		expect(result).toContain("line2");
		expect(result).toContain("line3");
		expect(result).toContain("[... 14 lines omitted ...]");
		expect(result).toContain("line18");
		expect(result).toContain("line19");
		expect(result).toContain("line20");
		expect(result).not.toContain("line10");
	});
});

describe("truncateToolOutput", () => {
	it("applies char truncation first, then line truncation", () => {
		// Create short lines so that after char truncation many lines remain
		const lines = Array.from({ length: 500 }, (_, i) => `line-${i}`);
		const output = lines.join("\n");

		// Char limit high enough to keep most content, but line limit is very low
		const result = truncateToolOutput("shell", output, { shell: 100_000 }, { shell: 6 });

		// Char truncation should not fire (output is ~4000 chars < 100_000),
		// but line truncation should fire (500 lines > 6).
		expect(result).toContain("[... ");
		expect(result).toContain(" lines omitted ...]");
		// Head 3 lines preserved
		expect(result).toContain("line-0");
		expect(result).toContain("line-1");
		expect(result).toContain("line-2");
		// Tail 3 lines preserved
		expect(result).toContain("line-499");
		expect(result).toContain("line-498");
		expect(result).toContain("line-497");
	});

	it("uses default limits for known tools", () => {
		const longOutput = "Z".repeat(60_000);
		const result = truncateToolOutput("read_file", longOutput);

		// read_file default char limit is 50_000
		expect(result.length).toBeLessThan(longOutput.length);
		expect(result).toContain("[WARNING: Tool output was truncated.");
	});

	it("allows custom limits to override defaults", () => {
		const output = "A".repeat(500);

		// Default read_file limit is 50_000, override to 100
		const result = truncateToolOutput("read_file", output, { read_file: 100 });

		expect(result).toContain("[WARNING: Tool output was truncated.");
		expect(result).toContain("400 characters were removed from the middle.");
	});

	it("applies no truncation for unknown tool names without custom limits", () => {
		const output = "A".repeat(100_000);
		const result = truncateToolOutput("my_unknown_tool", output);

		expect(result).toBe(output);
	});
});

describe("DEFAULT_CHAR_LIMITS", () => {
	it("has correct values for all known tools", () => {
		expect(DEFAULT_CHAR_LIMITS).toEqual({
			read_file: 50_000,
			shell: 30_000,
			grep: 20_000,
			glob: 20_000,
			edit_file: 10_000,
			apply_patch: 10_000,
			write_file: 1_000,
			spawn_agent: 20_000,
		});
	});
});

describe("DEFAULT_LINE_LIMITS", () => {
	it("has correct values for shell, grep, glob", () => {
		expect(DEFAULT_LINE_LIMITS).toEqual({
			shell: 256,
			grep: 200,
			glob: 500,
		});
	});
});

describe("TRUNCATION_MODES", () => {
	it("has correct modes for all known tools", () => {
		expect(TRUNCATION_MODES).toEqual({
			read_file: "head_tail",
			shell: "head_tail",
			grep: "tail",
			glob: "tail",
			edit_file: "tail",
			apply_patch: "tail",
			write_file: "tail",
			spawn_agent: "head_tail",
		});
	});
});
