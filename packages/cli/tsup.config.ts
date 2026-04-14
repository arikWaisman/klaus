import { defineConfig } from "tsup";

export default defineConfig({
	entry: ["src/cli.ts"],
	format: ["esm"],
	clean: true,
	sourcemap: true,
	splitting: false,
	banner: {
		js: "#!/usr/bin/env node",
	},
});
