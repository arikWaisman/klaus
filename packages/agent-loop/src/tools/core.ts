import type { ExecutionEnvironment, SessionConfig, ToolExecutor } from "../types.js";

// ---------------------------------------------------------------------------
// read_file
// ---------------------------------------------------------------------------

export const readFileTool: ToolExecutor = {
	schema: {
		name: "read_file",
		description:
			"Read the contents of a file. Returns line-numbered content. " +
			"Use offset and limit to read specific ranges of large files.",
		parameters: {
			type: "object",
			properties: {
				file_path: {
					type: "string",
					description: "Absolute path to the file to read.",
				},
				offset: {
					type: "integer",
					description: "Line number to start reading from (1-based).",
				},
				limit: {
					type: "integer",
					description: "Maximum number of lines to read.",
				},
			},
			required: ["file_path"],
			additionalProperties: false,
		},
	},

	async execute(args: Record<string, unknown>, env: ExecutionEnvironment): Promise<string> {
		const filePath = args.file_path as string;
		const offset = args.offset as number | undefined;
		const limit = args.limit as number | undefined;
		return env.read_file(filePath, offset, limit);
	},
};

// ---------------------------------------------------------------------------
// write_file
// ---------------------------------------------------------------------------

export const writeFileTool: ToolExecutor = {
	schema: {
		name: "write_file",
		description: "Write content to a file, creating it if it does not exist or overwriting it.",
		parameters: {
			type: "object",
			properties: {
				file_path: {
					type: "string",
					description: "Absolute path to the file to write.",
				},
				content: {
					type: "string",
					description: "The full content to write to the file.",
				},
			},
			required: ["file_path", "content"],
			additionalProperties: false,
		},
	},

	async execute(args: Record<string, unknown>, env: ExecutionEnvironment): Promise<string> {
		const filePath = args.file_path as string;
		const content = args.content as string;
		await env.write_file(filePath, content);
		const byteLength = new TextEncoder().encode(content).length;
		return `Wrote ${byteLength} bytes to ${filePath}`;
	},
};

// ---------------------------------------------------------------------------
// edit_file (Anthropic/Gemini style -- old_string/new_string)
// ---------------------------------------------------------------------------

/**
 * Like fuzzyIndexOf but returns { start, end } character offsets so the caller
 * can splice the original string while preserving the original line content
 * outside the matched region.
 */
function fuzzyMatch(haystack: string, needle: string): { start: number; end: number } | null {
	const normaliseLine = (l: string) => l.trimEnd().replace(/\s+/g, " ");

	const hLines = haystack.split("\n");
	const nLines = needle.split("\n");

	if (nLines.length === 0) return null;

	outer: for (let i = 0; i <= hLines.length - nLines.length; i++) {
		for (let j = 0; j < nLines.length; j++) {
			if (normaliseLine(hLines[i + j]) !== normaliseLine(nLines[j])) {
				continue outer;
			}
		}
		let start = 0;
		for (let k = 0; k < i; k++) {
			start += hLines[k].length + 1;
		}
		let end = start;
		for (let k = 0; k < nLines.length; k++) {
			end += hLines[i + k].length;
			if (k < nLines.length - 1) end += 1;
		}
		return { start, end };
	}
	return null;
}

