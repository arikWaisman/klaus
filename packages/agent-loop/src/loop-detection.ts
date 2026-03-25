import type { ToolCallInfo } from "./types.js";

/**
 * Generate a signature for a tool call (name + hash of arguments).
 * The hash doesn't need to be cryptographic — just a stable string representation.
 */
function toolCallSignature(call: ToolCallInfo): string {
	// Use name + JSON.stringify of sorted args for deterministic comparison
	const sortedArgs = JSON.stringify(call.arguments, Object.keys(call.arguments).sort());
	return `${call.name}:${sortedArgs}`;
}

/**
 * Check if the recent tool call history contains repeating patterns.
 * Checks for patterns of length 1, 2, or 3.
 *
 * @param recentCalls - The last N tool calls (signatures)
 * @param windowSize - How many recent calls to examine (default 10)
 * @returns The detected pattern length (1, 2, or 3) or 0 if no loop detected
 */
export function detectLoop(recentCalls: ToolCallInfo[], windowSize = 10): number {
	if (recentCalls.length < 2) return 0;

	// Get signatures for the window
	const window = recentCalls.slice(-windowSize).map(toolCallSignature);

	if (window.length < 2) return 0;

	// Check for patterns of length 1, 2, 3
	for (const patternLen of [1, 2, 3]) {
		if (window.length < patternLen * 2) continue;

		// Extract the last patternLen signatures as the candidate pattern
		const pattern = window.slice(-patternLen);

		// Check how many times this pattern repeats going backwards
		let repeats = 0;
		for (let i = window.length - patternLen; i >= 0; i -= patternLen) {
			const chunk = window.slice(i, i + patternLen);
			if (chunk.length < patternLen) break;
			const matches = chunk.every((sig, idx) => sig === pattern[idx]);
			if (matches) {
				repeats++;
			} else {
				break;
			}
		}

		// If the pattern repeats enough times to fill most of the window
		if (repeats >= Math.floor(windowSize / patternLen) - 1 && repeats >= 2) {
			return patternLen;
		}
	}

	return 0;
}

/**
 * Build the warning message for a detected loop.
 */
export function loopWarningMessage(patternLength: number, windowSize: number): string {
	return `Loop detected: the last ${windowSize} tool calls follow a repeating pattern of length ${patternLength}. Try a different approach.`;
}
