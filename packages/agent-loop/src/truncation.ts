export const DEFAULT_CHAR_LIMITS: Record<string, number> = {
	read_file: 50_000,
	shell: 30_000,
	grep: 20_000,
	glob: 20_000,
	edit_file: 10_000,
	apply_patch: 10_000,
	write_file: 1_000,
	spawn_agent: 20_000,
};

export const DEFAULT_LINE_LIMITS: Record<string, number> = {
	shell: 256,
	grep: 200,
	glob: 500,
};

export const TRUNCATION_MODES: Record<string, "head_tail" | "tail"> = {
	read_file: "head_tail",
	shell: "head_tail",
	grep: "tail",
	glob: "tail",
	edit_file: "tail",
	apply_patch: "tail",
	write_file: "tail",
	spawn_agent: "head_tail",
};

export function truncateChars(
	output: string,
	maxChars: number,
	mode: "head_tail" | "tail",
): string {
	if (output.length <= maxChars) {
		return output;
	}

	if (mode === "head_tail") {
		const half = maxChars / 2;
		const removed = output.length - maxChars;
		return `${output.slice(0, half)}\n\n[WARNING: Tool output was truncated. ${removed} characters were removed from the middle. Full output available in events.]\n\n${output.slice(-half)}`;
	}

	// tail mode
	const removed = output.length - maxChars;
	return `[WARNING: Tool output was truncated. First ${removed} characters were removed.]\n\n${output.slice(-maxChars)}`;
}

export function truncateLines(output: string, maxLines: number): string {
	const lines = output.split("\n");
	if (lines.length <= maxLines) {
		return output;
	}

	const headCount = Math.floor(maxLines / 2);
	const tailCount = maxLines - headCount;
	const omitted = lines.length - headCount - tailCount;

	return `${lines.slice(0, headCount).join("\n")}\n[... ${omitted} lines omitted ...]\n${lines.slice(-tailCount).join("\n")}`;
}

export function truncateToolOutput(
	toolName: string,
	output: string,
	charLimits?: Record<string, number>,
	lineLimits?: Record<string, number>,
): string {
	let result = output;

	// Character-based truncation ALWAYS runs FIRST
	const effectiveCharLimits = { ...DEFAULT_CHAR_LIMITS, ...charLimits };
	const maxChars = effectiveCharLimits[toolName];
	if (maxChars !== undefined) {
		const mode = TRUNCATION_MODES[toolName] ?? "tail";
		result = truncateChars(result, maxChars, mode);
	}

	// Line-based truncation runs SECOND
	const effectiveLineLimits = { ...DEFAULT_LINE_LIMITS, ...lineLimits };
	const maxLines = effectiveLineLimits[toolName];
	if (maxLines !== undefined) {
		result = truncateLines(result, maxLines);
	}

	return result;
}