export const editFileTool: ToolExecutor = {
	schema: {
		name: "edit_file",
		description:
			"Edit a file by replacing occurrences of old_string with new_string. " +
			"Falls back to fuzzy whitespace matching if an exact match is not found.",
		parameters: {
			type: "object",
			properties: {
				file_path: {
					type: "string",
					description: "Absolute path to the file to edit.",
				},
				old_string: {
					type: "string",
					description: "The exact text to find in the file.",
				},
				new_string: {
					type: "string",
					description: "The replacement text.",
				},
				replace_all: {
					type: "boolean",
					description: "Replace all occurrences instead of only the first.",
				},
			},
			required: ["file_path", "old_string", "new_string"],
			additionalProperties: false,
		},
	},

	async execute(args: Record<string, unknown>, env: ExecutionEnvironment): Promise<string> {
		const filePath = args.file_path as string;
		const oldString = args.old_string as string;
		const newString = args.new_string as string;
		const replaceAll = (args.replace_all as boolean) ?? false;

		let content = await env.read_file(filePath);

		// --- exact match path ---
		if (content.includes(oldString)) {
			let count = 0;
			if (replaceAll) {
				// Count occurrences then replace all
				let idx = content.indexOf(oldString);
				while (idx !== -1) {
					count++;
					idx = content.indexOf(oldString, idx + oldString.length);
				}
				content = content.split(oldString).join(newString);
			} else {
				const idx = content.indexOf(oldString);
				if (idx !== -1) {
					content = content.slice(0, idx) + newString + content.slice(idx + oldString.length);
					count = 1;
				}
			}
			await env.write_file(filePath, content);
			return `Edited ${filePath}: replaced ${count} occurrence(s)`;
		}

		// --- fuzzy match path (whitespace differences) ---
		if (replaceAll) {
			let count = 0;
			let current = content;
			let match = fuzzyMatch(current, oldString);
			while (match) {
				current = current.slice(0, match.start) + newString + current.slice(match.end);
				count++;
				match = fuzzyMatch(current, oldString);
			}
			if (count === 0) {
				throw new Error(`old_string not found in ${filePath} (neither exact nor fuzzy match)`);
			}
			await env.write_file(filePath, current);
			return `Edited ${filePath}: replaced ${count} occurrence(s) (fuzzy match)`;
		}

		const match = fuzzyMatch(content, oldString);
		if (!match) {
			throw new Error(`old_string not found in ${filePath} (neither exact nor fuzzy match)`);
		}
		content = content.slice(0, match.start) + newString + content.slice(match.end);
		await env.write_file(filePath, content);
		return `Edited ${filePath}: replaced 1 occurrence(s) (fuzzy match)`;
	},
};

// ---------------------------------------------------------------------------
// shell
// ---------------------------------------------------------------------------

export const shellTool: ToolExecutor = {
	schema: {
		name: "shell",
		description:
			"Execute a shell command. Returns stdout, stderr, and exit code. " +
			"Commands that exceed the timeout are killed.",
		parameters: {
			type: "object",
			properties: {
				command: {
					type: "string",
					description: "The shell command to execute.",
				},
				timeout_ms: {
					type: "integer",
					description: "Optional timeout in milliseconds.",
				},
				description: {
					type: "string",
					description: "A short human-readable description of what the command does.",
				},
			},
			required: ["command"],
			additionalProperties: false,
		},
	},

	async execute(
		args: Record<string, unknown>,
		env: ExecutionEnvironment,
		config: SessionConfig,
	): Promise<string> {
		const command = args.command as string;
		let timeoutMs = (args.timeout_ms as number | undefined) ?? config.default_command_timeout_ms;

		// Clamp to the configured maximum
		timeoutMs = Math.min(timeoutMs, config.max_command_timeout_ms);

		const result = await env.exec_command(command, timeoutMs);

		let output = "";
		if (result.timed_out) {
			output += `[Command timed out after ${timeoutMs}ms]\n`;
		}
		output += `Exit code: ${result.exit_code}\n`;
		output += `--- stdout ---\n${result.stdout}\n`;
		output += `--- stderr ---\n${result.stderr}`;

		return output;
	},
};

// ---------------------------------------------------------------------------
// grep
// ---------------------------------------------------------------------------

export const grepTool: ToolExecutor = {
	schema: {
		name: "grep",
		description:
			"Search file contents using a regular expression pattern. " +
			"Returns matching lines with file paths and line numbers.",
		parameters: {
			type: "object",
			properties: {
				pattern: {
					type: "string",
					description: "Regular expression pattern to search for.",
				},
				path: {
					type: "string",
					description: "File or directory to search in. Defaults to the working directory.",
				},
				glob_filter: {
					type: "string",
					description: 'Glob pattern to filter which files are searched (e.g. "*.ts").',
				},
				case_insensitive: {
					type: "boolean",
					description: "Perform a case-insensitive search.",
				},
				max_results: {
					type: "integer",
					description: "Maximum number of matching lines to return.",
				},
			},
			required: ["pattern"],
			additionalProperties: false,
		},
	},

	async execute(args: Record<string, unknown>, env: ExecutionEnvironment): Promise<string> {
		const pattern = args.pattern as string;
		const path = (args.path as string | undefined) ?? ".";
		const globFilter = args.glob_filter as string | undefined;
		const caseInsensitive = args.case_insensitive as boolean | undefined;
		const maxResults = args.max_results as number | undefined;

		return env.grep(pattern, path, {
			recursive: true,
			case_insensitive: caseInsensitive,
			glob_filter: globFilter,
			max_results: maxResults,
		});
	},
};

