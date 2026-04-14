import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const REQUIRED_SKILLS = ["sprint-plan", "sprint-execute"];
const SKILLS_REPO = "strongdm/skills";

/**
 * Find the project root (nearest directory with a .git folder).
 */
function findProjectRoot(from: string): string {
	let dir = from;
	while (dir !== path.dirname(dir)) {
		if (fs.existsSync(path.join(dir, ".git"))) return dir;
		dir = path.dirname(dir);
	}
	return from;
}

/**
 * Check which skills are missing from the project.
 */
export function getMissingSkills(cwd: string): string[] {
	const root = findProjectRoot(cwd);
	const missing: string[] = [];

	for (const skill of REQUIRED_SKILLS) {
		const skillPath = path.join(root, ".claude", "skills", skill, "SKILL.md");
		if (!fs.existsSync(skillPath)) {
			missing.push(skill);
		}
	}

	return missing;
}

/**
 * Install skills from strongdm/skills using the skills CLI.
 */
export function installSkills(cwd: string): void {
	const missing = getMissingSkills(cwd);
	if (missing.length === 0) {
		console.log("All required skills are already installed.");
		return;
	}

	console.log(`Installing missing skills: ${missing.join(", ")}`);
	console.log(`Source: ${SKILLS_REPO}`);

	try {
		execSync(`npx -y skills add ${SKILLS_REPO} --yes`, {
			cwd: findProjectRoot(cwd),
			stdio: "inherit",
		});
		console.log("Skills installed successfully.");
	} catch (error) {
		console.error("Failed to install skills:", error instanceof Error ? error.message : error);
		console.error(`You can install manually: npx skills add ${SKILLS_REPO}`);
		process.exit(1);
	}
}

/**
 * Check and report on skill installation status.
 */
export function checkSkills(cwd: string): boolean {
	const missing = getMissingSkills(cwd);
	if (missing.length === 0) {
		console.log("All required skills are installed:");
		for (const skill of REQUIRED_SKILLS) {
			console.log(`  [x] ${skill}`);
		}
		return true;
	}

	console.log("Skill status:");
	for (const skill of REQUIRED_SKILLS) {
		const installed = !missing.includes(skill);
		console.log(`  [${installed ? "x" : " "}] ${skill}`);
	}
	console.log(`\nRun 'klaus skills install' to install missing skills.`);
	return false;
}
