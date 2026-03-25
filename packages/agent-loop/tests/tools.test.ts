import { describe, it, expect, vi, beforeEach } from "vitest";
import {
	readFileTool,
	writeFileTool,
	editFileTool,
	shellTool,
	grepTool,
	globTool,
	applyPatchTool,
} from "../src/tools/core.js";
import { DEFAULT_SESSION_CONFIG } from "../src/types.js";
import type { ExecutionEnvironment, SessionConfig } from "../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockEnv(): ExecutionEnvironment {
	return {
		read_file: vi.fn(),
		write_file: vi.fn(),
		exec_command: vi.fn(),
		grep: vi.fn(),
		glob: vi.fn(),
		file_exists: vi.fn(),
		list_directory: vi.fn(),
		working_directory: vi.fn().mockReturnValue("/test"),
		platform: vi.fn().mockReturnValue("darwin"),
		os_version: vi.fn().mockReturnValue("24.0.0"),
		initialize: vi.fn(),
		cleanup: vi.fn(),
	} as unknown as ExecutionEnvironment;
}

const config: SessionConfig = { ...DEFAULT_SESSION_CONFIG };

// ---------------------------------------------------------------------------
// readFileTool
// ---------------------------------------------------------------------------

describe("readFileTool", () => {
	let mockEnv: ExecutionEnvironment;

	beforeEach(() => {
		mockEnv = createMockEnv();
	});

	it("calls env.read_file with correct args", async () => {
		(mockEnv.read_file as ReturnType<typeof vi.fn>).mockResolvedValue(
			"1\t| line one\n2\t| line two",
		);

		const result = await readFileTool.execute(
			{ file_path: "/test/foo.ts", offset: 5, limit: 20 },
			mockEnv,
			config,
		);

		expect(mockEnv.read_file).toHaveBeenCalledWith("/test/foo.ts", 5, 20);
		expect(result).toBe("1\t| line one\n2\t| line two");
	});

	it("passes undefined offset and limit when not provided", async () => {
		(mockEnv.read_file as ReturnType<typeof vi.fn>).mockResolvedValue("content");

		await readFileTool.execute({ file_path: "/test/bar.ts" }, mockEnv, config);

		expect(mockEnv.read_file).toHaveBeenCalledWith("/test/bar.ts", undefined, undefined);
	});
});

// ---------------------------------------------------------------------------
// writeFileTool
// ---------------------------------------------------------------------------

