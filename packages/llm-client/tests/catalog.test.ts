import { afterEach, describe, expect, it } from "vitest";
import { getLatestModel, getModelInfo, listModels, registerModel } from "../src/catalog.js";
import type { ModelInfo } from "../src/catalog.js";

// ---------------------------------------------------------------------------
// getModelInfo
// ---------------------------------------------------------------------------

describe("getModelInfo", () => {
	it("returns info for a known model by canonical id", () => {
		const info = getModelInfo("claude-opus-4-6");
		expect(info).toBeDefined();
		expect(info?.id).toBe("claude-opus-4-6");
		expect(info?.provider).toBe("anthropic");
		expect(info?.display_name).toBe("Claude Opus 4.6");
	});

	it("returns info for an OpenAI model", () => {
		const info = getModelInfo("gpt-5.2");
		expect(info).toBeDefined();
		expect(info?.provider).toBe("openai");
	});

	it("returns info for a Gemini model", () => {
		const info = getModelInfo("gemini-3.1-pro-preview");
		expect(info).toBeDefined();
		expect(info?.provider).toBe("gemini");
	});

	it("returns undefined for unknown models", () => {
		expect(getModelInfo("unknown-model-xyz")).toBeUndefined();
		expect(getModelInfo("")).toBeUndefined();
	});

	it("resolves aliases to the correct model", () => {
		const info = getModelInfo("claude-opus-4-6-20250814");
		expect(info).toBeDefined();
		expect(info?.id).toBe("claude-opus-4-6");
	});

	it("resolves the claude-sonnet-4-5 alias", () => {
		const info = getModelInfo("claude-sonnet-4-5");
		expect(info).toBeDefined();
		expect(info?.id).toBe("claude-sonnet-4-5-20250929");
	});

	it("resolves the claude-haiku-4-5 alias", () => {
		const info = getModelInfo("claude-haiku-4-5");
		expect(info).toBeDefined();
		expect(info?.id).toBe("claude-haiku-4-5-20251001");
	});

	it("resolves the gemini-3-flash alias", () => {
		const info = getModelInfo("gemini-3-flash");
		expect(info).toBeDefined();
		expect(info?.id).toBe("gemini-3-flash-preview");
	});

	it("returns correct model properties", () => {
		const info = getModelInfo("claude-opus-4-6");
		expect(info).toBeDefined();
		expect(info?.context_window).toBe(200_000);
		expect(info?.max_output).toBe(32_000);
		expect(info?.supports_tools).toBe(true);
		expect(info?.supports_vision).toBe(true);
		expect(info?.supports_reasoning).toBe(true);
		expect(info?.input_cost_per_million).toBe(15);
		expect(info?.output_cost_per_million).toBe(75);
	});
});

// ---------------------------------------------------------------------------
// listModels
// ---------------------------------------------------------------------------

describe("listModels", () => {
	it("returns all models when no provider is specified", () => {
		const models = listModels();
		expect(models.length).toBeGreaterThanOrEqual(8);

		const providers = new Set(models.map((m) => m.provider));
		expect(providers.has("anthropic")).toBe(true);
		expect(providers.has("openai")).toBe(true);
		expect(providers.has("gemini")).toBe(true);
	});

	it("filters by provider when specified", () => {
		const anthropicModels = listModels("anthropic");
		expect(anthropicModels.length).toBeGreaterThanOrEqual(3);
		expect(anthropicModels.every((m) => m.provider === "anthropic")).toBe(true);
	});

	it("returns only OpenAI models when filtered", () => {
		const openaiModels = listModels("openai");
		expect(openaiModels.length).toBeGreaterThanOrEqual(3);
		expect(openaiModels.every((m) => m.provider === "openai")).toBe(true);
	});

	it("returns only Gemini models when filtered", () => {
		const geminiModels = listModels("gemini");
		expect(geminiModels.length).toBeGreaterThanOrEqual(2);
		expect(geminiModels.every((m) => m.provider === "gemini")).toBe(true);
	});

	it("returns empty array for unknown provider", () => {
		expect(listModels("nonexistent")).toEqual([]);
	});

	it("returns a copy, not the internal array", () => {
		const a = listModels();
		const b = listModels();
		expect(a).not.toBe(b);
		expect(a).toEqual(b);
	});
});

