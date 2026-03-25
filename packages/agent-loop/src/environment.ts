import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { platform as osPlatform, release as osRelease } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import type { DirEntry, ExecResult, ExecutionEnvironment, GrepOptions } from "./types.js";

// Keys in the environment that should always be preserved even when filtering
// out secrets.
const SAFE_ENV_KEYS = new Set([
	"PATH",
	"HOME",
	"USER",
	"SHELL",
	"LANG",
	"TERM",
	"TMPDIR",
	"EDITOR",
	"NODE_PATH",
	"GOPATH",
	"PYTHONPATH",
	"RUBY_PATH",
	"JAVA_HOME",
	"RUSTUP_HOME",
	"CARGO_HOME",
]);

const SECRET_PATTERN = /(_API_KEY|_SECRET|_TOKEN|_PASSWORD)$/i;

/**
 * Filter the current process environment to remove likely secrets while
 * keeping PATH and other essential variables.
 */
function buildSafeEnv(extra?: Record<string, string>): Record<string, string | undefined> {
	const base: Record<string, string | undefined> = {};

	for (const [key, value] of Object.entries(process.env)) {
		if (SAFE_ENV_KEYS.has(key) || !SECRET_PATTERN.test(key)) {
			base[key] = value;
		}
	}

	if (extra) {
		for (const [key, value] of Object.entries(extra)) {
			base[key] = value;
		}
	}

	return base;
}

/**
 * Minimatch-style glob matching. Supports `*`, `**`, and `?` wildcards.
 * Returns true when `name` matches the given `pattern`.
 */
function globMatch(pattern: string, name: string): boolean {
	// Convert glob pattern to a regular expression
	let regex = "^";
	let i = 0;
	while (i < pattern.length) {
		const ch = pattern[i]!;
		if (ch === "*") {
			if (pattern[i + 1] === "*") {
				// "**" matches everything including path separators
				if (pattern[i + 2] === "/") {
					regex += "(?:.*/)?";
					i += 3;
				} else {
					regex += ".*";
					i += 2;
				}
			} else {
				// "*" matches anything except "/"
				regex += "[^/]*";
				i += 1;
			}
		} else if (ch === "?") {
			regex += "[^/]";
			i += 1;
		} else if (ch === "{") {
			regex += "(?:";
			i += 1;
		} else if (ch === "}") {
			regex += ")";
			i += 1;
		} else if (ch === ",") {
			// Inside a brace expression, comma means alternation
			regex += "|";
			i += 1;
		} else if (".+^$|()[]\\".includes(ch)) {
			regex += `\\${ch}`;
			i += 1;
		} else {
			regex += ch;
			i += 1;
		}
	}
	regex += "$";

	return new RegExp(regex).test(name);
}

export class LocalExecutionEnvironment implements ExecutionEnvironment {
	private cwd: string;

	constructor(working_directory: string) {
		this.cwd = resolve(working_directory);
	}

	// -----------------------------------------------------------------------
	// File I/O
	// -----------------------------------------------------------------------

	async read_file(path: string, offset?: number, limit?: number): Promise<string> {
		const resolved = resolve(this.cwd, path);
		const content = await readFile(resolved, "utf-8");
		let lines = content.split("\n");

		// offset is 1-indexed (line number to start from)
		const startLine = offset !== undefined && offset > 0 ? offset - 1 : 0;
		if (startLine > 0) {
			lines = lines.slice(startLine);
		}

		if (limit !== undefined && limit > 0) {
			lines = lines.slice(0, limit);
		}

		// Format with line numbers: right-aligned "  NNN\t| content"
		const firstLineNum = startLine + 1;
		const lastLineNum = firstLineNum + lines.length - 1;
		const padWidth = String(lastLineNum).length;

		const numbered = lines.map((line, idx) => {
			const lineNum = String(firstLineNum + idx).padStart(padWidth, " ");
			return `${lineNum}\t| ${line}`;
		});

		return numbered.join("\n");
	}

	async write_file(path: string, content: string): Promise<void> {
		const resolved = resolve(this.cwd, path);
		const dir = dirname(resolved);
		await mkdir(dir, { recursive: true });
		await writeFile(resolved, content, "utf-8");
	}

	async file_exists(path: string): Promise<boolean> {
		const resolved = resolve(this.cwd, path);
		return existsSync(resolved);
	}

	// -----------------------------------------------------------------------
	// Directory Listing
	// -----------------------------------------------------------------------

	async list_directory(path: string, depth = 1): Promise<DirEntry[]> {
		const resolved = resolve(this.cwd, path);
		const entries: DirEntry[] = [];

		const dirents = await readdir(resolved, { withFileTypes: true });
		for (const dirent of dirents) {
			const fullPath = join(resolved, dirent.name);
			let size: number | undefined;
			let modified: number | undefined;

			try {
				const st = await stat(fullPath);
				size = st.size;
				modified = st.mtimeMs;
			} catch {
				// stat may fail for broken symlinks, etc.
			}

			const isDir = dirent.isDirectory();
			entries.push({
				name: dirent.name,
				is_directory: isDir,
				size,
				modified,
			});

			if (isDir && depth > 1) {
				try {
					const children = await this.list_directory(fullPath, depth - 1);
					for (const child of children) {
						entries.push({
							...child,
							name: join(dirent.name, child.name),
						});
					}
				} catch {
					// Permission errors or other issues reading sub-directories
				}
			}
		}

		return entries;
	}

	// -----------------------------------------------------------------------
	// Command Execution
	// -----------------------------------------------------------------------