describe("writeFileTool", () => {
	let mockEnv: ExecutionEnvironment;

	beforeEach(() => {
		mockEnv = createMockEnv();
	});

	it("calls env.write_file and returns byte count message", async () => {
		(mockEnv.write_file as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

		const content = "hello world";
		const result = await writeFileTool.execute(
			{ file_path: "/test/out.txt", content },
			mockEnv,
			config,
		);

		expect(mockEnv.write_file).toHaveBeenCalledWith("/test/out.txt", "hello world");
		const expectedBytes = new TextEncoder().encode(content).length;
		expect(result).toBe(`Wrote ${expectedBytes} bytes to /test/out.txt`);
	});

	it("counts multi-byte characters correctly", async () => {
		(mockEnv.write_file as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

		const content = "\u{1F600}"; // emoji, 4 bytes in UTF-8
		const result = await writeFileTool.execute(
			{ file_path: "/test/emoji.txt", content },
			mockEnv,
			config,
		);

		const expectedBytes = new TextEncoder().encode(content).length;
		expect(expectedBytes).toBe(4);
		expect(result).toContain(`${expectedBytes} bytes`);
	});
});

// ---------------------------------------------------------------------------
// editFileTool
// ---------------------------------------------------------------------------

describe("editFileTool", () => {
	let mockEnv: ExecutionEnvironment;

	beforeEach(() => {
		mockEnv = createMockEnv();
	});

	it("reads file, replaces old_string with new_string, writes back", async () => {
		(mockEnv.read_file as ReturnType<typeof vi.fn>).mockResolvedValue(
			"const x = 1;\nconst y = 2;\n",
		);
		(mockEnv.write_file as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

		const result = await editFileTool.execute(
			{
				file_path: "/test/code.ts",
				old_string: "const x = 1;",
				new_string: "const x = 42;",
			},
			mockEnv,
			config,
		);

		expect(mockEnv.read_file).toHaveBeenCalledWith("/test/code.ts");
		expect(mockEnv.write_file).toHaveBeenCalledWith(
			"/test/code.ts",
			"const x = 42;\nconst y = 2;\n",
		);
		expect(result).toContain("replaced 1 occurrence(s)");
	});

	it("replace_all replaces all occurrences", async () => {
		(mockEnv.read_file as ReturnType<typeof vi.fn>).mockResolvedValue(
			"foo bar foo baz foo",
		);
		(mockEnv.write_file as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

		const result = await editFileTool.execute(
			{
				file_path: "/test/data.txt",
				old_string: "foo",
				new_string: "qux",
				replace_all: true,
			},
			mockEnv,
			config,
		);

		expect(mockEnv.write_file).toHaveBeenCalledWith(
			"/test/data.txt",
			"qux bar qux baz qux",
		);
		expect(result).toContain("replaced 3 occurrence(s)");
	});

	it("throws when old_string not found", async () => {
		(mockEnv.read_file as ReturnType<typeof vi.fn>).mockResolvedValue(
			"const a = 1;",
		);

		await expect(
			editFileTool.execute(
				{
					file_path: "/test/code.ts",
					old_string: "nonexistent string content",
					new_string: "replacement",
				},
				mockEnv,
				config,
			),
		).rejects.toThrow("old_string not found");
	});

	it("falls back to fuzzy match on whitespace differences", async () => {
		(mockEnv.read_file as ReturnType<typeof vi.fn>).mockResolvedValue(
			"function hello()  {\n  return 1;\n}",
		);
		(mockEnv.write_file as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

		// old_string has different whitespace (single space instead of double)
		const result = await editFileTool.execute(
			{
				file_path: "/test/code.ts",
				old_string: "function hello() {\n return 1;\n}",
				new_string: "function hello() {\n  return 42;\n}",
			},
			mockEnv,
			config,
		);

		expect(result).toContain("fuzzy match");
		expect(mockEnv.write_file).toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// shellTool
// ---------------------------------------------------------------------------

describe("shellTool", () => {
	let mockEnv: ExecutionEnvironment;

	beforeEach(() => {
		mockEnv = createMockEnv();
	});

	it("calls env.exec_command with timeout clamped to max", async () => {
		(mockEnv.exec_command as ReturnType<typeof vi.fn>).mockResolvedValue({
			stdout: "hello",
			stderr: "",
			exit_code: 0,
			timed_out: false,
			duration_ms: 50,
		});

		// Request a timeout larger than the max
		const result = await shellTool.execute(
			{ command: "echo hello", timeout_ms: 999_999_999 },
			mockEnv,
			config,
		);

		// Should be clamped to max_command_timeout_ms (600_000)
		expect(mockEnv.exec_command).toHaveBeenCalledWith(
			"echo hello",
			config.max_command_timeout_ms,
		);
		expect(result).toContain("Exit code: 0");
	});

	it("uses default timeout when not specified", async () => {
		(mockEnv.exec_command as ReturnType<typeof vi.fn>).mockResolvedValue({
			stdout: "ok",
			stderr: "",
			exit_code: 0,
			timed_out: false,
			duration_ms: 50,
		});

		await shellTool.execute({ command: "ls" }, mockEnv, config);

		expect(mockEnv.exec_command).toHaveBeenCalledWith(
			"ls",
			config.default_command_timeout_ms,
		);
	});

	it("formats output with exit code, stdout, stderr", async () => {
		(mockEnv.exec_command as ReturnType<typeof vi.fn>).mockResolvedValue({
			stdout: "file1.ts\nfile2.ts",
			stderr: "warning: something",
			exit_code: 0,
			timed_out: false,
			duration_ms: 100,
		});

		const result = await shellTool.execute(
			{ command: "ls" },
			mockEnv,
			config,
		);

		expect(result).toContain("Exit code: 0");
		expect(result).toContain("--- stdout ---");
		expect(result).toContain("file1.ts\nfile2.ts");
		expect(result).toContain("--- stderr ---");
		expect(result).toContain("warning: something");
	});

	it("adds timeout warning when command times out", async () => {
		(mockEnv.exec_command as ReturnType<typeof vi.fn>).mockResolvedValue({
			stdout: "partial",
			stderr: "",
			exit_code: 137,
			timed_out: true,
			duration_ms: 10_000,
		});

		const result = await shellTool.execute(
			{ command: "sleep 9999" },
			mockEnv,
			config,
		);

		expect(result).toContain("Command timed out");
		expect(result).toContain(`${config.default_command_timeout_ms}ms`);
	});
});

// ---------------------------------------------------------------------------
// grepTool
// ---------------------------------------------------------------------------

describe("grepTool", () => {
	let mockEnv: ExecutionEnvironment;

	beforeEach(() => {
		mockEnv = createMockEnv();
	});

	it("calls env.grep with correct options", async () => {
		(mockEnv.grep as ReturnType<typeof vi.fn>).mockResolvedValue(
			"file.ts:10:const foo = bar;",
		);

		const result = await grepTool.execute(
			{
				pattern: "foo.*bar",
				path: "/src",
				glob_filter: "*.ts",
				case_insensitive: true,
				max_results: 50,
			},
			mockEnv,
			config,
		);

		expect(mockEnv.grep).toHaveBeenCalledWith("foo.*bar", "/src", {
			recursive: true,
			case_insensitive: true,
			glob_filter: "*.ts",
			max_results: 50,
		});
		expect(result).toBe("file.ts:10:const foo = bar;");
	});

	it("defaults path to '.' and options to undefined", async () => {
		(mockEnv.grep as ReturnType<typeof vi.fn>).mockResolvedValue("");

		await grepTool.execute({ pattern: "search" }, mockEnv, config);

		expect(mockEnv.grep).toHaveBeenCalledWith("search", ".", {
			recursive: true,
			case_insensitive: undefined,
			glob_filter: undefined,
			max_results: undefined,
		});
	});
});

// ---------------------------------------------------------------------------
// globTool
// ---------------------------------------------------------------------------

describe("globTool", () => {
	let mockEnv: ExecutionEnvironment;

	beforeEach(() => {
		mockEnv = createMockEnv();
	});

	it("calls env.glob and joins results with newlines", async () => {
		(mockEnv.glob as ReturnType<typeof vi.fn>).mockResolvedValue([
			"src/index.ts",
			"src/utils.ts",
			"src/types.ts",
		]);

		const result = await globTool.execute(
			{ pattern: "**/*.ts", path: "/project" },
			mockEnv,
			config,
		);

		expect(mockEnv.glob).toHaveBeenCalledWith("**/*.ts", "/project");
		expect(result).toBe("src/index.ts\nsrc/utils.ts\nsrc/types.ts");
	});

	it("returns empty string when no matches", async () => {
		(mockEnv.glob as ReturnType<typeof vi.fn>).mockResolvedValue([]);

		const result = await globTool.execute(
			{ pattern: "**/*.xyz" },
			mockEnv,
			config,
		);

		expect(mockEnv.glob).toHaveBeenCalledWith("**/*.xyz", undefined);
		expect(result).toBe("");
	});
});

// ---------------------------------------------------------------------------
// applyPatchTool
// ---------------------------------------------------------------------------

describe("applyPatchTool", () => {
	let mockEnv: ExecutionEnvironment;

	beforeEach(() => {
		mockEnv = createMockEnv();
	});

	it("handles Add File operation", async () => {
		(mockEnv.write_file as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

		const patch = [
			"*** Begin Patch",
			"*** Add File: src/new-file.ts",
			"+export const greeting = \"hello\";",
			"+export const farewell = \"goodbye\";",
			"*** End Patch",
		].join("\n");

		const result = await applyPatchTool.execute(
			{ patch },
			mockEnv,
			config,
		);

		expect(mockEnv.write_file).toHaveBeenCalledWith(
			"src/new-file.ts",
			"export const greeting = \"hello\";\nexport const farewell = \"goodbye\";",
		);
		expect(result).toContain("Added file: src/new-file.ts");
	});

	it("handles Delete File operation", async () => {
		(mockEnv.write_file as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

		const patch = [
			"*** Begin Patch",
			"*** Delete File: src/old-file.ts",
			"*** End Patch",
		].join("\n");

		const result = await applyPatchTool.execute(
			{ patch },
			mockEnv,
			config,
		);

		expect(mockEnv.write_file).toHaveBeenCalledWith("src/old-file.ts", "");
		expect(result).toContain("Deleted file: src/old-file.ts");
	});

	it("handles Update File operation with hunks", async () => {
		(mockEnv.read_file as ReturnType<typeof vi.fn>).mockResolvedValue(
			"line1\nline2\nline3\nline4\n",
		);
		(mockEnv.write_file as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

		const patch = [
			"*** Begin Patch",
			"*** Update File: src/code.ts",
			"@@ context",
			" line2",
			"-line3",
			"+line3_modified",
			" line4",
			"*** End Patch",
		].join("\n");

		const result = await applyPatchTool.execute(
			{ patch },
			mockEnv,
			config,
		);

		expect(mockEnv.read_file).toHaveBeenCalledWith("src/code.ts");
		expect(mockEnv.write_file).toHaveBeenCalledWith(
			"src/code.ts",
			"line1\nline2\nline3_modified\nline4\n",
		);
		expect(result).toContain("Updated file: src/code.ts");
		expect(result).toContain("1 hunk(s)");
	});

	it("throws on empty patch with no operations", async () => {
		const patch = [
			"*** Begin Patch",
			"*** End Patch",
		].join("\n");

		await expect(
			applyPatchTool.execute({ patch }, mockEnv, config),
		).rejects.toThrow("No operations found in patch");
	});

	it("throws on patch missing Begin Patch header", async () => {
		const patch = "just some text without patch markers";

		await expect(
			applyPatchTool.execute({ patch }, mockEnv, config),
		).rejects.toThrow("Begin Patch");
	});

	it("handles Move to operation", async () => {
		(mockEnv.read_file as ReturnType<typeof vi.fn>).mockResolvedValue(
			"original content\n",
		);
		(mockEnv.write_file as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

		const patch = [
			"*** Begin Patch",
			"*** Update File: src/old-name.ts",
			"*** Move to: src/new-name.ts",
			"@@ context",
			" original content",
			"*** End Patch",
		].join("\n");

		const result = await applyPatchTool.execute(
			{ patch },
			mockEnv,
			config,
		);

		expect(mockEnv.write_file).toHaveBeenCalledWith(
			"src/new-name.ts",
			"original content\n",
		);
		expect(result).toContain("moved file");
		expect(result).toContain("src/old-name.ts");
		expect(result).toContain("src/new-name.ts");
	});
});