// ---------------------------------------------------------------------------
// glob
// ---------------------------------------------------------------------------

export const globTool: ToolExecutor = {
	schema: {
		name: "glob",
		description: "Find files matching a glob pattern. Returns one file path per line.",
		parameters: {
			type: "object",
			properties: {
				pattern: {
					type: "string",
					description: 'Glob pattern to match (e.g. "**/*.ts", "src/**/*.json").',
				},
				path: {
					type: "string",
					description: "Base directory to search from.",
				},
			},
			required: ["pattern"],
			additionalProperties: false,
		},
	},

	async execute(args: Record<string, unknown>, env: ExecutionEnvironment): Promise<string> {
		const pattern = args.pattern as string;
		const path = args.path as string | undefined;
		const files = await env.glob(pattern, path);
		return files.join("\n");
	},
};

// ---------------------------------------------------------------------------
// apply_patch (OpenAI v4a format)
// ---------------------------------------------------------------------------

interface PatchAddFile {
	kind: "add";
	path: string;
	content: string;
}

interface PatchDeleteFile {
	kind: "delete";
	path: string;
}

interface PatchHunk {
	contextHint: string;
	lines: PatchHunkLine[];
}

interface PatchHunkLine {
	type: "context" | "remove" | "add";
	text: string;
}

interface PatchUpdateFile {
	kind: "update";
	path: string;
	moveTo: string | null;
	hunks: PatchHunk[];
}

type PatchOperation = PatchAddFile | PatchDeleteFile | PatchUpdateFile;

/**
 * Parse the v4a unified patch format.
 *
 * Expected structure:
 * ```
 * *** Begin Patch
 * *** Add File: path
 * +line1
 * +line2
 * *** Delete File: path
 * *** Update File: path
 * *** Move to: new_path        (optional)
 * @@ context_hint
 *  context line
 * -removed line
 * +added line
 * *** End Patch
 * ```
 */
function parsePatch(patch: string): PatchOperation[] {
	const lines = patch.split("\n");
	const ops: PatchOperation[] = [];
	let i = 0;

	// Skip until we find *** Begin Patch
	while (i < lines.length && !lines[i].startsWith("*** Begin Patch")) {
		i++;
	}
	if (i >= lines.length) {
		throw new Error("Patch does not contain '*** Begin Patch' header");
	}
	i++; // skip the Begin Patch line

	while (i < lines.length) {
		const line = lines[i];

		if (line.startsWith("*** End Patch")) {
			break;
		}

		if (line.startsWith("*** Add File: ")) {
			const path = line.slice("*** Add File: ".length).trim();
			i++;
			const contentLines: string[] = [];
			while (i < lines.length && lines[i].startsWith("+")) {
				contentLines.push(lines[i].slice(1));
				i++;
			}
			ops.push({ kind: "add", path, content: contentLines.join("\n") });
			continue;
		}

		if (line.startsWith("*** Delete File: ")) {
			const path = line.slice("*** Delete File: ".length).trim();
			ops.push({ kind: "delete", path });
			i++;
			continue;
		}

		if (line.startsWith("*** Update File: ")) {
			const path = line.slice("*** Update File: ".length).trim();
			i++;

			let moveTo: string | null = null;
			if (i < lines.length && lines[i].startsWith("*** Move to: ")) {
				moveTo = lines[i].slice("*** Move to: ".length).trim();
				i++;
			}

			const hunks: PatchHunk[] = [];
			while (i < lines.length && lines[i].startsWith("@@")) {
				const contextHint = lines[i].slice(2).trim();
				i++;
				const hunkLines: PatchHunkLine[] = [];
				while (i < lines.length && !lines[i].startsWith("@@") && !lines[i].startsWith("*** ")) {
					const hLine = lines[i];
					if (hLine.startsWith(" ")) {
						hunkLines.push({ type: "context", text: hLine.slice(1) });
					} else if (hLine.startsWith("-")) {
						hunkLines.push({ type: "remove", text: hLine.slice(1) });
					} else if (hLine.startsWith("+")) {
						hunkLines.push({ type: "add", text: hLine.slice(1) });
					} else {
						// Bare line -- treat as context (handles empty context lines)
						hunkLines.push({ type: "context", text: hLine });
					}
					i++;
				}
				hunks.push({ contextHint, lines: hunkLines });
			}

			ops.push({ kind: "update", path, moveTo, hunks });
			continue;
		}

		// Skip unrecognised lines
		i++;
	}

	return ops;
}

