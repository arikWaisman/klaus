import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalExecutionEnvironment } from "../src/environment.js";

describe("LocalExecutionEnvironment", () => {
	let env: LocalExecutionEnvironment;
	let testDir: string;

	beforeEach(() => {
		testDir = join(
			tmpdir(),
			`agent-loop-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		mkdirSync(testDir, { recursive: true });
		env = new LocalExecutionEnvironment(testDir);
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	// -------------------------------------------------------------------
	// Environment info
	// -------------------------------------------------------------------

	describe("working_directory", () => {
		it("returns the configured directory", () => {
			expect(env.working_directory()).toBe(testDir);
		});
	});

	describe("platform", () => {
		it("returns a string", () => {
			const p = env.platform();
			expect(typeof p).toBe("string");
			expect(p.length).toBeGreaterThan(0);
			expect(["darwin", "linux", "win32", "freebsd", "openbsd", "sunos", "aix"]).toContain(p);
		});
	});

	describe("os_version", () => {
		it("returns a string", () => {
			const v = env.os_version();
			expect(typeof v).toBe("string");
			expect(v.length).toBeGreaterThan(0);
		});
	});

	// -------------------------------------------------------------------
	// File I/O
	// -------------------------------------------------------------------

	describe("read_file", () => {
		it("reads a file with line numbers", async () => {
			writeFileSync(join(testDir, "hello.txt"), "line one\nline two\nline three\n");

			const result = await env.read_file("hello.txt");

			expect(result).toContain("line one");
			expect(result).toContain("line two");
			expect(result).toContain("line three");
			// Should include line numbers
			expect(result).toMatch(/1\t\| line one/);
			expect(result).toMatch(/2\t\| line two/);
			expect(result).toMatch(/3\t\| line three/);
		});

		it("supports offset and limit", async () => {
			const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n");
			writeFileSync(join(testDir, "many.txt"), lines);

			// offset=3 means start from line 3, limit=2 means read 2 lines
			const result = await env.read_file("many.txt", 3, 2);

			expect(result).toContain("line 3");
			expect(result).toContain("line 4");
			expect(result).not.toContain("line 1");
			expect(result).not.toContain("line 2");
			expect(result).not.toContain("line 5");
		});
	});

	describe("write_file", () => {
		it("creates file and parent directories", async () => {
			await env.write_file("nested/deep/file.txt", "hello world");

			const exists = await env.file_exists("nested/deep/file.txt");
			expect(exists).toBe(true);

			const content = await env.read_file("nested/deep/file.txt");
			expect(content).toContain("hello world");
		});
	});

	describe("file_exists", () => {
		it("returns true for existing file", async () => {
			writeFileSync(join(testDir, "exists.txt"), "content");
			expect(await env.file_exists("exists.txt")).toBe(true);
		});

		it("returns false for non-existing file", async () => {
			expect(await env.file_exists("does-not-exist.txt")).toBe(false);
		});
	});

	// -------------------------------------------------------------------
	// Directory Listing
	// -------------------------------------------------------------------

	describe("list_directory", () => {
		it("lists files with metadata", async () => {
			writeFileSync(join(testDir, "alpha.txt"), "aaa");
			writeFileSync(join(testDir, "beta.txt"), "bbb");
			mkdirSync(join(testDir, "subdir"));

			const entries = await env.list_directory(".");

			expect(entries.length).toBe(3);

			const names = entries.map((e) => e.name).sort();
			expect(names).toEqual(["alpha.txt", "beta.txt", "subdir"]);

			const subdir = entries.find((e) => e.name === "subdir");
			expect(subdir?.is_directory).toBe(true);

			const alpha = entries.find((e) => e.name === "alpha.txt");
			expect(alpha?.is_directory).toBe(false);
			expect(alpha?.size).toBeGreaterThan(0);
			expect(alpha?.modified).toBeDefined();
			expect(typeof alpha?.modified).toBe("number");
		});
	});

	// -------------------------------------------------------------------
	// Command Execution
	// -------------------------------------------------------------------

	describe("exec_command", () => {
		it("runs a simple command", async () => {
			const result = await env.exec_command('echo "hello"', 5000);

			expect(result.stdout.trim()).toBe("hello");
			expect(result.exit_code).toBe(0);
			expect(result.timed_out).toBe(false);
		});

		it("captures stdout and stderr", async () => {
			const result = await env.exec_command('echo "out" && echo "err" >&2', 5000);

			expect(result.stdout).toContain("out");
			expect(result.stderr).toContain("err");
		});

		it("reports exit code", async () => {
			const result = await env.exec_command("exit 42", 5000);

			expect(result.exit_code).toBe(42);
		});

		it("enforces timeout", async () => {
			const result = await env.exec_command("sleep 60", 200);

			expect(result.timed_out).toBe(true);
			expect(result.duration_ms).toBeLessThan(5000);
		});

		it("filters environment variables containing secrets", async () => {
			// Set a secret-looking env var, then check it is not available
			const original = process.env.MY_API_KEY;
			process.env.MY_API_KEY = "super-secret-value";

			try {
				const result = await env.exec_command("echo $MY_API_KEY", 5000);
				// The secret should be filtered out; stdout should not contain the value
				expect(result.stdout.trim()).not.toBe("super-secret-value");
			} finally {
				if (original === undefined) {
					process.env.MY_API_KEY = undefined;
				} else {
					process.env.MY_API_KEY = original;
				}
			}
		});

		it("reports duration_ms", async () => {
			const result = await env.exec_command("echo fast", 5000);

			expect(result.duration_ms).toBeGreaterThanOrEqual(0);
			expect(typeof result.duration_ms).toBe("number");
		});
	});

	// -------------------------------------------------------------------
	// Glob
	// -------------------------------------------------------------------

	describe("glob", () => {
		it("finds files matching pattern", async () => {
			writeFileSync(join(testDir, "a.ts"), "");
			writeFileSync(join(testDir, "b.ts"), "");
			writeFileSync(join(testDir, "c.js"), "");
			mkdirSync(join(testDir, "sub"));
			writeFileSync(join(testDir, "sub", "d.ts"), "");

			const results = await env.glob("**/*.ts");

			expect(results).toContain("a.ts");
			expect(results).toContain("b.ts");
			expect(results).toContain(join("sub", "d.ts"));
			expect(results).not.toContain("c.js");
		});
	});

	// -------------------------------------------------------------------
	// Grep
	// -------------------------------------------------------------------

	describe("grep", () => {
		it("finds matching content", async () => {
			writeFileSync(join(testDir, "search.txt"), "hello world\nfoo bar\nhello again\n");

			const result = await env.grep("hello", "search.txt");

			expect(result).toContain("hello world");
			expect(result).toContain("hello again");
			expect(result).not.toContain("foo bar");
		});
	});
});
