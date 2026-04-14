import * as readline from "node:readline";
import type { Answer, Interviewer, Question } from "@klaus/pipeline";

/**
 * Interactive console interviewer for human-in-the-loop pipeline gates.
 */
export class ConsoleInterviewer implements Interviewer {
	private rl: readline.Interface;

	constructor() {
		this.rl = readline.createInterface({
			input: process.stdin,
			output: process.stderr,
		});
	}

	async ask(question: Question): Promise<Answer> {
		console.error(`\n--- ${question.stage} ---`);
		console.error(question.text);

		if (question.options.length > 0) {
			for (const opt of question.options) {
				console.error(`  [${opt.key}] ${opt.label}`);
			}
		}

		const response = await this.prompt("> ");

		if (question.type === "YES_NO") {
			const normalized = response.trim().toLowerCase();
			if (normalized === "y" || normalized === "yes") {
				return { value: "YES" };
			}
			if (normalized === "n" || normalized === "no") {
				return { value: "NO" };
			}
			return { value: response.trim() };
		}

		// Match to option by key
		const matchedOption = question.options.find(
			(o) => o.key.toLowerCase() === response.trim().toLowerCase(),
		);
		if (matchedOption) {
			return { value: matchedOption.key, selected_option: matchedOption };
		}

		return { value: response.trim() };
	}

	async inform(message: string, stage: string): Promise<void> {
		console.error(`\n[${stage}] ${message}`);
	}

	close(): void {
		this.rl.close();
	}

	private prompt(query: string): Promise<string> {
		return new Promise((resolve) => {
			this.rl.question(query, resolve);
		});
	}
}
