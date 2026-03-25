import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globals: false,
		include: ["packages/*/tests/**/*.test.ts"],
		exclude: ["packages/*/tests/integration/**"],
		testTimeout: 10_000,
	},
});