	async exec_command(
		command: string,
		timeout_ms: number,
		working_dir?: string,
		env_vars?: Record<string, string>,
	): Promise<ExecResult> {
		const cwd = working_dir ? resolve(this.cwd, working_dir) : this.cwd;
		const env = buildSafeEnv(env_vars);

		const shell = osPlatform() === "win32" ? "cmd.exe" : "/bin/bash";
		const shellArgs = osPlatform() === "win32" ? ["/c", command] : ["-c", command];

		return new Promise<ExecResult>((resolvePromise) => {
			const start = Date.now();

			const child: ChildProcess = spawn(shell, shellArgs, {
				cwd,
				env: env as NodeJS.ProcessEnv,
				detached: osPlatform() !== "win32",
				stdio: ["ignore", "pipe", "pipe"],
			});

			let stdout = "";
			let stderr = "";
			let finished = false;
			let timedOut = false;

			child.stdout?.on("data", (chunk: Buffer) => {
				stdout += chunk.toString();
			});

			child.stderr?.on("data", (chunk: Buffer) => {
				stderr += chunk.toString();
			});

			const finish = (exitCode: number | null) => {
				if (finished) return;
				finished = true;
				clearTimeout(timer);
				clearTimeout(killTimer);

				resolvePromise({
					stdout,
					stderr,
					exit_code: exitCode ?? (timedOut ? 137 : 1),
					timed_out: timedOut,
					duration_ms: Date.now() - start,
				});
			};

			child.on("close", (code) => {
				finish(code);
			});

			child.on("error", (err) => {
				stderr += err.message;
				finish(1);
			});

			// Timeout handling: SIGTERM first, then SIGKILL after 2 seconds
			let killTimer: ReturnType<typeof setTimeout>;

			const timer = setTimeout(() => {
				timedOut = true;

				if (child.pid) {
					try {
						// Kill the entire process group
						process.kill(-child.pid, "SIGTERM");
					} catch {
						// Process may already be gone
						try {
							child.kill("SIGTERM");
						} catch {
							// ignore
						}
					}
				}

				killTimer = setTimeout(() => {
					if (!finished && child.pid) {
						try {
							process.kill(-child.pid, "SIGKILL");
						} catch {
							try {
								child.kill("SIGKILL");
							} catch {
								// ignore
							}
						}
					}
				}, 2000);
			}, timeout_ms);
		});
	}

	// -----------------------------------------------------------------------
	// Grep
	// -----------------------------------------------------------------------

	async grep(pattern: string, path: string, options?: GrepOptions): Promise<string> {
		const resolved = resolve(this.cwd, path);
		const args: string[] = [];

		const recursive = options?.recursive !== false;
		if (recursive) {
			args.push("-rn");
		} else {
			args.push("-n");
		}

		if (options?.case_insensitive) {
			args.push("-i");
		}

		if (options?.max_results !== undefined && options.max_results > 0) {
			args.push("-m", String(options.max_results));
		}

		if (options?.glob_filter) {
			args.push("--include", options.glob_filter);
		}

		// Escape the pattern for safe shell usage by using -- to signal end of
		// flags, and single-quoting the pattern.
		const escapedPattern = pattern.replace(/'/g, "'\\''");
		const cmd = `grep ${args.join(" ")} -- '${escapedPattern}' ${JSON.stringify(resolved)}`;

		const result = await this.exec_command(cmd, 30_000);

		// grep returns exit code 1 when no matches found, which is not an error
		if (result.exit_code > 1) {
			throw new Error(`grep failed: ${result.stderr}`);
		}

		return result.stdout;
	}

	// -----------------------------------------------------------------------
	// Glob
	// -----------------------------------------------------------------------

	async glob(pattern: string, path?: string): Promise<string[]> {
		const basePath = path ? resolve(this.cwd, path) : this.cwd;
		const results: Array<{ path: string; mtime: number }> = [];

		const walk = (dir: string): void => {
			let entries: import("node:fs").Dirent[];
			try {
				entries = readdirSync(dir, {
					withFileTypes: true,
					encoding: "utf-8",
				}) as import("node:fs").Dirent[];
			} catch {
				return;
			}

			for (const entry of entries) {
				const fullPath = join(dir, entry.name);
				const rel = relative(basePath, fullPath);

				// Skip hidden directories for performance (unless pattern
				// explicitly starts with a dot).
				if (entry.isDirectory() && entry.name.startsWith(".") && !pattern.startsWith(".")) {
					continue;
				}

				if (globMatch(pattern, rel)) {
					try {
						const st = statSync(fullPath);
						results.push({ path: rel, mtime: st.mtimeMs });
					} catch {
						results.push({ path: rel, mtime: 0 });
					}
				}

				if (entry.isDirectory()) {
					walk(fullPath);
				}
			}
		};

		walk(basePath);

		// Sort by modification time, newest first
		results.sort((a, b) => b.mtime - a.mtime);

		return results.map((r) => r.path);
	}

	// -----------------------------------------------------------------------
	// Lifecycle
	// -----------------------------------------------------------------------

	async initialize(): Promise<void> {
		// No-op for local environment
	}

	async cleanup(): Promise<void> {
		// No-op for local environment
	}

	// -----------------------------------------------------------------------
	// Environment info
	// -----------------------------------------------------------------------

	working_directory(): string {
		return this.cwd;
	}

	platform(): string {
		return osPlatform();
	}

	os_version(): string {
		return osRelease();
	}
}