// ---------------------------------------------------------------------------
// getLatestModel
// ---------------------------------------------------------------------------

describe("getLatestModel", () => {
	it("returns the first model for a provider (no capability filter)", () => {
		const model = getLatestModel("anthropic");
		expect(model).toBeDefined();
		expect(model?.provider).toBe("anthropic");
		// The first anthropic model in the catalog is claude-opus-4-6
		expect(model?.id).toBe("claude-opus-4-6");
	});

	it("returns the first OpenAI model", () => {
		const model = getLatestModel("openai");
		expect(model).toBeDefined();
		expect(model?.provider).toBe("openai");
		expect(model?.id).toBe("gpt-5.2");
	});

	it("returns undefined for unknown provider", () => {
		expect(getLatestModel("nonexistent")).toBeUndefined();
	});

	it("filters by reasoning capability", () => {
		const model = getLatestModel("anthropic", "reasoning");
		expect(model).toBeDefined();
		expect(model?.supports_reasoning).toBe(true);
	});

	it("filters by vision capability", () => {
		const model = getLatestModel("anthropic", "vision");
		expect(model).toBeDefined();
		expect(model?.supports_vision).toBe(true);
	});

	it("filters by tools capability", () => {
		const model = getLatestModel("anthropic", "tools");
		expect(model).toBeDefined();
		expect(model?.supports_tools).toBe(true);
	});

	it("returns the first Gemini model with reasoning", () => {
		const model = getLatestModel("gemini", "reasoning");
		expect(model).toBeDefined();
		expect(model?.supports_reasoning).toBe(true);
		// gemini-3.1-pro-preview supports reasoning, gemini-3-flash-preview does not
		expect(model?.id).toBe("gemini-3.1-pro-preview");
	});
});

// ---------------------------------------------------------------------------
// registerModel
// ---------------------------------------------------------------------------

describe("registerModel", () => {
	const customModel: ModelInfo = {
		id: "custom-test-model",
		provider: "custom",
		display_name: "Custom Test Model",
		context_window: 100_000,
		max_output: 4096,
		supports_tools: true,
		supports_vision: false,
		supports_reasoning: false,
		input_cost_per_million: 1,
		output_cost_per_million: 2,
		aliases: ["custom-test"],
	};

	afterEach(() => {
		// Clean up: remove any custom models we added by re-registering.
		// Since there is no unregister, we overwrite it so future tests
		// still see it in the catalog but that is acceptable.
	});

	it("adds a new model that can be retrieved by getModelInfo", () => {
		registerModel(customModel);
		const info = getModelInfo("custom-test-model");
		expect(info).toBeDefined();
		expect(info?.id).toBe("custom-test-model");
		expect(info?.provider).toBe("custom");
		expect(info?.display_name).toBe("Custom Test Model");
	});

	it("makes the new model appear in listModels", () => {
		registerModel(customModel);
		const all = listModels();
		const found = all.find((m) => m.id === "custom-test-model");
		expect(found).toBeDefined();
	});

	it("makes the new model appear when filtering by its provider", () => {
		registerModel(customModel);
		const custom = listModels("custom");
		expect(custom.length).toBeGreaterThanOrEqual(1);
		expect(custom[0].id).toBe("custom-test-model");
	});

	it("resolves aliases of registered models", () => {
		registerModel(customModel);
		const info = getModelInfo("custom-test");
		expect(info).toBeDefined();
		expect(info?.id).toBe("custom-test-model");
	});

	it("replaces an existing model with the same id", () => {
		registerModel(customModel);
		const updated: ModelInfo = {
			...customModel,
			display_name: "Updated Name",
			max_output: 8192,
		};
		registerModel(updated);

		const info = getModelInfo("custom-test-model");
		expect(info).toBeDefined();
		expect(info?.display_name).toBe("Updated Name");
		expect(info?.max_output).toBe(8192);
	});

	it("makes the registered model available via getLatestModel", () => {
		registerModel(customModel);
		const model = getLatestModel("custom");
		expect(model).toBeDefined();
		expect(model?.id).toBe("custom-test-model");
	});
});
