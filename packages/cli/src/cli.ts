import * as fs from "node:fs";
import * as path from "node:path";
import { Client } from "@klaus/llm-client";
import { PipelineEngine, createAutoApproveInterviewer, parseDOT, validate } from "@klaus/pipeline";
import type { PipelineEvent } from "@klaus/pipeline";
import { Command } from "commander";
import { createSessionBackend } from "./backend.js";
import { ConsoleInterviewer } from "./console-interviewer.js";
import { checkSkills, getMissingSkills, installSkills } from "./skills.js";

const program = new Command();

program.name("klaus").description("Klaus — DOT-based AI pipeline runner").version("0.1.0");

// ---------------------------------------------------------------------------
// klaus run <file.dot>
// ---------------------------------------------------------------------------

program
	.command("run")
	.description("Run a DOT pipeline")
	.argument("<file>", "Path to .dot pipeline file")
	.option("-m, --model <model>", "Default LLM model", "claude-sonnet-4-5-20250929")
	.option("--auto-approve", "Auto-approve all human gates", false)
	.option("--logs <dir>", "Log output directory", "/tmp/klaus-logs")
	.option("-q, --quiet", "Suppress event logging", false)
	.action(async (file: string, opts) => {
		const dotPath = path.resolve(file);
		if (!fs.existsSync(dotPath)) {
			console.error(`File not found: ${dotPath}`);
			process.exit(1);
		}

		const dot = fs.readFileSync(dotPath, "utf-8");
		const cwd = process.cwd();

		// Check skills on first run
		const missing = getMissingSkills(cwd);
		if (missing.length > 0) {
			console.log(`Missing skills: ${missing.join(", ")}. Installing...`);
			installSkills(cwd);
		}

		// Create LLM client from env vars
		const client = Client.fromEnv();

		// Create backend
		const backend = createSessionBackend({
			client,
			model: opts.model,
			cwd,
		});

		// Create interviewer
		let interviewer: ReturnType<typeof createAutoApproveInterviewer> | ConsoleInterviewer;
		let consoleInterviewer: ConsoleInterviewer | null = null;
		if (opts.autoApprove) {
			interviewer = createAutoApproveInterviewer();
		} else {
			consoleInterviewer = new ConsoleInterviewer();
			interviewer = consoleInterviewer;
		}

		// Event handler
		const onEvent = opts.quiet
			? undefined
			: (event: PipelineEvent) => {
					const ts = new Date(event.timestamp).toISOString().slice(11, 19);
					switch (event.kind) {
						case "PipelineStarted":
							console.log(`\n[${ts}] Pipeline started: ${event.data.name}`);
							break;
						case "StageStarted":
							console.log(`[${ts}] -> ${event.data.name}`);
							break;
						case "StageCompleted":
							console.log(`[${ts}]    done (${event.data.duration}ms)`);
							break;
						case "StageFailed":
							console.error(`[${ts}]    FAILED: ${event.data.error}`);
							break;
						case "StageRetrying":
							console.log(`[${ts}]    retrying (attempt ${event.data.attempt})...`);
							break;
						case "PipelineCompleted":
							console.log(`\n[${ts}] Pipeline completed (${event.data.duration}ms)`);
							break;
						case "PipelineFailed":
							console.error(`\n[${ts}] Pipeline FAILED: ${event.data.error}`);
							break;
						default:
							break;
					}
				};

		// Run
		try {
			const engine = new PipelineEngine({
				dot,
				backend,
				interviewer,
				logs_root: opts.logs,
				on_event: onEvent,
			});

			const outcome = await engine.run();

			console.log(`\nOutcome: ${outcome.status}`);
			if (outcome.notes) {
				console.log(`Notes: ${outcome.notes}`);
			}
			if (outcome.failure_reason) {
				console.error(`Failure: ${outcome.failure_reason}`);
			}

			process.exit(outcome.status === "success" ? 0 : 1);
		} catch (error) {
			console.error("\nPipeline error:", error instanceof Error ? error.message : error);
			process.exit(1);
		} finally {
			consoleInterviewer?.close();
		}
	});

// ---------------------------------------------------------------------------
// klaus validate <file.dot>
// ---------------------------------------------------------------------------

program
	.command("validate")
	.description("Validate a DOT pipeline file")
	.argument("<file>", "Path to .dot pipeline file")
	.action((file: string) => {
		const dotPath = path.resolve(file);
		if (!fs.existsSync(dotPath)) {
			console.error(`File not found: ${dotPath}`);
			process.exit(1);
		}

		const dot = fs.readFileSync(dotPath, "utf-8");

		try {
			const graph = parseDOT(dot);
			const diagnostics = validate(graph);
			const errors = diagnostics.filter((d) => d.severity === "error");
			const warnings = diagnostics.filter((d) => d.severity === "warning");

			if (errors.length === 0 && warnings.length === 0) {
				console.log("Valid pipeline.");
				process.exit(0);
			}

			for (const d of errors) {
				console.error(`ERROR: ${d.message}${d.node_id ? ` (node: ${d.node_id})` : ""}`);
			}
			for (const d of warnings) {
				console.log(`WARN: ${d.message}${d.node_id ? ` (node: ${d.node_id})` : ""}`);
			}

			process.exit(errors.length > 0 ? 1 : 0);
		} catch (error) {
			console.error("Parse error:", error instanceof Error ? error.message : error);
			process.exit(1);
		}
	});

// ---------------------------------------------------------------------------
// klaus skills [check|install]
// ---------------------------------------------------------------------------

const skillsCmd = program.command("skills").description("Manage Claude Code skills");

skillsCmd
	.command("check")
	.description("Check if required skills are installed")
	.action(() => {
		const ok = checkSkills(process.cwd());
		process.exit(ok ? 0 : 1);
	});

skillsCmd
	.command("install")
	.description("Install skills from strongdm/skills")
	.action(() => {
		installSkills(process.cwd());
	});

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

program.parse();