/**
 * Find the position in `fileLines` where a hunk's context lines match.
 * Returns the 0-based line index where the hunk starts, or -1 if not found.
 */
function findHunkPosition(fileLines: string[], hunk: PatchHunk): number {
	// Build the sequence of "old" lines (context + remove) that must appear
	// consecutively in the file.
	const oldLines: string[] = [];
	for (const hl of hunk.lines) {
		if (hl.type === "context" || hl.type === "remove") {
			oldLines.push(hl.text);
		}
	}

	if (oldLines.length === 0) {
		// No context to anchor -- append at end
		return fileLines.length;
	}

	for (let i = 0; i <= fileLines.length - oldLines.length; i++) {
		let matches = true;
		for (let j = 0; j < oldLines.length; j++) {
			if (fileLines[i + j] !== oldLines[j]) {
				matches = false;
				break;
			}
		}
		if (matches) return i;
	}

	// Fuzzy: trim trailing whitespace
	for (let i = 0; i <= fileLines.length - oldLines.length; i++) {
		let matches = true;
		for (let j = 0; j < oldLines.length; j++) {
			if (fileLines[i + j].trimEnd() !== oldLines[j].trimEnd()) {
				matches = false;
				break;
			}
		}
		if (matches) return i;
	}

	return -1;
}

/**
 * Apply hunks to file content (as an array of lines, mutated in place).
 */
function applyHunks(fileLines: string[], hunks: PatchHunk[]): string[] {
	// Process hunks in reverse document order so earlier indices stay valid.
	// First, resolve positions for all hunks.
	const resolved: { position: number; hunk: PatchHunk }[] = [];

	for (const hunk of hunks) {
		const pos = findHunkPosition(fileLines, hunk);
		if (pos === -1) {
			throw new Error(`Could not locate hunk position (context hint: "${hunk.contextHint}")`);
		}
		resolved.push({ position: pos, hunk });
	}

	// Sort by descending position so splicing doesn't invalidate earlier positions
	resolved.sort((a, b) => b.position - a.position);

	for (const { position, hunk } of resolved) {
		// Count old lines (context + remove) to know how many lines to replace
		let oldLineCount = 0;
		for (const hl of hunk.lines) {
			if (hl.type === "context" || hl.type === "remove") {
				oldLineCount++;
			}
		}

		// Build replacement lines
		const newLines: string[] = [];
		for (const hl of hunk.lines) {
			if (hl.type === "context" || hl.type === "add") {
				newLines.push(hl.text);
			}
		}

		fileLines.splice(position, oldLineCount, ...newLines);
	}

	return fileLines;
}

export const applyPatchTool: ToolExecutor = {
	schema: {
		name: "apply_patch",
		description:
			"Apply a patch in OpenAI v4a format. Supports adding, deleting, and updating files " +
			"with contextual hunks.",
		parameters: {
			type: "object",
			properties: {
				patch: {
					type: "string",
					description: "The full patch content in v4a format.",
				},
			},
			required: ["patch"],
			additionalProperties: false,
		},
	},

	async execute(args: Record<string, unknown>, env: ExecutionEnvironment): Promise<string> {
		const patchText = args.patch as string;
		const ops = parsePatch(patchText);

		if (ops.length === 0) {
			throw new Error("No operations found in patch");
		}

		const summaryParts: string[] = [];

		for (const op of ops) {
			switch (op.kind) {
				case "add": {
					await env.write_file(op.path, op.content);
					summaryParts.push(`Added file: ${op.path}`);
					break;
				}
				case "delete": {
					// Write empty content to signal deletion; the environment should
					// handle actual file removal if supported. We rely on write_file
					// since the ExecutionEnvironment interface doesn't expose a
					// delete_file method.
					await env.write_file(op.path, "");
					summaryParts.push(`Deleted file: ${op.path}`);
					break;
				}
				case "update": {
					const existing = await env.read_file(op.path);
					let fileLines = existing.split("\n");

					fileLines = applyHunks(fileLines, op.hunks);

					const targetPath = op.moveTo ?? op.path;
					await env.write_file(targetPath, fileLines.join("\n"));

					if (op.moveTo) {
						summaryParts.push(`Updated and moved file: ${op.path} -> ${op.moveTo}`);
					} else {
						summaryParts.push(`Updated file: ${op.path} (${op.hunks.length} hunk(s))`);
					}
					break;
				}
			}
		}

		return summaryParts.join("\n");
	},
};
